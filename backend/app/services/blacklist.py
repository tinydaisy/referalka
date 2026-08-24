"""
Чёрный список (миграция 228).

Две НЕЗАВИСИМЫЕ сущности — не путать:

1. contact_blacklist — контакт в базе конкретного клиента. Заблокированный
   не получает контент из ботов ЭТОГО клиента: бот отвечает заглушкой с
   каналами поддержки, рассылки не уходят, воронки не запускаются.
   В базах других клиентов тот же человек работает как обычно.

2. clients.collab_hub_blocked — запрет покупки Коллабораторной. Ставится
   админом, действует глобально (человек как клиент платформы).

Одно не подразумевает другого: контакт можно заблокировать в базе клиента,
не трогая его покупки, и наоборот.
"""
from typing import Optional


# SQL-условие для вставки в запросы аудитории рассылок.
# Требует, чтобы в запросе были доступны алиасы контакта и клиента.
def not_blacklisted_clause(contact_col: str, client_col: str) -> str:
    """AND NOT EXISTS(...) для исключения заблокированных из аудитории."""
    return (
        f" AND NOT EXISTS (SELECT 1 FROM contact_blacklist bl"
        f" WHERE bl.contact_id = {contact_col} AND bl.client_id = {client_col})"
    )


async def is_contact_blacklisted(db, client_id: int, contact_id: int) -> bool:
    """Заблокирован ли контакт в базе этого клиента."""
    if not client_id or not contact_id:
        return False
    return bool(await db.fetchval(
        "SELECT 1 FROM contact_blacklist WHERE client_id = $1 AND contact_id = $2",
        client_id, contact_id
    ))


async def is_identity_blacklisted(
    db, client_id: int, platform_slug: str, platform_user_id: str
) -> bool:
    """
    Заблокирован ли человек по его аккаунту на платформе.

    Нужно на входе в бота, когда contact_id ещё не резолвлен: ищем контакт
    по platform_users и проверяем блок. Если контакта нет — не заблокирован
    (человек в базе клиента впервые).
    """
    if not client_id or not platform_user_id:
        return False
    return bool(await db.fetchval(
        """SELECT 1
             FROM platform_users pu
             JOIN contact_blacklist bl ON bl.contact_id = pu.contact_id
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE c_own.client_id = $1
              AND pu.platform_slug = $2
              AND pu.platform_user_id = $3
              AND bl.client_id = $1
            LIMIT 1""",
        client_id, platform_slug, str(platform_user_id)
    ))


async def blocked_message(db, client_id: int, platform: str = "telegram") -> str:
    """
    Текст-заглушка для заблокированного + каналы поддержки клиента.

    Формат подписи под площадку: в TG допустим HTML, в VK/MAX — plain.
    """
    row = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1",
        client_id
    )
    lines = ["Доступ к материалам ограничен — вы в чёрном списке."]
    contacts = []
    if row:
        # ⚠️ work_tg_username у части клиентов заполнен полным URL
        # (https://telegram.me/ник), а не ником — вытаскиваем ник.
        tg = (row["work_tg_username"] or "").strip()
        if tg:
            tg = tg.rstrip("/").split("/")[-1].lstrip("@")
        if tg:
            contacts.append(f"Telegram: @{tg}" if platform != "telegram"
                            else f'Telegram: <a href="https://t.me/{tg}">@{tg}</a>')
        if row["work_vk"]:
            contacts.append(f"VK: {row['work_vk']}")
        if row["work_max"]:
            contacts.append(f"MAX: {row['work_max']}")

    if contacts:
        lines.append("")
        lines.append("Если это ошибка — напишите в поддержку:")
        lines.extend(contacts)
    else:
        lines.append("")
        lines.append("Если это ошибка — обратитесь в службу поддержки.")
    return "\n".join(lines)


async def is_collab_hub_blocked(db, client_id: int) -> bool:
    """Запрещена ли клиенту покупка Коллабораторной (ставит админ)."""
    if not client_id:
        return False
    return bool(await db.fetchval(
        "SELECT collab_hub_blocked FROM clients WHERE id = $1", client_id
    ))
