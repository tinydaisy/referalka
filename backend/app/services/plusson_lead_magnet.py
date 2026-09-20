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
                  plusson_lm_visibility, plusson_lm_link_mode
             FROM platform_settings WHERE id = 1"""
    )
    return {
        "name": (row["plusson_lm_name"] if row else None) or DEFAULT_NAME,
        "description": (row["plusson_lm_description"] if row else None) or "",
        "delivery": (row["plusson_lm_delivery"] if row else None) or "direct",
        "visibility": (row["plusson_lm_visibility"] if row else None) or "testing",
        "link_mode": (row["plusson_lm_link_mode"] if row else None) or "both",
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
               VALUES ($1, $2, $3, $4, $5, $7, $6, 'plusson_self', TRUE)
               RETURNING id""",
            client_id, st["name"], st["description"] or None,
            URL_PLACEHOLDER, slug, BUTTON_LABEL, st["link_mode"],
        )
    except asyncpg.UniqueViolationError:
        # Гонка: параллельный вызов успел раньше — берём его экземпляр.
        return await db.fetchval(
            "SELECT id FROM lead_magnets WHERE client_id = $1 AND is_plusson", client_id
        )


async def sync_all(db: asyncpg.Connection, name: str, description: Optional[str],
                   link_mode: str = "both") -> int:
    """Разнести настройки платформы по всем экземплярам. Вернёт число строк.

    ⚠️ Переписываем БЕЗУСЛОВНО, а не только там, где текст совпадал со старым:
    клиент мог поправить его у себя в кабинете (форма это запрещает, но правка
    могла приехать и старым запросом). Текст платформенный — правки клиента по
    нему не сохраняются осознанно.
    """
    res = await db.execute(
        """UPDATE lead_magnets
              SET name = $1, description = $2, link_mode = $3, updated_at = NOW()
            WHERE is_plusson""",
        name, description or None, link_mode if link_mode in ("button", "both") else "both",
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

    ⚠️⚠️ В режиме `direct` это ПРЯМЫЕ ССЫЛКИ НА БОТЫ ПЛЮСОНа, без нашего домена
    (решение владельца 20.09.2026). Сначала отдавали `pluson.ru/m/{slug}?to=…` —
    наш переход, который считал клик и уводил дальше. Отказались: подарок ведёт
    в бот платформы, и лишний прыжок через сайт тут только теряет людей —
    у части браузер открывает страницу вместо мессенджера.

    ⚠️ Цена решения: клик минует наш сервер, и «сколько перешло» считать
    нечем. Поэтому счётчик считает не клики, а ДОШЕДШИХ ДО БОТА
    (`plusson_reach`) — это и честнее: клик по ссылке ещё ничей.

    ⚠️⚠️ `build_funnel_landing_links` годится ТОЛЬКО для режима `funnel`. Она
    отдаёт deeplink в бот КЛИЕНТА по его площадкам — что и нужно, когда подарок
    выдаётся через его воронку. В прямом режиме это увело бы человека к клиенту
    вместо ПЛЮСОНа, а у клиента без ботов ссылок не было бы вовсе.
    """
    st = await get_settings(db)
    if st["delivery"] != "direct":
        from app.services.share_links import build_funnel_landing_links
        return await build_funnel_landing_links(
            db, client_id=client_id, slug=slug, kind='m', base_url=base_url)

    from app.services.plusson_ref_links import plusson_ref_links

    code = await db.fetchval(
        "SELECT referral_code FROM clients WHERE id = $1", client_id) or ""
    return await plusson_ref_links(db, code, SOURCE_CODE)


async def reach_count(db: asyncpg.Connection, client_id: int) -> int:
    """Сколько человек дошло до бота ПЛЮСОНа по подарку ЭТОГО клиента.

    ⚠️ Считаем по КОНТАКТАМ, а не по забегам воронки: в прямом режиме ссылка
    ведёт в бот платформы мимо нашего сайта, и забега не возникает вовсе.
    Контакт же появляется ровно тогда, когда человек нажал «Старт» в боте
    ПЛЮСОНа, — то есть считается не клик, а пришедший человек.

    ⚠️ Метка `plusson_referrer_source` отделяет пришедших С ПОДАРКА от пришедших
    по обычной реф-ссылке клиента: код в обоих случаях один и тот же.
    """
    code = await db.fetchval(
        "SELECT referral_code FROM clients WHERE id = $1", client_id)
    if not code:
        return 0
    return int(await db.fetchval(
        """SELECT count(*) FROM contacts
            WHERE plusson_referrer_code = $1
              AND plusson_referrer_source = $2""",
        code, SOURCE_CODE) or 0)


async def fill_gift_links(db: asyncpg.Connection, gifts: list[dict], *,
                          referrer_code: str = "",
                          prefer_platform: Optional[str] = None) -> None:
    """Проставить ссылки подаркам, которые ведут в бот ПЛЮСОНа. Меняет на месте.

    ⚠️⚠️ ОДНА ФУНКЦИЯ НА ВСЕ ВИТРИНЫ. Подарки участнику показывают Mini App
    (`api/gifts.py`) и веб-страница события (`api/event_page_html.py`), и обе
    отдавали `{plsn_bot}` СТРОКОЙ КАК ЕСТЬ: плейсхолдер раскрывался только при
    выдаче в боте (`funnel_service`). Фронт открывал его как относительный
    адрес, и человек попадал на «Не удалось загрузить событие». У самого
    Плюсоновского подарка `url` пустой вовсе — ссылка собирается из
    `link_source`, и пустое поле выглядело так же.

    Ждёт в каждом подарке: `link_source`, `is_plusson`, `link_url`,
    `lm_client_id`. Проставляет `platform_links`, `web_url`, `link_url`.

    `referrer_code` — код рефовода зрителя (режим `plusson_referrer`).
    `prefer_platform` — площадка, с которой пришёл человек: её ссылка ставится
    в `link_url`. Неизвестна — берём первую включённую, а фронт покажет выбор
    по `platform_links`.
    """
    targets = [g for g in gifts
               if (g.get("link_source") or "").startswith("plusson_")
               or URL_PLACEHOLDER in (g.get("link_url") or "")]
    if not targets:
        return

    from app.services.plusson_ref_links import plusson_ref_links
    from app.services.client_domains import platform_base_url

    for g in targets:
        src = g.get("link_source") or ""
        owner_code = await db.fetchval(
            "SELECT referral_code FROM clients WHERE id = $1", g.get("lm_client_id")) or ""
        # ⚠️ «Ссылка рефовода» — с ЗАПАСНЫМ вариантом на владельца: рефовода
        # может не быть или он не клиент ПЛЮСОНа, и тогда код никуда не
        # резолвится. Подарок без ссылки хуже, чем подарок, приведший человека
        # владельцу.
        code = (referrer_code or owner_code) if src == "plusson_referrer" else owner_code

        # ⚠️ Площадки спрашиваем у общей функции: какие показывать, решает
        # админка (миграция 476), и знать это витрине неоткуда.
        # Метка источника — только у самого Плюсоновского подарка: по ней
        # пришедшие с него отличаются в партнёрке от пришедших по обычной
        # реф-ссылке, код-то один и тот же.
        links = await plusson_ref_links(
            db, code, SOURCE_CODE if g.get("is_plusson") else None)

        # Запасной адрес — сайт платформы с тем же кодом: включённых ботов
        # может не остаться вовсе, а пустая кнопка хуже сайта.
        web = ""
        if code:
            web = f"{platform_base_url().rstrip('/')}/?pid={code}"
            if g.get("is_plusson"):
                web += f"&src={SOURCE_CODE}"

        one = (links.get(prefer_platform) if prefer_platform else None) \
            or next(iter(links.values()), "") or web

        g["platform_links"] = links
        g["web_url"] = web
        url = g.get("link_url") or ""
        g["link_url"] = (url.replace(URL_PLACEHOLDER, one)
                         if URL_PLACEHOLDER in url else (url or one))
