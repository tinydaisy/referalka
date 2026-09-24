"""Диалоги внедренца — переписка с теми, кто написал в @pluson_bot (миграция 392).

⚠️⚠️ ЗДЕСЬ ЧИТАЮТСЯ ДИАЛОГИ СИСТЕМНОГО КАБИНЕТА, а не клиента. В @pluson_bot
пишут будущие клиенты и просто люди с вопросами: их сообщения попадают в базу
СЕРВИСНОГО кабинета, потому что этот бот принадлежит ему.

⚠️ Внедренец видит ТОЛЬКО назначенные ему разговоры. Отдать все и отфильтровать
на фронте нельзя: запрос повторяется мимо интерфейса.

⚠️ Отправка идёт ГОТОВОЙ функцией из `dialogs.py`, а не своей копией: там уже
разобраны четыре площадки, выбор токена и запись в ленту. Вторая копия
разошлась бы с первой на первой же правке.
"""

from __future__ import annotations

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_tech
from app.database import get_db

router = APIRouter(prefix="/tech/dialogs", tags=["Внедренец: диалоги"])


class ReplyIn(BaseModel):
    platform: str
    text: str


async def _system_client_id(db) -> int:
    """Кабинет, которому принадлежит @pluson_bot."""
    cid = await db.fetchval(
        "SELECT id FROM clients WHERE is_system_service = TRUE LIMIT 1")
    if not cid:
        raise HTTPException(404, "Системный кабинет не найден")
    return cid


# ⚠️⚠️ ДИАЛОГ ПРИНАДЛЕЖИТ ТОМУ, ЗА КЕМ ЗАКРЕПЛЁН КЛИЕНТ (23.09.2026).
#
# Раньше диалоги раздавались ОТДЕЛЬНО, вручную, через `dialog_assignments` —
# и это было неверно: клиент закреплён за внедренцем в
# `clients.tech_specialist_id`, а переписка с ним оставалась ничьей, пока
# владелец не раздаст её руками. На проде у человека с шестью клиентами раздел
# «Диалоги» был пуст — назначений не существовало ни одного.
#
# Диалоги от клиентов НЕОТДЕЛИМЫ: закрепление клиента — единственное основание.
# Второй механизм раздачи означал бы два ответа на вопрос «чей это разговор».
#
# ⚠️ Человек в системном боте — это КОНТАКТ, а клиент платформы — отдельная
# запись; общее у них почта. Тот же приём, что в `plusson_match`: сравниваем
# `LOWER(TRIM(...))`, иначе «Miss-25@» и «miss-25@» разъезжаются.
MINE_SQL = """EXISTS (
    SELECT 1 FROM platform_users pe
      JOIN clients cl
        ON LOWER(TRIM(cl.email)) = LOWER(TRIM(pe.platform_user_id))
     WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
       AND cl.tech_specialist_id = $2)"""


async def _assert_mine(db, spec_id: int, client_id: int, contact_id: int) -> None:
    """Разговор с МОИМ клиентом — иначе 404.

    ⚠️ Именно 404, а не 403: по чужому id не должно быть видно даже того, что
    такой разговор существует.
    """
    ok = await db.fetchval(
        "SELECT 1 FROM contacts c WHERE c.id = $3 AND " + MINE_SQL,
        client_id, spec_id, contact_id,
    )
    if not ok:
        raise HTTPException(404, "Диалог не найден")


@router.get("", summary="Мои диалоги")
async def my_dialogs(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Мои клиенты и переписка с ними.

    ⚠️⚠️ СПИСОК ИДЁТ ОТ КЛИЕНТОВ, А НЕ ОТ СООБЩЕНИЙ (23.09.2026). Раньше здесь
    стоял `JOIN` с перепиской, и человек попадал в список, только если уже
    что-то написал. Выходило бессмысленно: внедренцу нужно НАПИСАТЬ клиенту
    первым, а в разделе «Диалоги» этого клиента не было вовсе, пока тот не
    напишет сам. Теперь видно всех своих, а переписка подтягивается, если есть.

    ⚠️ `where_to_write` — по каким каналам человеку МОЖНО написать (telegram,
    vk, max, email). У кого что есть: без этого внедренец открывает карточку и
    обнаруживает, что отправить некуда.
    """
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)

    rows = await db.fetch(
        """WITH last AS (
             SELECT DISTINCT ON (dm.contact_id)
                    dm.contact_id, dm.text, dm.media_kind, dm.direction, dm.sent_at
               FROM direct_messages dm
              WHERE dm.client_id = $1 AND dm.contact_id IS NOT NULL
              ORDER BY dm.contact_id, dm.sent_at DESC
           ), agg AS (
             SELECT dm.contact_id,
                    MAX(dm.sent_at) AS last_at,
                    array_agg(DISTINCT dm.platform) AS platforms,
                    COUNT(*) FILTER (WHERE dm.direction='in' AND NOT dm.is_read) AS unread
               FROM direct_messages dm
              WHERE dm.client_id = $1 AND dm.contact_id IS NOT NULL
              GROUP BY dm.contact_id
           )
           SELECT c.id AS contact_id,
                  COALESCE(c.name, cl.name) AS name,
                  COALESCE(c.phone, cl.phone) AS phone,
                  a.last_at, a.platforms,
                  COALESCE(a.unread, 0) AS unread,
                  l.text AS last_text, l.media_kind AS last_media_kind,
                  l.direction AS last_direction,
                  -- Куда ему можно написать: у кого телеграм, у кого только
                  -- почта. Пустой список — писать некуда, и это видно сразу.
                  --
                  -- ⚠️ Почта есть ВСЕГДА — это логин клиента платформы,
                  -- поэтому она в списке даже когда контакта в боте нет вовсе.
                  (SELECT array_agg(DISTINCT x) FROM unnest(
                     COALESCE((SELECT array_agg(DISTINCT pu.platform_slug)
                                 FROM platform_users pu
                                WHERE pu.contact_id = c.id
                                  AND pu.platform_slug IN ('telegram','vk','max','email')),
                              ARRAY[]::text[])
                     || ARRAY['email']
                     || CASE WHEN COALESCE(cl.telegram_username,'') <> ''
                             THEN ARRAY['telegram'] ELSE ARRAY[]::text[] END
                   ) AS x) AS where_to_write,
                  cl.id AS platform_client_id,
                  cl.email AS client_email
             -- ⚠️⚠️ ИДЁМ ОТ КЛИЕНТОВ, А НЕ ОТ КОНТАКТОВ БОТА (23.09.2026):
             -- у половины клиентов контакта в боте нет вовсе (они туда не
             -- заходили), и по контактам они бы в список не попали — а
             -- написать им нужно в первую очередь.
             FROM clients cl
             LEFT JOIN contacts c
                    ON c.client_id = $1
                   AND EXISTS (SELECT 1 FROM platform_users pe
                                WHERE pe.contact_id = c.id
                                  AND pe.platform_slug = 'email'
                                  AND LOWER(TRIM(pe.platform_user_id))
                                    = LOWER(TRIM(cl.email)))
             LEFT JOIN agg a ON a.contact_id = c.id
             LEFT JOIN last l ON l.contact_id = c.id
            WHERE cl.tech_specialist_id = $2
            -- Сначала те, с кем уже говорили (свежие сверху), затем остальные.
            ORDER BY a.last_at DESC NULLS LAST, COALESCE(c.name, cl.name)""",
        client_id, spec_id,
    )
    return {"dialogs": [dict(r) for r in rows]}


@router.get("/unread-count", summary="Сколько у меня новых сообщений")
async def unread_count(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Цифра для пункта меню «Диалоги» — как у клиента в кабинете.

    ⚠️⚠️ ОБЪЯВЛЕН ДО `/{contact_id}`: FastAPI разбирает маршруты по порядку, и
    после него «unread-count» ушёл бы в динамический путь как номер контакта —
    эндпоинт молча отвечал бы 422 вместо цифры.

    ⚠️ Считаем ровно то же, что показывает список: только НАЗНАЧЕННЫЕ мне
    разговоры (переписка с МОИМИ клиентами). Иначе в меню висела бы цифра от чужих
    диалогов, которые человек не может открыть, — то самое расхождение, из-за
    которого у клиентов счётчик уже переделывали.
    """
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)
    n = await db.fetchval(
        """SELECT COUNT(*)
             FROM direct_messages dm
             JOIN contacts c ON c.id = dm.contact_id
            WHERE dm.client_id = $1
              AND dm.contact_id IS NOT NULL
              AND dm.direction = 'in' AND NOT dm.is_read
              AND """ + MINE_SQL,
        client_id, spec_id,
    )
    return {"unread": int(n or 0)}


@router.get("/{contact_id}", summary="Лента переписки")
async def messages(
    contact_id: int,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)
    await _assert_mine(db, spec_id, client_id, contact_id)

    # ⚠️⚠️ НАБОР ПОЛЕЙ — РОВНО КАК У КЛИЕНТСКОЙ ЛЕНТЫ (23.09.2026): экран
    # переписки теперь ОБЩИЙ (`components/DialogChat`), и он ждёт именно эти
    # поля. Урезанный список давал пустые вкладки площадок и «сломанные»
    # сообщения без признака правки.
    rows = await db.fetch(
        """SELECT id, platform, channel_id, platform_user_id, direction,
                  author_kind, text, media_url, media_kind,
                  platform_message_id, is_deleted, error, sent_at, edited_at
             FROM direct_messages
            WHERE client_id = $1 AND contact_id = $2
            ORDER BY sent_at""",
        client_id, contact_id,
    )
    # Площадки этого разговора и непрочитанные по каждой — для вкладок сверху.
    plats = await db.fetch(
        """SELECT platform,
                  COUNT(*) FILTER (WHERE direction='in' AND NOT is_read) AS unread
             FROM direct_messages
            WHERE client_id = $1 AND contact_id = $2
            GROUP BY platform ORDER BY platform""",
        client_id, contact_id,
    )
    # Помечаем прочитанным: человек открыл ленту и увидел сообщения.
    await db.execute(
        """UPDATE direct_messages SET is_read = TRUE
            WHERE client_id = $1 AND contact_id = $2
              AND direction = 'in' AND NOT is_read""",
        client_id, contact_id,
    )
    contact = await db.fetchrow(
        "SELECT id, name, phone FROM contacts WHERE id = $1", contact_id)
    # ⚠️ Площадки, где у человека есть аккаунт — для выбора, КУДА отвечать.
    # Их может быть больше, чем площадок переписки: писали в телеграм, а почта
    # у него тоже есть.
    # ⚠️ `$1::int` — приведение обязательно: без него Postgres не может вывести
    # тип параметра в этом запросе и падает с IndeterminateDatatypeError.
    accs = await db.fetch(
        """SELECT DISTINCT platform_slug FROM platform_users
            WHERE contact_id = $1::int
              AND platform_slug IN ('telegram','vk','max','email')""",
        contact_id)
    return {
        "contact": dict(contact) if contact else None,
        "messages": [dict(r) for r in rows],
        "platforms": [r["platform"] for r in plats],
        "unread_by_platform": {
            r["platform"]: int(r["unread"] or 0) for r in plats if r["unread"]
        },
        "available_platforms": [r["platform_slug"] for r in accs],
    }


class StartIn(BaseModel):
    """Начать переписку с клиентом, которого в боте ещё нет."""
    client_id: int


@router.post("/start", summary="Завести разговор с моим клиентом")
async def start_dialog(
    data: StartIn,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Создаёт контакт в системном боте для клиента, у которого его ещё нет.

    ⚠️⚠️ ЗАЧЕМ. В списке диалогов теперь ВСЕ клиенты внедренца, но у половины
    из них контакта в боте не существует — они туда не заходили. Без контакта
    ни открыть переписку, ни написать нельзя: и лента, и отправка адресуются
    `contact_id`. Получался список, в котором половина строк не кликается.

    ⚠️ Контакт заводится ТОЛЬКО для своего клиента (проверка ниже) и ТОЛЬКО в
    базе системного кабинета — это карточка «человек, которому мы пишем», а не
    новый клиент платформы.

    ⚠️ Почта кладётся в `platform_users`, потому что именно по ней контакт
    связывается с клиентом платформы (см. `MINE_SQL`). Без неё разговор тут же
    перестал бы считаться своим.
    """
    spec_id = int(user["sub"])
    sys_client_id = await _system_client_id(db)

    cl = await db.fetchrow(
        """SELECT id, name, email, phone, telegram_username
             FROM clients WHERE id = $1 AND tech_specialist_id = $2""",
        data.client_id, spec_id)
    if not cl:
        raise HTTPException(404, "Это не ваш клиент")

    # Контакт мог появиться параллельно — ищем по той же почте.
    existing = await db.fetchval(
        """SELECT c.id FROM contacts c
            JOIN platform_users pe ON pe.contact_id = c.id
                                  AND pe.platform_slug = 'email'
           WHERE c.client_id = $1
             AND LOWER(TRIM(pe.platform_user_id)) = LOWER(TRIM($2))
           LIMIT 1""",
        sys_client_id, cl["email"])
    if existing:
        return {"contact_id": existing, "created": False}

    # ⚠️ `contacts.ref_code` — NOT NULL UNIQUE (миграция 060). Берём ОБЩИЙ
    # генератор, а не придумываем свой: он один на все точки создания контакта
    # и умеет разрешать коллизии.
    from app.services.contact_merge import _generate_unique_ref_code
    ref_code = await _generate_unique_ref_code(db)
    contact_id = await db.fetchval(
        """INSERT INTO contacts (client_id, name, phone, ref_code)
           VALUES ($1, $2, $3, $4) RETURNING id""",
        sys_client_id, cl["name"], cl["phone"], ref_code)
    await db.execute(
        """INSERT INTO platform_users (contact_id, platform_slug, platform_user_id)
           VALUES ($1, 'email', $2)
           ON CONFLICT DO NOTHING""",
        contact_id, cl["email"])
    # Телеграм — если клиент его указал: это второй канал, по которому можно
    # написать, и без записи он был бы недоступен отправке.
    # ⚠️ `platform_user_id` — NOT NULL, поэтому кладём туда ник: числового id
    # телеграма у нас нет (человек в бот не заходил), а ник — единственное,
    # что клиент указал сам. Тот же приём, что у почты: там в этом поле адрес.
    tg = (cl["telegram_username"] or "").strip().lstrip("@")
    if tg:
        await db.execute(
            """INSERT INTO platform_users
                   (contact_id, platform_slug, platform_user_id, username)
               VALUES ($1, 'telegram', $2, $2)
               ON CONFLICT DO NOTHING""",
            contact_id, tg)
    return {"contact_id": contact_id, "created": True}


@router.post("/{contact_id}/reply", summary="Ответить")
async def reply(
    contact_id: int,
    data: ReplyIn,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Ответ уходит через бот СИСТЕМНОГО кабинета — тот, в который человек писал.

    ⚠️ Переиспользуем готовую отправку из `dialogs.py`: там разобраны четыре
    площадки, выбор токена и запись в ленту. Своя копия разошлась бы с ней.
    """
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)
    await _assert_mine(db, spec_id, client_id, contact_id)

    from app.api.dialogs import ReplyBody, reply_to_contact

    # Готовая функция ждёт токен КЛИЕНТА (в `sub` — id кабинета). Подставляем
    # системный кабинет и помечаем, кто на самом деле пишет: без пометки в
    # логах не отличить ответ внедренца от ответа владельца.
    fake_client = {"sub": str(client_id), "role": "client",
                   "acting_tech_id": spec_id}
    return await reply_to_contact(
        contact_id=contact_id,
        body=ReplyBody(platform=data.platform, text=data.text),
        client=fake_client,
        db=db,
    )
