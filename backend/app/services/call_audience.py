"""
Аудитория автообзвона (миграция 359).

Собирает список «кому звонить» тем же набором фильтров, что и рассылки:
событие / регистрация / оплата / теги. Отличие одно — вместо идентичности на
площадке нужен ТЕЛЕФОН.

⚠️ `_build_audience` из рассылок сюда не годится: она возвращает
`platform_user_id` (Telegram) и проверяет подписку на бота. Телефон живёт на
`contacts`, площадки «phone» в `channels` нет. Поэтому выборка своя, но
ФИЛЬТРЫ переиспользуются дословно — три хелпера из tasks/broadcast.py,
работающие в терминах contact_id. Своих копий этих фильтров тут быть не должно:
разъедутся, и обзвон начнёт считать аудиторию не так, как рассылка.
"""
import logging
from typing import Optional

from app.services.blacklist import not_blacklisted_clause
from app.services.calldog import normalize_phone_for_calldog

logger = logging.getLogger(__name__)


async def collect_call_targets(
    conn,
    *,
    client_id: int,
    event_id: Optional[int] = None,
    audience_include: Optional[str] = None,
    audience_exclude: Optional[str] = None,
    tags_include: Optional[list] = None,
    tags_exclude: Optional[list] = None,
    require_consent: bool = False,
) -> dict:
    """Кому звоним.

    Возвращает:
      targets        — [{contact_id, phone, name}] готовые к отправке
      skipped_no_phone — сколько отсеяно без телефона или с негодным номером
      skipped_unsub    — сколько отказались от звонков
      total_contacts   — сколько всего прошло фильтры (для «дозвонимся N из M»)
    """
    # Ленивый импорт: tasks.broadcast тянет Celery, а этот модуль зовётся и из
    # API (счётчик охвата), где Celery поднимать незачем.
    from app.tasks.broadcast import (
        _tag_filtered_contact_ids,
        _excluded_contact_ids,
        _paid_filter_contact_ids,
    )

    aud_in = (audience_include or "").strip() or ("all_event" if event_id else "all_client")
    aud_ex = (audience_exclude or "").strip() or "none"

    # ── 1. Базовый круг: вся база клиента или участники события ──────────────
    # ⚠️ merged_into IS NULL — склеенные контакты исключаем, иначе один человек
    # получит два звонка (у дубля телефон тот же).
    if event_id and aud_in != "all_client":
        rows = await conn.fetch(
            """SELECT DISTINCT ep.contact_id
                 FROM event_participants ep
                 JOIN contacts c ON c.id = ep.contact_id
                WHERE ep.event_id = $1
                  AND c.client_id = $2
                  AND c.merged_into IS NULL
                  AND COALESCE(c.is_active, TRUE) = TRUE
                  AND (
                        $3::text = 'all_event'
                     OR ($3::text = 'registered_event'   AND ep.is_registered = TRUE)
                     OR ($3::text = 'unregistered_event' AND ep.is_registered = FALSE)
                     OR $3::text IN ('paid_event', 'unpaid_event')
                  )""",
            event_id, client_id, aud_in,
        )
    else:
        rows = await conn.fetch(
            """SELECT id AS contact_id FROM contacts
                WHERE client_id = $1 AND merged_into IS NULL
                  AND COALESCE(is_active, TRUE) = TRUE""",
            client_id,
        )
    contact_ids = {r["contact_id"] for r in rows if r["contact_id"]}
    if not contact_ids:
        return _empty()

    # ── 2. Фильтр по оплате (общий с рассылками) ─────────────────────────────
    if event_id:
        need_paid, paid_ids = await _paid_filter_contact_ids(conn, event_id, aud_in)
        if need_paid:
            contact_ids &= paid_ids

        excluded = await _excluded_contact_ids(conn, event_id, aud_ex)
        contact_ids -= excluded
    if not contact_ids:
        return _empty()

    # ── 3. Теги (общий с рассылками) ─────────────────────────────────────────
    contact_ids = await _tag_filtered_contact_ids(
        conn, client_id, tags_include or [], tags_exclude or [], contact_ids
    )
    if not contact_ids:
        return _empty()

    total_contacts = len(contact_ids)

    # ── 4. Телефон, отказ от звонков, чёрный список ──────────────────────────
    # ⚠️ Чёрный список — тот же общий, что у рассылок (`not_blacklisted_clause`):
    # человек, которому клиент запретил писать, не должен получать и звонки.
    consent_clause = ""
    if require_consent:
        # ⚠️ Согласие на маркетинг (миграция 099). Включается настройкой
        # кампании: у большинства старых контактов отметки нет, и жёсткая
        # проверка обнулила бы аудиторию без объяснения.
        consent_clause = " AND c.consent_marketing_at IS NOT NULL"

    # ⚠️ not_blacklisted_clause уже возвращает строку, НАЧИНАЮЩУЮСЯ с " AND " —
    # свой AND перед ней не ставить, иначе получится «AND AND» и запрос упадёт.
    rows = await conn.fetch(
        f"""SELECT c.id, c.name, c.phone, c.phone_normalized,
                   (c.calls_unsubscribed_at IS NOT NULL) AS unsub
              FROM contacts c
             WHERE c.id = ANY($1::int[])
               {not_blacklisted_clause('c.id', 'c.client_id')}
               {consent_clause}""",
        list(contact_ids),
    )

    targets, skipped_no_phone, skipped_unsub = [], 0, 0
    seen_phones: set[str] = set()
    for r in rows:
        if r["unsub"]:
            skipped_unsub += 1
            continue
        phone = normalize_phone_for_calldog(r["phone_normalized"] or "")
        if not phone:
            skipped_no_phone += 1
            continue
        # ⚠️ Дедуп по номеру: у двух контактов (муж/жена, старый и новый
        # аккаунт) бывает один телефон. Два звонка подряд на один номер —
        # верный путь к жалобе.
        if phone in seen_phones:
            continue
        seen_phones.add(phone)
        targets.append({
            "contact_id": r["id"],
            "phone": phone,
            "name": (r["name"] or "").strip(),
        })

    # Прошли фильтры, но телефона нет — тоже считаем «не дозвонимся».
    skipped_no_phone += max(0, total_contacts - len(rows) - skipped_unsub - skipped_no_phone)

    return {
        "targets": targets,
        "skipped_no_phone": skipped_no_phone,
        "skipped_unsub": skipped_unsub,
        "total_contacts": total_contacts,
    }


def _empty() -> dict:
    return {"targets": [], "skipped_no_phone": 0, "skipped_unsub": 0, "total_contacts": 0}


def chunked(items: list, size: int):
    """Резать список на пачки — их API принимает ограниченное число за раз."""
    for i in range(0, len(items), size):
        yield items[i:i + size]
