"""Realtime-хаб вебинарной комнаты: WebSocket + Redis pub/sub.

Зачем Redis. API может крутиться в нескольких воркерах uvicorn — WS-соединения
зрителей раскиданы по процессам. Чтобы событие (новое сообщение чата, реакция,
запуск опроса/батла), пришедшее в один процесс, долетело до всех зрителей во всех
процессах, публикуем его в Redis-канал `webinar:{room_id}`, а каждый процесс на него
подписан и рассылает своим локальным сокетам.

Graceful degrade: если Redis недоступен — работаем в пределах одного процесса
(локальный broadcast). На одном воркере этого достаточно.
"""
from __future__ import annotations

import asyncio
import json
from typing import Dict, Set, Optional

from app.config import settings

try:
    import redis.asyncio as aioredis  # redis==5.x (есть в проекте под Celery)
except Exception:  # pragma: no cover
    aioredis = None


class _Hub:
    def __init__(self) -> None:
        # room_id -> набор активных WebSocket-объектов в ЭТОМ процессе
        self._local: Dict[int, Set] = {}
        self._redis = None
        self._pubsub_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    async def _ensure_redis(self) -> None:
        if self._redis is not None or aioredis is None:
            return
        try:
            self._redis = aioredis.from_url(settings.redis_url, decode_responses=True)
            await self._redis.ping()
            self._pubsub_task = asyncio.create_task(self._listen())
        except Exception:
            self._redis = None  # фолбэк на локальный режим

    async def _listen(self) -> None:
        """Единая подписка на все комнаты процесса: канал webinar:*."""
        assert self._redis is not None
        pubsub = self._redis.pubsub()
        await pubsub.psubscribe("webinar:*")
        async for msg in pubsub.listen():
            if msg.get("type") != "pmessage":
                continue
            try:
                channel = msg["channel"]           # webinar:{room_id}
                room_id = int(channel.split(":")[1])
                data = json.loads(msg["data"])
            except Exception:
                continue
            await self._local_broadcast(room_id, data)

    async def connect(self, room_id: int, ws) -> None:
        await self._ensure_redis()
        async with self._lock:
            self._local.setdefault(room_id, set()).add(ws)

    async def disconnect(self, room_id: int, ws) -> None:
        async with self._lock:
            conns = self._local.get(room_id)
            if conns:
                conns.discard(ws)
                if not conns:
                    self._local.pop(room_id, None)

    async def _local_broadcast(self, room_id: int, data: dict) -> None:
        conns = list(self._local.get(room_id, ()))
        dead = []
        for ws in conns:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(room_id, ws)

    async def publish(self, room_id: int, data: dict) -> None:
        """Разослать событие всем зрителям комнаты (через Redis, если он есть)."""
        await self._ensure_redis()
        if self._redis is not None:
            try:
                await self._redis.publish(f"webinar:{room_id}", json.dumps(data, default=str))
                return
            except Exception:
                pass  # Redis отвалился — на локальный режим
        await self._local_broadcast(room_id, data)

    def online_count(self, room_id: int) -> int:
        return len(self._local.get(room_id, ()))


_hub = _Hub()


async def connect(room_id: int, ws) -> None:
    await _hub.connect(room_id, ws)


async def disconnect(room_id: int, ws) -> None:
    await _hub.disconnect(room_id, ws)


async def publish(room_id: int, data: dict) -> None:
    await _hub.publish(room_id, data)


def online_count(room_id: int) -> int:
    return _hub.online_count(room_id)
