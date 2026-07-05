"""
Автозапись истории коллабораций (Коллабораторная / Хаб).

Рейтинг партнёра, Win-Win-коэффициент и число коллабов на карточке в Хабе
считаются из hub_collab_history (collab_hub.py / collab_events.py — только SELECT).
Раньше в эту таблицу НИКАКОЙ код не писал — наполнялась только ручным SQL (демо).
Из-за этого у реальных клиентов рейтинг всегда был «0 коллабов / — вклад».

Здесь — единственная точка автозаписи. Зовётся при ЗАВЕРШЕНИИ коллаб-события
(status → ended) из update_event. Идемпотентно (UPSERT по UNIQUE(client_id, event_id),
миграция 193): повторный перевод в ended не плодит дубли, а обновляет вклад.

Что пишем на КАЖДОГО организатора (event_owners.status='accepted'):
  - participants_total = всего участников события
  - brought_live       = сколько живых он привёл = участники, кого привёл ЭТОТ
    организатор (referrer_ref_code → contacts.ref_code → contacts.client_id = его id)
    И кто дошёл до эфира (link_clicked_at IS NOT NULL)
  - partner_client_id  = один из ДРУГИХ организаторов (для строки «с кем коллабился»)

avg_contribution карточки = avg(100 * brought_live / participants_total) по всем строкам.
"""
import logging

logger = logging.getLogger(__name__)


async def record_collab_history(db, event_id: int) -> int:
    """Записать вклад каждого организатора коллаб-события в hub_collab_history.

    Вызывать ТОЛЬКО для коллаб-события (is_collab=TRUE) в момент завершения.
    Возвращает число записанных/обновлённых строк. Ошибки глушит (не роняет PATCH).
    """
    try:
        ev = await db.fetchrow(
            "SELECT is_collab FROM events WHERE id = $1", event_id)
        if not ev or not ev["is_collab"]:
            return 0

        owners = await db.fetch(
            "SELECT client_id FROM event_owners WHERE event_id = $1 AND status = 'accepted'",
            event_id)
        owner_ids = [o["client_id"] for o in owners]
        if len(owner_ids) < 2:
            return 0  # не коллаб по факту — один владелец

        participants_total = await db.fetchval(
            "SELECT count(*) FROM event_participants WHERE event_id = $1", event_id) or 0

        written = 0
        for cid in owner_ids:
            # Сколько ЖИВЫХ (дошли до эфира) привёл именно этот организатор:
            # участник события, чей referrer_ref_code принадлежит контакту
            # этого клиента (его реф-код / реф-код его коллаба), и link_clicked_at не пуст.
            brought_live = await db.fetchval(
                """SELECT count(DISTINCT ep.id)
                     FROM event_participants ep
                     JOIN contacts rc ON rc.ref_code = ep.referrer_ref_code
                    WHERE ep.event_id = $1
                      AND ep.link_clicked_at IS NOT NULL
                      AND rc.client_id = $2""",
                event_id, cid) or 0

            # «С кем коллабился» — любой другой организатор (для карточки-строки).
            partner_cid = next((o for o in owner_ids if o != cid), None)

            await db.execute(
                """INSERT INTO hub_collab_history
                       (client_id, event_id, partner_client_id, participants_total, brought_live)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (client_id, event_id) WHERE event_id IS NOT NULL
                   DO UPDATE SET partner_client_id = EXCLUDED.partner_client_id,
                                 participants_total = EXCLUDED.participants_total,
                                 brought_live = EXCLUDED.brought_live""",
                cid, event_id, partner_cid, participants_total, brought_live)
            written += 1

        logger.info("collab_history: event %s → %s owner-rows written", event_id, written)
        return written
    except Exception:
        logger.exception("collab_history: failed for event %s", event_id)
        return 0
