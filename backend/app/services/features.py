"""
Helpers для работы с фичами тарифа.

Фича-набор клиента = JOIN активная подписка (client_subscriptions WHERE expires_at > NOW())
                   → tariff_features → features.

Базовые возможности (контакты, мероприятия, рассылки) — НЕ фичи, всегда включены, в этой
системе не проверяются. Фичи — только опциональные модули поверх базы.

Slug-и фич (миграция 067):
  channels         — свои каналы / брендированный бот
  conference       — модуль Конференции
  awards           — модуль Премий (на вырост)
  lead_magnets     — лид-магниты + воронки
  export_contacts  — экспорт контактов в CSV

Семантика:
  - Если у клиента нет активной подписки — функция возвращает False / [].
  - При истечении подписки (expires_at < NOW()) фичи автоматически отключаются.
"""
from typing import Optional


async def get_client_features(db, client_id: int) -> list[str]:
    """Список slug-ов фич у клиента.

    Фича приходит из ДВУХ источников (объединение):
      1. тариф активной подписки (tariff_features) — база;
      2. купленный аддон (client_addons) — расширение лично на клиенте.
    """
    rows = await db.fetch(
        """SELECT f.slug
             FROM client_subscriptions cs
             JOIN tariff_features tf ON tf.tariff_id = cs.tariff_id
             JOIN features f         ON f.id = tf.feature_id
            WHERE cs.client_id = $1
              AND cs.status = 'active'
              AND cs.expires_at > NOW()
            UNION
           SELECT f.slug
             FROM client_addons ca
             JOIN features f ON f.id = ca.feature_id
            WHERE ca.client_id = $1
              AND ca.status = 'active'
              AND ca.expires_at > NOW()
            ORDER BY slug""",
        client_id,
    )
    return [r["slug"] for r in rows]


async def client_has_feature(db, client_id: int, feature_slug: str) -> bool:
    """True если фича есть у клиента — в тарифе ИЛИ как активный аддон."""
    return bool(
        await db.fetchval(
            """SELECT 1
                 FROM client_subscriptions cs
                 JOIN tariff_features tf ON tf.tariff_id = cs.tariff_id
                 JOIN features f         ON f.id = tf.feature_id
                WHERE cs.client_id = $1 AND f.slug = $2
                  AND cs.status = 'active' AND cs.expires_at > NOW()
                UNION ALL
               SELECT 1
                 FROM client_addons ca
                 JOIN features f ON f.id = ca.feature_id
                WHERE ca.client_id = $1 AND f.slug = $2
                  AND ca.status = 'active' AND ca.expires_at > NOW()
                LIMIT 1""",
            client_id,
            feature_slug,
        )
    )


async def get_tariff_features(db, tariff_slug: str) -> list[str]:
    """Список фич произвольного тарифа (для отображения в UI/админке)."""
    rows = await db.fetch(
        """SELECT f.slug
             FROM tariff_features tf
             JOIN tariffs  t ON t.id = tf.tariff_id
             JOIN features f ON f.id = tf.feature_id
            WHERE t.slug = $1
            ORDER BY f.sort, f.slug""",
        tariff_slug,
    )
    return [r["slug"] for r in rows]
