"""Сопоставление КОНТАКТА в базе клиента с его АККАУНТОМ в ПЛЮСОНе.

⚠️⚠️ ПОЧЕМУ НЕ `contacts.linked_client_id` (22.09.2026). Поле есть, но его
заполняет ровно один путь — форма `/link-pluson`, куда человек должен сам зайти
и ввести пароль своего ПЛЮСОН-аккаунта (`api/pluson_connect.py`). На проде так
не сделал НИКТО: `linked_client_id` заполнен у 0 контактов из 5330. Блок CRM
«кто из них дошёл до платформы» читал это поле и поэтому всегда показывал нули —
хотя люди в ПЛЮСОНе есть, и регистрируются они каждый день.

Сопоставляем по тому, что у человека реально есть в обеих базах: почта и ники
площадок. Совпадение по ЛЮБОМУ каналу — это он.

⚠️ Нормализация обязательна с обеих сторон, иначе тот же человек не находится:
  • регистр — контакт `miss-25@mail.ru` против клиента `Miss-25@mail.ru`;
  • `@` у ника — контакт `totella28` против клиента `@totella28`.
Обе разницы встретились на одном живом примере (Элла Тот, контакт 4121 ↔
клиент 11), поэтому `lower()` и `ltrim(…,'@')` стоят и слева, и справа.

⚠️ У клиента ТРИ источника телеграма: `telegram_username` (профиль),
`work_tg_username` и `work_tg_id` (рабочий аккаунт, им он заходит в чужие боты).
Берём все: человек мог прийти на событие с рабочего аккаунта, а в ПЛЮСОНе
указать личный.

⚠️ `work_tg_username` и `work_vk` на практике хранят ССЫЛКУ, а не ник: у клиента
146 там `https://t.me/larisavolodinapsy` и `https://vk.ru/larisavolodina_makeup`.
Голое сравнение такую строку не поймает никогда, поэтому режем всё до последнего
`/` (`regexp_replace`), а уже потом снимаем `@`.

⚠️ ТЕЛЕФОН — равноправный четвёртый признак. У Ларисы Володиной (контакт 12626 ↔
клиент 146) совпадают и почта, и телеграм, и телефон, но так везёт не всем: у
части контактов заполнен только телефон, и без него они не найдутся вовсе.
Сравниваем по ЦИФРАМ (`regexp_replace(…,'\\D','','g')`) и по последним 10 — иначе
`+79212861071` и `89212861071` считаются разными людьми.

⚠️ Чего этот механизм НЕ умеет: контакт без почты, телеграма и телефона не
найдётся никак — сравнивать нечего. Так у второй карточки той же Ларисы
(контакт 16006, только MAX-id `21675136`): в ПЛЮСОНе её MAX не указан, и совпасть
им негде. Это не ошибка сопоставления, а отсутствие данных с одной из сторон.

⚠️ Берём МИНИМАЛЬНЫЙ `clients.id` при нескольких совпадениях: у одного человека
может быть несколько аккаунтов (три почты подряд у одного из участников события
89). Для CRM важен факт «он на платформе», а стабильный выбор нужен, чтобы
карточка не прыгала между аккаунтами от запроса к запросу.
"""
from __future__ import annotations

# Идентификаторы КЛИЕНТОВ платформы, приведённые к виду (client_id, площадка,
# значение). Одним `UNION` — чтобы сравнение шло одинаково по всем каналам.
#
# ⚠️ `UNION`, а не `UNION ALL`: у клиента `telegram_username` и
# `work_tg_username` часто одно и то же, и дубли только раздували бы соединение.
CLIENT_IDS_CTE = """
    SELECT cl.id AS client_id, 'email' AS plat, LOWER(TRIM(cl.email)) AS val
      FROM clients cl WHERE COALESCE(cl.email,'') <> ''
    UNION
    SELECT cl.id, 'telegram', LOWER(LTRIM(TRIM(cl.telegram_username),'@'))
      FROM clients cl WHERE COALESCE(cl.telegram_username,'') <> ''
    UNION
    SELECT cl.id, 'telegram',
           LOWER(LTRIM(regexp_replace(TRIM(cl.work_tg_username), '^.*/', ''), '@'))
      FROM clients cl WHERE COALESCE(cl.work_tg_username,'') <> ''
    UNION
    SELECT cl.id, 'telegram', cl.work_tg_id::text
      FROM clients cl WHERE cl.work_tg_id IS NOT NULL
    UNION
    SELECT cl.id, 'vk',
           LOWER(LTRIM(regexp_replace(TRIM(cl.work_vk), '^.*/', ''), '@'))
      FROM clients cl WHERE COALESCE(cl.work_vk,'') <> ''
    UNION
    SELECT cl.id, 'max',
           LOWER(LTRIM(regexp_replace(TRIM(cl.work_max), '^.*/', ''), '@'))
      FROM clients cl WHERE COALESCE(cl.work_max,'') <> ''
"""

# Телефон стоит отдельно от каналов: он лежит не в `platform_users`, а прямо в
# `contacts.phone` и `clients.phone`, и сравнивается по последним 10 цифрам.
CLIENT_PHONES_CTE = """
    SELECT cl.id AS client_id,
           RIGHT(regexp_replace(cl.phone, '\\D', '', 'g'), 10) AS digits
      FROM clients cl
     WHERE LENGTH(regexp_replace(COALESCE(cl.phone,''), '\\D', '', 'g')) >= 10
"""


def matched_client_id_sql(contact_expr: str) -> str:
    """Подзапрос: id аккаунта ПЛЮСОНа для контакта `contact_expr` (или NULL).

    `contact_expr` — SQL-выражение с id контакта, например `c.id` или
    `rc.id`. Возвращается скалярный подзапрос, который можно подставить
    в SELECT и в WHERE.

    ⚠️ Сравниваем и `username`, и `platform_user_id`: у части людей ник не
    сохранён вовсе (заходили без @username), и тогда единственный признак —
    числовой id. Почта лежит в `platform_user_id` канала `email`, ника у неё
    нет — поэтому `COALESCE` берёт оба поля, а не одно.
    """
    return f"""(
        SELECT MIN(m.client_id) FROM (
            -- по каналам: почта, telegram, vk, max
            SELECT ci.client_id
              FROM platform_users pu_m
              JOIN ({CLIENT_IDS_CTE}) ci
                   ON ci.plat = pu_m.platform_slug
                  AND ci.val IN (
                        LOWER(LTRIM(TRIM(COALESCE(pu_m.username,'')),'@')),
                        LOWER(TRIM(COALESCE(pu_m.platform_user_id,'')))
                      )
             WHERE pu_m.contact_id = {contact_expr}
            UNION
            -- по телефону контакта
            SELECT cp.client_id
              FROM contacts c_m
              JOIN ({CLIENT_PHONES_CTE}) cp
                   ON cp.digits = RIGHT(regexp_replace(c_m.phone, '\\D', '', 'g'), 10)
             WHERE c_m.id = {contact_expr}
               AND LENGTH(regexp_replace(COALESCE(c_m.phone,''), '\\D', '', 'g')) >= 10
        ) m
    )"""


def plusson_interest_sql(contact_expr: str) -> str:
    """Подзапрос: реф-код ПЛЮСОНа, по которому человек зашёл в бот (или NULL).

    ⚠️⚠️ ИСКАТЬ НАДО ПО ЧЕЛОВЕКУ, А НЕ ПО ЭТОЙ КАРТОЧКЕ КОНТАКТА (22.09.2026).
    `plusson_referrer_code` проставляется контакту в базе КЛИЕНТА 3 («ПЛЮСОН
    Сервис») — это карточка захода в @pluson_bot. Событие принадлежит другому
    клиенту, и его CRM отбирает строго свои контакты (`c.client_id = $2`), где
    этого поля нет никогда. Отсюда и был вечный ноль в «Заинтересовались»: на
    событии 89 таких людей 23, а показывалось 0.

    Один человек = несколько карточек в базах разных клиентов, связанных общими
    площадками. Поэтому ищем код по ЛЮБОЙ карточке с теми же `platform_users`.

    ⚠️ Сравниваем по паре (площадка, значение), а не по одному значению: id
    `103194824` во ВКонтакте и в MAX — разные люди, и без площадки они бы
    склеились.
    """
    return f"""(
        SELECT MIN(c_i.plusson_referrer_code)
          FROM platform_users pu_a
          JOIN platform_users pu_b
               ON pu_b.platform_slug = pu_a.platform_slug
              AND LOWER(COALESCE(pu_b.username, pu_b.platform_user_id))
                = LOWER(COALESCE(pu_a.username, pu_a.platform_user_id))
          JOIN contacts c_i ON c_i.id = pu_b.contact_id
         WHERE pu_a.contact_id = {contact_expr}
           AND c_i.plusson_referrer_code IS NOT NULL
    )"""
