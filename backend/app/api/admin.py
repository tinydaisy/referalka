from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from typing import Optional
from app.auth import get_current_admin, hash_password
from app.database import get_db
import asyncpg
import json

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
          (SELECT COUNT(*) FROM clients WHERE is_active = TRUE) as clients_total,
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
    limit: int = 50,
    offset: int = 0,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    conditions = ["1=1"]
    params = []

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
                    JOIN platform_users pu ON pu.contact_id = ct.id
                    WHERE ct.email_normalized = lower(c.email)
                      AND (pu.username ILIKE ${p} OR ct.name ILIKE ${p} OR ct.email ILIKE ${p})
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

    where = " AND ".join(conditions)
    params.extend([limit, offset])

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
            WHERE cc.client_id = c.id AND ch.is_system = FALSE) AS channels_breakdown
        FROM clients c
        LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
        LEFT JOIN tariffs t ON t.id = cs.tariff_id
        WHERE {where}
        ORDER BY c.created_at DESC
        LIMIT ${len(params)-1} OFFSET ${len(params)}
        """,
        *params
    )
    total = await db.fetchval(f"SELECT COUNT(*) FROM clients c WHERE {where}", *params[:-2])
    result = []
    for c in clients:
        d = dict(c)
        raw = d.get("channels_breakdown")
        d["channels_breakdown"] = json.loads(raw) if isinstance(raw, str) else (raw or [])
        result.append(d)
    return {"clients": result, "total": total}


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


@router.patch("/clients/{client_id}", summary="Обновить клиента")
async def update_client(
    client_id: int,
    is_active: Optional[bool] = None,
    tariff_slug: Optional[str] = None,
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
            "SELECT id, default_duration_days FROM tariffs WHERE slug = $1", tariff_slug
        )
        if not tariff:
            raise HTTPException(status_code=400, detail=f"Тариф '{tariff_slug}' не найден")
        days = tariff["default_duration_days"] or 30
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
    """Правило проекта: тариф `trial` ВСЕГДА имеет те же фичи, что `pro`.
    Если изменили фичи именно у pro — выравниваем trial под pro (добавляем
    недостающие; лишние у trial не трогаем, он не должен быть беднее pro).
    """
    pro = await db.fetchval("SELECT id FROM tariffs WHERE slug = 'pro'")
    trial = await db.fetchval("SELECT id FROM tariffs WHERE slug = 'trial'")
    if not pro or not trial or changed_tariff_id != pro:
        return
    await db.execute(
        """INSERT INTO tariff_features (tariff_id, feature_id)
           SELECT $1, tf.feature_id FROM tariff_features tf
            WHERE tf.tariff_id = $2
           ON CONFLICT DO NOTHING""",
        trial, pro,
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
    rows = await db.fetch("SELECT id, slug, name, description, sort FROM features ORDER BY sort, slug")
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
