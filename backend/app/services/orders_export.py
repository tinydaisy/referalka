"""Выгрузка заказов события в бот клиента: команда `/menu{event_id}_orders`.

Отдаёт заказы тарифов события (`event_participant_tariffs`) двумя блоками —
НЕОПЛАЧЕННЫЕ и ОПЛАЧЕННЫЕ, с контактами человека в виде готовых ссылок.

⚠️ Доступ — только владельцу события. Команда приходит в бот КЛИЕНТА, поэтому
проверяем, что бот принадлежит клиенту, который владеет этим событием
(`event_owners`, status='accepted'). Иначе чужой клиент, зная id события,
выгрузил бы себе базу заказчиков вместе с телефонами.
"""

from typing import Optional

from app.services.admin_export import wa_link, tg_link


async def client_owns_event(db, client_id: int, event_id: int) -> bool:
    """Событие принадлежит этому клиенту? (у events нет client_id — через event_owners)"""
    return bool(await db.fetchval(
        """SELECT 1 FROM event_owners
            WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'""",
        event_id, client_id,
    ))


async def fetch_orders(db, event_id: int) -> list[dict]:
    """Заказы события с контактами заказчика и названием тарифа.

    Контакт берём из `contact_id` заказа; если его нет (старые записи) — через
    участника события. Ник/ВК/МАКС — из идентичностей контакта (platform_users).
    """
    rows = await db.fetch(
        """
        SELECT o.id, o.status, o.amount, o.ordered_at, o.paid_at, o.note,
               et.title AS tariff_title,
               ct.id AS contact_id, ct.name, ct.phone, ct.email,
               (SELECT pu.username FROM platform_users pu
                 WHERE pu.contact_id = ct.id AND pu.platform_slug = 'telegram'
                   AND pu.username IS NOT NULL LIMIT 1) AS tg_username,
               (SELECT pu.username FROM platform_users pu
                 WHERE pu.contact_id = ct.id AND pu.platform_slug = 'vk'
                   AND pu.username IS NOT NULL LIMIT 1) AS vk_username,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = ct.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_id,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = ct.id AND pu.platform_slug = 'max' LIMIT 1) AS max_id
          FROM event_participant_tariffs o
          LEFT JOIN event_tariffs et ON et.id = o.tariff_id
          LEFT JOIN event_participants ep ON ep.id = o.participant_id
          LEFT JOIN contacts ct ON ct.id = COALESCE(o.contact_id, ep.contact_id)
         WHERE o.event_id = $1
         ORDER BY COALESCE(o.ordered_at, o.paid_at) DESC, o.id DESC
        """,
        event_id,
    )
    return [dict(r) for r in rows]


def _vk_link(row: dict) -> str:
    """Ссылка на профиль ВК: по нику, иначе по числовому id."""
    nick = (row.get("vk_username") or "").strip()
    if nick:
        return f"https://vk.com/{nick.lstrip('@')}"
    vid = (row.get("vk_id") or "").strip()
    # Псевдо-идентичность вида '@ник' — не числовой id, ссылку по ней не собрать.
    if vid and vid.isdigit():
        return f"https://vk.com/id{vid}"
    return ""


def _max_link(row: dict) -> str:
    """Ссылка на профиль MAX: числовой id → /u/<id>, публичный ник → /<ник>."""
    mid = (row.get("max_id") or "").strip()
    if not mid:
        return ""
    return f"https://max.ru/u/{mid}" if mid.isdigit() else f"https://max.ru/{mid.lstrip('@')}"


def format_order(row: dict, idx: int) -> str:
    """Карточка одного заказа: имя, тариф, сумма и контакты ссылками.

    Пустые поля не выводим — иначе список не читается.
    """
    name = (row.get("name") or "").strip() or "Без имени"
    parts = [f"<b>{idx}. {name}</b>"]

    money = []
    if row.get("tariff_title"):
        money.append(row["tariff_title"])
    if row.get("amount"):
        money.append(f"{row['amount']} ₽")
    if money:
        parts.append("<i>" + " · ".join(money) + "</i>")

    tg = tg_link(row.get("tg_username"))
    if tg:
        parts.append(f"TG: {tg}")
    vk = _vk_link(row)
    if vk:
        parts.append(f"ВК: {vk}")
    mx = _max_link(row)
    if mx:
        parts.append(f"МАКС: {mx}")
    wa = wa_link(row.get("phone"))
    if wa:
        parts.append(f"WhatsApp: {wa}")
    if row.get("email"):
        parts.append(f"Email: {row['email']}")
    if row.get("note"):
        parts.append(f"Комментарий: {row['note']}")

    if len(parts) <= 2:
        parts.append("<i>контактов нет</i>")
    return "\n".join(parts)


def build_orders_message(rows: list[dict], event_title: str) -> list[str]:
    """Заказы двумя блоками: сначала НЕОПЛАЧЕННЫЕ (с ними работать), потом оплаченные.

    Режем по границе карточки (лимит Telegram ~4096) — по символам нельзя,
    HTML-теги разъедутся и сообщение не уйдёт.
    """
    unpaid = [r for r in rows if r.get("status") != "paid"]
    paid = [r for r in rows if r.get("status") == "paid"]
    if not rows:
        return [f"<b>Заказы: {event_title}</b>\n\nЗаказов пока нет."]

    total_sum = sum(r.get("amount") or 0 for r in paid)
    head = (f"<b>Заказы: {event_title}</b>\n"
            f"Неоплаченных — {len(unpaid)} · Оплаченных — {len(paid)}"
            + (f" · на {total_sum} ₽" if total_sum else "") + "\n")

    chunks: list[str] = []
    cur: list[str] = [head]
    cur_len = len(head)

    def flush():
        nonlocal cur, cur_len
        if cur:
            chunks.append("".join(cur))
        cur, cur_len = [], 0

    for title, items in (("НЕ ОПЛАЧЕНО", unpaid), ("ОПЛАЧЕНО", paid)):
        if not items:
            continue
        block_head = f"\n<b>━━ {title} — {len(items)} ━━</b>\n"
        if cur_len + len(block_head) > 3800:
            flush()
        cur.append(block_head)
        cur_len += len(block_head)
        for i, r in enumerate(items, 1):
            body = "\n" + format_order(r, i) + "\n"
            if cur_len + len(body) > 3800:
                flush()
                cont = f"<b>━━ {title} (продолжение) ━━</b>\n"
                cur.append(cont)
                cur_len += len(cont)
            cur.append(body)
            cur_len += len(body)
    flush()
    return chunks
