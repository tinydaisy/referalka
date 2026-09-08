"""Закрепление человека за партнёром клиента — ЕДИНАЯ точка записи.

⚠️⚠️ ПРАВИЛО ОДНО, И ОНО ЕДИНСТВЕННОЕ:

    Закрепление возникает, когда человек приходит по ссылке ЗАРЕГИСТРИРОВАННОГО
    партнёра и место свободно. Дальше НЕ МЕНЯЕТСЯ НИКОГДА.

Три следствия, каждое — осознанное решение владельца:

1. **Не перебивается** (№ 13). Перешёл по чужой ссылке — закрепление прежнее.
   Иначе случайный клик уводил бы человека в чужую команду и рвал ветку
   многоуровневого дохода.
2. **Не возникает от НЕ-партнёра** (№ 14). Друг привёл друга — это подарки
   события, а не деньги. Деньги платим только тем, кто принял оферту и указал
   налоговый статус.
3. **Не зависит от участия партнёра в событии** — он приводит в базу клиента,
   а не на мероприятие.

⚠️⚠️ РЕТРОАКТИВНОГО ЗАКРЕПЛЕНИЯ НЕТ (№ 28). Прохода по истории здесь нет и
быть не должно: «не засчитывать прошлые заслуги» — это не проверка, которую
можно забыть или обойти, а ОТСУТСТВИЕ такого кода.

⚠️ Не перепутать «прошлую заслугу» и «старый контакт»:

    Партнёр привёл человека ДО того, как стал партнёром  → НЕ закрепляем
    Человек давно в базе, но СЕГОДНЯ перешёл по ссылке   → ЗАКРЕПЛЯЕМ
    Человек уже закреплён за другим                      → НЕ трогаем

Вторая строка обязательна: в базе 22 485 контактов, почти все «старые».
Партнёр рассылает ссылку знакомым, которые уже есть у клиента, — он привёл их
на этот продукт сейчас. Откажи им — партнёрка работала бы только на людях
с улицы.

⚠️⚠️ НЕ ПУТАТЬ С РЕФЕРАЛКОЙ СОБЫТИЯ. `event_participants.referrer_ref_code`
хранит «кто привёл на это событие» (любой человек, там держатся подарки), а
`contacts.partner_id` — «кому платим деньги» (только партнёр). Партнёрка
событийное поле не читает и не меняет.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


async def find_partner_by_ref_code(
    db, *, client_id: int, ref_code: Optional[str]
) -> Optional[dict]:
    """Реф-код → активный партнёр этого клиента, или None.

    Реф-код принадлежит контакту (`contacts.ref_code`, NOT NULL у всех), а
    партнёром становится не каждый. Поэтому «код есть» и «получатель есть» —
    разные вещи, и решает эта функция.

    ⚠️ Учитываем `merged_ref_codes`: после объединения контактов старый код
    продолжает ходить по чужим рассылкам и постам, и партнёр не должен терять
    людей из-за того, что мы когда-то склеили его карточку.
    """
    if not ref_code:
        return None

    row = await db.fetchrow(
        """SELECT p.id, p.contact_id, p.payout_mode, p.is_active,
                  c.name AS partner_name, c.ref_code
             FROM contacts c
             JOIN client_partners p
               ON p.contact_id = c.id AND p.client_id = c.client_id
            WHERE c.client_id = $1
              AND (c.ref_code = $2 OR c.merged_ref_codes ? $2)
              AND p.is_active = TRUE
            LIMIT 1""",
        client_id, ref_code,
    )
    return dict(row) if row else None


async def get_binding(db, contact_id: int) -> Optional[dict]:
    """За кем закреплён человек. None — место свободно."""
    row = await db.fetchrow(
        """SELECT p.id, p.contact_id AS partner_contact_id, p.payout_mode,
                  p.is_active, c.partner_bound_at,
                  pc.name AS partner_name
             FROM contacts c
             JOIN client_partners p ON p.id = c.partner_id
             JOIN contacts pc ON pc.id = p.contact_id
            WHERE c.id = $1""",
        contact_id,
    )
    return dict(row) if row else None


async def bind_contact_to_partner(
    db, *, contact_id: int, partner_id: int
) -> tuple[bool, Optional[int]]:
    """Закрепляет человека за партнёром, если место свободно.

    Возвращает (закрепили ли, id партнёра, за которым человек оказался).
    Второе значение нужно вызывающему, чтобы отправить уведомление (№ 35):
    «человек не зачисляется под вас — его привёл ранее такой-то».

    ⚠️⚠️ ЗАПРЕТ НА СМЕНУ ЖИВЁТ ЗДЕСЬ, В `WHERE partner_id IS NULL`, а не в
    интерфейсе (№ 16). Смена недоступна НИКОМУ: ни клиенту, ни админу. Условие
    в самом UPDATE держит правило даже при одновременных запросах — второй
    просто не найдёт строку и вернёт «не закрепили».

    ⚠️ Себя за себя не закрепляем: партнёр не может быть собственным
    реферером — иначе он получал бы вознаграждение со своих же покупок.
    """
    partner = await db.fetchrow(
        "SELECT id, contact_id FROM client_partners WHERE id = $1 AND is_active = TRUE",
        partner_id,
    )
    if not partner:
        return False, None
    if partner["contact_id"] == contact_id:
        return False, None

    bound = await db.fetchval(
        """UPDATE contacts
              SET partner_id = $2, partner_bound_at = NOW()
            WHERE id = $1 AND partner_id IS NULL
        RETURNING partner_id""",
        contact_id, partner_id,
    )
    if bound:
        logger.info("Партнёрка: контакт %s закреплён за партнёром %s", contact_id, partner_id)
        return True, partner_id

    # Место занято — сообщаем вызывающему, КЕМ именно.
    existing = await db.fetchval("SELECT partner_id FROM contacts WHERE id = $1", contact_id)
    return False, existing


async def try_bind_by_ref_code(
    db, *, client_id: int, contact_id: int, ref_code: Optional[str]
) -> Optional[dict]:
    """Человек пришёл по ссылке с `pid` — пробуем закрепить.

    Точка входа для ботов, воронок и веб-страниц. Возвращает описание того, что
    произошло, — вызывающему нужно только решить, слать ли уведомление:

        None                     — реф-кода нет / он не партнёрский, делать нечего
        {'bound': True,  ...}    — закрепили за этим партнёром
        {'bound': False, ...}    — место было занято другим

    ⚠️ FAIL-OPEN. Партнёрка — надстройка над входом человека в базу. Сбой
    закрепления не должен ронять регистрацию, запуск бота или выдачу подарка:
    человек не виноват, что у нас что-то не сошлось. Поэтому исключения гасим
    и пишем в лог.
    """
    if not ref_code:
        return None

    try:
        partner = await find_partner_by_ref_code(db, client_id=client_id, ref_code=ref_code)
        if not partner:
            # Код есть, но он не партнёрский — обычная рефералка события.
            # Это НЕ ошибка и не повод что-то писать.
            return None

        bound, holder_id = await bind_contact_to_partner(
            db, contact_id=contact_id, partner_id=partner["id"])

        # Место было занято другим — говорим об этом ПАРТНЁРУ, который привёл
        # (решение № 35). ⚠️ Про ЗАКРЕПЛЕНИЕ, а не про деньги, и сразу, а не
        # после покупки: партнёр должен узнать в момент перехода, а не найти
        # сюрприз в отчёте через месяц.
        if not bound and holder_id and holder_id != partner["id"]:
            from app.services.partner_notify import notify_binding_taken
            await notify_binding_taken(
                db, client_id=client_id, partner_id=partner["id"],
                contact_id=contact_id)
        elif bound:
            # ⚠️ Человек закрепился за партнёром — говорим ему СРАЗУ, пока тот
            # тёплый. Раньше партнёр не узнавал о переходе вовсе и видел
            # новичка, только если сам зашёл в кабинет. Ограничение «раз в
            # сутки на человека» внутри уведомления: по одной ссылке заходят
            # помногу раз.
            from app.services.partner_notify import notify_interest
            await notify_interest(
                db, client_id=client_id, partner_id=partner["id"],
                contact_id=contact_id)

        return {
            "bound": bound,
            "partner_id": partner["id"],
            "partner_contact_id": partner["contact_id"],
            "holder_partner_id": holder_id,
        }
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрка: закрепление контакта %s не удалось: %s", contact_id, e)
        return None
