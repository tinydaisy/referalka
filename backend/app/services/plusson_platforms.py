"""Площадки ПЛЮСОНа, которые показываем клиентам, — ОДНА точка на весь проект.

⚠️⚠️ ВСЕ МЕСТА, где клиенту достаётся бот платформы, спрашивают площадки
ЗДЕСЬ. Своего списка не заводить и по таблицам не ходить — иначе места
разъезжаются, что уже и случилось (20.09.2026): в ссылках Плюсоновского
подарка ВК был, в «Партнёрке ПЛЮСОНа» его не было вовсе (ссылки склеивались
руками в `api/referrals.py`), а «Написать в тех.поддержку» держала список
ЗАХАРДКОЖЕННЫМ во фронте (`web/src/lib/support.ts`). Три места — три разных
ответа на один вопрос.

Сейчас отсюда питаются:
  • ссылки Плюсоновского лид-магнита (`plusson_ref_links`), а через них —
    переход `/m/{slug}` и выдача подарка внутри воронки;
  • «Партнёрка ПЛЮСОНа» — реф-ссылки клиента (`api/referrals.py`);
  • «Написать в тех.поддержку» и публичная `/support` (`api/support_public.py`).

ПРАВИЛО ОТБОРА — пересечение настройки и факта:
  площадка отмечена в админке  И  у платформы есть на ней бот (handle + токен).
Галочка без живого бота дала бы битую ссылку, а живой бот без галочки —
площадку, которую выключили сознательно (так сейчас с ВК).
"""
from __future__ import annotations

import asyncpg

# Порядок показа везде один: Telegram, MAX, ВК. Задаётся здесь, а не в каждом
# шаблоне, — иначе в подарке один порядок, а в поддержке другой.
PLATFORM_ORDER = ("telegram", "max", "vk")

# Названия площадок для человека. ⚠️ Цвета и логотипы живут во фронте
# (`PlatformLogo` / `PLATFORM_COLORS`) — дублировать их сюда нельзя, иначе
# синий Telegram снова станет «примерно похожим» в каждом месте.
PLATFORM_LABEL = {"telegram": "Telegram", "max": "MAX", "vk": "ВКонтакте"}

# Запасной ник телеграм-бота: он у платформы один и не перевыпускается. Нужен
# на случай, когда карточки канала в базе нет вовсе — ссылка всё равно рабочая.
FALLBACK_TG_HANDLE = "pluson_bot"


async def enabled_platforms(db: asyncpg.Connection) -> list[str]:
    """Что отмечено в админке (миграция 476). Живость бота НЕ проверяется."""
    row = await db.fetchval(
        "SELECT plusson_platforms FROM platform_settings WHERE id = 1")
    if row is None:
        # Строки настроек нет (пустая база, тесты) — ведём себя как «Telegram и
        # MAX включены»: это состояние по умолчанию из миграции.
        return ["telegram", "max"]
    return [p for p in PLATFORM_ORDER if p in set(row)]


async def platform_channels(db: asyncpg.Connection) -> list[dict]:
    """Боты ПЛЮСОНа, которые реально показываем: `[{slug, handle, title}]`.

    В списке только площадки, которые отмечены в админке И у которых есть
    живой бот. Порядок — `PLATFORM_ORDER`, один и тот же везде.

    ⚠️ ОБЯЗАТЕЛЬНО `bot_token <> ''`. У сервисного клиента встречается карточка
    канала БЕЗ токена — бот за ней фактически не заведён, его вебхук не
    резолвится, и ссылка молча ведёт в пустоту.

    ⚠️ Сервисный клиент в приоритете, но при отсутствии у него живого бота
    падаем на любой другой бот ПЛЮСОНа: и реф-код, и обращение в поддержку
    разбираются в ЛЮБОМ боте платформы, поэтому ссылка остаётся рабочей.
    """
    enabled = await enabled_platforms(db)
    if not enabled:
        return []

    rows = await db.fetch(
        """SELECT DISTINCT ON (ch.platform_slug)
                  ch.platform_slug, ch.handle, ch.display_name
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
             JOIN clients cl ON cl.id = cc.client_id
            WHERE ch.platform_slug = ANY($1::text[])
              AND COALESCE(ch.handle, '') <> ''
              AND COALESCE(ch.bot_token, '') <> ''
            ORDER BY ch.platform_slug, cl.is_system_service DESC,
                     cc.is_active DESC, ch.id""",
        enabled,
    )
    found = {r["platform_slug"]: {
        "slug": r["platform_slug"],
        "handle": (r["handle"] or "").lstrip("@"),
        "title": r["display_name"] or PLATFORM_LABEL.get(r["platform_slug"], ""),
    } for r in rows}

    # Телеграм-бот у платформы один и тот же всегда — если карточки канала не
    # оказалось, ссылка на него всё равно верная.
    if "telegram" in enabled and "telegram" not in found:
        found["telegram"] = {"slug": "telegram", "handle": FALLBACK_TG_HANDLE,
                             "title": PLATFORM_LABEL["telegram"]}

    return [found[p] for p in PLATFORM_ORDER if p in found]


async def platform_handles(db: asyncpg.Connection) -> dict[str, str]:
    """`{площадка: ник бота}` — те же площадки, что и в `platform_channels`."""
    return {c["slug"]: c["handle"] for c in await platform_channels(db)}


def bot_link(platform: str, handle: str, payload: str) -> str:
    """Ссылка в бот ПЛЮСОНа с payload.

    ⚠️ У ВКонтакте payload приходит параметром `ref`, а не `start`: формат
    ссылки на сообщество другой, чем у ботов TG и MAX. Собираем здесь, чтобы
    это знание не расползлось по вызывающим.
    """
    from app.services.share_links import TG_DOMAIN

    h = (handle or "").lstrip("@")
    if platform == "telegram":
        return f"https://{TG_DOMAIN}/{h}?start={payload}"
    if platform == "max":
        return f"https://max.ru/{h}?start={payload}"
    if platform == "vk":
        return f"https://vk.me/{h}?ref={payload}"
    return ""


async def platform_links(db: asyncpg.Connection, payload: str) -> dict[str, str]:
    """`{площадка: ссылка в бот ПЛЮСОНа с этим payload}` — уже отфильтровано."""
    return {p: bot_link(p, h, payload)
            for p, h in (await platform_handles(db)).items()}
