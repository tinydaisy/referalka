"""В ЧЬЮ БАЗУ попадает человек, пришедший на событие. ЕДИНАЯ ТОЧКА.

⚠️⚠️ ГЛАВНОЕ ПРАВИЛО. Клиент события НИКОГДА не выбирается запросом
«первый из event_owners» там, где речь о ЧЕЛОВЕКЕ — его контакте, регистрации,
реф-коде или боте, которым ему пишут. Для этого есть `resolve_event_client`.

**Почему.** У обычного события владелец один, и «первый из списка» = он же —
всё сходится. У КОЛЛАБЫ владельцев несколько и они равноправны: суть коллабы
в том, что каждый организатор ведёт СВОЮ базу через СВОЕГО бота. «Первый»
там определяется порядком строк в таблице (роль, затем id), то есть тем, кто
раньше принял приглашение, — к работе с людьми это отношения не имеет.

**Что ломалось** (прод, событие 92, разбор 2026-08-17). Человек шёл по ссылке
одного организатора, а попадал в базу другого:
  • контакт и регистрация уходили не тому организатору;
  • реф-код приведшего искался в ЧУЖОЙ базе, не находился и терялся —
    привлечение не засчитывалось никому;
  • уведомления слал бот постороннего организатора;
  • догрев не находил бота для отправки и умирал с `no_channel`;
  • регистрация и заход расходились по разным базам, и Mini App показывал
    человека незарегистрированным — все вкладки под замками.
Чинилось несколько раз по одной точке и каждый раз всплывало в следующей —
потому что таких мест в бэкенде под девяносто. Отсюда эта единая функция.

**Правило выбора (решение владельца):**
  1. **Реф-код в ссылке** → база того организатора, чей это код. Он привёл —
     ему и вести человека, ему и засчитывается привлечение.
  2. **Реф-кода нет** → база владельца БОТА или MINI APP, через который
     человек зашёл. Он пришёл к конкретному организатору, а не «в событие».
  3. Ни того, ни другого → как передали (владелец события).

Оба кандидата проверяются на участие в событии: иначе по чужому реф-коду или
из чужого бота человека можно было бы увести в постороннюю базу.

⚠️ Обычного события это не касается — там владелец один, и все ветки дают его.
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)


async def is_event_owner(db, event_id: int, client_id: Optional[int]) -> bool:
    """Является ли клиент принявшим приглашение организатором события."""
    if not client_id:
        return False
    return bool(await db.fetchval(
        """SELECT 1 FROM event_owners
            WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'""",
        event_id, client_id,
    ))


async def resolve_event_contact_id_any_owner(
    db, event_id: int, platform: str, platform_user_id,
) -> Optional[int]:
    """contact_id человека в базе ЛЮБОГО организатора события.

    ⚠️ КОЛЛАБА: организаторов несколько и они равноправны, поэтому ищем среди
    ВСЕХ, а не у «первого из event_owners». Человека из базы второго
    организатора иначе просто не находили: contact_id уходил NULL, и дальше по
    цепочке он выглядел незарегистрированным — вкладки под замками, клики и
    статистика анонимные.

    Один tg/vk/max-id живёт у разных клиентов разными контактами, поэтому
    ограничиваемся организаторами события. Предпочтение — участнику события
    (он в нужной базе), затем более свежей идентичности.
    """
    return await db.fetchval(
        """SELECT pu.contact_id FROM platform_users pu
            WHERE pu.platform_slug = $1 AND pu.platform_user_id = $2
              AND pu.client_id IN (SELECT eo.client_id FROM event_owners eo
                                    WHERE eo.event_id = $3 AND eo.status = 'accepted')
            ORDER BY EXISTS (SELECT 1 FROM event_participants ep
                              WHERE ep.event_id = $3 AND ep.contact_id = pu.contact_id) DESC,
                     pu.id DESC
            LIMIT 1""",
        platform, str(platform_user_id), event_id,
    )


async def resolve_event_client(
    db, *, event_id: int, client_id: int,
    partner_id: Optional[str] = None,
    source_client_id: Optional[int] = None,
    contact_id: Optional[int] = None,
) -> int:
    """В чью базу вести человека. Единственный допустимый способ — см. шапку.

    :param client_id:        владелец события (то, что было раньше)
    :param partner_id:       реф-код из ссылки (`pid`), если пришёл
    :param source_client_id: владелец бота / Mini App, через который зашли
    :param contact_id:       контакт человека, если он уже известен — САМЫЙ
                             надёжный признак: контакт лежит в базе того
                             организатора, к которому человек и относится
    """
    try:
        if not await db.fetchval("SELECT is_collab FROM events WHERE id = $1", event_id):
            return client_id

        # 0) Человек уже известен — берём базу, в которой лежит его контакт.
        #    Точнее любого другого признака: ссылку могли переслать, бота
        #    сменить, а контакт у человека в этом событии один.
        if contact_id:
            by_contact = await db.fetchval(
                "SELECT client_id FROM contacts WHERE id = $1", contact_id)
            if await is_event_owner(db, event_id, by_contact):
                return by_contact

        # 1) Кто привёл — по реф-коду из ссылки.
        if partner_id:
            by_ref = await db.fetchval(
                """SELECT c.client_id
                     FROM contacts c
                     JOIN event_owners eo
                       ON eo.client_id = c.client_id
                      AND eo.event_id = $2
                      AND eo.status = 'accepted'
                    WHERE (c.ref_code = $1 OR c.merged_ref_codes ? $1)
                    LIMIT 1""",
                partner_id, event_id,
            )
            if by_ref:
                return by_ref

        # 2) Через чей бот / Mini App зашёл.
        # ⚠️ Если вызывающий не передал явно — берём клиента ОТКРЫТОГО Mini App
        # из заголовка запроса (middleware/app_client.py). Без этого запасного
        # пути человек, зашедший в приложении одного организатора НЕ по ссылке
        # (например, из календаря), уезжал к «первому владельцу»: путей входа
        # много, и передавать клиента в каждом вызове поштучно — то же самое
        # латание, из-за которого баг всплывал снова и снова.
        if source_client_id is None:
            try:
                from app.middleware.app_client import get_app_client_id
                source_client_id = get_app_client_id()
            except Exception:
                source_client_id = None
        if await is_event_owner(db, event_id, source_client_id):
            return source_client_id

        return client_id
    except Exception:
        # Сбой определения не должен ронять заход человека в событие.
        logger.exception("resolve_event_client failed: event=%s", event_id)
        return client_id
