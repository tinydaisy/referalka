"""
Уровень доступа помощника кабинета (миграции 208, 209).

Помощник ведёт несколько кабинетов, и в каждом у него свой уровень доступа,
поэтому уровень живёт в ПРОПУСКЕ (`assistant_grants`), а не в самом человеке.
Номер пропуска (`grant_id`) кладётся в JWT при входе — по нему и спрашиваем.

'full'    — те же права, что у владельца кабинета. Исключения: раздел управления
            помощниками (иначе он отзовёт себе доступ), админка, а также пароль
            владельца и письмо на его email.
'limited' — исторический набор прав (см. middleware/assistant_permission_guard.py).

Уровень читается ИЗ БД, а не из JWT: владелец переключает тумблер — права
меняются сразу, помощнику не нужно перелогиниваться.
"""
from typing import Optional

import asyncpg

from app.database import get_pool


# Уровни доступа помощника.
#   'orders' — «менеджер заказов»: «Контакты» и «Анкеты», ВСЕ контакты (342).
#   'leads'  — «менеджер лидов»: «Контакты» и CRM событий, ТОЛЬКО закреплённые
#              за ним люди (484).
#
# ⚠️⚠️ НОВЫЙ УРОВЕНЬ ДОБАВЛЯТЬ ЗДЕСЬ ПЕРВЫМ ДЕЛОМ. Всё, чего нет в этом
# кортеже, `get_grant_access_level` превращает в 'limited' — МОЛЧА, без
# единой ошибки в логе: в базе роль стоит, CHECK её пропускает, эндпоинт
# её принимает, а действует она как «ограниченный помощник». Так и вышло
# с `leads` на выкатке 21.09.2026: роль выдана, а менеджер видел все 5330
# контактов кабинета вместо своих закреплённых.
_LEVELS = ("full", "limited", "orders", "leads")


async def get_grant_access_level(grant_id: Optional[int]) -> str:
    """Возвращает 'full' | 'limited' | 'orders' | 'leads'.

    ⚠️ Неизвестное значение и отозванный пропуск → 'limited' (безопасный
    дефолт). Раньше здесь стояло `"full" if lvl == "full" else "limited"`, и
    новый уровень молча превращался в 'limited': роль сохранялась в базе, но
    не действовала — менеджер видел весь кабинет.
    """
    if not grant_id:
        return "limited"
    pool = await get_pool()
    if pool is None:
        return "limited"
    async with pool.acquire() as conn:
        lvl = await conn.fetchval(
            "SELECT access_level FROM assistant_grants WHERE id = $1", int(grant_id)
        )
    return lvl if lvl in _LEVELS else "limited"


async def grant_access_level_row(db: asyncpg.Connection, grant_id: Optional[int]) -> str:
    """То же, что `get_grant_access_level`, но на уже открытом соединении.

    ⚠️ Отдавать наружу нужно именно этот РЕАЛЬНЫЙ уровень. `/auth/me` раньше
    считал его как `"full" if is_full_grant_row(...) else "limited"` — и любая
    новая роль превращалась для фронта в 'limited': меню рисовалось как у
    ограниченного помощника, а API резал его по-своему. Человек видел пункты,
    каждый из которых отвечал 403.
    """
    if not grant_id:
        return "limited"
    lvl = await db.fetchval(
        "SELECT access_level FROM assistant_grants WHERE id = $1", int(grant_id)
    )
    return lvl if lvl in _LEVELS else "limited"


async def is_full_grant_row(db: asyncpg.Connection, grant_id: Optional[int]) -> bool:
    """То же самое, но на уже открытом соединении (для эндпоинтов)."""
    if not grant_id:
        return False
    lvl = await db.fetchval(
        "SELECT access_level FROM assistant_grants WHERE id = $1", int(grant_id)
    )
    return lvl == "full"


# Кому из помощников разрешено ПИСАТЬ человеку в диалогах.
# ⚠️ Раньше здесь стоял общий `assistant_is_restricted` — «не полный, значит
# нельзя». Из-за него менеджер заказов видел переписку (путь /api/v1/dialogs
# ему открыт) и поле ввода, набирал ответ и получал 403: работать с людьми —
# ровно его задача, а ответить он не мог.
# ⚠️ 'leads' здесь ОБЯЗАТЕЛЕН: писать своим закреплённым людям — смысл роли.
# Кому именно он пишет, ограничивает `assert_leads_access` в самом эндпоинте.
_CAN_REPLY_LEVELS = ("full", "orders", "leads")


async def assistant_can_reply_in_dialogs(user: dict) -> bool:
    """True — этому помощнику можно отправлять сообщения людям."""
    if user.get("role") != "assistant":
        return True
    lvl = await get_grant_access_level(user.get("grant_id"))
    return lvl in _CAN_REPLY_LEVELS


async def leads_only_grant_id(user: dict) -> Optional[int]:
    """Номер пропуска, если это «менеджер лидов» — иначе None.

    Единственная точка, где решается «этому человеку показывать только
    закреплённых за ним». Возвращает именно `grant_id`, потому что закрепление
    в `contact_assignments` ссылается на ПРОПУСК: помощник ведёт несколько
    кабинетов, и в каждом у него свой список людей.

    ⚠️ Пользоваться этим в КАЖДОЙ выборке людей: список контактов, экспорт
    CSV, CRM события, CRM лид-магнита, счётчики. Пропустить одну — и человек
    увидит чужих ровно там, где забыли.
    """
    if user.get("role") != "assistant":
        return None
    lvl = await get_grant_access_level(user.get("grant_id"))
    if lvl != "leads":
        return None
    gid = user.get("grant_id")
    return int(gid) if gid else None


async def tech_spec_id_of(user: dict) -> Optional[int]:
    """Роль внедренца у вошедшего человека — иначе None.

    ⚠️⚠️ ЕДИНСТВЕННАЯ ТОЧКА, где решается «этот человек ещё и внедренец». От
    неё зависят два блока CRM события («Заинтересовались ПЛЮСОНом» и
    «Зарегистрированы в ПЛЮСОНе»): их видит только помощник-внедренец, у
    обычного помощника этих блоков нет вовсе.

    ⚠️ СВЯЗЬ ПО ПОЧТЕ, а не по внешнему ключу. Внедренец — роль над КЛИЕНТОМ
    (`tech_specialists.client_id` → `clients`), а помощник живёт отдельной
    строкой в `assistants`: прямой связи между ними в базе нет. Общее у них
    одно — человек и его почта. Тот же приём, что в `dialog_archive`, где
    контакт сопоставляется с клиентом платформы.

    ⚠️ Сравниваем `LOWER(TRIM(email))`: колонки `email_normalized` у `clients`
    и `assistants` нет вовсе — она есть только у `contacts`.

    ⚠️ Уволенный (`is_active = FALSE`) внедренцем НЕ считается: доступ к
    кабинету внедренца ему закрыт, значит и блоков ПЛЮСОНа он видеть не должен.

    ⚠️ Владелец кабинета, который сам внедренец, тоже получает роль — блоки
    ему покажутся. Это верно: данные его собственные, и прятать их не от кого.
    """
    role = user.get("role")
    if role == "assistant":
        email_q = "SELECT email FROM assistants WHERE id = $1"
        who = user.get("assistant_id")
    elif role == "client":
        email_q = "SELECT email FROM clients WHERE id = $1"
        who = user.get("sub")
    else:
        return None
    if not who:
        return None

    pool = await get_pool()
    async with pool.acquire() as db:
        email = await db.fetchval(email_q, int(who))
        if not email:
            return None
        return await db.fetchval(
            """SELECT ts.id FROM tech_specialists ts
                 JOIN clients c ON c.id = ts.client_id
                WHERE LOWER(TRIM(c.email)) = LOWER(TRIM($1))
                  AND ts.is_active""",
            email,
        )


async def assistant_is_restricted(user: dict) -> bool:
    """
    True — если это помощник с ограниченными правами (нужно резать доступ).
    False — владелец, админ или помощник с полным доступом.

    `user` — payload JWT (то, что отдаёт get_current_client / get_current_user).
    """
    if user.get("role") != "assistant":
        return False
    lvl = await get_grant_access_level(user.get("grant_id"))
    return lvl != "full"
