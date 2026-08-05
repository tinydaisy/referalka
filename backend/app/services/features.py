"""
Helpers для работы с фичами тарифа.

Фича-набор клиента собирается из ТРЁХ источников (см. `_CLIENT_FEATURES_SQL`):
  1. тариф активной подписки  → tariff_features
  2. купленный модуль         → client_addons
  3. вложенные фичи модуля    → feature_bundles (миграция 267)

Третий источник нужен, чтобы модуль мог приносить с собой возможности другого
тарифа: Коллабораторная даёт безлимитные чаты рассылок (`broadcast_chats`), но
у остальных клиентов на Профи безлимита не появляется.

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


# ⚠️ Источники фич клиента — ОДИН SQL на оба хелпера (список и проверка одной
# фичи). Держать их врозь нельзя: разойдутся, и раздел откроется по одному
# правилу, а список фич в /auth/me покажет другое.
#
# Три источника, объединяются:
#   1. тариф активной подписки (tariff_features) — база;
#   2. купленный модуль (client_addons) — расширение лично на клиенте;
#   3. фичи, которые ПРИНОСИТ С СОБОЙ купленный модуль (feature_bundles,
#      миграция 267). Например Коллабораторная даёт безлимитные чаты рассылок,
#      не отдавая их всем на Профи.
#
# Разворот bundle — один уровень (фича из bundle сама bundle не разворачивает).
_CLIENT_FEATURES_SQL = """
    SELECT f.slug
      FROM client_subscriptions cs
      JOIN tariff_features tf ON tf.tariff_id = cs.tariff_id
      JOIN features f         ON f.id = tf.feature_id
     WHERE cs.client_id = $1
       AND cs.status = 'active' AND cs.expires_at > NOW()
     UNION
    SELECT f.slug
      FROM client_addons ca
      JOIN features f ON f.id = ca.feature_id
     WHERE ca.client_id = $1
       AND ca.status = 'active' AND ca.expires_at > NOW()
     UNION
    SELECT f.slug
      FROM client_addons ca
      JOIN feature_bundles fb ON fb.feature_id = ca.feature_id
      JOIN features f         ON f.id = fb.included_feature_id
     WHERE ca.client_id = $1
       AND ca.status = 'active' AND ca.expires_at > NOW()
     UNION
    SELECT f.slug
      FROM client_subscriptions cs
      JOIN tariff_features tf  ON tf.tariff_id = cs.tariff_id
      JOIN feature_bundles fb  ON fb.feature_id = tf.feature_id
      JOIN features f          ON f.id = fb.included_feature_id
     WHERE cs.client_id = $1
       AND cs.status = 'active' AND cs.expires_at > NOW()
"""


async def get_client_features(db, client_id: int) -> list[str]:
    """Список slug-ов фич у клиента (тариф + модули + вложенные фичи модулей)."""
    rows = await db.fetch(
        f"SELECT slug FROM ({_CLIENT_FEATURES_SQL}) s ORDER BY slug",
        client_id,
    )
    return [r["slug"] for r in rows]


async def client_has_feature(db, client_id: int, feature_slug: str) -> bool:
    """True если фича есть у клиента — в тарифе, как купленный модуль ИЛИ как
    вложенная фича купленного модуля (feature_bundles).

    Один и тот же SQL, что и у `get_client_features` — иначе список фич и
    проверка доступа к разделу могли бы разойтись.
    """
    return bool(
        await db.fetchval(
            f"SELECT 1 FROM ({_CLIENT_FEATURES_SQL}) s WHERE s.slug = $2 LIMIT 1",
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
