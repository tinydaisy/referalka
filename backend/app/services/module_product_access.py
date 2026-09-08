"""Модуль куплен → открылся доступ к урокам по нему.

Зачем это отдельный файл. Уроки по модулю (сейчас — «Коллабораторная») лежат
продуктом в кабинете СИСТЕМНОГО клиента, а купивший модуль — это строка в
`clients`, то есть другая сущность и другая база. Связи между ними в проекте
не было: файлы, работающие с `client_addons`, и файлы, работающие с
`product_access`, не пересекались ни одним файлом.

⚠️ Вебхука здесь нет и не нужно. Оба кабинета живут в одной базе и в одном
процессе `plusson-api`: HTTP-запрос самому себе добавил бы сетевой сбой,
вторую транзакцию и открытый наружу URL — ради того, что делается вызовом
функции в той же транзакции.

⚠️ Точек вызова ДВЕ, и обе обязательны — иначе один из путей покупки молча
останется без уроков:
  1. `_apply_paid_addon_order` — клиент купил модуль в кабинете ПЛЮСОНа;
  2. `activate_coupon` — перешёл по ссылке из письма (модуль подарен тарифом
     события).
При добавлении третьего пути выдачи модуля — звать эту функцию, а не писать
свой INSERT.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)

# Какому модулю какой продукт открывает доступ.
# ⚠️ Ключ — slug фичи, значение — slug продукта В КАБИНЕТЕ СИСТЕМНОГО клиента.
# Новый обучающий продукт под модуль = строка сюда, без правок кода.
MODULE_PRODUCTS: dict[str, str] = {
    "collab_hub": "collab-hub",
}


async def grant_module_product_access(
    db: asyncpg.Connection,
    *,
    client_id: int,
    feature_slug: Optional[str],
    expires_at: Optional[datetime],
) -> Optional[int]:
    """Открывает клиенту доступ к урокам по купленному модулю.

    `expires_at` — срок САМОГО модуля: доступ к урокам живёт ровно столько же
    (решение владельца «пока модуль активен»). None здесь означало бы
    «бессрочно», поэтому при неизвестном сроке доступ не выдаём вовсе.

    Возвращает id строки `product_access` или None, если выдавать нечего.

    ⚠️ Никогда не бросает исключение: деньги за модуль уже приняты, и сбой
    выдачи уроков не должен откатывать оплату. Проблема уходит в лог.
    """
    if not feature_slug:
        return None
    product_slug = MODULE_PRODUCTS.get(feature_slug)
    if not product_slug:
        return None

    try:
        return await _grant(
            db, client_id=client_id, product_slug=product_slug, expires_at=expires_at
        )
    except Exception as e:  # noqa: BLE001 — модуль уже выдан, падать нельзя
        logger.exception(
            "module product access failed (client %s, feature %s): %s",
            client_id, feature_slug, e,
        )
        return None


async def _grant(
    db: asyncpg.Connection,
    *,
    client_id: int,
    product_slug: str,
    expires_at: Optional[datetime],
) -> Optional[int]:
    # 1. Продукт с уроками — в кабинете системного клиента («ПЛЮСОН Сервис»).
    #    Ищем по флагу, а не по id 3: id — деталь текущей базы.
    row = await db.fetchrow(
        """SELECT p.id AS product_id, p.client_id AS owner_id
             FROM products p
             JOIN clients c ON c.id = p.client_id
            WHERE c.is_system_service = TRUE AND p.slug = $1
            LIMIT 1""",
        product_slug,
    )
    if not row:
        # Продукт ещё не заведён — это не ошибка оплаты, просто пока нечего
        # открывать. Модуль клиент получил.
        logger.info(
            "module product access: продукта '%s' у системного клиента нет — пропуск",
            product_slug,
        )
        return None

    # 2. Кто этот человек в базе владельца уроков. Покупатель модуля — клиент
    #    ПЛЮСОНа, а `product_access` висит на контакте, поэтому заводим его
    #    контактом по той почте, которой он зарегистрирован в кабинете.
    buyer = await db.fetchrow(
        "SELECT email, name, phone FROM clients WHERE id = $1", client_id
    )
    email = (buyer["email"] or "").strip().lower() if buyer else ""
    if not email:
        logger.warning(
            "module product access: у клиента %s нет почты — доступ не выдан", client_id
        )
        return None

    from app.services.contact_merge import upsert_contact_with_identity

    contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
        db,
        client_id=row["owner_id"],
        platform_slug="email",
        platform_user_id=email,
        first_name=(buyer["name"] or None),
        email=email,
        phone=(buyer["phone"] or None),
    )

    # 3. Сам доступ.
    # ⚠️ `expires_at` перезаписывается, а не продлевается — срок берётся у
    #    модуля, который к этому моменту уже посчитан с учётом продления.
    #    Прибавлять здесь второй раз значило бы удвоить подаренные дни.
    # ⚠️ `revoked_at = NULL` — повторная покупка возвращает доступ, если его
    #    когда-то закрывали вручную.
    access_id = await db.fetchval(
        """INSERT INTO product_access
               (product_id, contact_id, source, expires_at)
           VALUES ($1, $2, 'manual', $3)
           ON CONFLICT (product_id, contact_id)
           DO UPDATE SET expires_at       = EXCLUDED.expires_at,
                         revoked_at       = NULL,
                         expiry_warned_at = NULL
           RETURNING id""",
        row["product_id"], contact_id, expires_at,
    )

    if access_id:
        from app.services.product_access import log_access_event

        await log_access_event(
            db, access_id, "granted", actor="system",
            detail=("модуль, бессрочно" if expires_at is None
                    else f"модуль, до {expires_at:%d.%m.%Y}"),
        )
    return access_id
