"""Общие хелперы вебинарной комнаты (миграция 221).

Переиспользуются клиентским и публичным роутерами + WS-хабом:
- владение событием (через event_owners),
- резолв client_id по slug,
- генерация ключа потока,
- «текущий спикер по слоту программы дня» (для авто-кнопки подписки/подарка),
- тегирование контакта (JSONB contacts.tags — отдельного write-эндпоинта в проекте нет).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import HTTPException

# Московское время — вся программа проекта в МСК (см. правило "время HH:MM МСК").
MSK = timezone(timedelta(hours=3))

_KEY_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"  # без похожих 0/o/1/l/i


def make_stream_key(n: int = 16) -> str:
    return "".join(secrets.choice(_KEY_ALPHABET) for _ in range(n))


async def resolve_event_by_slug(db, slug: str) -> Optional[dict]:
    """Событие + client_id владельца по slug (у events нет client_id — берём из event_owners)."""
    row = await db.fetchrow(
        "SELECT id, title, slug, module_slug, status, "
        "  (SELECT eo.client_id FROM event_owners eo "
        "     WHERE eo.event_id=events.id AND eo.status='accepted' "
        "     ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id "
        "FROM events WHERE slug = $1",
        slug,
    )
    return dict(row) if row else None


async def assert_event_owner(db, event_id: int, client_id: int) -> None:
    """404 если событие не принадлежит клиенту (через event_owners, status='accepted')."""
    row = await db.fetchrow(
        "SELECT 1 FROM events WHERE id = $1 AND id IN "
        "(SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено или нет доступа")


async def get_room_or_404(db, event_id: int, day_number: int) -> dict:
    row = await db.fetchrow(
        "SELECT * FROM webinar_rooms WHERE event_id=$1 AND day_number=$2",
        event_id, day_number,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Вебинарная комната не найдена")
    return dict(row)


async def current_speaker_ec_id(db, event_id: int, day_number: int) -> Optional[int]:
    """event_collaborators.id спикера, чей слот программы дня идёт СЕЙЧАС (МСК).

    conf_sessions.speaker_id = event_collaborators.id (не collaborators.id).
    Ориентир — start_time/end_time слота (TEXT "HH:MM"). Если сейчас между началом
    и концом какого-то слота — его спикер «в эфире». Иначе None.
    """
    now = datetime.now(MSK)
    hhmm = now.strftime("%H:%M")
    row = await db.fetchrow(
        "SELECT speaker_id FROM conf_sessions "
        " WHERE event_id=$1 AND day=$2 AND speaker_id IS NOT NULL "
        "   AND start_time IS NOT NULL AND start_time <= $3 "
        "   AND (end_time IS NULL OR end_time >= $3) "
        " ORDER BY start_time DESC LIMIT 1",
        event_id, day_number, hhmm,
    )
    return row["speaker_id"] if row else None


async def speaker_follow_card(db, event_id: int, ec_id: Optional[int]) -> Optional[dict]:
    """Данные для авто-кнопки «Подписаться на спикера» / плашки «Сейчас выступает».

    По event_collaborators.id → имя коллаба + его каналы (TG/VK/MAX).
    """
    if not ec_id:
        return None
    row = await db.fetchrow(
        "SELECT ec.id AS ec_id, c.name, c.tg_channel_url, c.vk_url, c.max_url, c.photo_url "
        "FROM event_collaborators ec JOIN collaborators c ON c.id = ec.speaker_id "
        "WHERE ec.id = $1 AND ec.event_id = $2",
        ec_id, event_id,
    )
    if not row:
        return None
    d = dict(row)
    return {
        "ec_id": d["ec_id"],
        "name": d["name"],
        "photo_url": d["photo_url"],
        "channels": {
            "telegram": d["tg_channel_url"],
            "vk": d["vk_url"],
            "max": d["max_url"],
        },
    }


async def speaker_gift_card(db, event_id: int, ec_id: Optional[int]) -> Optional[dict]:
    """Подарок спикера для всплытия по таймингу слота.

    Источник — event_collaborators: ручной подарок (gift_after_speech_*) ИЛИ
    привязанный лид-магнит/пакет ПЛЮСОНа.
    """
    if not ec_id:
        return None
    row = await db.fetchrow(
        "SELECT gift_after_speech_title, gift_after_speech_url, "
        "       gift_lead_magnet_id, gift_package_id "
        "FROM event_collaborators WHERE id=$1 AND event_id=$2",
        ec_id, event_id,
    )
    if not row:
        return None
    d = dict(row)
    if d["gift_after_speech_title"] or d["gift_after_speech_url"]:
        return {"kind": "manual", "title": d["gift_after_speech_title"], "url": d["gift_after_speech_url"]}
    if d["gift_lead_magnet_id"]:
        return {"kind": "lead_magnet", "lead_magnet_id": d["gift_lead_magnet_id"]}
    if d["gift_package_id"]:
        return {"kind": "package", "package_id": d["gift_package_id"]}
    return None


async def tag_contact(db, client_id: int, contact_id: int, tag: str) -> None:
    """Добавить тег контакту (JSONB contacts.tags), без дублей.

    В проекте нет готового write-эндпоинта тегов — паттерн через
    jsonb_array_elements_text + agg (операторы уже используются в contacts.py).
    """
    if not tag:
        return
    await db.execute(
        "UPDATE contacts SET tags = ("
        "  SELECT to_jsonb(array_agg(DISTINCT t)) FROM jsonb_array_elements_text("
        "    COALESCE(tags,'[]'::jsonb) || to_jsonb(ARRAY[$2::text])) t"
        ") WHERE id = $1 AND client_id = $3",
        contact_id, tag, client_id,
    )


def rtmp_url(stream_key: str) -> str:
    from app.config import settings
    return f"rtmp://{settings.webinar_rtmp_host}/live/{stream_key}"


def hls_url(stream_key: str) -> str:
    from app.config import settings
    return f"{settings.webinar_hls_base}/{stream_key}/index.m3u8"
