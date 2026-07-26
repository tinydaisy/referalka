"""Аналитика вебинарной комнаты: присутствие по времени + активность зрителей.

Строит то, что видно на дашборде (референс — GetCourse):
- метрики: всего уникальных, пик онлайн, комментарии, клики, заказы/оплаты;
- график «уникальные онлайн» по интервалам (5/10/20/40/60 мин) + наложение активности;
- активность ПО КАЖДОМУ ЗРИТЕЛЮ (сообщения/реакции) — под будущую геймификацию.

session_id (запуск эфира): если задан — аналитика считается ТОЛЬКО по этой сессии
(тест не смешивается с боевым эфиром). None — по всей комнате (все запуски + старые).
"""
from __future__ import annotations

from typing import Optional


async def compute_analytics(db, room_id: int, step_min: int = 5,
                            session_id: Optional[int] = None) -> dict:
    # фильтр по сессии: '' — вся комната, ' AND session_id=$N' — конкретный запуск
    sf = " AND session_id=$3" if session_id is not None else ""
    sf2 = " AND session_id=$2" if session_id is not None else ""
    args3 = (room_id, step_min, session_id) if session_id is not None else (room_id, step_min)
    args2 = (room_id, session_id) if session_id is not None else (room_id,)

    # ── всего уникальных ─────────────────────────────────────────────────────
    # ⚠️ НЕ COALESCE(contact_id, session_key) — иначе один человек, заходивший
    # анонимно (session_key) и потом авторизовавшийся (contact_id), считается ДВАЖДЫ.
    # Считаем: distinct contact_id (опознанные) + distinct session_key ТОЛЬКО у
    # записей без contact_id (не опознанные ни разу).
    total_uniq = await db.fetchval(
        f"SELECT (SELECT COUNT(DISTINCT contact_id) FROM webinar_presence "
        f"          WHERE room_id=$1{sf2} AND contact_id IS NOT NULL) "
        f"     + (SELECT COUNT(DISTINCT session_key) FROM webinar_presence "
        f"          WHERE room_id=$1{sf2} AND contact_id IS NULL AND session_key IS NOT NULL)",
        *args2) or 0

    # ── присутствие по бакетам step_min ──────────────────────────────────────
    # uniq — все онлайн; authorized — известные (contact_id); vg — вовлечённые
    # (совершили действие в этом бакете); new — впервые появились.
    presence = await db.fetch(
        f"""
        WITH first_seen AS (
          SELECT COALESCE(contact_id::text, session_key) AS vid, MIN(bucket_at) AS fs
            FROM webinar_presence WHERE room_id=$1{sf} GROUP BY vid
        )
        SELECT to_timestamp(floor(extract(epoch from p.bucket_at) / ($2*60)) * ($2*60)) AS slot,
               COUNT(DISTINCT COALESCE(p.contact_id::text, p.session_key)) AS uniq,
               COUNT(DISTINCT p.contact_id) FILTER (WHERE p.contact_id IS NOT NULL) AS authorized,
               COUNT(DISTINCT COALESCE(p.contact_id::text, p.session_key))
                 FILTER (WHERE fs.fs >= to_timestamp(floor(extract(epoch from p.bucket_at)/($2*60))*($2*60))) AS new_v
          FROM webinar_presence p
          JOIN first_seen fs ON fs.vid = COALESCE(p.contact_id::text, p.session_key)
         WHERE p.room_id=$1{sf}
         GROUP BY slot ORDER BY slot
        """, *args3,
    )
    # вовлечённые по бакетам (кто совершил действие)
    eng = await db.fetch(
        f"""
        SELECT to_timestamp(floor(extract(epoch from at) / ($2*60)) * ($2*60)) AS slot,
               COUNT(DISTINCT COALESCE(contact_id::text, session_key)) AS engaged
          FROM webinar_activity WHERE room_id=$1{sf}
         GROUP BY slot
        """, *args3,
    )
    eng_map = {r["slot"].isoformat(): r["engaged"] for r in eng}
    series = [{
        "at": r["slot"].isoformat(),
        "uniq": r["uniq"],
        "authorized": r["authorized"],
        "new": r["new_v"],
        "engaged": eng_map.get(r["slot"].isoformat(), 0),
        "active": r["uniq"],   # TODO: реальный фокус-флаг из heartbeat (пока = uniq)
    } for r in presence]

    peak = max((p["uniq"] for p in series), default=0)
    peak_at = next((p["at"] for p in series if p["uniq"] == peak), None) if peak else None

    # ── активность по бакетам (точки на графике) ─────────────────────────────
    activity = await db.fetch(
        f"""
        SELECT to_timestamp(floor(extract(epoch from at) / ($2*60)) * ($2*60)) AS slot,
               kind, COUNT(*) AS n
          FROM webinar_activity
         WHERE room_id=$1{sf}
         GROUP BY slot, kind ORDER BY slot
        """, *args3,
    )
    act_series: dict = {}
    for r in activity:
        act_series.setdefault(r["slot"].isoformat(), {})[r["kind"]] = r["n"]

    # ── суммарные метрики активности ─────────────────────────────────────────
    totals = await db.fetch(
        f"SELECT kind, COUNT(*) AS n FROM webinar_activity WHERE room_id=$1{sf2} GROUP BY kind", *args2)
    tmap = {r["kind"]: r["n"] for r in totals}

    active_uniq = await db.fetchval(
        f"SELECT COUNT(DISTINCT COALESCE(contact_id::text, session_key)) "
        f"FROM webinar_activity WHERE room_id=$1{sf2}", *args2) or 0
    engagement = round(active_uniq / total_uniq * 100, 1) if total_uniq else 0.0

    return {
        "step_min": step_min,
        "session_id": session_id,
        "metrics": {
            "total_unique": total_uniq,
            "peak_online": peak,
            "peak_at": peak_at,
            "engagement_pct": engagement,
            "comments": tmap.get("chat_msg", 0),
            "clicks": tmap.get("click", 0),
            "orders": tmap.get("order", 0),
            "payments": tmap.get("payment", 0),
        },
        "presence": series,
        "activity": act_series,
    }


async def viewer_activity(db, room_id: int, limit: int = 200,
                          session_id: Optional[int] = None) -> dict:
    """Активность ПО КАЖДОМУ ЗРИТЕЛЮ — сообщения и реакции (для геймификации)."""
    sf = " AND a.session_id=$3" if session_id is not None else ""
    args = (room_id, limit, session_id) if session_id is not None else (room_id, limit)
    rows = await db.fetch(
        f"""
        SELECT a.contact_id, c.name,
               COUNT(*) FILTER (WHERE a.kind='chat_msg')  AS messages,
               COUNT(*) FILTER (WHERE a.kind='reaction')  AS reactions,
               COUNT(*) FILTER (WHERE a.kind='click')     AS clicks,
               COUNT(*) FILTER (WHERE a.kind='poll_vote') AS poll_votes,
               COUNT(*)                                   AS total
          FROM webinar_activity a
          LEFT JOIN contacts c ON c.id = a.contact_id
         WHERE a.room_id=$1 AND a.contact_id IS NOT NULL{sf}
         GROUP BY a.contact_id, c.name
         ORDER BY total DESC
         LIMIT $2
        """, *args,
    )
    return {"viewers": [dict(r) for r in rows]}


async def list_sessions(db, room_id: int) -> dict:
    """Список запусков эфира (сессий) комнаты — для селектора в аналитике."""
    rows = await db.fetch(
        """
        SELECT s.id, s.started_at, s.ended_at, s.title,
               (SELECT COUNT(DISTINCT COALESCE(p.contact_id::text, p.session_key))
                  FROM webinar_presence p WHERE p.session_id = s.id) AS unique_viewers
          FROM webinar_sessions s
         WHERE s.room_id=$1
         ORDER BY s.started_at DESC
        """, room_id,
    )
    return {"sessions": [dict(r) for r in rows]}
