"""
Массовая проверка «кто из участников события состоит в Telegram-чате».

Кнопка «Проверить чаты» на странице участников события дёргает
POST /events/{id}/check-chats, который зовёт check_event_chat_membership().

Принцип:
- Берём ID чатов из events.telegram_chat_ids (CSV, формат «-100…»).
- Берём бот-токен: VIP-бот клиента → fallback системный @pluson_bot.
  Бот ОБЯЗАН быть админом чата, иначе getChatMember вернёт ошибку.
- По каждому участнику с числовым tg_id зовём getChatMember(chat_id, tg_id).
  Член хотя бы одного чата (member/administrator/creator/restricted-is_member)
  → is_in_chat=TRUE, иначе FALSE. Время проверки → chat_check_at=now().

Ограничения платформ:
- ВКонтакте-беседа и MAX-беседа через API не проверяются (нет метода,
  отдающего боту состав чужой беседы) — фича пока только Telegram.

Лимит Telegram ~30 запросов/сек — троттлим, чтобы не словить 429.
"""
import asyncio
from typing import Optional

import httpx

from app.config import settings
from .channels import get_client_telegram_token

# Статусы getChatMember, означающие «человек в чате».
_IN_CHAT_STATUSES = {"member", "administrator", "creator"}

# Пауза между запросами ~ 25 rps (запас от лимита 30).
_THROTTLE_SEC = 0.04


def _parse_chat_ids(raw: Optional[str]) -> list[str]:
    """CSV «-100…,-100…» → список валидных chat_id."""
    if not raw:
        return []
    out: list[str] = []
    for part in str(raw).split(","):
        t = part.strip()
        if t and (t.lstrip("-").isdigit()):
            out.append(t)
    return out


async def _is_member(http: httpx.AsyncClient, token: str, chat_id: str, tg_id: str) -> Optional[bool]:
    """getChatMember для одного (чат, человек).

    Возвращает:
      True  — в чате,
      False — точно не в чате (left/kicked),
      None  — не смогли определить (бот не админ / чат не найден / ошибка сети).
            None трактуем как «не подтверждено», в итог не засчитываем «в чате».
    """
    try:
        r = await http.get(
            f"https://api.telegram.org/bot{token}/getChatMember",
            params={"chat_id": chat_id, "user_id": tg_id},
        )
        data = r.json()
        if not data.get("ok"):
            return None
        status = (data.get("result") or {}).get("status")
        if status in _IN_CHAT_STATUSES:
            return True
        if status == "restricted":
            # ограничен, но может быть в чате — поле is_member
            return bool((data.get("result") or {}).get("is_member"))
        # left / kicked
        return False
    except Exception:
        return None


async def check_event_chat_membership(db, event_id: int, client_id: int) -> dict:
    """Проверяет всех участников события на членство в TG-чатах события.

    Пишет event_participants.is_in_chat + chat_check_at.
    Возвращает сводку для UI.
    """
    # Проверяем по чату СОБЫТИЯ (TG) — через ref на client_broadcast_chats.
    chat_ids_raw = await db.fetchval(
        """SELECT cbc.chat_id FROM events e
             JOIN client_broadcast_chats cbc ON cbc.id = e.tg_chat_ref
            WHERE e.id = $1
              AND e.id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')""",
        event_id, client_id,
    )
    chat_ids = _parse_chat_ids(chat_ids_raw)
    if not chat_ids:
        return {
            "ok": False,
            "reason": "no_chat_ids",
            "message": "У события не задан ID чата. Впишите его в блоке «Чаты события» → «ID чата для подсчёта заданий».",
        }

    token = await get_client_telegram_token(client_id, db)
    if not token:
        return {"ok": False, "reason": "no_bot_token", "message": "Не найден бот для проверки."}

    # Участники с числовым tg_id (псевдо-записи @username пропускаем — их не проверить).
    rows = await db.fetch(
        """SELECT ep.id AS participant_id,
                  pu.platform_user_id AS tg_id
             FROM event_participants ep
             JOIN contacts c ON c.id = ep.contact_id
             LEFT JOIN platform_users pu
                    ON pu.contact_id = c.id AND pu.platform_slug = 'telegram'
            WHERE ep.event_id = $1""",
        event_id,
    )

    total = len(rows)
    checked = 0          # реально опросили (есть tg_id)
    in_chat = 0
    skipped_no_tg = 0    # нет числового tg_id (только VK/MAX/email или псевдо-@username)
    undetermined = 0     # бот не админ / чат не найден — не смогли определить

    async with httpx.AsyncClient(timeout=10) as http:
        for row in rows:
            tg_id = row["tg_id"]
            pid = row["participant_id"]
            # Псевдо-запись @username или вовсе нет TG — не проверяем, is_in_chat не трогаем.
            if not tg_id or not str(tg_id).lstrip("-").isdigit():
                skipped_no_tg += 1
                continue

            member = False
            determined = False
            for chat_id in chat_ids:
                res = await _is_member(http, token, chat_id, str(tg_id))
                await asyncio.sleep(_THROTTLE_SEC)
                if res is True:
                    member = True
                    determined = True
                    break
                if res is False:
                    determined = True
                # res is None — не смогли по этому чату, пробуем следующий

            checked += 1
            if not determined:
                undetermined += 1
                # Ничего не записываем: статус остаётся прежним, но ставим время проверки.
                await db.execute(
                    "UPDATE event_participants SET chat_check_at = now() WHERE id = $1",
                    pid,
                )
                continue

            if member:
                in_chat += 1
            await db.execute(
                "UPDATE event_participants SET is_in_chat = $2, chat_check_at = now() WHERE id = $1",
                pid, member,
            )

    return {
        "ok": True,
        "total": total,
        "checked": checked,
        "in_chat": in_chat,
        "not_in_chat": checked - in_chat - undetermined,
        "skipped_no_tg": skipped_no_tg,
        "undetermined": undetermined,
        "chat_ids": chat_ids,
    }
