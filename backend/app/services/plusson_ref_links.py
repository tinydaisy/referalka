"""
Реф-ссылки на боты САМОГО ПЛЮСОНА — одна точка сборки.

Нужны в двух местах сразу: раздел «Партнёрка ПЛЮСОНа» в кабинете (клиент
копирует ссылку руками) и подарок «Доступ к ПЛЮСОНу» в воронке лид-магнитов
(ссылка подставляется сама, под площадку человека). Две копии этой сборки
разъехались бы: у одной обновили бы ник бота, у другой забыли — и половина
ссылок повела бы в никуда.

⚠️⚠️ ССЫЛКА ВЕДЁТ В БОТ, А НЕ НА САЙТ. Человек сидит в мессенджере: переход на
сайт выбрасывает его из привычной среды, а бот — это ещё и подписка, то есть
он остаётся достижим. Веб-ссылка нужна только там, где мессенджера нет вовсе.

⚠️ Payload `ref<код>` — ОДИН формат на все площадки, и ветку его разбора обязан
иметь бот КАЖДОЙ. Показывать ссылку на площадку, где разбора нет, нельзя: код
молча теряется, и приведённый человек не засчитывается никому.
"""
from __future__ import annotations

from app.services.share_links import TG_DOMAIN

# Ник телеграм-бота ПЛЮСОНа. ⚠️ В отличие от MAX и VK, он захардкожен
# намеренно: это бот самой платформы, он один и не перевыпускается — а лишний
# запрос в базу тут пришлось бы делать на каждую выдачу подарка.
PLUSON_TG_BOT = "pluson_bot"


async def plusson_bot_handle(db, platform: str) -> str:
    """Ник бота ПЛЮСОНа на площадке (`max` / `vk`). Пусто — бота нет.

    ⚠️ ОБЯЗАТЕЛЬНО `bot_token <> ''`. У сервисного клиента встречается карточка
    канала БЕЗ токена — бот за ней фактически не заведён, его вебхук не
    резолвится, и ссылка молча ведёт в пустоту.

    ⚠️ Сервисный клиент в приоритете, но при отсутствии у него живого бота
    падаем на любой другой бот ПЛЮСОНа: реф-код разбирается в ЛЮБОМ боте
    платформы, поэтому ссылка остаётся рабочей.
    """
    return await db.fetchval(
        """SELECT ch.handle
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
             JOIN clients cl ON cl.id = cc.client_id
            WHERE ch.platform_slug = $1
              AND COALESCE(ch.handle, '') <> ''
              AND COALESCE(ch.bot_token, '') <> ''
            ORDER BY cl.is_system_service DESC, cc.is_active DESC, ch.id
            LIMIT 1""",
        platform,
    ) or ""


async def plusson_ref_links(db, ref_code: str, source: str | None = None) -> dict[str, str]:
    """Все ссылки на боты ПЛЮСОНа с реф-кодом: `{telegram, max, vk}`.

    Ключа нет, если бота на площадке нет или у него пустой токен.

    `source` — чем привели человека (`plusson_lm` у Плюсоновского лид-магнита).
    ⚠️ Дописывается в САМ payload, а не отдельным параметром ссылки: у ВК и MAX
    лишние параметры до бота не доезжают вовсе, а payload доезжает всегда — он
    и есть то единственное, что площадка передаёт боту.
    """
    code = (ref_code or "").strip()
    if not code:
        return {}

    from app.services.plusson_referral import plusson_ref_payload
    pl = plusson_ref_payload(code, source)

    links = {"telegram": f"https://{TG_DOMAIN}/{PLUSON_TG_BOT}?start={pl}"}

    h = await plusson_bot_handle(db, "max")
    if h:
        links["max"] = f"https://max.ru/{h.lstrip('@')}?start={pl}"

    # ⚠️ У ВКонтакте payload приходит параметром `ref`, а не `start`: формат
    # ссылки на сообщество другой, чем у ботов TG и MAX.
    h = await plusson_bot_handle(db, "vk")
    if h:
        links["vk"] = f"https://vk.me/{h.lstrip('@')}?ref={pl}"

    return links


async def plusson_ref_link(db, ref_code: str, platform: str = "telegram",
                           source: str | None = None) -> str:
    """Ссылка (или список ссылок) на бот ПЛЮСОНа — по площадке человека.

    ⚠️⚠️ ПРАВИЛО ТО ЖЕ, ЧТО У ВСЕХ ПОДАРКОВ (`pick_gift_funnel_link`), и оно
    здесь переиспользуется, а не переписано заново:
      • есть бот на площадке человека → ТОЛЬКО эта ссылка, без подписи —
        он уже в этом мессенджере, выбор ему предлагать незачем;
      • площадка неизвестна (пришёл из ВЕБ-КАБИНЕТА) или бота на ней нет →
        ВСЕ ссылки, каждая с подписью «Через Телеграм» / «Через МАКС» / «Через
        ВК», чтобы человек выбрал свой мессенджер сам.

    Своя логика выбора здесь была бы ошибкой: наш подарок стоит в одном списке
    с остальными, и вести себя должен так же — иначе человек видит рядом два
    разных поведения и не понимает, почему.
    """
    from app.services.share_links import pick_gift_funnel_link

    code = (ref_code or "").strip()
    if not code:
        return ""

    links = await plusson_ref_links(db, code, source)
    # ⚠️ Ботов нет ни на одной площадке (все отключены / без токена) → ведём на
    # САЙТ платформы с тем же реф-кодом. Пустая строка означала бы подарок без
    # ссылки, а сайт хотя бы доводит человека до регистрации — код лендинг
    # пробрасывает в форму сам.
    # ⚠️ Адрес через `platform_base_url()`, а НЕ литералом: это адрес САМОЙ
    # платформы, и он живёт в одном месте (правило проекта — литералов
    # `pluson.ru` в коде быть не должно).
    from app.services.client_domains import platform_base_url
    web = f"{platform_base_url().rstrip('/')}/?pid={code}"
    if source:
        web += f"&src={source}"
    if not links:
        return web
    return pick_gift_funnel_link(links, (platform or "").lower()) or web
