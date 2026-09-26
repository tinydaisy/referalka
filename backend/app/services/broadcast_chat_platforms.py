"""Площадки по видам чатов рассылки (миграция 520).

chat_platforms = {"private": [...], "common": [...], "event": [...], "speakers": [...]}
Нет ключа вида (или NULL целиком) = ВСЕ площадки. Движок читает поле в
tasks/broadcast.py (_chat_platforms_for); здесь — чистка на входе API и
разбор на выходе (asyncpg отдаёт JSONB строкой).
"""
from __future__ import annotations

import json

# Какие площадки бывают у каждого вида чатов. WhatsApp — только в общих
# чатах: в личных каналах, чатах события и спикеров его нет.
KIND_PLATFORMS: dict[str, tuple[str, ...]] = {
    "private": ("telegram", "max", "vk"),
    "common": ("telegram", "max", "vk", "whatsapp"),
    "event": ("telegram", "max", "vk"),
    "speakers": ("telegram", "max", "vk"),
}


def normalize(value) -> str | None:
    """Входящее значение → JSON-строка для `$N::jsonb`. None = не трогать.

    Лишние виды и площадки выбрасываем. Вид, где отмечены ВСЕ площадки,
    не храним — отсутствие ключа и так значит «все», а новая площадка,
    подключённая позже, не окажется снятой в старых рассылках."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:  # noqa: BLE001
            return None
    if not isinstance(value, dict):
        return None
    out: dict[str, list[str]] = {}
    for kind, allowed in KIND_PLATFORMS.items():
        v = value.get(kind)
        if not isinstance(v, list):
            continue
        picked = [p for p in allowed if p in v]
        if len(picked) < len(allowed):
            out[kind] = picked
    return json.dumps(out)


def parse(value) -> dict:
    """JSONB из базы (строка/dict/None) → dict для фронта."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:  # noqa: BLE001
            return {}
    return value if isinstance(value, dict) else {}


async def available(db, client_id: int, event_id: int | None = None) -> dict:
    """Площадки, где у вида чатов реально есть чат — столько галочек и рисуем.

    common/private — база чатов клиента (client_broadcast_chats);
    event/speakers — чаты этого события (без события — пусто)."""
    out: dict[str, list[str]] = {k: [] for k in KIND_PLATFORMS}
    rows = await db.fetch(
        """SELECT DISTINCT platform, is_private FROM client_broadcast_chats
            WHERE client_id = $1 AND is_active = TRUE AND use_for_broadcasts = TRUE""",
        client_id,
    )
    for r in rows:
        kind = "private" if r["is_private"] else "common"
        if r["platform"] in KIND_PLATFORMS[kind]:
            out[kind].append(r["platform"])
    if event_id:
        ev = await db.fetchrow(
            """SELECT tg_chat_ref, vk_chat_ref, max_chat_ref,
                      NULLIF(TRIM(tg_speakers_chat_id), '')  AS tg_sp,
                      NULLIF(TRIM(vk_speakers_chat_id), '')  AS vk_sp,
                      NULLIF(TRIM(max_speakers_chat_id), '') AS max_sp
                 FROM events WHERE id = $1""",
            event_id,
        )
        if ev:
            for pf, col in (("telegram", "tg_chat_ref"), ("max", "max_chat_ref"), ("vk", "vk_chat_ref")):
                if ev[col]:
                    out["event"].append(pf)
            for pf, col in (("telegram", "tg_sp"), ("max", "max_sp"), ("vk", "vk_sp")):
                if ev[col]:
                    out["speakers"].append(pf)
    # Порядок как в KIND_PLATFORMS — галочки всегда в одном порядке.
    return {k: [p for p in KIND_PLATFORMS[k] if p in out[k]] for k in out}
