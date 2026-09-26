"""Диалоги внедренца — переписка с теми, кто написал в @pluson_bot (миграция 392).

⚠️⚠️ ЗДЕСЬ ЧИТАЮТСЯ ДИАЛОГИ СИСТЕМНОГО КАБИНЕТА, а не клиента. В @pluson_bot
пишут будущие клиенты и просто люди с вопросами: их сообщения попадают в базу
СЕРВИСНОГО кабинета, потому что этот бот принадлежит ему.

⚠️ Внедренец видит ТОЛЬКО назначенные ему разговоры. Отдать все и отфильтровать
на фронте нельзя: запрос повторяется мимо интерфейса.

⚠️ Отправка идёт ГОТОВОЙ функцией из `dialogs.py`, а не своей копией: там уже
разобраны четыре площадки, выбор токена и запись в ленту. Вторая копия
разошлась бы с первой на первой же правке.
"""

from __future__ import annotations

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_tech
from app.database import get_db
# ⚠️ Статус воронки — из ОБЩЕГО модуля: теми же выражениями считаются деньги.
from app.services.tech_accruals import CRM_CASE_SQL

router = APIRouter(prefix="/tech/dialogs", tags=["Внедренец: диалоги"])


class ReplyIn(BaseModel):
    platform: str
    text: str


async def _system_client_id(db) -> int:
    """Кабинет, которому принадлежит @pluson_bot."""
    cid = await db.fetchval(
        "SELECT id FROM clients WHERE is_system_service = TRUE LIMIT 1")
    if not cid:
        raise HTTPException(404, "Системный кабинет не найден")
    return cid


# ⚠️⚠️ ДИАЛОГ ПРИНАДЛЕЖИТ ТОМУ, ЗА КЕМ ЗАКРЕПЛЁН КЛИЕНТ (23.09.2026).
#
# Раньше диалоги раздавались ОТДЕЛЬНО, вручную, через `dialog_assignments` —
# и это было неверно: клиент закреплён за внедренцем в
# `clients.tech_specialist_id`, а переписка с ним оставалась ничьей, пока
# владелец не раздаст её руками. На проде у человека с шестью клиентами раздел
# «Диалоги» был пуст — назначений не существовало ни одного.
#
# Диалоги от клиентов НЕОТДЕЛИМЫ: закрепление клиента — единственное основание.
# Второй механизм раздачи означал бы два ответа на вопрос «чей это разговор».
#
# ⚠️ Человек в системном боте — это КОНТАКТ, а клиент платформы — отдельная
# запись; общее у них почта. Тот же приём, что в `plusson_match`: сравниваем
# `LOWER(TRIM(...))`, иначе «Miss-25@» и «miss-25@» разъезжаются.
MINE_SQL = """EXISTS (
    SELECT 1 FROM platform_users pe
      JOIN clients cl
        ON LOWER(TRIM(cl.email)) = LOWER(TRIM(pe.platform_user_id))
     WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
       AND cl.tech_specialist_id = $2)"""


async def _assert_mine(db, spec_id: int, client_id: int, contact_id: int) -> None:
    """Разговор с МОИМ клиентом — иначе 404.

    ⚠️ Именно 404, а не 403: по чужому id не должно быть видно даже того, что
    такой разговор существует.
    """
    # ⚠️ Параметры ровно те, что В ЗАПРОСЕ. Лишний `client_id` первым
    # аргументом приводил к IndeterminateDatatypeError: Postgres не может
    # вывести тип параметра, который нигде не используется, и лента переписки
    # отвечала 500. `MINE_SQL` ждёт номер внедренца вторым — держим порядок.
    ok = await db.fetchval(
        "SELECT 1 FROM contacts c WHERE c.id = $1 AND " + MINE_SQL,
        contact_id, spec_id,
    )
    if not ok:
        raise HTTPException(404, "Диалог не найден")


# ⚠️⚠️ ОТ ЧЬЕГО ИМЕНИ ПЕРЕПИСКА (владелец, 26.09.2026). Внедренцы путались:
# думали, что они помощники в боте iVision, а пишут они клиентам ПЛЮСОНа из
# каналов сервисного кабинета. Показываем эти каналы прямо в «Диалогах».
#
# ⚠️ Каналы берём из БАЗЫ (главные каналы сервисного кабинета), а не пишем в
# коде: сменится бот или сообщество — экран покажет новое сам.
# ⚠️ Токены и `platform_meta` наружу НЕ отдаём — только имя и ссылку.
_PLATFORM_ORDER = {"telegram": 0, "max": 1, "vk": 2, "email": 3}


async def _our_channels(db) -> list[dict]:
    rows = await db.fetch(
        """SELECT ch.platform_slug, ch.display_name, ch.handle,
                  ch.platform_meta->>'max_bot_name' AS max_bot_name
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
             JOIN clients c ON c.id = cc.client_id
            WHERE c.is_system_service AND cc.is_active""")
    out = []
    for r in rows:
        p, h = r["platform_slug"], (r["handle"] or "").lstrip("@")
        if p == "telegram":
            label, url = (f"@{h}" if h else r["display_name"]), (f"https://t.me/{h}" if h else None)
        elif p == "max":
            label, url = (r["max_bot_name"] or r["display_name"]), (f"https://max.ru/{h}" if h else None)
        elif p == "vk":
            label, url = r["display_name"], (f"https://vk.com/{h}" if h else None)
        elif p == "email":
            # ⚠️ Показываем support@, а не адрес канала (noreply@): письма
            # ПЛЮСОНа идут с Reply-To на support@, и ответы клиентов приходят
            # сюда же, в «Диалоги» (миграция 521).
            from app.services.email_sender import PLUSON_SUPPORT_EMAIL
            label, url = PLUSON_SUPPORT_EMAIL, f"mailto:{PLUSON_SUPPORT_EMAIL}"
        else:
            continue
        out.append({"platform": p, "label": label, "url": url})
    out.sort(key=lambda x: _PLATFORM_ORDER.get(x["platform"], 9))
    return out


@router.get("/our-channels", summary="Каналы ПЛЮСОНа, из которых идёт переписка")
async def our_channels(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    return {"channels": await _our_channels(db)}


@router.get("", summary="Мои диалоги")
async def my_dialogs(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Мои клиенты и переписка с ними.

    ⚠️⚠️ СПИСОК ИДЁТ ОТ КЛИЕНТОВ, А НЕ ОТ СООБЩЕНИЙ (23.09.2026). Раньше здесь
    стоял `JOIN` с перепиской, и человек попадал в список, только если уже
    что-то написал. Выходило бессмысленно: внедренцу нужно НАПИСАТЬ клиенту
    первым, а в разделе «Диалоги» этого клиента не было вовсе, пока тот не
    напишет сам. Теперь видно всех своих, а переписка подтягивается, если есть.

    ⚠️ `where_to_write` — по каким каналам человеку МОЖНО написать (telegram,
    vk, max, email). У кого что есть: без этого внедренец открывает карточку и
    обнаруживает, что отправить некуда.
    """
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)

    rows = await db.fetch(
        """WITH last AS (
             SELECT DISTINCT ON (dm.contact_id)
                    dm.contact_id, dm.text, dm.media_kind, dm.direction, dm.sent_at
               FROM direct_messages dm
              WHERE dm.client_id = $1 AND dm.contact_id IS NOT NULL
              ORDER BY dm.contact_id, dm.sent_at DESC
           ), agg AS (
             SELECT dm.contact_id,
                    MAX(dm.sent_at) AS last_at,
                    array_agg(DISTINCT dm.platform) AS platforms,
                    COUNT(*) FILTER (WHERE dm.direction='in' AND NOT dm.is_read) AS unread
               FROM direct_messages dm
              WHERE dm.client_id = $1 AND dm.contact_id IS NOT NULL
              GROUP BY dm.contact_id
           )
           SELECT c.id AS contact_id,
                  COALESCE(c.name, cl.name) AS name,
                  COALESCE(c.phone, cl.phone) AS phone,
                  a.last_at, a.platforms,
                  COALESCE(a.unread, 0) AS unread,
                  l.text AS last_text, l.media_kind AS last_media_kind,
                  l.direction AS last_direction,
                  -- Куда ему можно написать: у кого телеграм, у кого только
                  -- почта. Пустой список — писать некуда, и это видно сразу.
                  --
                  -- ⚠️ Почта есть ВСЕГДА — это логин клиента платформы,
                  -- поэтому она в списке даже когда контакта в боте нет вовсе.
                  (SELECT array_agg(DISTINCT x) FROM unnest(
                     COALESCE((SELECT array_agg(DISTINCT pu.platform_slug)
                                 FROM platform_users pu
                                WHERE pu.contact_id = c.id
                                  AND pu.platform_slug IN ('telegram','vk','max','email')),
                              ARRAY[]::text[])
                     || ARRAY['email']
                     || CASE WHEN COALESCE(cl.telegram_username,'') <> ''
                             THEN ARRAY['telegram'] ELSE ARRAY[]::text[] END
                   ) AS x) AS where_to_write,
                  cl.id AS platform_client_id,
                  cl.email AS client_email
             -- ⚠️⚠️ ИДЁМ ОТ КЛИЕНТОВ, А НЕ ОТ КОНТАКТОВ БОТА (23.09.2026):
             -- у половины клиентов контакта в боте нет вовсе (они туда не
             -- заходили), и по контактам они бы в список не попали — а
             -- написать им нужно в первую очередь.
             FROM clients cl
             LEFT JOIN contacts c
                    ON c.client_id = $1
                   AND EXISTS (SELECT 1 FROM platform_users pe
                                WHERE pe.contact_id = c.id
                                  AND pe.platform_slug = 'email'
                                  AND LOWER(TRIM(pe.platform_user_id))
                                    = LOWER(TRIM(cl.email)))
             LEFT JOIN agg a ON a.contact_id = c.id
             LEFT JOIN last l ON l.contact_id = c.id
            WHERE cl.tech_specialist_id = $2
            -- Сначала те, с кем уже говорили (свежие сверху), затем остальные.
            ORDER BY a.last_at DESC NULLS LAST, COALESCE(c.name, cl.name)""",
        client_id, spec_id,
    )
    return {"dialogs": [dict(r) for r in rows]}


@router.get("/unread-count", summary="Сколько у меня новых сообщений")
async def unread_count(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Цифра для пункта меню «Диалоги» — как у клиента в кабинете.

    ⚠️⚠️ ОБЪЯВЛЕН ДО `/{contact_id}`: FastAPI разбирает маршруты по порядку, и
    после него «unread-count» ушёл бы в динамический путь как номер контакта —
    эндпоинт молча отвечал бы 422 вместо цифры.

    ⚠️ Считаем ровно то же, что показывает список: только НАЗНАЧЕННЫЕ мне
    разговоры (переписка с МОИМИ клиентами). Иначе в меню висела бы цифра от чужих
    диалогов, которые человек не может открыть, — то самое расхождение, из-за
    которого у клиентов счётчик уже переделывали.
    """
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)
    n = await db.fetchval(
        """SELECT COUNT(*)
             FROM direct_messages dm
             JOIN contacts c ON c.id = dm.contact_id
            WHERE dm.client_id = $1
              AND dm.contact_id IS NOT NULL
              AND dm.direction = 'in' AND NOT dm.is_read
              AND """ + MINE_SQL,
        client_id, spec_id,
    )
    return {"unread": int(n or 0)}


@router.get("/{contact_id}", summary="Лента переписки")
async def messages(
    contact_id: int,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)
    await _assert_mine(db, spec_id, client_id, contact_id)

    # ⚠️⚠️ НАБОР ПОЛЕЙ — РОВНО КАК У КЛИЕНТСКОЙ ЛЕНТЫ (23.09.2026): экран
    # переписки теперь ОБЩИЙ (`components/DialogChat`), и он ждёт именно эти
    # поля. Урезанный список давал пустые вкладки площадок и «сломанные»
    # сообщения без признака правки.
    rows = await db.fetch(
        """SELECT id, platform, channel_id, platform_user_id, direction,
                  author_kind, text, media_url, media_kind, email_subject,
                  platform_message_id, is_deleted, error, sent_at, edited_at
             FROM direct_messages
            WHERE client_id = $1 AND contact_id = $2
            ORDER BY sent_at""",
        client_id, contact_id,
    )
    # Площадки этого разговора и непрочитанные по каждой — для вкладок сверху.
    plats = await db.fetch(
        """SELECT platform,
                  COUNT(*) FILTER (WHERE direction='in' AND NOT is_read) AS unread
             FROM direct_messages
            WHERE client_id = $1 AND contact_id = $2
            GROUP BY platform ORDER BY platform""",
        client_id, contact_id,
    )
    # Помечаем прочитанным: человек открыл ленту и увидел сообщения.
    await db.execute(
        """UPDATE direct_messages SET is_read = TRUE
            WHERE client_id = $1 AND contact_id = $2
              AND direction = 'in' AND NOT is_read""",
        client_id, contact_id,
    )
    contact = await db.fetchrow(
        "SELECT id, name, phone FROM contacts WHERE id = $1", contact_id)
    # ⚠️ Площадки, где у человека есть аккаунт — для выбора, КУДА отвечать.
    # Их может быть больше, чем площадок переписки: писали в телеграм, а почта
    # у него тоже есть.
    # ⚠️ `$1::int` — приведение обязательно: без него Postgres не может вывести
    # тип параметра в этом запросе и падает с IndeterminateDatatypeError.
    accs = await db.fetch(
        """SELECT DISTINCT platform_slug FROM platform_users
            WHERE contact_id = $1::int
              AND platform_slug IN ('telegram','vk','max','email')""",
        contact_id)
    return {
        "contact": dict(contact) if contact else None,
        "messages": [dict(r) for r in rows],
        "platforms": [r["platform"] for r in plats],
        "unread_by_platform": {
            r["platform"]: int(r["unread"] or 0) for r in plats if r["unread"]
        },
        "available_platforms": [r["platform_slug"] for r in accs],
    }


@router.get("/card/{contact_id}", summary="Карточка человека рядом с перепиской")
async def dialog_card(
    contact_id: int,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Кто этот человек — всё, что нужно знать перед ответом (24.09.2026).

    ⚠️ ТОЛЬКО ЧТЕНИЕ. Менять отсюда ничего нельзя: тарифы, модули и данные
    человека — не зона внедренца.

    ⚠️ Объявлен ДО `/{contact_id}`: FastAPI разбирает маршруты по порядку, и
    после него «card» ушёл бы в динамический путь как номер контакта.

    Состав выбран владельцем: контакты и соцсети, когда создан, кто привёл,
    деньги и тариф, что у него есть (события/боты/подписчики/вебинары),
    подключённые модули. Профиль и ниша не выводятся — заполнены редко.
    """
    spec_id = int(user["sub"])
    sys_client_id = await _system_client_id(db)
    await _assert_mine(db, spec_id, sys_client_id, contact_id)

    # Контакт в боте и клиент платформы — РАЗНЫЕ записи, общее у них почта.
    row = await db.fetchrow(
        f"""SELECT ct.id AS contact_id, ct.name AS contact_name, ct.phone,
                   ct.created_at AS contact_created_at,
                   cl.id AS client_id, cl.name, cl.last_name, cl.email,
                   cl.phone AS client_phone, cl.telegram_username,
                   cl.work_tg_username, cl.work_vk, cl.work_max,
                   cl.social_links, cl.brand_name, cl.created_at,
                   cl.tech_assigned_at, cl.timezone,
                   t.name AS tariff_name, cs.expires_at, cs.status AS sub_status,
                   cs.source AS sub_source,
                   -- ⚠️ Заменяем АЛИАС целиком (`c.` → `cl.`), а не одно поле:
                   -- в выражении есть и `c.id`, и `c.current_subscription_id`,
                   -- и замена по `c.id` оставляла второе висеть на таблице,
                   -- которой в этом запросе нет.
                   ({CRM_CASE_SQL.replace('c.', 'cl.')}) AS crm_status,
                   -- Кто привёл В ПЛЮСОН: имя того, по чьей ссылке пришёл.
                   refc.name AS referrer_name,
                   refc.email AS referrer_email,
                   -- Деньги.
                   (SELECT COUNT(*) FROM subscription_orders so
                     WHERE so.client_id = cl.id AND so.status='paid'
                       AND so.amount_paid_card_kopecks > 0) AS payments_count,
                   (SELECT COALESCE(SUM(so.amount_paid_card_kopecks),0)
                      FROM subscription_orders so
                     WHERE so.client_id = cl.id AND so.status='paid')
                     AS total_paid_kopecks,
                   (SELECT MAX(so.paid_at) FROM subscription_orders so
                     WHERE so.client_id = cl.id AND so.status='paid') AS last_paid_at,
                   -- Что у него есть.
                   (SELECT COUNT(*) FROM events e
                     WHERE EXISTS (SELECT 1 FROM event_owners eo
                                    WHERE eo.event_id = e.id AND eo.client_id = cl.id
                                      AND eo.status='accepted')) AS events_count,
                   (SELECT COUNT(*) FROM client_channels cc
                      JOIN channels ch ON ch.id = cc.channel_id
                     WHERE cc.client_id = cl.id AND ch.is_system = FALSE)
                     AS own_channels_count,
                   (SELECT COUNT(*) FROM platform_user_channels puc
                      JOIN client_channels cc ON cc.id = puc.client_channel_id
                     WHERE cc.client_id = cl.id AND puc.is_unsubscribed = FALSE)
                     AS subscribers_count,
                   (SELECT COUNT(*) FROM webinar_rooms wr
                     WHERE EXISTS (SELECT 1 FROM event_owners eo
                                    WHERE eo.event_id = wr.event_id
                                      AND eo.client_id = cl.id
                                      AND eo.status='accepted')) AS webinars_count,
                   (SELECT COUNT(*) FROM contacts c2
                     WHERE c2.client_id = cl.id AND c2.is_active) AS contacts_count,
                   -- Подключённые модули с датой окончания.
                   (SELECT json_agg(json_build_object(
                             'name', f.name,
                             'expires_at', ca.expires_at,
                             'is_active', (ca.status='active' AND ca.expires_at > NOW()))
                           ORDER BY (ca.status='active' AND ca.expires_at > NOW()) DESC,
                                    ca.expires_at DESC)
                      FROM client_addons ca
                      JOIN features f ON f.id = ca.feature_id
                     WHERE ca.client_id = cl.id) AS addons
              FROM contacts ct
              LEFT JOIN clients cl
                     ON LOWER(TRIM(cl.email)) = LOWER(TRIM((
                          SELECT pe.platform_user_id FROM platform_users pe
                           WHERE pe.contact_id = ct.id
                             AND pe.platform_slug = 'email'
                           ORDER BY pe.id LIMIT 1)))
              LEFT JOIN client_subscriptions cs ON cs.id = cl.current_subscription_id
              LEFT JOIN tariffs t ON t.id = cs.tariff_id
              LEFT JOIN clients refc ON refc.id = cl.referred_by_client_id
             WHERE ct.id = $1::int""",
        contact_id)
    if not row:
        raise HTTPException(404, "Не найден")

    d = dict(row)
    # ⚠️ jsonb из asyncpg приходит СТРОКОЙ — разбираем, иначе фронт получит
    # текст вместо объекта и упадёт на `.map`.
    import json as _json
    for k in ("social_links", "addons"):
        if isinstance(d.get(k), str):
            try:
                d[k] = _json.loads(d[k])
            except Exception:  # noqa: BLE001
                d[k] = None

    # Аккаунты человека в мессенджерах — из его контакта в боте.
    accs = await db.fetch(
        """SELECT platform_slug, username, platform_user_id
             FROM platform_users WHERE contact_id = $1::int
            ORDER BY platform_slug""",
        contact_id)
    d["accounts"] = [dict(a) for a in accs]
    return d


class StartIn(BaseModel):
    """Начать переписку с клиентом, которого в боте ещё нет."""
    client_id: int


@router.post("/start", summary="Завести разговор с моим клиентом")
async def start_dialog(
    data: StartIn,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Создаёт контакт в системном боте для клиента, у которого его ещё нет.

    ⚠️⚠️ ЗАЧЕМ. В списке диалогов теперь ВСЕ клиенты внедренца, но у половины
    из них контакта в боте не существует — они туда не заходили. Без контакта
    ни открыть переписку, ни написать нельзя: и лента, и отправка адресуются
    `contact_id`. Получался список, в котором половина строк не кликается.

    ⚠️ Контакт заводится ТОЛЬКО для своего клиента (проверка ниже) и ТОЛЬКО в
    базе системного кабинета — это карточка «человек, которому мы пишем», а не
    новый клиент платформы.

    ⚠️ Почта кладётся в `platform_users`, потому что именно по ней контакт
    связывается с клиентом платформы (см. `MINE_SQL`). Без неё разговор тут же
    перестал бы считаться своим.
    """
    spec_id = int(user["sub"])
    sys_client_id = await _system_client_id(db)

    cl = await db.fetchrow(
        """SELECT id, name, email, phone, telegram_username
             FROM clients WHERE id = $1 AND tech_specialist_id = $2""",
        data.client_id, spec_id)
    if not cl:
        raise HTTPException(404, "Это не ваш клиент")

    # Контакт мог появиться параллельно — ищем по той же почте.
    existing = await db.fetchval(
        """SELECT c.id FROM contacts c
            JOIN platform_users pe ON pe.contact_id = c.id
                                  AND pe.platform_slug = 'email'
           WHERE c.client_id = $1
             AND LOWER(TRIM(pe.platform_user_id)) = LOWER(TRIM($2))
           LIMIT 1""",
        sys_client_id, cl["email"])
    if existing:
        return {"contact_id": existing, "created": False}

    # ⚠️ `contacts.ref_code` — NOT NULL UNIQUE (миграция 060). Берём ОБЩИЙ
    # генератор, а не придумываем свой: он один на все точки создания контакта
    # и умеет разрешать коллизии.
    from app.services.contact_merge import _generate_unique_ref_code
    ref_code = await _generate_unique_ref_code(db)
    contact_id = await db.fetchval(
        """INSERT INTO contacts (client_id, name, phone, ref_code)
           VALUES ($1, $2, $3, $4) RETURNING id""",
        sys_client_id, cl["name"], cl["phone"], ref_code)
    await db.execute(
        """INSERT INTO platform_users (contact_id, platform_slug, platform_user_id)
           VALUES ($1, 'email', $2)
           ON CONFLICT DO NOTHING""",
        contact_id, cl["email"])
    # Телеграм — если клиент его указал: это второй канал, по которому можно
    # написать, и без записи он был бы недоступен отправке.
    # ⚠️ `platform_user_id` — NOT NULL, поэтому кладём туда ник: числового id
    # телеграма у нас нет (человек в бот не заходил), а ник — единственное,
    # что клиент указал сам. Тот же приём, что у почты: там в этом поле адрес.
    tg = (cl["telegram_username"] or "").strip().lstrip("@")
    if tg:
        await db.execute(
            """INSERT INTO platform_users
                   (contact_id, platform_slug, platform_user_id, username)
               VALUES ($1, 'telegram', $2, $2)
               ON CONFLICT DO NOTHING""",
            contact_id, tg)
    return {"contact_id": contact_id, "created": True}


@router.post("/{contact_id}/reply", summary="Ответить")
async def reply(
    contact_id: int,
    data: ReplyIn,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Ответ уходит через бот СИСТЕМНОГО кабинета — тот, в который человек писал.

    ⚠️ Переиспользуем готовую отправку из `dialogs.py`: там разобраны четыре
    площадки, выбор токена и запись в ленту. Своя копия разошлась бы с ней.
    """
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)
    await _assert_mine(db, spec_id, client_id, contact_id)

    from app.api.dialogs import ReplyBody, reply_to_contact

    # Готовая функция ждёт токен КЛИЕНТА (в `sub` — id кабинета). Подставляем
    # системный кабинет и помечаем, кто на самом деле пишет: без пометки в
    # логах не отличить ответ внедренца от ответа владельца.
    fake_client = {"sub": str(client_id), "role": "client",
                   "acting_tech_id": spec_id}
    return await reply_to_contact(
        contact_id=contact_id,
        body=ReplyBody(platform=data.platform, text=data.text),
        client=fake_client,
        db=db,
    )
