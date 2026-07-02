"""Публичные эндпоинты для лендинга pluson.ru.

Возвращают данные о тарифах и активных промоакциях без аутентификации —
их читает заглушка-лендинг (web/src/app/page.tsx) при загрузке.

Здесь же — endpoint для регистрации сразу с pid, который дописывается через
?pid=... на лендинге. Сам register живёт в auth.py — этот файл только для
read-only публичных данных.
"""
from fastapi import APIRouter, Depends
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/api/v1/public", tags=["Публичные данные лендинга"])


@router.get("/tariffs", summary="Список тарифов для лендинга")
async def public_tariffs(db: asyncpg.Connection = Depends(get_db)):
    """Возвращает все активные тарифы с их фичами и текущей акцией.

    Используется на главной pluson.ru и в форме «Подписка» дашборда.
    Намеренно отдаёт даже тариф `trial` — лендинг сам решит, показывать ли его
    (обычно не показывают, потому что регистрация = автоматический trial).
    """
    rows = await db.fetch(
        """SELECT t.id, t.slug, t.name, t.price, t.default_duration_days,
                  t.contact_limit, t.broadcasts_daily_limit,
                  t.prodamus_payment_url,
                  (t.leadpay_product_id IS NOT NULL AND t.leadpay_product_id <> '') AS leadpay_product_id,
                  t.promo_banner_text, t.promo_old_price,
                  t.is_active, t.bullet_points,
                  ARRAY(SELECT f.slug FROM tariff_features tf
                          JOIN features f ON f.id = tf.feature_id
                         WHERE tf.tariff_id = t.id
                         ORDER BY f.sort) AS feature_slugs
             FROM tariffs t
            WHERE t.is_active = TRUE
            ORDER BY t.price ASC""",
    )
    out = []
    for r in rows:
        d = dict(r)
        bp = d.get("bullet_points")
        if isinstance(bp, str):
            import json
            try:
                d["bullet_points"] = json.loads(bp)
            except Exception:
                d["bullet_points"] = []
        out.append(d)
    return {"tariffs": out}


@router.get("/features", summary="Справочник фич (для лендинга и страницы подписки)")
async def public_features(db: asyncpg.Connection = Depends(get_db)):
    """Возвращает все доступные опции тарифов (slug + name + description).

    Используется лендингом и `/dashboard/subscription` чтобы динамически
    подставлять название каждой фичи рядом с её slug — без хардкода
    FEATURE_LABELS на фронте. Любое изменение `features.name` в БД сразу
    отражается в UI без правок кода.
    """
    rows = await db.fetch(
        """SELECT slug, name, description, sort,
                  is_addon, price_monthly, price_6mo, min_tariff_slug,
                  promo_old_monthly, promo_old_6mo,
                  tagline, bullet_points
             FROM features ORDER BY sort, slug"""
    )
    out = []
    for r in rows:
        d = dict(r)
        bp = d.get("bullet_points")
        if isinstance(bp, str):
            import json
            try:
                d["bullet_points"] = json.loads(bp)
            except Exception:
                d["bullet_points"] = []
        out.append(d)
    return {"features": out}


@router.get("/promotions/active", summary="Активные акции (для счётчиков на лендинге)")
async def public_active_promotions(db: asyncpg.Connection = Depends(get_db)):
    """Возвращает все активные не исчерпавшиеся акции с оставшимися местами.

    Используется лендингом чтобы показать «Осталось N мест из 30 — успейте
    зарегистрироваться» и баннеры скидок.
    """
    rows = await db.fetch(
        """SELECT id, slug, name, description, type, value, target_tariff_slug,
                  max_uses, used_count, starts_at, ends_at,
                  CASE WHEN max_uses IS NULL THEN NULL
                       ELSE GREATEST(0, max_uses - used_count)
                  END AS remaining
             FROM promotions
            WHERE is_active = TRUE
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (ends_at   IS NULL OR ends_at   >  NOW())
              AND (max_uses  IS NULL OR used_count < max_uses)
            ORDER BY id""",
    )
    return {"promotions": [dict(r) for r in rows]}
