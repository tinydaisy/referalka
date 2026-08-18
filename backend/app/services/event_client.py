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

**Правило выбора (решение владельца, уточнено 2026-08-18):**
  1. **ГДЕ ЧЕЛОВЕК СЕЙЧАС СИДИТ** — чей бот открыт, чьё Mini App. Это главнее
     всего: он пришёл к конкретному организатору и работает в его контексте.
  2. Контекста нет (веб-страница, письмо, вебхук) → база, где контакт уже есть.
  3. Нет и контакта → кто привёл (реф-код из ссылки).
  4. Ничего из этого → как передали (владелец события).

⚠️ Реф-код НЕ первый. Он отвечает на другой вопрос — «кто привёл», — и не
должен перебивать то, в чьём приложении человек находится прямо сейчас.
Пока он стоял первым, человек, когда-то пришедший по ссылке одного
организатора, сидя в приложении второго получал сообщения от бота первого и
заводил у него второй контакт.

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


async def event_owner_client_ids(db, event_id: int) -> list[int]:
    """Все организаторы события (принявшие приглашение), в обычном порядке."""
    rows = await db.fetch(
        """SELECT eo.client_id FROM event_owners eo
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY (eo.role = 'owner') DESC, eo.id""",
        event_id,
    )
    return [r["client_id"] for r in rows]


async def share_web_contact_with_all_owners(
    db, *, event_id: int, platform_slug: str, platform_user_id: str,
    username: str | None = None, first_name: str | None = None,
    last_name: str | None = None, email: str | None = None, phone: str | None = None,
) -> None:
    """Записать человека в базу КАЖДОГО организатора коллабы.

    ⚠️ ТОЛЬКО ОДИН СЛУЧАЙ: человек зарегистрировался на ВЕБ-СТРАНИЦЕ события —
    не через бота, не через Mini App, без реф-кода. То есть неизвестно, чей он.
    Организаторы равноправны, и отдавать такого создателю события неправильно
    (решение владельца, 2026-08-18).

    ⚠️ Только ПОСЛЕ регистрации: до неё о человеке нет ничего — ни почты, ни
    телефона, записывать нечего.

    ⚠️ Что реально получит второй организатор: карточку контакта с почтой и
    телефоном. НАПИСАТЬ он по ней не сможет, пока человек сам не запустит его
    бота — это ограничение мессенджеров, а не наше. Поэтому смысл записи —
    почта и телефон, а не переписка.

    ⚠️ НЕ звать, когда контекст есть (бот, Mini App, реф-код): там человек
    принадлежит конкретному организатору, у каждого своя база.

    Идемпотентно; ошибки глушим — это дополнение к регистрации, а не её часть.
    """
    try:
        if not await db.fetchval("SELECT is_collab FROM events WHERE id = $1", event_id):
            return
        owner_ids = await event_owner_client_ids(db, event_id)
        if len(owner_ids) < 2:
            return
        from app.services.contact_merge import upsert_contact_with_identity
        for cid in owner_ids:
            try:
                await upsert_contact_with_identity(
                    db, client_id=cid,
                    platform_slug=platform_slug,
                    platform_user_id=str(platform_user_id),
                    username=username, first_name=first_name, last_name=last_name,
                    email=email, phone=phone,
                )
            except Exception:
                logger.warning(
                    "share_web_contact: не удалось записать контакт клиенту %s (event=%s)",
                    cid, event_id,
                )
    except Exception:
        logger.exception("share_web_contact_with_all_owners failed: event=%s", event_id)


async def resolve_event_client(
    db, *, event_id: int, client_id: int,
    partner_id: Optional[str] = None,
    source_client_id: Optional[int] = None,
    contact_id: Optional[int] = None,
    platform_slug: Optional[str] = None,
    platform_user_id: Optional[str] = None,
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

        # ⚠️⚠️ ПОРЯДОК ВАЖЕН: ПЕРВЫМ — ГДЕ ЧЕЛОВЕК СЕЙЧАС СИДИТ.
        # Он открыл бота/Mini App конкретного организатора — значит работаем в
        # ЕГО контексте, и ничто это не перебивает. Раньше первым шёл реф-код,
        # и человек, когда-то пришедший по ссылке Лилии, сидя в приложении
        # Нурии всё равно уезжал к Лилии: ему писал её бот, ссылки вели в её
        # кабинет, а в базе заводился второй контакт (прод, 2026-08-18).
        #
        # Реф-код и старый контакт отвечают на ДРУГОЙ вопрос — «кто привёл» и
        # «где он уже есть». К тому, в чьём приложении он сейчас, отношения
        # они не имеют.
        if source_client_id is None:
            try:
                from app.middleware.app_client import get_app_client_id
                source_client_id = get_app_client_id()
            except Exception:
                source_client_id = None
        if await is_event_owner(db, event_id, source_client_id):
            return source_client_id

        # 2) Контекста «где сидит» нет (веб-страница, письмо, вебхук) — тогда
        #    берём базу, в которой контакт человека уже лежит.
        if contact_id:
            by_contact = await db.fetchval(
                "SELECT client_id FROM contacts WHERE id = $1", contact_id)
            if await is_event_owner(db, event_id, by_contact):
                return by_contact

        # 2.5) Контакт не передали, но известен ID человека НА ПЛОЩАДКЕ —
        # находим его УЖЕ СУЩЕСТВУЮЩЕЕ участие в этом событии и берём базу
        # оттуда. Самый надёжный признак после «где сидит»: не зависит ни от
        # ссылки, ни от того, каким запросом пришли. Человек уже был в событии —
        # значит организатор у него определён, и менять его нельзя.
        if platform_slug and platform_user_id:
            by_participation = await db.fetchval(
                """SELECT c.client_id
                     FROM event_participants ep
                     JOIN contacts c ON c.id = ep.contact_id
                     JOIN platform_users pu
                       ON pu.contact_id = c.id
                      AND pu.platform_slug = $2
                      AND pu.platform_user_id = $3
                     JOIN event_owners eo
                       ON eo.client_id = c.client_id
                      AND eo.event_id = $1
                      AND eo.status = 'accepted'
                    WHERE ep.event_id = $1
                    ORDER BY ep.is_registered DESC, ep.id
                    LIMIT 1""",
                event_id, platform_slug, str(platform_user_id),
            )
            if by_participation:
                return by_participation

        # 3) Совсем нет контекста (веб-ссылка без кода контакта, вебхук) —
        #    последняя зацепка: чей реф-код в ссылке.
        #    ⚠️ Реф-код нужен для СТАТИСТИКИ «кто привёл», а не для выбора базы.
        #    Смотрим на него только когда неизвестно ни где человек сидит, ни
        #    где его контакт: лучше отдать тому, кто привёл, чем «первому
        #    владельцу» по порядку строк.
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

        return client_id
    except Exception:
        # Сбой определения не должен ронять заход человека в событие.
        logger.exception("resolve_event_client failed: event=%s", event_id)
        return client_id
