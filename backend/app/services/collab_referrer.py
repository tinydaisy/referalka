"""
Кто из организаторов КОЛЛАБ-события привёл конкретного участника.

В коллабе каждый организатор ведёт СВОЮ базу через СВОЕГО бота. Значит и служба
заботы у человека — та, чей организатор его привёл, а не владельца события.
Отсюда плейсхолдер {support_link_org} в воронке догрева коллаб-события.

Как определяем: участник пришёл по реф-ссылке организатора →
event_participants.referrer_ref_code → contacts.ref_code → contacts.client_id.
Если этот клиент действительно организатор события (event_owners) — он и есть
«тот, от кого пришёл». Иначе — None (вызывающий код падает на владельца события).
"""
import logging

logger = logging.getLogger(__name__)


async def resolve_source_organizer(db, event_id: int, contact_id: int) -> int | None:
    """client_id организатора коллаб-события, который привёл этого участника.

    None — если событие не коллаб, реферер не определён, или он не организатор.
    """
    try:
        is_collab = await db.fetchval("SELECT is_collab FROM events WHERE id = $1", event_id)
        if not is_collab:
            return None

        # Реф-код, по которому пришёл участник → чей это контакт
        cid = await db.fetchval(
            """SELECT rc.client_id
                 FROM event_participants ep
                 JOIN contacts rc ON rc.ref_code = ep.referrer_ref_code
                WHERE ep.event_id = $1 AND ep.contact_id = $2
                LIMIT 1""",
            event_id, contact_id)
        if not cid:
            return None

        # Он точно организатор ЭТОГО события?
        ok = await db.fetchval(
            """SELECT 1 FROM event_owners
                WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'""",
            event_id, cid)
        return cid if ok else None
    except Exception:
        logger.exception("resolve_source_organizer failed: event=%s contact=%s", event_id, contact_id)
        return None


async def support_html_for_client(db, client_id: int) -> str:
    """Служба заботы клиента (ВК/Телеграм/MAX) как HTML — для {support_link_org}."""
    from app.services.support_message import build_support_inline_html
    row = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1", client_id)
    if not row:
        return ""
    return build_support_inline_html(
        work_tg=row["work_tg_username"],
        work_vk=row["work_vk"],
        work_max=row["work_max"],
    )
