"""
Плюсоновский лид-магнит — платформенный подарок в кабинете КАЖДОГО клиента.

Клиент раздаёт своей аудитории доступ к самому ПЛЮСОНу и получает за пришедших
реферальные начисления. Лид-магнит заводится сам при регистрации, удалить его
нельзя, ссылку настраивать не надо — её собирает сервер в момент выдачи
(режим `plusson_self`, миграция 399): под площадку человека и с реф-кодом
этого клиента.

⚠️⚠️ НАЗВАНИЕ И ОПИСАНИЕ — ОДНИ НА ВСЮ ПЛАТФОРМУ (`platform_settings`), правятся
в админке. Но хранятся они при этом и в самом `lead_magnets`: колонку `name`
читают десятки мест (рассылки, воронки, подарки события, витрина Mini App,
CRM, экспорт), и подменять текст на лету пришлось бы в каждом из них — рано
или поздно где-то забыли бы. Поэтому настройка остаётся единственным местом
ПРАВКИ, а `sync_all` разносит текст по экземплярам разом.

⚠️ Режим выдачи (`plusson_lm_delivery`) касается ТОЛЬКО прямой ссылки
`/m/{slug}`, которую клиент кладёт в сторис или канал:
    direct — человек попадает сразу в бот ПЛЮСОНа, догревает его наша команда
             (решение владельца 20.09.2026: клиент никого не греет);
    funnel — сначала бот клиента, как у обычного лид-магнита.
Когда подарок выдаётся ВНУТРИ бота (за рефералов, в воронке события, в инфо о
бренде), режим ни на что не влияет: человек уже в боте и уже контакт клиента,
ему просто приходит ссылка.
"""
from __future__ import annotations

import logging
from typing import Optional

import asyncpg

log = logging.getLogger(__name__)

# Метка источника: чем именно привели клиента. Живёт в трёх местах — в payload
# реф-ссылки (`ref<код>-lm`), в `contacts.plusson_referrer_source` и в
# `clients.referred_source`. Одна константа на все три, чтобы не разъехались.
SOURCE_CODE = "plusson_lm"

# ⚠️ Запасной текст на случай пустой настройки: лид-магнит без названия
# показался бы клиенту пустой строкой в списке подарков.
DEFAULT_NAME = (
    "20+ готовых тех.решений и Коллабораторная + Продлённый доступ к платформе "
    "«iViSiON: ПЛЮСОН» для привлечения клиентов. Внедряются без тех.спеца сразу "
    "в ТГ, МАХ, ВК."
)

# Надпись на кнопке под сообщением. ⚠️ Короткая: у ВКонтакте предел 40
# символов, и длинную он отвергает вместе со всем сообщением.
BUTTON_LABEL = "Забрать доступ"

# Плейсхолдер вместо адреса: настоящую ссылку подставляет `funnel_service` в
# момент выдачи. Колонка `url` NOT NULL, пустая строка выглядела бы как
# недозаполненный материал (та же логика, что в `_url_for_source`).
URL_PLACEHOLDER = "{plsn_bot}"


async def get_settings(db: asyncpg.Connection) -> dict:
    """Платформенные настройки Плюсоновского лид-магнита.

    Строки настроек может не быть на свежей базе — отдаём значения по
    умолчанию, а не падаем: без них не открылась бы вся админка.
    """
    row = await db.fetchrow(
        """SELECT plusson_lm_name, plusson_lm_description, plusson_lm_delivery,
                  plusson_lm_visibility
             FROM platform_settings WHERE id = 1"""
    )
    return {
        "name": (row["plusson_lm_name"] if row else None) or DEFAULT_NAME,
        "description": (row["plusson_lm_description"] if row else None) or "",
        "delivery": (row["plusson_lm_delivery"] if row else None) or "direct",
        "visibility": (row["plusson_lm_visibility"] if row else None) or "testing",
    }


async def ensure_for_client(db: asyncpg.Connection, client_id: int) -> Optional[int]:
    """Завести Плюсоновский лид-магнит клиенту, если его ещё нет. Вернёт id.

    ⚠️ Зовётся при регистрации и из админки. Повторный вызов безопасен: есть —
    возвращаем существующий, не плодим второй (плюс уникальный индекс
    `lead_magnets_plusson_uidx` как последняя защита от гонки).

    ⚠️ Сбой НЕ должен рвать регистрацию: человек остался бы без кабинета из-за
    подарка. Поэтому вызывающая сторона ловит исключение и идёт дальше. Цена —
    клиент без подарка; чтобы это не осталось незамеченным, админка показывает
    счётчик «Без подарка».
    """
    existing = await db.fetchval(
        "SELECT id FROM lead_magnets WHERE client_id = $1 AND is_plusson", client_id
    )
    if existing:
        return existing

    # ⚠️ Slug — общей функцией, а не своим генератором: иначе ссылки этого
    # подарка отличались бы форматом от всех остальных, и он перестал бы быть
    # обычным лид-магнитом с точки зрения адресов.
    from app.api.lead_magnets import _make_unique_lead_magnet_slug

    st = await get_settings(db)
    slug = await _make_unique_lead_magnet_slug(db)
    try:
        return await db.fetchval(
            """INSERT INTO lead_magnets
                 (client_id, name, description, url, slug, link_mode,
                  button_label, link_source, is_plusson)
               VALUES ($1, $2, $3, $4, $5, 'both', $6, 'plusson_self', TRUE)
               RETURNING id""",
            client_id, st["name"], st["description"] or None,
            URL_PLACEHOLDER, slug, BUTTON_LABEL,
        )
    except asyncpg.UniqueViolationError:
        # Гонка: параллельный вызов успел раньше — берём его экземпляр.
        return await db.fetchval(
            "SELECT id FROM lead_magnets WHERE client_id = $1 AND is_plusson", client_id
        )


async def sync_all(db: asyncpg.Connection, name: str, description: Optional[str]) -> int:
    """Разнести название и описание по всем экземплярам. Вернёт число строк.

    ⚠️ Переписываем БЕЗУСЛОВНО, а не только там, где текст совпадал со старым:
    клиент мог поправить его у себя в кабинете (форма это запрещает, но правка
    могла приехать и старым запросом). Текст платформенный — правки клиента по
    нему не сохраняются осознанно.
    """
    res = await db.execute(
        """UPDATE lead_magnets
              SET name = $1, description = $2, updated_at = NOW()
            WHERE is_plusson""",
        name, description or None,
    )
    try:
        return int(res.rsplit(" ", 1)[1])
    except Exception:  # noqa: BLE001 — формат ответа не критичен
        return 0


async def is_visible_for(db: asyncpg.Connection, client_id: int) -> bool:
    """Показывать ли подарок ЭТОМУ клиенту (миграция 473).

    ⚠️ Прячется ПОКАЗ, а не создание: подарок есть у всех, и переключение на
    «всем» проявляет его разом, не трогая базу. Не создавать его на время
    обкатки было бы хуже — включение означало бы раздачу задним числом, то
    есть новые slug у половины клиентов.

    ⚠️ На обкатке видят АДМИНСКИЙ и СЕРВИСНЫЙ аккаунт, а не список id: сейчас
    это ровно клиенты 1 и 3, но при заведении второго админского кабинета
    список пришлось бы дописывать руками, и об этом никто бы не вспомнил.
    """
    if (await get_settings(db))["visibility"] == "all":
        return True
    return bool(await db.fetchval(
        """SELECT 1 FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             LEFT JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.id = $1
              AND (c.is_system_service OR t.slug = 'admin')""",
        client_id,
    ))


async def share_links(db: asyncpg.Connection, client_id: int, slug: str,
                      base_url: str) -> dict:
    """Ссылки, которые клиент раздаёт аудитории, — по площадкам.

    ⚠️⚠️ НЕ `build_funnel_landing_links`, и это принципиально. Та функция даёт
    deeplink В БОТ КЛИЕНТА (`t.me/{его бот}?start=m_{slug}`) — то есть в обход
    нашего перехода `/m/{slug}`: бот разбирает метку сам и запускает обычную
    воронку. Для этого подарка получилось бы ровно наоборот задуманному —
    человек попадал бы к клиенту вместо ПЛЮСОНа. А у клиента без единого бота
    ссылок не было бы вовсе, хотя раздавать подарок он может и без них.

    Поэтому в режиме `direct` отдаём СВОЙ адрес `/m/{slug}?to=…`: он считает
    переход и уводит в бот ПЛЮСОНа нужной площадки. В режиме `funnel` подарок
    ведёт себя как обычный лид-магнит, и ссылки строит общая функция.

    ⚠️ Площадки берём по ботам ПЛЮСОНа, а не клиента: человек идёт к нам.
    """
    st = await get_settings(db)
    if st["delivery"] != "direct":
        from app.services.share_links import build_funnel_landing_links
        return await build_funnel_landing_links(
            db, client_id=client_id, slug=slug, kind='m', base_url=base_url)

    from app.services.plusson_ref_links import plusson_bot_handle

    base = (base_url or "").rstrip("/")
    links = {"telegram": f"{base}/m/{slug}?to=tg"}
    for platform, param in (("max", "max"), ("vk", "vk")):
        if await plusson_bot_handle(db, platform):
            links[platform] = f"{base}/m/{slug}?to={param}"
    return links
