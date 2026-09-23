from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime, timezone
from app.auth import get_current_admin, hash_password
from app.database import get_db
from app.services.addon_grant import grant_addon
from app.config import settings
import asyncpg
import json
import logging
import math

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["Администратор"])


@router.get("/me", summary="Профиль текущего администратора (для admin-guard на фронте)")
async def admin_me(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Возвращает данные ИЗ ТАБЛИЦЫ admins по sub из JWT с role='admin'.

    Создан потому что /auth/me читает clients по sub — у админа и клиента
    с id=1 это разные люди (admin@plusson.app vs margarita.vl2011@gmail.com).
    Использовать для admin-guard на фронте: если ответ 200 → admin, иначе → нет.
    """
    row = await db.fetchrow(
        "SELECT id, name, email, is_superadmin FROM admins WHERE id = $1",
        int(admin["sub"]),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Администратор не найден")
    return {**dict(row), "role": "admin"}


# ─── Статистика ───────────────────────────────────────────────────────────────

@router.get("/stats", summary="Общая статистика платформы")
async def platform_stats(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    stats = await db.fetchrow(
        """
        SELECT
          -- ⚠️ Тестовые кабинеты техспецов (миграция 403) в счётчик не идут:
          -- иначе «всего клиентов» раздувается их проверками платформы.
          (SELECT COUNT(*) FROM clients
            WHERE is_active = TRUE AND NOT is_tech_test) as clients_total,
          (SELECT COUNT(*) FROM events) as events_total,
          (SELECT COUNT(*) FROM events WHERE status = 'published') as events_active,
          (SELECT COUNT(*) FROM event_participants) as participants_total,
          (SELECT COUNT(*) FROM referral_events WHERE type IN ('free','paid')) as conversions_total
        """
    )
    return dict(stats)


# ─── Клиенты ──────────────────────────────────────────────────────────────────

@router.get("/clients", summary="Список клиентов")
async def list_clients(
    search: Optional[str] = None,
    tariff: Optional[str] = None,
    min_contacts: Optional[int] = None,
    subscription: Optional[str] = None,   # active | inactive
    has_bot: Optional[str] = None,        # yes | no
    in_collab: Optional[str] = None,      # yes | no
    feature: Optional[str] = None,        # slug фичи/модуля
    # ⚠️ `feature` — slug ПОДКЛЮЧЁННОГО МОДУЛЯ (`features.is_addon`), а не
    # любой фичи: фильтр отвечает на вопрос «у кого сейчас подключён модуль».
    min_subscribers: Optional[int] = None,
    min_events: Optional[int] = None,
    min_channels: Optional[int] = None,
    # ⚠️ Чьи клиенты (23.09.2026). Тот же список, суженный до одного внедренца —
    # так из карточки внедренца попадают в его клиентов, не заходя в чужой
    # кабинет. `0` — особый случай: «ничьи», у кого ответственного нет вовсе.
    spec_id: Optional[int] = None,
    sort: Optional[str] = None,           # см. SORT_COLUMNS
    sort_dir: Optional[str] = None,       # asc | desc
    limit: int = 50,
    offset: int = 0,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    conditions = ["1=1"]
    params = []

    # Чьи клиенты: закреплённые ЛИБО приведённые этим внедренцем лично —
    # ему принадлежат обе группы, по одному признаку видна половина работы.
    if spec_id is not None:
        if spec_id == 0:
            conditions.append("c.tech_specialist_id IS NULL")
        else:
            params.append(spec_id)
            n = len(params)
            conditions.append(
                f"(c.tech_specialist_id = ${n}"
                f" OR EXISTS (SELECT 1 FROM tech_specialists ts_r"
                f"             WHERE ts_r.id = ${n}"
                f"               AND ts_r.client_id = c.referred_by_client_id))")

    # ─── Сегментные фильтры (для рассылок по клиентам платформы) ─────────
    # Подписка активна = есть текущая подписка со status='active' и не истёкшая.
    # Смотрим и статус, и дату: статус может отставать до тика Celery.
    if subscription in ("active", "inactive"):
        cond = ("EXISTS (SELECT 1 FROM client_subscriptions cs2 WHERE cs2.id = c.current_subscription_id "
                "AND cs2.status = 'active' AND cs2.expires_at > NOW())")
        conditions.append(cond if subscription == "active" else f"NOT {cond}")

    # Свой бот = не-системный канал с токеном. Именно токен, а не просто запись:
    # без токена бот не может ни отвечать, ни рассылать.
    if has_bot in ("yes", "no"):
        cond = ("EXISTS (SELECT 1 FROM client_channels cc2 JOIN channels ch2 ON ch2.id = cc2.channel_id "
                "WHERE cc2.client_id = c.id AND ch2.is_system = FALSE "
                "AND ch2.bot_token IS NOT NULL AND ch2.bot_token <> '')")
        conditions.append(cond if has_bot == "yes" else f"NOT {cond}")

    # В Коллабораторной = активный аддон collab_hub ЛИБО опубликован в Хабе.
    if in_collab in ("yes", "no"):
        cond = ("(c.is_published_in_hub = TRUE OR EXISTS (SELECT 1 FROM client_addons ca2 "
                "JOIN features f2 ON f2.id = ca2.feature_id "
                "WHERE ca2.client_id = c.id AND f2.slug = 'collab_hub' AND ca2.status = 'active'))")
        conditions.append(cond if in_collab == "yes" else f"NOT {cond}")

    # ─── Фильтр по ПОДКЛЮЧЁННОМУ МОДУЛЮ ─────────────────────────────────
    #
    # ⚠️⚠️ ТОЛЬКО `client_addons` — то есть модуль, который клиенту РЕАЛЬНО
    # подключён прямо сейчас (куплен или выдан админом), с действующим сроком.
    #
    # ⚠️ Раньше здесь искали по ДОСТУПУ К ФИЧЕ (`_CLIENT_FEATURES_SQL`), и это
    # был неверный ответ на вопрос: доступ даёт ещё и тариф, поэтому в выдачу
    # попадали все, у кого фича «есть», — а нужны те, у кого модуль ПОДКЛЮЧЁН.
    # Модулей всего три (`features.is_addon`), остальные 33 фичи к этому
    # фильтру отношения не имеют.
    #
    # ⚠️ `expires_at > NOW()` обязательно: истёкший модуль остаётся строкой в
    # таблице со статусом `active`, и без проверки срока в списке висели бы
    # клиенты, у которых модуль давно кончился.
    if feature:
        params.append(feature)
        conditions.append(
            f"""EXISTS (SELECT 1 FROM client_addons ca3
                          JOIN features f3 ON f3.id = ca3.feature_id
                         WHERE ca3.client_id = c.id AND f3.slug = ${len(params)}
                           AND ca3.status = 'active' AND ca3.expires_at > NOW())"""
        )

    # ─── Пороги по числовым колонкам ────────────────────────────────────
    #
    # ⚠️ Считаем ТЕМИ ЖЕ подзапросами, что и колонки в выдаче: иначе фильтр
    # «подписчиков от 100» отберёт не тех, кого показывает столбец, и цифрам
    # перестанут верить.
    _MIN_FILTERS = {
        "min_subscribers": (min_subscribers,
            "(SELECT COUNT(*) FROM platform_user_channels puc "
            "   JOIN client_channels cc ON cc.id = puc.client_channel_id "
            "  WHERE cc.client_id = c.id AND puc.is_unsubscribed = FALSE)"),
        "min_events": (min_events,
            "(SELECT COUNT(*) FROM events e WHERE EXISTS("
            "  SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id "
            "    AND eo.client_id=c.id AND eo.status='accepted'))"),
        "min_channels": (min_channels,
            "(SELECT COUNT(*) FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id "
            "  WHERE cc.client_id = c.id AND ch.is_system = FALSE)"),
    }
    for _name, (_val, _expr) in _MIN_FILTERS.items():
        if _val is not None and _val > 0:
            params.append(_val)
            conditions.append(f"{_expr} >= ${len(params)}")

    if search:
        params.append(f"%{search}%")
        p = len(params)
        # Ищем по данным самого клиента (имя/email/телефон/TG-ник из регистрации),
        # а также по идентичностям связанных контактов: clients не связан с
        # platform_users напрямую — единственная связка это email. Так поиск
        # находит клиента по его TG/VK/MAX-нику и по email контакта.
        conditions.append(
            f"""(
                c.name ILIKE ${p} OR c.email ILIKE ${p}
                OR c.phone ILIKE ${p} OR c.telegram_username ILIKE ${p}
                OR EXISTS (
                    SELECT 1 FROM contacts ct
                    JOIN platform_users pe ON pe.contact_id = ct.id
                                          AND pe.platform_slug = 'email'
                                          AND pe.platform_user_id = lower(c.email)
                    JOIN platform_users pu ON pu.contact_id = ct.id
                    WHERE pu.username ILIKE ${p} OR ct.name ILIKE ${p}
                )
            )"""
        )

    if tariff:
        params.append(tariff)
        # Фильтр по тарифу через активную подписку (clients.tariff_slug удалён, миграция 074)
        conditions.append(
            f"EXISTS (SELECT 1 FROM client_subscriptions cs JOIN tariffs t ON t.id=cs.tariff_id "
            f"WHERE cs.client_id=c.id AND cs.id=c.current_subscription_id AND t.slug = ${len(params)})"
        )

    # Фильтр «база не меньше N контактов» — чтобы отделить рабочие кабинеты от
    # пустых регистраций (их большинство, и они забивают список).
    if min_contacts is not None and min_contacts > 0:
        params.append(min_contacts)
        conditions.append(
            f"(SELECT COUNT(*) FROM contacts ct WHERE ct.client_id = c.id "
            f"AND ct.is_active = TRUE) >= ${len(params)}"
        )

    where = " AND ".join(conditions)
    params.extend([limit, offset])

    # ─── Сортировка по клику на заголовок столбца ───────────────────────
    #
    # ⚠️⚠️ ТОЛЬКО БЕЛЫЙ СПИСОК. Имя столбца приходит из браузера и уходит
    # прямо в SQL — принимать его как есть нельзя ни при каких условиях.
    # Тот же приём, что в таблице заявок анкет (`sort_map`).
    SORT_COLUMNS = {
        "created_at": "c.created_at",
        "name": "c.name",
        "tariff": "t.price",
        "expires_at": "cs.expires_at",
        "events": "events_count",
        "contacts": "contacts_count",
        "subscribers": "subscribers_count",
        "unsubscribed": "unsubscribed_count",
        "channels": "own_channels_count",
        "collaborators": "collaborators_count",
    }
    sort_col = SORT_COLUMNS.get(sort or "", "c.created_at")
    direction = "ASC" if (sort_dir or "").lower() == "asc" else "DESC"
    # ⚠️ `c.id` вторым ключом — без него строки с одинаковым значением
    # «плавают» между страницами, и при листании часть клиентов пропадает,
    # а часть показывается дважды.
    order_by = f"{sort_col} {direction} NULLS LAST, c.id DESC"

    # Расширенные колонки: тариф, фичи активной подписки, статус подписки, число событий,
    # число своих не-системных каналов, число подписчиков (через client_channels),
    # число отписавшихся, число коллабораторов.
    clients = await db.fetch(
        f"""
        SELECT
          c.id, c.name, c.email, c.phone, c.telegram_username,
          c.is_active, c.collab_hub_blocked, c.created_at,
          t.slug AS tariff_slug, t.name AS tariff_name,
          cs.expires_at AS subscription_expires_at,
          cs.status     AS subscription_status,
          (SELECT ARRAY_AGG(f.slug ORDER BY f.sort)
             FROM tariff_features tf
             JOIN features f         ON f.id = tf.feature_id
            WHERE tf.tariff_id = cs.tariff_id
              AND cs.status = 'active'
              AND cs.expires_at > NOW()) AS features,
          -- ⚠️ КУПЛЕННЫЕ МОДУЛИ — ОТДЕЛЬНО от фич тарифа. Выше собираются
          -- только `tariff_features`, то есть то, что клиенту дал тариф;
          -- модуль, за который он ЗАПЛАТИЛ отдельно (Конференции, Турниры,
          -- Коллабораторная), туда не попадает вовсе — и в админке его не
          -- было видно. Владельцу нужно именно это: кто что купил и до когда.
          -- ⚠️ ИСТЁКШИЕ МОДУЛИ ТОЖЕ ОТДАЁМ (`is_active` в каждой строке).
          -- Раньше условие было `expires_at > NOW()`, и модуль, у которого
          -- кончился срок, пропадал из админки бесследно: владелец не видел,
          -- что клиент им пользовался и когда доступ закончился.
          (SELECT json_agg(json_build_object(
                     'slug', f.slug, 'name', f.name,
                     'expires_at', ca.expires_at,
                     'is_active', (ca.status = 'active' AND ca.expires_at > NOW()))
                   -- Действующие сверху, затем недавно истёкшие.
                   ORDER BY (ca.status = 'active' AND ca.expires_at > NOW()) DESC,
                            ca.expires_at DESC)
             FROM client_addons ca
             JOIN features f ON f.id = ca.feature_id
            WHERE ca.client_id = c.id) AS addons,
          -- ⚠️ КТО ВЕДЁТ и КТО ПРИВЁЛ (23.09.2026) — РАЗНЫЕ люди и разные
          -- деньги: ведущему идёт фикс за обслуживание, приведшему 10 %
          -- навсегда. В одной колонке их путали бы.
          c.tech_specialist_id,
          ownc.name AS tech_owner_name,
          (SELECT ts_r.id FROM tech_specialists ts_r
            WHERE ts_r.client_id = c.referred_by_client_id) AS referrer_spec_id,
          refc.name AS referrer_name,
          (SELECT COUNT(*) FROM events e WHERE EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id AND eo.client_id=c.id AND eo.status='accepted')) AS events_count,
          (SELECT COUNT(*) FROM contacts ct WHERE ct.client_id = c.id AND ct.is_active = TRUE) AS contacts_count,
          (SELECT COUNT(*) FROM client_channels cc
            JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = c.id AND ch.is_system = FALSE) AS own_channels_count,
          (SELECT COUNT(*) FROM platform_user_channels puc
             JOIN client_channels cc ON cc.id = puc.client_channel_id
            WHERE cc.client_id = c.id AND puc.is_unsubscribed = FALSE) AS subscribers_count,
          (SELECT COUNT(*) FROM platform_user_channels puc
             JOIN client_channels cc ON cc.id = puc.client_channel_id
            WHERE cc.client_id = c.id AND puc.is_unsubscribed = TRUE) AS unsubscribed_count,
          (SELECT COUNT(*) FROM collaborators co
            JOIN contacts ct ON ct.id = co.contact_id
            WHERE ct.client_id = c.id) AS collaborators_count,
          -- Разбивка подписчиков ПО КАЖДОМУ не-системному каналу клиента
          -- (для тултипа «?»): платформа, ник/название, подписаны, отписались.
          (SELECT json_agg(json_build_object(
                     'platform', ch.platform_slug,
                     'name', COALESCE(NULLIF(ch.handle,''), ch.display_name),
                     'subscribed', (SELECT COUNT(*) FROM platform_user_channels puc
                                      WHERE puc.client_channel_id = cc.id AND puc.is_unsubscribed = FALSE),
                     'unsubscribed', (SELECT COUNT(*) FROM platform_user_channels puc
                                        WHERE puc.client_channel_id = cc.id AND puc.is_unsubscribed = TRUE))
                     ORDER BY ch.platform_slug, ch.id)
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = c.id AND ch.is_system = FALSE) AS channels_breakdown,
          -- Акцепты правовых документов (миграции 315, 319): по ним видно,
          -- с какой редакцией согласился клиент и можно ли ему платить
          -- партнёрское вознаграждение.
          c.offer_accepted_at, c.offer_accepted_version,
          c.privacy_consent_at,
          c.partner_offer_accepted_at, c.partner_tax_status,
          -- ⚠️ Тестовый кабинет техспеца (миграция 403) — бейджем в списке:
          -- иначе он неотличим от живого клиента, и его берут в работу.
          c.is_tech_test
        FROM clients c
        LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
        LEFT JOIN tariffs t ON t.id = cs.tariff_id
        -- Имена внедренцев: у роли своего имени нет, оно у клиента под ней.
        LEFT JOIN tech_specialists own ON own.id = c.tech_specialist_id
        LEFT JOIN clients ownc ON ownc.id = own.client_id
        LEFT JOIN tech_specialists refs ON refs.client_id = c.referred_by_client_id
        LEFT JOIN clients refc ON refc.id = refs.client_id
        WHERE {where}
        ORDER BY {order_by}
        LIMIT ${len(params)-1} OFFSET ${len(params)}
        """,
        *params
    )
    total = await db.fetchval(f"SELECT COUNT(*) FROM clients c WHERE {where}", *params[:-2])
    result = []
    for c in clients:
        d = dict(c)
        # ⚠️⚠️ JSONB из asyncpg приходит СТРОКОЙ — её обязан разобрать каждый
        # json_agg в этом запросе. `addons` добавили позже `channels_breakdown`
        # и разбор дописать забыли: фронт получал текст вместо массива, падал
        # на `(c.addons || []).map is not a function`, и ВЕСЬ раздел «Клиенты»
        # в админке открывался белым экраном (16.09.2026).
        #
        # ⚠️ Новый json_agg в этом SELECT — сразу добавлять в список ниже,
        # иначе админка ляжет так же и причина будет видна только в консоли
        # браузера: в логах сервера при этом ЧИСТО, запрос отдаёт 200.
        for _f in ("channels_breakdown", "addons"):
            raw = d.get(_f)
            d[_f] = json.loads(raw) if isinstance(raw, str) else (raw or [])
        result.append(d)
    return {"clients": result, "total": total}


# Сегменты клиентов платформы → теги в базе получателя.
# Владелец платформы рассылает по клиентам ПЛЮСОНа СВОИМ ботом (у сервисного
# @pluson_bot почти нет подписчиков — люди приходили через бот Марго).
# Поэтому сегмент материализуется тегом на contacts ЦЕЛЕВОГО клиента, а рассылка
# потом фильтруется по этому тегу штатным движком (миграция 265).
SEGMENT_TAGS = {
    "plusson:no_sub":      "Нет активной подписки",
    "plusson:sub_no_bot":  "Есть подписка, нет своего бота",
    "plusson:sub_and_bot": "Есть подписка и свой бот",
    "plusson:in_collab":   "В Коллабораторной",
}


class SyncSegmentTagsRequest(BaseModel):
    # В чью базу писать теги (contacts.client_id). Обычно 1 — кабинет владельца.
    target_client_id: int
    # Исключить самих себя/сервисный аккаунт и тестовые записи.
    exclude_client_ids: list[int] = [1, 3]


@router.post("/clients/sync-segment-tags", summary="Проставить теги сегментов клиентов в базу контактов")
async def sync_segment_tags(
    data: SyncSegmentTagsRequest,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Размечает контакты тегами plusson:* по текущему состоянию клиентов.

    Матчинг клиент→контакт идёт по email, телефону и TG-нику — только по этим
    трём ключам. По ИМЕНИ не сопоставляем принципиально: в базе десятки «Ирин»
    и «Татьян», совпадение по имени привело бы к рассылке чужому человеку.

    Сегмент один на человека (взаимоисключающие): при двух кабинетах у одного
    человека выигрывает более «продвинутый» (с ботом > без бота > без подписки),
    иначе он получил бы два противоречащих письма.

    Идемпотентно: старые plusson:*-теги снимаются и проставляются заново,
    прочие теги контакта не трогаются.
    """
    target = int(data.target_client_id)
    excl = list(data.exclude_client_ids or [])
    async with db.transaction():
        rows = await db.fetch(
            """
            WITH seg AS (
              SELECT c.id AS client_id, c.email, c.telegram_username, c.phone,
                CASE
                  WHEN (c.is_published_in_hub = TRUE OR EXISTS (
                          SELECT 1 FROM client_addons ca JOIN features f ON f.id = ca.feature_id
                          WHERE ca.client_id = c.id AND f.slug='collab_hub' AND ca.status='active'))
                    THEN 'plusson:in_collab'
                  WHEN NOT EXISTS (SELECT 1 FROM client_subscriptions cs
                          WHERE cs.id = c.current_subscription_id
                            AND cs.status='active' AND cs.expires_at > NOW())
                    THEN 'plusson:no_sub'
                  WHEN NOT EXISTS (SELECT 1 FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
                          WHERE cc.client_id = c.id AND ch.is_system = FALSE
                            AND ch.bot_token IS NOT NULL AND ch.bot_token <> '')
                    THEN 'plusson:sub_no_bot'
                  ELSE 'plusson:sub_and_bot'
                END AS tag
              FROM clients c
              WHERE c.is_active = TRUE
                AND NOT (c.id = ANY($2::int[]))
                AND c.name NOT ILIKE 'ТЕСТ %'
                AND c.email NOT LIKE '%@hub.local'
            ), m AS (
              SELECT ct.id AS contact_id, s.tag,
                     CASE s.tag WHEN 'plusson:in_collab' THEN 0
                                WHEN 'plusson:sub_and_bot' THEN 1
                                WHEN 'plusson:sub_no_bot' THEN 2 ELSE 3 END AS prio
              FROM seg s
              JOIN contacts ct ON ct.client_id = $1 AND (
                    lower(ct.email) = lower(s.email)
                 OR (COALESCE(s.phone,'') <> '' AND COALESCE(ct.phone,'') <> ''
                     AND regexp_replace(ct.phone,'[^0-9]','','g') = regexp_replace(s.phone,'[^0-9]','','g'))
                 OR (COALESCE(s.telegram_username,'') <> '' AND EXISTS (
                        SELECT 1 FROM platform_users pu WHERE pu.contact_id = ct.id
                          AND pu.platform_slug='telegram'
                          AND lower(pu.username) = lower(regexp_replace(s.telegram_username,'^@|.*/','','g')))))
            )
            SELECT DISTINCT ON (contact_id) contact_id, tag FROM m ORDER BY contact_id, prio
            """,
            target, excl,
        )
        # Снимаем прежние plusson:* — иначе при смене сегмента у человека
        # остался бы старый тег и он попал бы в обе рассылки.
        await db.execute(
            """
            UPDATE contacts SET tags = COALESCE((
                SELECT jsonb_agg(e) FROM jsonb_array_elements_text(tags) e
                 WHERE e NOT LIKE 'plusson:%'), '[]'::jsonb)
             WHERE client_id = $1 AND jsonb_typeof(tags)='array' AND tags::text LIKE '%plusson:%'
            """,
            target,
        )
        for r in rows:
            await db.execute(
                """
                UPDATE contacts SET tags = COALESCE((
                    SELECT jsonb_agg(DISTINCT e) FROM jsonb_array_elements_text(
                      (CASE WHEN jsonb_typeof(tags)='array' THEN tags ELSE '[]'::jsonb END)
                      || to_jsonb(ARRAY[$2::text])) e), to_jsonb(ARRAY[$2::text]))
                 WHERE id = $1
                """,
                r["contact_id"], r["tag"],
            )
    stats: dict = {}
    for r in rows:
        stats[r["tag"]] = stats.get(r["tag"], 0) + 1
    return {"ok": True, "tagged": len(rows), "by_segment": stats, "labels": SEGMENT_TAGS}


@router.get("/clients/{client_id}", summary="Клиент по ID")
async def get_client(
    client_id: int,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    client = await db.fetchrow(
        """
        SELECT c.*, COUNT(DISTINCT e.id) as events_count
        FROM clients c
        LEFT JOIN events e ON EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id AND eo.client_id=c.id AND eo.status='accepted')
        WHERE c.id = $1
        GROUP BY c.id
        """,
        client_id
    )
    if not client:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    return {"client": dict(client)}


@router.get("/clients/{client_id}/billing", summary="Подписка и модули клиента")
async def client_billing(
    client_id: int,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Всё о доступах клиента ОДНИМ ответом: подписка в днях и деньгах + модули.

    ⚠️⚠️ ЗАЧЕМ. Окно управления показывало только кнопки тарифов и поле «срок
    в днях» с пояснением про пересчёт остатка — но САМОГО остатка нигде не
    было: ни сколько дней прошло, ни сколько осталось, ни за какие деньги.
    Решение принималось вслепую. Про модули не было вовсе ни слова, хотя
    подключать их нужно так же часто, как менять тариф.

    ⚠️ Пересчёт считаем ТОЙ ЖЕ `recalc_days`, что применяется при смене
    тарифа: показанная цифра обязана совпасть с тем, что реально произойдёт.
    """
    from app.services.contact_limits import recalc_days

    sub = await db.fetchrow(
        """SELECT cs.id, cs.started_at, cs.expires_at, cs.status, cs.source,
                  t.slug, t.name, t.price
             FROM client_subscriptions cs
             JOIN tariffs t ON t.id = cs.tariff_id
            WHERE cs.id = (SELECT current_subscription_id FROM clients WHERE id = $1)""",
        client_id,
    )

    now = datetime.now(timezone.utc)
    days_left = days_used = 0
    if sub:
        if sub["expires_at"]:
            days_left = max(0, math.ceil((sub["expires_at"] - now).total_seconds() / 86400))
        if sub["started_at"]:
            days_used = max(0, int((now - sub["started_at"]).total_seconds() // 86400))

    # Во что превратится остаток при переходе на каждый из тарифов — чтобы
    # админ видел последствия ДО нажатия, а не после.
    tariffs = await db.fetch(
        "SELECT slug, name, price FROM tariffs ORDER BY price"
    )
    old_price = float(sub["price"] or 0) if sub else 0
    preview = [
        {
            "slug": t["slug"], "name": t["name"], "price": float(t["price"] or 0),
            "days_after": recalc_days(days_left, old_price, float(t["price"] or 0)),
            "current": bool(sub and t["slug"] == sub["slug"]),
        }
        for t in tariffs
    ]

    # Модули: и купленные (активные), и те, что можно подключить.
    addons = await db.fetch(
        """SELECT ca.id, ca.status, ca.started_at, ca.expires_at, ca.price, ca.months,
                  f.slug, f.name
             FROM client_addons ca
             JOIN features f ON f.id = ca.feature_id
            WHERE ca.client_id = $1
            ORDER BY (ca.status = 'active' AND ca.expires_at > NOW()) DESC, ca.expires_at DESC""",
        client_id,
    )
    available = await db.fetch(
        "SELECT slug, name, price_monthly FROM features WHERE is_addon = TRUE ORDER BY name"
    )

    return {
        "subscription": ({
            "tariff_slug": sub["slug"], "tariff_name": sub["name"],
            "price": float(sub["price"] or 0),
            "status": sub["status"], "source": sub["source"],
            "started_at": sub["started_at"], "expires_at": sub["expires_at"],
            "days_left": days_left, "days_used": days_used,
        } if sub else None),
        "tariffs": preview,
        "addons": [dict(a) for a in addons],
        "available_addons": [dict(a) for a in available],
    }


class AddonGrant(BaseModel):
    feature_slug: str
    days: int = 30


@router.post("/clients/{client_id}/addons", summary="Подключить/продлить модуль")
async def grant_addon(
    client_id: int,
    data: AddonGrant,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Выдаёт клиенту модуль на N дней. Уже есть активный — ПРОДЛЕВАЕТ его.

    ⚠️ Один активный модуль на (клиент, фича) — как при обычной покупке: там
    продление тоже делает UPDATE, а не вторую строку. Иначе у клиента
    оказались бы две записи с разными сроками, и какой из них верить —
    непонятно.
    """
    feat = await db.fetchrow(
        "SELECT id, name FROM features WHERE slug = $1 AND is_addon = TRUE",
        data.feature_slug,
    )
    if not feat:
        raise HTTPException(404, "Модуль не найден")
    days = max(1, min(int(data.days or 30), 3650))

    # ⚠️ Выдача/продление — ТОЛЬКО через общий grant_addon (см. его докстринг).
    # Своя копия падала на уникальном индексе, если у клиента оставалась истёкшая
    # строка со статусом 'active': выдача модуля из админки отваливалась ошибкой.
    # ⚠️ add_months=0 и price=None — ручная выдача не деньги, в отчёт по выручке
    # она попадать не должна.
    row = await grant_addon(
        db,
        client_id=client_id,
        feature_id=feat["id"],
        days=days,
        source="admin",
        add_months=0,
    )
    logger.info("admin %s granted addon %s to client %s for %s days",
                admin.get("sub"), data.feature_slug, client_id, days)
    return {"ok": True, "expires_at": row["expires_at"], "name": feat["name"]}


@router.delete("/clients/{client_id}/addons/{feature_slug}", summary="Отключить модуль")
async def revoke_addon(
    client_id: int,
    feature_slug: str,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Гасит активный модуль.

    ⚠️ Помечаем `expired`, а не удаляем строку: история покупок нужна — по ней
    видно, что клиент платил за модуль, даже если сейчас доступа нет.
    """
    res = await db.execute(
        """UPDATE client_addons ca
              SET status = 'expired', expires_at = NOW(), updated_at = NOW()
             FROM features f
            WHERE f.id = ca.feature_id AND f.slug = $2
              AND ca.client_id = $1 AND ca.status = 'active'""",
        client_id, feature_slug,
    )
    if res == "UPDATE 0":
        raise HTTPException(404, "Активный модуль не найден")
    logger.info("admin %s revoked addon %s from client %s",
                admin.get("sub"), feature_slug, client_id)
    return {"ok": True}


@router.patch("/clients/{client_id}", summary="Обновить клиента")
async def update_client(
    client_id: int,
    is_active: Optional[bool] = None,
    tariff_slug: Optional[str] = None,
    tariff_days: Optional[int] = None,
    collab_hub_blocked: Optional[bool] = None,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    if is_active is not None:
        await db.execute("UPDATE clients SET is_active = $1 WHERE id = $2", is_active, client_id)
    # Запрет покупки Коллабораторной (миграция 228) — ставит админ, действует глобально
    if collab_hub_blocked is not None:
        await db.execute(
            "UPDATE clients SET collab_hub_blocked = $1 WHERE id = $2",
            collab_hub_blocked, client_id
        )
    if tariff_slug:
        # Перевод на другой тариф: помечаем активную подписку expired,
        # создаём новую подписку с этим тарифом на default_duration_days, source='admin'.
        tariff = await db.fetchrow(
            "SELECT id, default_duration_days, price FROM tariffs WHERE slug = $1", tariff_slug
        )
        if not tariff:
            raise HTTPException(status_code=400, detail=f"Тариф '{tariff_slug}' не найден")
        # Сколько дней ставить.
        #
        # ⚠️ По умолчанию срок НЕ начинается заново, а пересчитывается из
        # остатка текущей подписки по формуле п. 3.9.1 Оферты:
        #   осталось дней × цена прежнего Тарифа ÷ цена нового.
        # Это нужно при обратном переходе на прежний Тариф (п. 3.9.3): клиент
        # почистил базу и просит вернуть Профи — дни, прожитые на Экстра, ему
        # не возвращаются, а остаток пересчитывается. Без пересчёта админ молча
        # дарил бы полные 30 дней вместо положенного остатка.
        #
        # `tariff_days` — явный срок, если админ хочет задать своё число
        # (выдача доступа, компенсация). Тогда пересчёт не применяется.
        if tariff_days and tariff_days > 0:
            days = int(tariff_days)
        else:
            cur = await db.fetchrow(
                """SELECT cs.expires_at, t.price
                     FROM client_subscriptions cs
                     JOIN tariffs t ON t.id = cs.tariff_id
                    WHERE cs.id = (SELECT current_subscription_id FROM clients WHERE id = $1)
                      AND cs.status = 'active' AND cs.expires_at > NOW()""",
                client_id,
            )
            days = tariff["default_duration_days"] or 30
            if cur and cur["price"] and tariff["price"]:
                from app.services.contact_limits import recalc_days
                left = await db.fetchval(
                    "SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM ($1::timestamptz - NOW())) / 86400))",
                    cur["expires_at"],
                )
                if left and int(left) > 0:
                    days = recalc_days(int(left), cur["price"], tariff["price"])
        async with db.transaction():
            await db.execute(
                """UPDATE client_subscriptions SET status='expired', updated_at=NOW()
                    WHERE client_id=$1 AND status='active'""",
                client_id,
            )
            new_sub_id = await db.fetchval(
                """INSERT INTO client_subscriptions
                     (client_id, tariff_id, started_at, expires_at, status, source)
                   VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval, 'active', 'admin')
                   RETURNING id""",
                client_id, tariff["id"], str(days),
            )
            await db.execute(
                "UPDATE clients SET current_subscription_id = $1 WHERE id = $2",
                new_sub_id, client_id,
            )
    return {"message": "Обновлено"}


# ─── Удаление клиента ─────────────────────────────────────────────────────────
#
# ⚠️⚠️ САМОЕ РАЗРУШИТЕЛЬНОЕ ДЕЙСТВИЕ В СИСТЕМЕ. Вместе с клиентом уходят его
# события, контакты, рассылки, воронки, продукты, боты и файлы — восстановить
# можно только из ночного дампа. Поэтому:
#   * подтверждение — ВВОД СЛОВА, а не «ок» в окне (случайно не наберёшь);
#   * перед удалением показываем, ЧТО именно исчезнет (эндпоинт preview);
#   * системный клиент и клиент с id=1 (владелец платформы) не удаляются вовсе.

DELETE_CONFIRM_WORD = "ПОДТВЕРДИТЬ"


async def _client_delete_summary(db, client_id: int) -> dict:
    """Что исчезнет вместе с клиентом. Только чтение."""
    row = await db.fetchrow(
        """
        SELECT c.id, c.name, c.email, c.is_system_service,
               (SELECT count(*) FROM event_owners eo WHERE eo.client_id = c.id)      AS events,
               (SELECT count(*) FROM contacts ct WHERE ct.client_id = c.id)          AS contacts,
               -- ⚠️ БОТЫ И ПОЧТА — РАЗНЫЕ СТРОКИ, хотя в БД лежат одной
               -- таблицей `channels`. Раньше считались все записи разом, и окно
               -- писало «Подключённые боты: 1» человеку без единого бота: это
               -- был СИСТЕМНЫЙ email-канал ПЛЮСОНа, который привязывается
               -- каждому клиенту сам при регистрации. Почта ботом не является.
               --
               -- Боты — свои каналы клиента, кроме почтовых.
               (SELECT count(*) FROM client_channels cc
                  JOIN channels ch ON ch.id = cc.channel_id
                 WHERE cc.client_id = c.id AND ch.is_system = FALSE
                   AND ch.platform_slug <> 'email')                                  AS channels,
               -- ⚠️ Почта считается подключённой, только когда у клиента СВОЙ
               -- почтовый домен (`client_domains.kind='mail'`). Системный канал
               -- есть у всех и ничего про клиента не говорит — показывать его
               -- как «подключено» значит обещать удаление того, чего у него нет.
               (SELECT count(*) FROM client_domains cd
                 WHERE cd.client_id = c.id AND cd.kind = 'mail')                     AS mail_domains,
               (SELECT count(*) FROM client_files cf WHERE cf.client_id = c.id)      AS files,
               (SELECT count(*) FROM products p WHERE p.client_id = c.id)            AS products,
               (SELECT count(*) FROM lead_magnets lm WHERE lm.client_id = c.id)      AS lead_magnets,
               (SELECT count(*) FROM broadcast_schedules bs WHERE bs.client_id = c.id) AS broadcasts,
               (SELECT count(*) FROM direct_messages dm WHERE dm.client_id = c.id)   AS messages,
               (SELECT count(*) FROM clients r WHERE r.referred_by_client_id = c.id) AS referred,
               (SELECT COALESCE(SUM(cf.size_bytes), 0) FROM client_files cf
                 WHERE cf.client_id = c.id)                                          AS storage_bytes
          FROM clients c WHERE c.id = $1
        """,
        client_id,
    )
    if not row:
        raise HTTPException(404, "Клиент не найден")

    d = dict(row)
    # ⚠️ Событие принадлежит клиенту через event_owners, своего client_id у него
    # нет. Значит каскад снесёт только владение, а САМО событие останется
    # сиротой — его надо удалять отдельно, и только если других владельцев нет
    # (у коллаб-события их несколько, и оно должно остаться живым у партнёров).
    d["events_to_delete"] = await db.fetchval(
        """SELECT count(*) FROM events e
            WHERE EXISTS (SELECT 1 FROM event_owners eo
                           WHERE eo.event_id = e.id AND eo.client_id = $1)
              AND NOT EXISTS (SELECT 1 FROM event_owners eo2
                               WHERE eo2.event_id = e.id AND eo2.client_id <> $1)""",
        client_id,
    )
    d["events_shared"] = int(d["events"]) - int(d["events_to_delete"])
    # Кого нельзя удалять ни при каких условиях.
    d["protected"] = bool(row["is_system_service"]) or client_id == 1
    return d


@router.get("/clients/{client_id}/delete-preview", summary="Что исчезнет вместе с клиентом")
async def client_delete_preview(
    client_id: int,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Показывает объём потерь ДО удаления.

    ⚠️ Нужен именно перед удалением: по одному имени в списке невозможно
    понять, это пустой тестовый кабинет или клиент с базой в семь тысяч
    контактов. Цифры отрезвляют лучше любого предупреждения.
    """
    return await _client_delete_summary(db, client_id)


class ClientDeleteRequest(BaseModel):
    confirm: str


@router.delete("/clients/{client_id}", summary="Удалить клиента")
async def delete_client(
    client_id: int,
    confirm: Optional[str] = None,
    data: Optional[ClientDeleteRequest] = None,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Удаляет клиента со всеми его данными. Подтверждение — слово «ПОДТВЕРДИТЬ».

    ⚠️ Слово проверяется НА СЕРВЕРЕ, а не только в окне браузера: запрос
    легко повторить мимо интерфейса, и тогда защита не значила бы ничего.

    ⚠️ Принимаем слово и телом, и параметром адреса: тело у DELETE поддержано
    не везде (промежуточные прокси его иногда режут), а терять подтверждение
    на ровном месте нельзя — тогда удаление просто не сработает.
    """
    word = (confirm or (data.confirm if data else "") or "").strip().upper()
    summary = await _client_delete_summary(db, client_id)

    if summary["protected"]:
        raise HTTPException(
            400,
            "Этого клиента удалить нельзя: это владелец платформы или системный "
            "сервисный аккаунт — на нём держатся общие боты и рассылки",
        )

    # ⚠️⚠️ КЛИЕНТА С РОЛЬЮ ВНЕДРЕНЦА УДАЛЯТЬ НЕЛЬЗЯ (решение владельца
    # 22.09.2026, миграция 486). Кабинет клиента — рабочий инструмент
    # внедренца: на нём тестовое задание и уроки, оттуда он берёт ссылки для
    # приглашений. А главное — на роли висит история начислений, то есть деньги.
    #
    # ⚠️ Проверяем ДО подтверждающего слова: человек не должен вводить
    # «ПОДТВЕРДИТЬ», чтобы затем узнать, что удаление всё равно запрещено.
    #
    # ⚠️ В базе тот же запрет стоит вторым слоем — `tech_specialists.client_id`
    # объявлен ON DELETE RESTRICT. Здесь он нужен ради внятного текста: иначе
    # админ получил бы 500 по нарушенному внешнему ключу.
    spec = await db.fetchrow(
        "SELECT id, is_active FROM tech_specialists WHERE client_id = $1", client_id)
    if spec:
        raise HTTPException(400, (
            "Этот клиент — внедренец, его кабинет удалить нельзя: это его рабочий "
            "инструмент, и на нём висит история начислений. Сначала снимите роль "
            "внедренца в разделе «Внедренцы» — или просто увольте его, тогда "
            "кабинет внедренца закроется, а клиентский останется."
        ))

    if word != DELETE_CONFIRM_WORD:
        raise HTTPException(
            400, f"Для удаления введите слово {DELETE_CONFIRM_WORD}"
        )

    # ⚠️ Ключи файлов забираем ДО удаления: строки уйдут каскадом, а сами файлы
    # в хранилище останутся навсегда занимать место — их надо стереть отдельно.
    # Читаем заранее, потому что после транзакции узнать их будет неоткуда.
    file_keys = [
        r["r2_key"] for r in await db.fetch(
            "SELECT r2_key FROM client_files WHERE client_id = $1 AND r2_key <> ''",
            client_id,
        )
    ]

    async with db.transaction():
        # 1. Боты клиента. ⚠️ У client_channels внешний ключ БЕЗ каскада
        #    (NO ACTION) — без этой строки удаление просто падало бы с ошибкой
        #    внешнего ключа у ЛЮБОГО клиента: канал есть у всех.
        await db.execute("DELETE FROM client_channels WHERE client_id = $1", client_id)

        # 2. События, где он ЕДИНСТВЕННЫЙ владелец.
        #    ⚠️ Коллаб-события с другими организаторами НЕ трогаем: событие
        #    общее, партнёры продолжают его вести. Уйдёт только его владение.
        deleted_events = await db.fetch(
            """DELETE FROM events e
                WHERE EXISTS (SELECT 1 FROM event_owners eo
                               WHERE eo.event_id = e.id AND eo.client_id = $1)
                  AND NOT EXISTS (SELECT 1 FROM event_owners eo2
                                   WHERE eo2.event_id = e.id AND eo2.client_id <> $1)
              RETURNING e.id""",
            client_id,
        )

        # 3. ⚠️⚠️ КАРТОЧКИ КОЛЛАБА ЕГО КОНТАКТОВ — ДО удаления клиента.
        #
        #    Без этой строки удаление ПАДАЛО у любого клиента, у которого есть
        #    карточка коллаба, — а она заводится сама (self_collaborator_id),
        #    чтобы клиент мог добавлять себя в свои события.
        #
        #    Причина — противоречие в схеме: внешний ключ на контакт объявлен
        #    `ON DELETE SET NULL`, а сама колонка `contact_id` — `NOT NULL`.
        #    Каскад от клиента доходит до контактов, база обязана обнулить
        #    ссылку в карточке и тут же сама себе это запрещает:
        #    «null value in column "contact_id" violates not-null constraint».
        #
        #    ⚠️ Каскадом карточки НЕ уйдут: у `collaborators` нет `client_id`
        #    вовсе, а обе связи с `clients` (`linked_client_id`,
        #    `created_by_client_id`) — тоже SET NULL. Принадлежность клиенту
        #    выражена ТОЛЬКО через контакт, поэтому и удаляем по контактам.
        await db.execute(
            """DELETE FROM collaborators
                WHERE contact_id IN (SELECT id FROM contacts WHERE client_id = $1)""",
            client_id,
        )

        # 4. Сам клиент — остальное уйдёт каскадом (контакты, рассылки,
        #    воронки, продукты, файлы, подписки, диалоги и прочее).
        await db.execute("DELETE FROM clients WHERE id = $1", client_id)

    # 4. Файлы в хранилище — ПОСЛЕ транзакции.
    # ⚠️ Не внутри: удаление в облаке идёт по сети и необратимо. Сорвись
    # транзакция после него — клиент остался бы в базе, но уже без файлов.
    # И сбой чистки не должен отменять удаление: клиента уже нет, а мусорные
    # файлы — это лишь занятое место, о котором мы пишем в лог.
    files_deleted = 0
    if file_keys:
        from app.services import r2_storage
        for key in file_keys:
            try:
                await r2_storage.delete_object(key)
                files_deleted += 1
            except Exception as e:  # noqa: BLE001
                import logging
                logging.getLogger(__name__).warning(
                    "удаление клиента %s: файл %s не стёрт — %s", client_id, key, e
                )

    return {
        "message": f"Клиент «{summary['name']}» удалён",
        "deleted_events": len(deleted_events),
        "kept_shared_events": summary["events_shared"],
        "deleted_contacts": summary["contacts"],
        "deleted_files": files_deleted,
    }


# ─── Партнёры ─────────────────────────────────────────────────────────────────

class PartnerCreate(BaseModel):
    name: str
    partner_code: str
    percent: float = 0
    contact: Optional[str] = None
    notes: Optional[str] = None


@router.get("/partners", summary="Список партнёров")
async def list_partners(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    partners = await db.fetch(
        """
        SELECT p.*, COUNT(c.id) as clients_count
        FROM partners p
        LEFT JOIN clients c ON c.partner_code = p.partner_code
        GROUP BY p.id
        ORDER BY p.created_at DESC
        """
    )
    return {"partners": [dict(p) for p in partners]}


@router.post("/partners", summary="Создать партнёра")
async def create_partner(
    data: PartnerCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    existing = await db.fetchrow("SELECT id FROM partners WHERE partner_code = $1", data.partner_code)
    if existing:
        raise HTTPException(status_code=409, detail="Такой код уже существует")

    partner = await db.fetchrow(
        """
        INSERT INTO partners (name, partner_code, percent, contact, notes)
        VALUES ($1,$2,$3,$4,$5) RETURNING *
        """,
        data.name, data.partner_code.upper(), data.percent, data.contact, data.notes
    )
    return {"partner": dict(partner)}


# ─── Тарифы ───────────────────────────────────────────────────────────────────

class TariffCreate(BaseModel):
    slug: str
    name: str
    price: float = 0
    contact_limit: int = 1000
    broadcasts_daily_limit: Optional[int] = None  # NULL = безлимит
    default_duration_days: int = 30
    feature_slugs: list[str] = []
    prodamus_payment_url: Optional[str] = None
    leadpay_product_id: Optional[str] = None
    promo_banner_text: Optional[str] = None
    promo_old_price: Optional[float] = None


class TariffUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    contact_limit: Optional[int] = None
    broadcasts_daily_limit: Optional[int] = None  # ВНИМАНИЕ: чтобы поставить NULL (безлимит), передавать explicit null невозможно через эту схему — see endpoint
    default_duration_days: Optional[int] = None
    feature_slugs: Optional[list[str]] = None
    is_active: Optional[bool] = None
    prodamus_payment_url: Optional[str] = None
    leadpay_product_id: Optional[str] = None
    promo_banner_text: Optional[str] = None
    promo_old_price: Optional[float] = None


@router.get("/tariffs", summary="Список тарифов")
async def list_tariffs(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    tariffs = await db.fetch(
        """SELECT t.*,
                  ARRAY(SELECT f.slug FROM tariff_features tf
                          JOIN features f ON f.id = tf.feature_id
                         WHERE tf.tariff_id = t.id
                         ORDER BY f.sort) AS feature_slugs
             FROM tariffs t
            ORDER BY t.price"""
    )
    return {"tariffs": [dict(t) for t in tariffs]}


async def _mirror_pro_features_to_trial(db, changed_tariff_id: int) -> None:
    """Тариф `trial` ВСЕГДА имеет те же фичи, что `business_beta`.

    ⚠️⚠️ РАНЬШЕ ЗЕРКАЛИЛИ ПОД `pro`, и это отменено (решение владельца
    11.09.2026, миграция 404). Триал — витрина платформы: человек должен
    увидеть всё, за что потом платит. На Профи половина разделов стояла под
    замком, и попробовать их было нельзя — то есть триал не показывал того,
    что продаёт. Живой случай: у клиента на триале решение «Розыгрыш через
    анкету» просило Экстру, потому что `surveys` в триал не входили.

    ⚠️ Имя функции оставлено прежним намеренно: его знают три точки вызова, а
    переименование ради слова `pro` в названии ничего не даёт. Смысл описан
    здесь.

    ⚠️ Лишние фичи у trial НЕ снимаем: Коллабораторная (`collab_hub`) выдаётся
    ему отдельной строкой, хотя это модуль-аддон и в Бизнес он не входит. На
    триале её тоже надо пощупать, а гаснет она вместе с подпиской — то есть
    ровно на срок триала.
    """
    base = await db.fetchval("SELECT id FROM tariffs WHERE slug = 'business_beta'")
    trial = await db.fetchval("SELECT id FROM tariffs WHERE slug = 'trial'")
    if not base or not trial or changed_tariff_id != base:
        return
    await db.execute(
        """INSERT INTO tariff_features (tariff_id, feature_id)
           SELECT $1, tf.feature_id FROM tariff_features tf
            WHERE tf.tariff_id = $2
           ON CONFLICT DO NOTHING""",
        trial, base,
    )


@router.post("/tariffs", summary="Создать тариф")
async def create_tariff(
    data: TariffCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    tariff = await db.fetchrow(
        """
        INSERT INTO tariffs (
            slug, name, price, contact_limit, broadcasts_daily_limit, default_duration_days,
            prodamus_payment_url, leadpay_product_id, promo_banner_text, promo_old_price
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
        """,
        data.slug, data.name, data.price,
        data.contact_limit, data.broadcasts_daily_limit, data.default_duration_days,
        data.prodamus_payment_url, data.leadpay_product_id, data.promo_banner_text, data.promo_old_price,
    )
    if data.feature_slugs:
        await db.execute(
            """INSERT INTO tariff_features (tariff_id, feature_id)
               SELECT $1, f.id FROM features f WHERE f.slug = ANY($2::text[])""",
            tariff["id"], data.feature_slugs,
        )
    await _mirror_pro_features_to_trial(db, tariff["id"])
    return {"tariff": dict(tariff)}


@router.patch("/tariffs/{tariff_id}", summary="Редактировать тариф")
async def update_tariff(
    tariff_id: int,
    data: TariffUpdate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    # Собираем UPDATE только из непустых полей. Пустая строка для URL/баннера = очистка (NULL).
    sets: list[str] = []
    args: list = []

    def add(column: str, value):
        args.append(value)
        sets.append(f"{column} = ${len(args)}")

    if data.name is not None: add("name", data.name)
    if data.price is not None: add("price", data.price)
    if data.contact_limit is not None: add("contact_limit", data.contact_limit)
    if data.broadcasts_daily_limit is not None: add("broadcasts_daily_limit", data.broadcasts_daily_limit if data.broadcasts_daily_limit > 0 else None)
    if data.default_duration_days is not None: add("default_duration_days", data.default_duration_days)
    if data.is_active is not None: add("is_active", data.is_active)
    if data.prodamus_payment_url is not None:
        add("prodamus_payment_url", data.prodamus_payment_url.strip() or None)
    if data.leadpay_product_id is not None:
        add("leadpay_product_id", data.leadpay_product_id.strip() or None)
    if data.promo_banner_text is not None:
        add("promo_banner_text", data.promo_banner_text.strip() or None)
    if data.promo_old_price is not None:
        # 0 трактуем как "очистить"
        add("promo_old_price", data.promo_old_price if data.promo_old_price > 0 else None)

    if sets:
        args.append(tariff_id)
        row = await db.fetchrow(
            f"UPDATE tariffs SET {', '.join(sets)} WHERE id = ${len(args)} RETURNING *",
            *args,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Тариф не найден")

    # Пересинхронизация фич если передан feature_slugs.
    # ⚠️ ЗАЩИТА ОТ МОЛЧАЛИВОГО СНОСА (2026-07-12). Ниже идёт полный DELETE+INSERT,
    # поэтому сохранение формы с ПУСТЫМ списком вырезает все фичи тарифа разом —
    # у всех клиентов на нём пропадают разделы. Именно так с «Профи» слетели
    # contests и export_contacts. Пустой список при непустом текущем наборе —
    # почти всегда следствие того, что форма не догрузила фичи, а не намерение.
    if data.feature_slugs is not None:
        if not data.feature_slugs:
            has_now = await db.fetchval(
                "SELECT COUNT(*) FROM tariff_features WHERE tariff_id = $1", tariff_id
            )
            if has_now:
                raise HTTPException(
                    status_code=400,
                    detail=("Пустой список фич сотрёт все опции тарифа у всех клиентов. "
                            "Если это правда нужно — снимите фичи по одной."),
                )
        await db.execute("DELETE FROM tariff_features WHERE tariff_id = $1", tariff_id)
        if data.feature_slugs:
            await db.execute(
                """INSERT INTO tariff_features (tariff_id, feature_id)
                   SELECT $1, f.id FROM features f WHERE f.slug = ANY($2::text[])""",
                tariff_id, data.feature_slugs,
            )
        # Правило: trial всегда = pro по фичам (если меняли pro — зеркалим).
        await _mirror_pro_features_to_trial(db, tariff_id)

    tariff = await db.fetchrow(
        """SELECT t.*,
                  ARRAY(SELECT f.slug FROM tariff_features tf
                          JOIN features f ON f.id = tf.feature_id
                         WHERE tf.tariff_id = t.id
                         ORDER BY f.sort) AS feature_slugs
             FROM tariffs t WHERE t.id = $1""",
        tariff_id,
    )
    if not tariff:
        raise HTTPException(status_code=404, detail="Тариф не найден")
    return {"tariff": dict(tariff)}


# ─── Промоакции ───────────────────────────────────────────────────────────────

class PromotionCreate(BaseModel):
    slug: str
    name: str
    description: Optional[str] = None
    type: str  # 'trial_bonus_days'
    value: int
    target_tariff_slug: Optional[str] = None
    max_uses: Optional[int] = None
    starts_at: Optional[str] = None  # ISO 8601
    ends_at: Optional[str] = None
    is_active: bool = True


class PromotionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    value: Optional[int] = None
    target_tariff_slug: Optional[str] = None
    max_uses: Optional[int] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    is_active: Optional[bool] = None


@router.get("/promotions", summary="Список акций")
async def list_promotions(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        """SELECT id, slug, name, description, type, value, target_tariff_slug,
                  max_uses, used_count, starts_at, ends_at, is_active, created_at
             FROM promotions ORDER BY id DESC"""
    )
    return {"promotions": [dict(r) for r in rows]}


@router.post("/promotions", summary="Создать акцию")
async def create_promotion(
    data: PromotionCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    if data.type not in ("trial_bonus_days",):
        raise HTTPException(status_code=400, detail="Неизвестный тип акции")
    from datetime import datetime
    starts = datetime.fromisoformat(data.starts_at) if data.starts_at else None
    ends = datetime.fromisoformat(data.ends_at) if data.ends_at else None
    try:
        row = await db.fetchrow(
            """INSERT INTO promotions
                   (slug, name, description, type, value, target_tariff_slug,
                    max_uses, starts_at, ends_at, is_active)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *""",
            data.slug, data.name, data.description, data.type, data.value,
            data.target_tariff_slug, data.max_uses, starts, ends, data.is_active,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="Slug уже используется")
    return {"promotion": dict(row)}


@router.patch("/promotions/{pid}", summary="Редактировать акцию")
async def update_promotion(
    pid: int,
    data: PromotionUpdate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    sets: list[str] = []
    args: list = []

    def add(col: str, val):
        args.append(val)
        sets.append(f"{col} = ${len(args)}")

    if data.name is not None: add("name", data.name)
    if data.description is not None: add("description", data.description or None)
    if data.value is not None: add("value", data.value)
    if data.target_tariff_slug is not None: add("target_tariff_slug", data.target_tariff_slug or None)
    if data.max_uses is not None: add("max_uses", data.max_uses if data.max_uses > 0 else None)
    if data.is_active is not None: add("is_active", data.is_active)
    if data.starts_at is not None:
        from datetime import datetime
        add("starts_at", datetime.fromisoformat(data.starts_at) if data.starts_at else None)
    if data.ends_at is not None:
        from datetime import datetime
        add("ends_at", datetime.fromisoformat(data.ends_at) if data.ends_at else None)
    if not sets:
        return {"ok": True, "message": "Нечего обновлять"}
    args.append(pid)
    row = await db.fetchrow(
        f"UPDATE promotions SET {', '.join(sets)}, updated_at = NOW() WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Акция не найдена")
    return {"promotion": dict(row)}


@router.delete("/promotions/{pid}", summary="Удалить акцию")
async def delete_promotion(
    pid: int,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    result = await db.execute("DELETE FROM promotions WHERE id = $1", pid)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Акция не найдена")
    return {"ok": True}


@router.get("/features", summary="Список фич (для админки)")
async def list_features(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    # ⚠️ `is_addon` — модуль, продающийся отдельно от тарифа.
    #
    # ⚠️⚠️ `is_connectable` — то, что РЕАЛЬНО подключают клиентам через
    # `client_addons`. Это НЕ то же самое, что `is_addon`: услуга автонастройки
    # (`tg_autosetup`) выдаётся строкой в той же таблице (по промокоду), но
    # модулем не помечена. Фильтр в списке клиентов строится по этому полю —
    # иначе клиент с подключённой услугой не нашёлся бы вовсе.
    rows = await db.fetch(
        """SELECT f.id, f.slug, f.name, f.description, f.sort, f.is_addon,
                  (f.is_addon OR EXISTS (
                      SELECT 1 FROM client_addons ca WHERE ca.feature_id = f.id
                  )) AS is_connectable
             FROM features f ORDER BY f.sort, f.slug"""
    )
    return {"features": [dict(r) for r in rows]}


# ─── Создание администратора (только суперадмин) ──────────────────────────────

class AdminCreate(BaseModel):
    name: str
    email: EmailStr
    password: str
    is_superadmin: bool = False


@router.post("/admins", summary="Создать администратора")
async def create_admin(
    data: AdminCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    if not admin.get("is_superadmin"):
        raise HTTPException(status_code=403, detail="Только суперадмин может создавать администраторов")
    pw_hash = hash_password(data.password)
    new_admin = await db.fetchrow(
        "INSERT INTO admins (name, email, password_hash, is_superadmin) VALUES ($1,$2,$3,$4) RETURNING id, name, email",
        data.name, data.email, pw_hash, data.is_superadmin
    )
    return {"admin": dict(new_admin)}



# ═════════════════════════════════════════════════════════════════════════
# Системные каналы — общие @pluson_bot, MAX, VK для всех клиентов сервиса
# Архитектура G: channels.is_system=TRUE, доступ через client_channels.
# ═════════════════════════════════════════════════════════════════════════

class SystemChannelCreate(BaseModel):
    platform_slug: str          # 'telegram' | 'vk' | 'max'
    display_name: str
    handle: Optional[str] = None
    bot_token: Optional[str] = None  # для telegram


class SystemChannelUpdate(BaseModel):
    display_name: Optional[str] = None
    handle: Optional[str] = None
    bot_token: Optional[str] = None  # менять только в is_test и без подписчиков
    is_test: Optional[bool] = None   # FALSE = выпустить в бой → backfill всем клиентам


class PlussonPlatformsUpdate(BaseModel):
    # Площадки ПЛЮСОНа, которые показываем клиентам. Пустой список допустим —
    # это «не показывать ни одной», у каждого места есть запасной путь на сайт.
    platforms: list[str]


@router.get("/plusson-platforms", summary="Площадки ПЛЮСОНа, которые видят клиенты")
async def get_plusson_platforms(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Что отмечено в админке и что из этого реально работает.

    ⚠️ Одна настройка на ТРИ места сразу: ссылки Плюсоновского подарка,
    «Написать в тех.поддержку» и «Партнёрка ПЛЮСОНа». До миграции 476 каждое
    место решало само — и они разъехались: в подарке ВК был, в партнёрке нет.

    Кроме галочек отдаём факт: заведён ли у платформы бот на этой площадке.
    Галочка без бота ничего не показывает (ссылка вела бы в пустоту), и админ
    должен видеть, почему площадка не появилась.
    """
    from app.services.plusson_platforms import (
        PLATFORM_LABEL, PLATFORM_ORDER, enabled_platforms, platform_channels,
    )
    enabled = set(await enabled_platforms(db))
    live = {c["slug"]: c for c in await platform_channels(db)}
    # Бот есть, даже если площадка выключена, — иначе админ не поймёт, можно ли
    # её включать. Спрашиваем по всем площадкам сразу, одним запросом.
    bots = await db.fetch(
        """SELECT DISTINCT ON (ch.platform_slug) ch.platform_slug, ch.handle
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
             JOIN clients cl ON cl.id = cc.client_id
            WHERE ch.platform_slug = ANY($1::text[])
              AND COALESCE(ch.handle, '') <> ''
              AND COALESCE(ch.bot_token, '') <> ''
            ORDER BY ch.platform_slug, cl.is_system_service DESC,
                     cc.is_active DESC, ch.id""",
        list(PLATFORM_ORDER),
    )
    handles = {r["platform_slug"]: (r["handle"] or "").lstrip("@") for r in bots}
    return {"items": [{
        "slug": p,
        "label": PLATFORM_LABEL.get(p, p),
        "enabled": p in enabled,
        "has_bot": bool(handles.get(p)) or p == "telegram",
        "handle": handles.get(p) or ("pluson_bot" if p == "telegram" else ""),
        "shown": p in live,
    } for p in PLATFORM_ORDER]}


@router.patch("/plusson-platforms", summary="Изменить набор площадок ПЛЮСОНа")
async def set_plusson_platforms(
    data: PlussonPlatformsUpdate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Сохранить галочки. Действует сразу во всех трёх местах, без пересборки."""
    from app.services.plusson_platforms import PLATFORM_ORDER
    bad = [p for p in data.platforms if p not in PLATFORM_ORDER]
    if bad:
        raise HTTPException(400, f"Неизвестные площадки: {', '.join(bad)}")
    # Порядок нормализуем сразу: в базе лежит тот же порядок, что и на экране.
    value = [p for p in PLATFORM_ORDER if p in set(data.platforms)]
    await db.execute(
        "UPDATE platform_settings SET plusson_platforms = $1::text[], updated_at = NOW() WHERE id = 1",
        value,
    )
    return {"ok": True, "platforms": value}


@router.get("/system-channels", summary="Список системных каналов с метриками")
async def list_system_channels(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Системные каналы (общие для всех клиентов).

    Для каждого: общее число подписок (по всем клиентам), отписавшихся,
    и кол-во клиентов которым он подключён через client_channels.
    """
    rows = await db.fetch("""
        SELECT ch.id, ch.platform_slug, ch.display_name, ch.handle,
               ch.is_system, ch.is_test, ch.created_at, ch.updated_at,
               (SELECT COUNT(DISTINCT cc.client_id) FROM client_channels cc
                 WHERE cc.channel_id = ch.id) AS clients_attached,
               (SELECT COUNT(*) FROM platform_user_channels puc
                  JOIN client_channels cc ON cc.id = puc.client_channel_id
                 WHERE cc.channel_id = ch.id AND puc.is_unsubscribed = FALSE) AS subscribers,
               (SELECT COUNT(*) FROM platform_user_channels puc
                  JOIN client_channels cc ON cc.id = puc.client_channel_id
                 WHERE cc.channel_id = ch.id AND puc.is_unsubscribed = TRUE) AS unsubscribed
          FROM channels ch
         WHERE ch.is_system = TRUE
         ORDER BY ch.platform_slug, ch.id
    """)
    return {"items": [dict(r) for r in rows]}


@router.post("/system-channels", summary="Создать системный канал (в тестовом режиме)")
async def create_system_channel(
    data: SystemChannelCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Создаёт is_system=TRUE, is_test=TRUE канал. Клиенты его пока НЕ видят
    (записи в client_channels не создаются). Для выпуска в бой — PATCH с is_test=FALSE."""
    platform_exists = await db.fetchval(
        "SELECT 1 FROM platforms WHERE slug = $1 AND is_active = TRUE", data.platform_slug
    )
    if not platform_exists:
        raise HTTPException(status_code=400, detail="Неизвестная платформа")
    new_id = await db.fetchval(
        """INSERT INTO channels (platform_slug, display_name, handle, bot_token, is_system, is_test)
           VALUES ($1, $2, $3, $4, TRUE, TRUE) RETURNING id""",
        data.platform_slug, data.display_name, data.handle, data.bot_token
    )
    return {"id": new_id, "ok": True}


@router.patch("/system-channels/{channel_id}", summary="Обновить системный канал / выпустить в бой")
async def update_system_channel(
    channel_id: int,
    data: SystemChannelUpdate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Логика:
      - is_test=FALSE (выпуск в бой): backfill client_channels для всех клиентов.
        Обратно (FALSE→TRUE) — только если 0 подписок (иначе 409).
      - bot_token: менять только в is_test=TRUE без подписок (иначе 409).
      - display_name/handle: можно менять всегда.
    """
    current = await db.fetchrow(
        "SELECT id, is_system, is_test, bot_token FROM channels WHERE id = $1",
        channel_id
    )
    if not current or not current["is_system"]:
        raise HTTPException(status_code=404, detail="Системный канал не найден")

    has_subs = await db.fetchval(
        """SELECT COUNT(*) FROM platform_user_channels puc
           JOIN client_channels cc ON cc.id = puc.client_channel_id
          WHERE cc.channel_id = $1""",
        channel_id
    )

    # Запрет смены токена при наличии подписок
    if data.bot_token is not None and data.bot_token != (current["bot_token"] or ""):
        if has_subs and has_subs > 0:
            raise HTTPException(
                status_code=409,
                detail=f"У канала {has_subs} подписок — токен менять нельзя (потеряете базу)."
            )

    # Запрет возврата в тест при наличии подписок
    if data.is_test is True and current["is_test"] is False:
        if has_subs and has_subs > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Канал в бою с {has_subs} подписками — вернуть в тест нельзя."
            )

    upd, params = [], []
    if data.display_name is not None:
        params.append(data.display_name); upd.append(f"display_name=${len(params)}")
    if data.handle is not None:
        params.append(data.handle); upd.append(f"handle=${len(params)}")
    if data.bot_token is not None:
        params.append(data.bot_token); upd.append(f"bot_token=${len(params)}")
    if data.is_test is not None:
        params.append(data.is_test); upd.append(f"is_test=${len(params)}")

    async with db.transaction():
        if upd:
            params.append(channel_id)
            await db.execute(
                f"UPDATE channels SET {', '.join(upd)}, updated_at=NOW() WHERE id=${len(params)}",
                *params
            )
        # Если выпустили в бой → backfill client_channels всем клиентам (кроме тех у кого уже есть)
        if data.is_test is False and current["is_test"] is True:
            await db.execute(
                """INSERT INTO client_channels (client_id, channel_id, is_active)
                   SELECT c.id, $1,
                     -- активным делаем если у клиента нет других активных каналов на этой платформе
                     NOT EXISTS (
                       SELECT 1 FROM client_channels cc2
                         JOIN channels ch2 ON ch2.id = cc2.channel_id
                        WHERE cc2.client_id = c.id
                          AND ch2.platform_slug = (SELECT platform_slug FROM channels WHERE id = $1)
                          AND cc2.is_active = TRUE
                     )
                     FROM clients c WHERE c.is_active = TRUE
                   ON CONFLICT (client_id, channel_id) DO NOTHING""",
                channel_id
            )
    return {"ok": True}


@router.delete("/system-channels/{channel_id}", summary="Удалить системный канал (только без подписок)")
async def delete_system_channel(
    channel_id: int,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Удалить можно только канал без подписок (даже отписавшихся)."""
    current = await db.fetchrow(
        "SELECT id, is_system FROM channels WHERE id = $1",
        channel_id
    )
    if not current or not current["is_system"]:
        raise HTTPException(status_code=404, detail="Системный канал не найден")
    has_subs = await db.fetchval(
        """SELECT COUNT(*) FROM platform_user_channels puc
           JOIN client_channels cc ON cc.id = puc.client_channel_id
          WHERE cc.channel_id = $1""",
        channel_id
    )
    if has_subs and has_subs > 0:
        raise HTTPException(
            status_code=409,
            detail=f"У канала {has_subs} подписок — удалять нельзя. Сначала миграция/чистка."
        )
    async with db.transaction():
        await db.execute("DELETE FROM client_channels WHERE channel_id = $1", channel_id)
        await db.execute("DELETE FROM channels WHERE id = $1", channel_id)
    return {"ok": True}


# ─── Email-метрики качества рассылок клиента (для warning-значков) ───────


@router.get("/clients-email-quality", summary="Метрики качества email-рассылок по клиентам")
async def clients_email_quality(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """
    За последние 30 дней по каждому клиенту считает:
    - sent — успешно отправленных email-писем
    - bounces_hard — hard-bounces
    - unsubs — отписок от email-канала
    - bounce_rate / unsub_rate — проценты от sent
    - status — 'green' / 'yellow' / 'red':
        red    = bounce > 10% или unsub > 3%
        yellow = bounce > 5%  или unsub > 1%
        green  = всё ниже

    UI в /admin/clients использует это поле чтобы рисовать значок предупреждения.
    """
    rows = await db.fetch(
        """
        WITH email_channels AS (
            SELECT cc.client_id, ch.id AS channel_id, cc.id AS client_channel_id
              FROM client_channels cc
              JOIN channels ch ON ch.id = cc.channel_id
             WHERE ch.platform_slug = 'email'
        ),
        sent_30d AS (
            SELECT ec.client_id, COUNT(*) AS cnt
              FROM email_channels ec
              JOIN broadcast_log bl ON bl.channel_id = ec.channel_id
             WHERE bl.status = 'sent' AND bl.sent_at > NOW() - INTERVAL '30 days'
             GROUP BY ec.client_id
        ),
        bounces_30d AS (
            SELECT bl.client_id, COUNT(*) AS cnt
              FROM email_bounce_log bl
             WHERE bl.bounce_type = 'hard' AND bl.bounced_at > NOW() - INTERVAL '30 days'
               AND bl.client_id IS NOT NULL
             GROUP BY bl.client_id
        ),
        unsubs_30d AS (
            SELECT ul.client_id, COUNT(*) AS cnt
              FROM email_unsubscribe_log ul
             WHERE ul.unsubscribed_at > NOW() - INTERVAL '30 days'
             GROUP BY ul.client_id
        )
        SELECT c.id AS client_id, c.name, c.email AS client_email,
               COALESCE(s.cnt, 0) AS sent,
               COALESCE(b.cnt, 0) AS bounces_hard,
               COALESCE(u.cnt, 0) AS unsubs
          FROM clients c
          LEFT JOIN sent_30d s   ON s.client_id = c.id
          LEFT JOIN bounces_30d b ON b.client_id = c.id
          LEFT JOIN unsubs_30d u  ON u.client_id = c.id
         WHERE c.id != 3  -- исключаем системный клиент
        ORDER BY c.id
        """
    )

    result = []
    for r in rows:
        sent = int(r["sent"] or 0)
        b = int(r["bounces_hard"] or 0)
        u = int(r["unsubs"] or 0)
        bounce_rate = (b / sent * 100.0) if sent else 0.0
        unsub_rate = (u / sent * 100.0) if sent else 0.0

        if bounce_rate > 10 or unsub_rate > 3:
            status = "red"
            recommendation = "Качество базы критически низкое — приостановите рассылки и проверьте источники контактов"
        elif bounce_rate > 5 or unsub_rate > 1:
            status = "yellow"
            recommendation = "Метрики выше нормы — проверьте свежесть базы и согласия на маркетинг"
        else:
            status = "green"
            recommendation = ""

        result.append({
            "client_id": r["client_id"],
            "name": r["name"],
            "email": r["client_email"],
            "sent": sent,
            "bounces_hard": b,
            "unsubs": u,
            "bounce_rate": round(bounce_rate, 2),
            "unsub_rate": round(unsub_rate, 2),
            "status": status,
            "recommendation": recommendation,
        })

    return {"period_days": 30, "clients": result}


# ─────────────────────────────────────────────────────────────
# БИБЛИОТЕКА ДЕФОЛТНЫХ ШАБЛОНОВ РАССЫЛОК (миграция 217)
#
# Отсюда шаблоны копируются клиенту при создании события (авто-сид) и по кнопке
# «Добавить шаблон» (пресеты). Правки здесь действуют на НОВЫЕ события и на
# добавление шаблона вручную; уже созданные события не трогаются — там свои
# тексты клиента, перезатирать их нельзя.
# ─────────────────────────────────────────────────────────────

_DBT_FIELDS = (
    "type", "name", "subject", "text", "text_event", "photo_url",
    "button_text", "button_url", "schedule_mode", "offset_minutes",
    "audience_include", "audience_exclude", "allow_custom_datetime",
    "for_event", "for_conference", "for_turnir", "autoseed", "multi_instance",
    "turnir_name", "turnir_text", "is_active", "sort_order",
)


class DefaultTemplateIn(BaseModel):
    type: Optional[str] = None
    name: Optional[str] = None
    subject: Optional[str] = None
    text: Optional[str] = None
    text_event: Optional[str] = None
    photo_url: Optional[str] = None
    button_text: Optional[str] = None
    button_url: Optional[str] = None
    schedule_mode: Optional[str] = None
    offset_minutes: Optional[int] = None
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    allow_custom_datetime: Optional[bool] = None
    for_event: Optional[bool] = None
    for_conference: Optional[bool] = None
    for_turnir: Optional[bool] = None
    autoseed: Optional[bool] = None
    multi_instance: Optional[bool] = None
    turnir_name: Optional[str] = None
    turnir_text: Optional[str] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


@router.get("/broadcast-templates", summary="Библиотека дефолтных шаблонов рассылок")
async def list_default_templates(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        f"SELECT id, {', '.join(_DBT_FIELDS)}, created_at, updated_at "
        "FROM default_broadcast_templates ORDER BY sort_order, id"
    )
    # Сколько событий уже используют шаблон этого типа — чтобы админ понимал,
    # что правка НЕ затронет их (они живут своей копией в broadcast_templates).
    used = {r["type"]: r["cnt"] for r in await db.fetch(
        "SELECT type, COUNT(*) AS cnt FROM broadcast_templates GROUP BY type"
    )}
    out = []
    for r in rows:
        d = dict(r)
        d["used_in_events"] = used.get(d["type"], 0)
        out.append(d)
    return {"templates": out}


@router.post("/broadcast-templates", summary="Добавить дефолтный шаблон")
async def create_default_template(
    data: DefaultTemplateIn,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    if not data.type or not data.name or not data.text:
        raise HTTPException(status_code=400, detail="Нужны тип, название и текст")
    try:
        row = await db.fetchrow(
            """INSERT INTO default_broadcast_templates
                 (type, name, subject, text, text_event, photo_url, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude,
                  allow_custom_datetime, for_event, for_conference, for_turnir,
                  autoseed, multi_instance, turnir_name, turnir_text, is_active, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
               RETURNING *""",
            data.type, data.name, data.subject, data.text, data.text_event, data.photo_url,
            data.button_text, data.button_url,
            data.schedule_mode or "fixed_offset", data.offset_minutes or 0,
            data.audience_include or "all_event", data.audience_exclude or "none",
            bool(data.allow_custom_datetime),
            bool(data.for_event), bool(data.for_conference), bool(data.for_turnir),
            True if data.autoseed is None else bool(data.autoseed),
            bool(data.multi_instance), data.turnir_name, data.turnir_text,
            True if data.is_active is None else bool(data.is_active),
            data.sort_order or 0,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="Шаблон с таким типом уже есть")
    return {"template": dict(row)}


@router.patch("/broadcast-templates/{tid}", summary="Редактировать дефолтный шаблон")
async def update_default_template(
    tid: int,
    data: DefaultTemplateIn,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    # Различаем «не прислали» и «прислали null» (очистка) — как в профиле клиента.
    fs = data.model_fields_set
    upd = {f: getattr(data, f) for f in _DBT_FIELDS if f in fs}
    if not upd:
        raise HTTPException(status_code=400, detail="Нечего обновлять")
    sets = [f"{k} = ${i + 2}" for i, k in enumerate(upd.keys())]
    sets.append("updated_at = NOW()")
    try:
        row = await db.fetchrow(
            f"UPDATE default_broadcast_templates SET {', '.join(sets)} WHERE id = $1 RETURNING *",
            tid, *upd.values(),
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="Шаблон с таким типом уже есть")
    if not row:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    return {"template": dict(row)}


@router.delete("/broadcast-templates/{tid}", summary="Удалить дефолтный шаблон")
async def delete_default_template(
    tid: int,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    # Копии в событиях клиентов не трогаем — удаляем только запись библиотеки.
    await db.execute("DELETE FROM default_broadcast_templates WHERE id = $1", tid)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Файловое хранилище платформы (админ)
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ Читаем БАКЕТ НАПРЯМУЮ, а не таблицу client_files: админу нужно видеть в том
# числе то, чего в учёте нет — служебные файлы платформы (бэкапы БД), ручные
# заливки мимо кабинета и осиротевшие файлы. Если смотреть только по учёту,
# именно эти категории и останутся невидимыми — а ради них раздел и нужен.
@router.get("/storage", summary="Файловое хранилище платформы")
async def admin_storage(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    import re as _re
    from app.services import r2_storage

    def _human(n: float) -> str:
        for unit in ("Б", "КБ", "МБ", "ГБ"):
            if abs(n) < 1024:
                return f"{n:.1f} {unit}"
            n /= 1024
        return f"{n:.1f} ТБ"

    # Опись бакета. Синхронный boto3 — уводим в поток, чтобы не блокировать loop.
    import asyncio as _asyncio

    def _list_bucket():
        client = r2_storage.get_r2_client()
        out = []
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=settings.cf_r2_bucket_name):
            for o in page.get("Contents", []):
                out.append((o["Key"], int(o["Size"])))
        return out

    try:
        objects = await _asyncio.get_event_loop().run_in_executor(None, _list_bucket)
    except Exception as e:
        raise HTTPException(502, detail=f"Не удалось прочитать хранилище: {e}")

    tracked = {
        r["r2_key"]: (int(r["client_id"]), int(r["size_bytes"]))
        for r in await db.fetch("SELECT r2_key, client_id, size_bytes FROM client_files")
    }
    names = {
        r["id"]: (r["name"] or f"Клиент #{r['id']}")
        for r in await db.fetch("SELECT id, name FROM clients")
    }

    CLIENT_RE = _re.compile(r"^clients/(\d+)/")
    per_client: dict = {}
    service: list = []
    total = 0

    for key, size in objects:
        total += size
        m = CLIENT_RE.match(key)
        if m and int(m.group(1)) in names:
            cid = int(m.group(1))
            row = per_client.setdefault(cid, {"client_id": cid, "name": names[cid],
                                              "files": 0, "bytes": 0, "untracked_bytes": 0})
            row["files"] += 1
            row["bytes"] += size
            if key not in tracked:
                row["untracked_bytes"] += size
        else:
            # Всё вне clients/{id}/ — служебное платформы либо ручная заливка.
            service.append({"key": key, "size_bytes": size, "size_human": _human(size),
                            "group": key.split("/")[0] or "—"})

    # Осиротевшие: в учёте есть, файла в бакете нет.
    bucket_keys = {k for k, _ in objects}
    orphans = [
        {"key": k, "client_id": v[0], "name": names.get(v[0], f"Клиент #{v[0]}"),
         "size_bytes": v[1], "size_human": _human(v[1])}
        for k, v in tracked.items() if k not in bucket_keys
    ]

    svc_groups: dict = {}
    for s in service:
        g = svc_groups.setdefault(s["group"], {"group": s["group"], "files": 0, "bytes": 0})
        g["files"] += 1
        g["bytes"] += s["size_bytes"]
    for g in svc_groups.values():
        g["size_human"] = _human(g["bytes"])

    clients_out = sorted(per_client.values(), key=lambda x: -x["bytes"])
    for c in clients_out:
        c["size_human"] = _human(c["bytes"])
        c["untracked_human"] = _human(c["untracked_bytes"]) if c["untracked_bytes"] else None

    service_bytes = sum(s["size_bytes"] for s in service)
    clients_bytes = sum(c["bytes"] for c in clients_out)

    return {
        "total_files": len(objects),
        "total_bytes": total,
        "total_human": _human(total),
        "clients_bytes": clients_bytes,
        "clients_human": _human(clients_bytes),
        "service_bytes": service_bytes,
        "service_human": _human(service_bytes),
        "clients": clients_out,
        "service_groups": sorted(svc_groups.values(), key=lambda x: -x["bytes"]),
        "service_files": sorted(service, key=lambda x: -x["size_bytes"])[:200],
        "orphans": sorted(orphans, key=lambda x: -x["size_bytes"])[:100],
        "orphans_bytes": sum(o["size_bytes"] for o in orphans),
    }
