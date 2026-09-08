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
            JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE pu.platform_slug = $1 AND pu.platform_user_id = $2
              AND c_own.client_id IN (SELECT eo.client_id FROM event_owners eo
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


async def share_contact_with_all_owners(db, *, event_id: int, contact_id: int) -> None:
    """Раздать ПОЧТУ И ТЕЛЕФОН зарегистрировавшегося всем организаторам коллабы.

    Организаторы равноправны и приводят людей вместе, поэтому контактные данные
    участника должны быть у каждого — иначе партнёр, чья аудитория пришла, не
    может даже написать письмо (решение владельца, 2026-08-18).

    ⚠️ ТОЛЬКО почта и телефон. Идентичности мессенджеров (tg_id, vk_id) НЕ
    копируем: человек не запускал бота второго организатора и не разрешал ему
    писать. Насильно привязывать к чужому боту нельзя — это спам и, для VK,
    прямое нарушение правил площадки. Написать партнёр сможет письмом; в бот —
    только если человек сам туда придёт.

    ⚠️ Только ПОСЛЕ регистрации: до неё почты и телефона нет, раздавать нечего.

    ⚠️ СНАЧАЛА ИЩЕМ человека в базе партнёра ПО ПЛОЩАДОЧНЫМ ID (tg/vk/max), и
    только не найдя — заводим новый контакт. Человек мог давно запускать бота
    партнёра: там он лежит без почты, и создание второго контакта по почте дало
    бы ДУБЛЬ вместо дополнения. Поиск по площадочному id надёжнее почты, потому
    что почта у пришедшего из бота может отсутствовать вовсе.

    ⚠️ Дописываем ТОЛЬКО ПУСТОЕ (`COALESCE(NULLIF(...))`): у партнёра могут быть
    свои, более свежие данные, затирать их нельзя.

    Идемпотентно; ошибки глушим — это дополнение к регистрации, а не её часть.
    """
    try:
        # ⚠️ Галочка на СОБЫТИИ (миграция 371). Снята — контакт остаётся только
        # у того, кто привёл: партнёры не всегда готовы отдавать свою базу, и
        # решать это за них платформа не должна. По умолчанию TRUE — как
        # работало до появления настройки.
        ev = await db.fetchrow(
            "SELECT is_collab, collab_share_contacts FROM events WHERE id = $1",
            event_id,
        )
        if not ev or not ev["is_collab"]:
            return
        if ev["collab_share_contacts"] is False:
            return
        owner_ids = await event_owner_client_ids(db, event_id)
        if len(owner_ids) < 2:
            return

        row = await db.fetchrow(
            """SELECT c.id, c.client_id, c.name, c.phone,
                      (SELECT pe.platform_user_id FROM platform_users pe
                        WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                        ORDER BY pe.id LIMIT 1) AS email
                 FROM contacts c WHERE c.id = $1""",
            contact_id,
        )
        if not row:
            return
        email, phone = (row["email"] or "").strip(), (row["phone"] or "").strip()
        if not email and not phone:
            return  # раздавать нечего

        # Площадочные идентичности человека — по ним ищем его у партнёра.
        idents = await db.fetch(
            """SELECT platform_slug, platform_user_id FROM platform_users
                WHERE contact_id = $1 AND platform_slug <> 'email'""",
            contact_id,
        )

        for cid in owner_ids:
            if cid == row["client_id"]:
                continue  # это его собственный контакт
            try:
                # 1) Человек уже есть у партнёра? Ищем по его площадочным id.
                found = None
                for i in idents:
                    found = await db.fetchval(
                        """SELECT pu.contact_id FROM platform_users pu
                            JOIN contacts c_own ON c_own.id = pu.contact_id
                            WHERE c_own.client_id = $1 AND pu.platform_slug = $2
                              AND pu.platform_user_id = $3 LIMIT 1""",
                        cid, i["platform_slug"], str(i["platform_user_id"]),
                    )
                    if found:
                        break

                if found:
                    # Дополняем ПУСТЫЕ поля: телефон в контакте, почту —
                    # отдельной идентичностью (колонки contacts.email нет).
                    if phone:
                        # ⚠️ Только через set_contact_phone — см. contact_merge.
                        from app.services.contact_merge import set_contact_phone
                        await set_contact_phone(db, found, phone)
                    if email:
                        await db.execute(
                            """INSERT INTO platform_users (contact_id, platform_slug, platform_user_id)
                               VALUES ($1, 'email', $2) ON CONFLICT DO NOTHING""",
                            found, email,
                        )
                    continue

                # 2) Не нашли — заводим контакт. Ключ почта; без неё завести
                #    нечего: телефон идентичностью в системе не является.
                if not email:
                    continue
                from app.services.contact_merge import upsert_contact_with_identity
                await upsert_contact_with_identity(
                    db, client_id=cid,
                    platform_slug="email", platform_user_id=email,
                    first_name=row["name"], email=email, phone=phone or None,
                )
            except Exception:
                logger.warning(
                    "share_contact: не удалось записать контакт клиенту %s (event=%s)",
                    cid, event_id,
                )
    except Exception:
        logger.exception("share_contact_with_all_owners failed: event=%s", event_id)


async def bot_owner_client_id(
    db, *, platform: str,
    bot_id: Optional[int] = None,
    bot_token: Optional[str] = None,
    handle: Optional[str] = None,
) -> Optional[int]:
    """ЧЕЙ ЭТО БОТ (сообщество) — клиент-владелец. ОДНА ФУНКЦИЯ НА ВСЕ ПЛОЩАДКИ.

    ⚠️⚠️ Вопрос «в чьём боте сидит человек» одинаков в Telegram, MAX, ВКонтакте
    и в любой площадке, которую подключат завтра, — значит и ответ должен быть
    один. Раньше это были три копии кода в трёх файлах: правили одну, две
    другие продолжали уводить человека к «первому владельцу» коллабы, и кабинет
    Нурии раз за разом открывался у Лилии.

    ⚠️ ВЕТОК «если telegram… если vk…» ЗДЕСЬ НЕТ, и заводить их нельзя. Иначе
    каждая новая площадка требует правки этой функции — то есть ровно та
    болезнь, от которой мы уходим. Опознаём канал по любому признаку, который
    у нас есть, и все они хранятся одинаково для всех площадок:

      • `bot_token` — точный ключ, есть у бота любой площадки;
      • `bot_id`    — числовая часть токена (в Telegram приходит в апдейте);
      • `handle`    — адрес бота/сообщества (в VK — номер сообщества).

    Площадка нужна только чтобы не спутать одинаковые адреса у разных площадок.
    Ошибки глушим: это уточнение контекста, а не обязательный шаг.
    """
    try:
        conds, args = [], [platform]
        if bot_token:
            args.append(bot_token)
            conds.append(f"ch.bot_token = ${len(args)}")
        if bot_id:
            args.append(str(bot_id))
            conds.append(f"split_part(COALESCE(ch.bot_token, ''), ':', 1) = ${len(args)}")
        if handle:
            args.append(str(handle).lstrip("@"))
            conds.append(f"LOWER(COALESCE(ch.handle, '')) = LOWER(${len(args)})")
        if not conds:
            return None

        return await db.fetchval(
            f"""SELECT cc.client_id FROM channels ch
                  JOIN client_channels cc ON cc.channel_id = ch.id
                 WHERE ch.platform_slug = $1 AND ({' OR '.join(conds)})
                 ORDER BY cc.is_active DESC, cc.id LIMIT 1""",
            *args,
        )
    except Exception:
        logger.warning("bot_owner_client_id failed: platform=%s", platform)
    return None



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
