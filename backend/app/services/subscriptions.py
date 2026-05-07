"""
Helpers для работы с подписками клиентов (миграция 069).

Подписка = (client_id, tariff_id, expires_at, status, source).
Статусы: active | expired | paused.

Источник истины — `client_subscriptions`. Денормализованный указатель
`clients.current_subscription_id` обновляется при создании/обновлении подписки.

Поведение при истечении (expires_at < NOW()):
  - Cron-задача expire_overdue (раз в час) переводит status='active' → 'expired'.
  - Будущие рассылки пакета клиента ставятся на паузу (paused_subscription_expired).
  - UI клиента переходит в read-only, write-эндпоинты возвращают 403.

При продлении подписки (новая запись или UPDATE expires_at в будущее) — обратные действия.
"""
from typing import Optional
from fastapi import HTTPException


async def get_subscription(db, client_id: int) -> Optional[dict]:
    """Текущая подписка клиента.

    Источник истины — `clients.current_subscription_id` (денормализация).
    Fallback (на случай рассинхронизации): активная запись с самым поздним expires_at.
    Если активных нет — последняя по expires_at (для отображения «истекла»).
    """
    row = await db.fetchrow(
        """SELECT cs.id, cs.client_id, cs.tariff_id, cs.started_at, cs.expires_at,
                  cs.status, cs.source,
                  cs.notified_7d, cs.notified_3d, cs.notified_1d,
                  t.slug AS tariff_slug, t.name AS tariff_name, t.price AS tariff_price,
                  t.contact_limit, t.broadcasts_daily_limit, t.default_duration_days
             FROM clients c
             JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.id = $1""",
        client_id,
    )
    if row:
        return dict(row)

    # Fallback: current_subscription_id NULL — берём активную (status='active'),
    # либо последнюю по expires_at если активных нет.
    row = await db.fetchrow(
        """SELECT cs.id, cs.client_id, cs.tariff_id, cs.started_at, cs.expires_at,
                  cs.status, cs.source,
                  cs.notified_7d, cs.notified_3d, cs.notified_1d,
                  t.slug AS tariff_slug, t.name AS tariff_name, t.price AS tariff_price,
                  t.contact_limit, t.broadcasts_daily_limit, t.default_duration_days
             FROM client_subscriptions cs
             JOIN tariffs t ON t.id = cs.tariff_id
            WHERE cs.client_id = $1
            ORDER BY (cs.status = 'active') DESC, cs.expires_at DESC, cs.id DESC
            LIMIT 1""",
        client_id,
    )
    return dict(row) if row else None


async def is_active(db, client_id: int) -> bool:
    """True если у клиента есть подписка status='active' и expires_at > NOW()."""
    return bool(
        await db.fetchval(
            """SELECT 1 FROM client_subscriptions
                WHERE client_id = $1
                  AND status = 'active'
                  AND expires_at > NOW()
                LIMIT 1""",
            client_id,
        )
    )


async def assert_active(db, client_id: int) -> None:
    """Гард для write-эндпоинтов: 403 если подписка не активна."""
    if not await is_active(db, client_id):
        raise HTTPException(
            status_code=403,
            detail="Подписка истекла. Продлите тариф для возобновления работы.",
        )


async def expire_overdue(db) -> int:
    """Перевод истёкших подписок в 'expired' + пауза будущих рассылок этих клиентов.

    Запускается cron-задачей раз в час. Возвращает число обработанных подписок.
    """
    rows = await db.fetch(
        """UPDATE client_subscriptions
              SET status = 'expired', updated_at = NOW()
            WHERE status = 'active' AND expires_at <= NOW()
        RETURNING id, client_id""",
    )
    if not rows:
        return 0

    client_ids = [r["client_id"] for r in rows]
    await db.execute(
        """UPDATE broadcast_schedules
              SET status = 'paused_subscription_expired'
            WHERE client_id = ANY($1::int[])
              AND status IN ('draft', 'pending')
              AND fire_at > NOW()""",
        client_ids,
    )
    return len(rows)


async def resume_subscription(db, client_id: int) -> int:
    """При продлении возвращаем запаузенные рассылки в pending. Возвращает число."""
    result = await db.execute(
        """UPDATE broadcast_schedules
              SET status = 'pending'
            WHERE client_id = $1
              AND status = 'paused_subscription_expired'
              AND fire_at > NOW()""",
        client_id,
    )
    if result and result.startswith("UPDATE "):
        try:
            return int(result.split()[1])
        except (IndexError, ValueError):
            pass
    return 0


def days_until_expires(expires_at) -> int:
    """Сколько целых дней до истечения подписки. Отрицательное если уже истекла."""
    from datetime import datetime, timezone
    if not expires_at:
        return -1
    now = datetime.now(timezone.utc)
    if expires_at.tzinfo is None:
        from datetime import timezone as tz
        expires_at = expires_at.replace(tzinfo=tz.utc)
    delta = expires_at - now
    return delta.days
