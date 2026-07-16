"""Аналитика вебинарной комнаты: присутствие по времени + активность зрителей.

Строит то, что видно на дашборде (референс — GetCourse):
- метрики: всего уникальных, пик онлайн, комментарии, клики, заказы/оплаты;
- график «уникальные онлайн» по интервалам (5/10/20/40/60 мин) + наложение активности;
- активность ПО КАЖДОМУ ЗРИТЕЛЮ (сообщения/реакции) — под будущую геймификацию.
"""
from __future__ import annotations

from typing import Optional


async def compute_analytics(db, room_id: int, step_min: int = 5) -> dict:
    # ── всего уникальных за всё время ────────────────────────────────────────
    total_uniq = await db.fetchval(
        "SELECT COUNT(DISTINCT COALESCE(contact_id::text, session_key)) "
        "FROM webinar_presence WHERE room_id=$1", room_id) or 0

    # ── присутствие по бакетам step_min ──────────────────────────────────────
    # округляем bucket_at (минутные точки) к сетке step_min, считаем уникальных
    presence = await db.fetch(
        """
        SELECT to_timestamp(floor(extract(epoch from bucket_at) / ($2*60)) * ($2*60)) AS slot,
               COUNT(DISTINCT COALESCE(contact_id::text, session_key)) AS uniq
          FROM webinar_presence
         WHERE room_id=$1
         GROUP BY slot ORDER BY slot
        """, room_id, step_min,
    )
    series = [{"at": r["slot"].isoformat(), "uniq": r["uniq"]} for r in presence]

    # ── пик онлайн ───────────────────────────────────────────────────────────
    peak = max((p["uniq"] for p in series), default=0)
    peak_at = next((p["at"] for p in series if p["uniq"] == peak), None) if peak else None

    # ── активность по бакетам (для точек на графике) ─────────────────────────
    activity = await db.fetch(
        """
        SELECT to_timestamp(floor(extract(epoch from at) / ($2*60)) * ($2*60)) AS slot,
               kind, COUNT(*) AS n
          FROM webinar_activity
         WHERE room_id=$1
         GROUP BY slot, kind ORDER BY slot
        """, room_id, step_min,
    )
    act_series: dict = {}
    for r in activity:
        slot = r["slot"].isoformat()
        act_series.setdefault(slot, {})[r["kind"]] = r["n"]

    # ── суммарные метрики активности ─────────────────────────────────────────
    totals = await db.fetch(
        "SELECT kind, COUNT(*) AS n FROM webinar_activity WHERE room_id=$1 GROUP BY kind", room_id)
    tmap = {r["kind"]: r["n"] for r in totals}
    comments = tmap.get("chat_msg", 0)
    clicks = tmap.get("click", 0)
    orders = tmap.get("order", 0)
    payments = tmap.get("payment", 0)

    # ── вовлечённость: доля уникальных, кто хоть раз проявил активность ───────
    active_uniq = await db.fetchval(
        "SELECT COUNT(DISTINCT COALESCE(contact_id::text, session_key)) "
        "FROM webinar_activity WHERE room_id=$1", room_id) or 0
    engagement = round(active_uniq / total_uniq * 100, 1) if total_uniq else 0.0

    return {
        "step_min": step_min,
        "metrics": {
            "total_unique": total_uniq,
            "peak_online": peak,
            "peak_at": peak_at,
            "engagement_pct": engagement,
            "comments": comments,
            "clicks": clicks,
            "orders": orders,
            "payments": payments,
        },
        "presence": series,
        "activity": act_series,
    }


async def viewer_activity(db, room_id: int, limit: int = 200) -> dict:
    """Активность ПО КАЖДОМУ ЗРИТЕЛЮ — сообщения и реакции (для геймификации)."""
    rows = await db.fetch(
        """
        SELECT a.contact_id, c.name,
               COUNT(*) FILTER (WHERE a.kind='chat_msg')  AS messages,
               COUNT(*) FILTER (WHERE a.kind='reaction')  AS reactions,
               COUNT(*) FILTER (WHERE a.kind='click')     AS clicks,
               COUNT(*) FILTER (WHERE a.kind='poll_vote') AS poll_votes,
               COUNT(*)                                   AS total
          FROM webinar_activity a
          LEFT JOIN contacts c ON c.id = a.contact_id
         WHERE a.room_id=$1 AND a.contact_id IS NOT NULL
         GROUP BY a.contact_id, c.name
         ORDER BY total DESC
         LIMIT $2
        """, room_id, limit,
    )
    return {"viewers": [dict(r) for r in rows]}
