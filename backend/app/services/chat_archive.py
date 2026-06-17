"""Слушалка чатов событий — архив сообщений для подсчёта заданий.

⚠️ ОТДЕЛЬНО от слушалки ботов (личка). Эта слушалка ничего не отвечает
   и не шлёт уведомлений организатору — только тихо складывает каждое
   сообщение чата события в `event_chat_messages`, чтобы потом считать
   баллы по ключевым словам.

⚠️ Контакты НЕ создаёт. Автора сообщения только СОПОСТАВЛЯЕТ с уже
   существующим контактом клиента по платформенному id (tg_id/vk_id/max).
   Не нашёл — пишет contact_id=NULL (привязка вручную позже).

Что слушаем:
  - chat_id чата события хранится в events.tg_chat_id / vk_chat_id / max_chat_id.
  - Сообщение пишем в архив ТОЛЬКО если его chat_id совпал с одним из этих полей.

Что запоминаем для кнопки «Определить ID»:
  - Каждый чат, где бот админ (поймал сообщение или своё добавление),
    апсертим в bot_known_chats. Кнопка в дашборде читает эту таблицу.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.database import get_pool

log = logging.getLogger(__name__)


async def remember_known_chat(
    *,
    platform: str,
    chat_id: str,
    title: Optional[str],
    bot_id: Optional[str],
    client_id: Optional[int],
    can_read: bool = True,
) -> None:
    """Апсерт чата, где бот админ — для кнопки «Определить ID» в дашборде.

    НЕ контакты. Отдельная служебная таблица bot_known_chats.
    """
    chat_id = str(chat_id)
    bot_id = str(bot_id) if bot_id is not None else None
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            await db.execute(
                """
                INSERT INTO bot_known_chats
                    (client_id, platform, chat_id, title, bot_id, can_read, last_seen_at)
                VALUES ($1, $2, $3, $4, $5, $6, now())
                ON CONFLICT (platform, chat_id, bot_id) DO UPDATE
                   SET title        = COALESCE(EXCLUDED.title, bot_known_chats.title),
                       can_read     = EXCLUDED.can_read,
                       client_id    = COALESCE(EXCLUDED.client_id, bot_known_chats.client_id),
                       last_seen_at = now()
                """,
                client_id, platform, chat_id, title, bot_id, can_read,
            )
    except Exception as e:  # noqa: BLE001 — слушалка не должна падать
        log.warning("remember_known_chat failed (%s chat=%s): %s", platform, chat_id, e)


async def _resolve_event_for_chat(db, platform: str, chat_id: str) -> Optional[tuple[int, int]]:
    """По (платформа, chat_id) найти событие, чей чат это. Возвращает (event_id, client_id) или None.

    Резолв через event_owners (новая co-ownership-архитектура): берём первого
    владельца события (accepted) как client_id для резолва автора.
    """
    col = {
        "telegram": "tg_chat_id",
        "vk": "vk_chat_id",
        "max": "max_chat_id",
    }.get(platform)
    if not col:
        return None
    row = await db.fetchrow(
        f"""
        SELECT e.id AS event_id,
               (SELECT eo.client_id FROM event_owners eo
                  WHERE eo.event_id = e.id AND eo.status = 'accepted'
                  ORDER BY eo.id LIMIT 1) AS client_id
          FROM events e
         WHERE e.{col} = $1
         LIMIT 1
        """,
        str(chat_id),
    )
    if not row or row["client_id"] is None:
        return None
    return int(row["event_id"]), int(row["client_id"])


async def _resolve_contact_id(db, client_id: int, platform: str, platform_user_id: str) -> Optional[int]:
    """Сопоставить автора сообщения с существующим контактом клиента по id площадки.

    НЕ создаёт контакт. Не нашёл → None.
    """
    return await db.fetchval(
        """
        SELECT pu.contact_id
          FROM platform_users pu
         WHERE pu.client_id = $1
           AND pu.platform_slug = $2
           AND pu.platform_user_id = $3
         LIMIT 1
        """,
        client_id, platform, str(platform_user_id),
    )


async def archive_chat_message(
    *,
    platform: str,
    chat_id: str,
    platform_user_id: str,
    username: Optional[str],
    author_name: Optional[str],
    text: Optional[str],
    has_attachment: bool,
    attachment_kind: Optional[str],
    message_ref: Optional[str],
    sent_at=None,
) -> bool:
    """Записать сообщение чата в архив, ЕСЛИ этот чат привязан к событию.

    Возвращает True если записали (чат события), False если чат не наш.
    Дедуп по (event_id, platform, chat_id, message_ref).
    """
    chat_id = str(chat_id)
    platform_user_id = str(platform_user_id)
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            resolved = await _resolve_event_for_chat(db, platform, chat_id)
            if not resolved:
                return False  # чат не привязан ни к одному событию — не наше дело
            event_id, client_id = resolved

            contact_id = await _resolve_contact_id(db, client_id, platform, platform_user_id)

            await db.execute(
                """
                INSERT INTO event_chat_messages
                    (event_id, platform, chat_id, platform_user_id, username,
                     author_name, contact_id, text, has_attachment, attachment_kind,
                     message_ref, sent_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, now()))
                ON CONFLICT (event_id, platform, chat_id, message_ref)
                    WHERE message_ref IS NOT NULL DO NOTHING
                """,
                event_id, platform, chat_id, platform_user_id, username,
                author_name, contact_id, text, has_attachment, attachment_kind,
                message_ref, sent_at,
            )
            return True
    except Exception as e:  # noqa: BLE001 — слушалка не должна падать
        log.warning("archive_chat_message failed (%s chat=%s): %s", platform, chat_id, e)
        return False


# ─────────────────────────────────────────────────────────────────────────────
# КОНТРОЛЬ ЗАДАНИЙ — ловля кодовых фраз критериев → балл + лог task_submissions
# ─────────────────────────────────────────────────────────────────────────────

async def _resolve_subject_for_audience(
    db, event_id: int, contact_id: Optional[int], audience: str
) -> Optional[tuple[str, int]]:
    """По contact_id и аудитории этапа вернуть (subject_kind, subject_id).

    audience='speakers' → event_collaborators.id (subject_kind='ec'),
    audience='viewers'  → event_participants.id   (subject_kind='ep').
    Не нашёл — None (автор не участник турнира в этой роли).
    """
    if not contact_id:
        return None
    if audience == "speakers":
        ec_id = await db.fetchval(
            """SELECT ec.id FROM event_collaborators ec
                 JOIN collaborators co ON co.id = ec.speaker_id
                WHERE ec.event_id = $1 AND co.contact_id = $2
                ORDER BY ec.id LIMIT 1""",
            event_id, contact_id,
        )
        return ("ec", int(ec_id)) if ec_id else None
    else:  # viewers
        ep_id = await db.fetchval(
            """SELECT id FROM event_participants
                WHERE event_id = $1 AND contact_id = $2
                ORDER BY id LIMIT 1""",
            event_id, contact_id,
        )
        return ("ep", int(ep_id)) if ep_id else None


def _build_message_link(platform: str, chat_id: str, message_ref: Optional[str]) -> Optional[str]:
    """Ссылка на сообщение в чате, где платформа это позволяет.

    TG: только публичные супергруппы (t.me/c/<internal>/<msg>) — для приватных
        ссылка может не открыться, но даём как есть.
    VK/MAX: прямой ссылки на сообщение беседы нет — None.
    """
    if platform == "telegram" and message_ref:
        # chat_id вида -100XXXXXXXXXX → внутренний id = XXXXXXXXXX
        cid = chat_id.lstrip("-")
        if cid.startswith("100"):
            cid = cid[3:]
        return f"https://t.me/c/{cid}/{message_ref}"
    return None


async def process_task_submissions(
    *,
    platform: str,
    chat_id: str,
    platform_user_id: str,
    username: Optional[str],
    author_name: Optional[str],
    text: Optional[str],
    attachments: Optional[list],
    message_ref: Optional[str],
    sent_at=None,
) -> list[dict]:
    """Ищет кодовые фразы критериев в сообщении чата события и засчитывает.

    Для каждого manual-критерия с непустой code_phrase, чья фраза найдена в тексте
    (где угодно, без регистра):
      - резолвит автора по аудитории этапа (speakers→ec / viewers→ep);
      - опознан → апсертит балл (scale_max) в tournament_scores + лог recognized=true;
      - не опознан → лог recognized=false (красным в UI) + добавляет в результат
        «нужно ответить автору».

    Возвращает список dict для бота: [{recognized: bool, ...}] по неопознанным —
    чтобы бот ответил «вы не регистрировались». Если слушание выключено или
    фраз нет — пустой список.
    """
    if not text:
        return []
    chat_id = str(chat_id)
    platform_user_id = str(platform_user_id)
    low = text.lower()
    results: list[dict] = []
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            resolved = await _resolve_event_for_chat(db, platform, chat_id)
            if not resolved:
                return []
            event_id, client_id = resolved

            # Слушание включено?
            enabled = await db.fetchval(
                "SELECT task_listen_enabled FROM events WHERE id = $1", event_id
            )
            if not enabled:
                return []

            # Критерии с кодовой фразой (только manual).
            criteria = await db.fetch(
                """SELECT tc.id, tc.code_phrase, tc.scale_max, tc.stage_id,
                          COALESCE(cs.listen_audience, 'viewers') AS audience
                     FROM tournament_criteria tc
                     LEFT JOIN conf_stages cs ON cs.id = tc.stage_id
                    WHERE tc.event_id = $1 AND tc.scorer = 'manual'
                      AND tc.is_active = TRUE
                      AND tc.code_phrase IS NOT NULL AND TRIM(tc.code_phrase) <> ''""",
                event_id,
            )
            if not criteria:
                return []

            contact_id = await _resolve_contact_id(db, client_id, platform, platform_user_id)
            msg_link = _build_message_link(platform, chat_id, message_ref)
            atts_json = attachments or []

            matched_any = False
            unrecognized_phrases: list[str] = []

            for c in criteria:
                phrase = (c["code_phrase"] or "").strip().lower()
                if not phrase or phrase not in low:
                    continue
                matched_any = True
                subj = await _resolve_subject_for_audience(
                    db, event_id, contact_id, c["audience"]
                )
                recognized = subj is not None
                subject_kind = subj[0] if subj else None
                subject_id = subj[1] if subj else None
                score_applied = False

                # Опознан → ставим ВСЕГДА 1 балл за выполнение задания (НЕ scale_max!).
                # Кодовая фраза = «задание выполнено» → 1 балл. Важность критерия
                # регулируется его ВЕСОМ (он есть в UI), а не баллом. scale_max для
                # manual в интерфейсе не показывается и у новых критериев = 10 по
                # умолчанию — поэтому на него НЕ завязываемся.
                if recognized:
                    await db.execute(
                        """
                        INSERT INTO tournament_scores
                            (event_id, criterion_id, subject_kind, subject_id,
                             juror_ec_id, scorer, value_number)
                        VALUES ($1, $2, $3, $4, NULL, 'manual', 1)
                        ON CONFLICT (criterion_id, subject_kind, subject_id)
                            WHERE juror_ec_id IS NULL
                        DO UPDATE SET value_number = 1, updated_at = now()
                        """,
                        event_id, c["id"], subject_kind, subject_id,
                    )
                    score_applied = True

                # Лог в task_submissions (дедуп по сообщение×критерий).
                import json as _json
                await db.execute(
                    """
                    INSERT INTO task_submissions
                        (event_id, criterion_id, stage_id, code_phrase, platform,
                         chat_id, platform_user_id, username, author_name,
                         subject_kind, subject_id, contact_id, recognized,
                         text, message_link, attachments, score_applied,
                         message_ref, sent_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                            COALESCE($19, now()))
                    ON CONFLICT (event_id, platform, chat_id, message_ref, criterion_id)
                        WHERE message_ref IS NOT NULL AND criterion_id IS NOT NULL
                    DO NOTHING
                    """,
                    event_id, c["id"], c["stage_id"], c["code_phrase"], platform,
                    chat_id, platform_user_id, username, author_name,
                    subject_kind, subject_id, contact_id, recognized,
                    text, msg_link, _json.dumps(atts_json, ensure_ascii=False),
                    score_applied, message_ref, sent_at,
                )

                if not recognized:
                    unrecognized_phrases.append(c["code_phrase"])

            if matched_any and unrecognized_phrases:
                results.append({
                    "recognized": False,
                    "platform": platform,
                    "chat_id": chat_id,
                    "platform_user_id": platform_user_id,
                    "client_id": client_id,
                    "event_id": event_id,
                    "phrases": unrecognized_phrases,
                })
    except Exception as e:  # noqa: BLE001 — движок не должен ронять слушалку
        log.warning("process_task_submissions failed (%s chat=%s): %s", platform, chat_id, e)
    return results
