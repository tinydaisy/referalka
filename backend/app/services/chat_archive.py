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
import random
from typing import Optional

from app.database import get_pool
from app.services.share_links import TG_DOMAIN

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


async def _resolve_event_for_chat(db, platform: str, chat_id: str,
                                  owner_client_id: Optional[int] = None,
                                  for_tasks: bool = False) -> Optional[tuple[int, int]]:
    """По (платформа, chat_id) найти событие, чей чат это. Возвращает (event_id, client_id) или None.

    Резолв через event_owners (новая co-ownership-архитектура): берём первого
    владельца события (accepted) как client_id для резолва автора.

    ⚠️ ОДИН чат привязан к НЕСКОЛЬКИМ событиям клиента (чат iViSiON используется
    конференциями, нетворкингами, голосованиями И чемпионатом). Раньше LIMIT 1 без
    сортировки брал СЛУЧАЙНОЕ событие — после правки данных стал отдавать старую
    конференцию вместо чемпионата, и задания перестали считаться.

    `for_tasks=True` (контроль заданий) — выбираем именно событие с НАСТРОЕННЫМИ
    заданиями: есть турнирные критерии с непустой code_phrase. Среди таких приоритет
    турниру (module_slug='turnir'), потом самое свежее (e.id DESC). Конференции/
    голосования без заданий чат заданий не перехватывают. `task_listen_enabled` как
    приоритет НЕ годится — клиент его не выключает после события, и он включён у
    многих сразу.

    `for_tasks=False` (архив/приветствия) — просто самое свежее событие на чате.

    ⚠️ owner_client_id — клиент-владелец БОТА/СООБЩЕСТВА, откуда пришло сообщение.
    Обязателен для VK: локальный chat_id беседы (2000000001, 2000000002…) НЕ
    уникален между сообществами — первая беседа КАЖДОГО сообщества = 2000000001.
    Без фильтра по клиенту сообщение из беседы сообщества А сматчило бы событие,
    привязанное к беседе сообщества Б с тем же номером. Для TG/MAX chat_id
    глобально уникальны (-100…), фильтр не нужен → owner_client_id=None.
    """
    # Чат события теперь — ссылка на запись в client_broadcast_chats (база чатов
    # клиента). Матчим по cbc.platform+cbc.chat_id и ref-колонке события.
    ref_col = {
        "telegram": "tg_chat_ref",
        "vk": "vk_chat_ref",
        "max": "max_chat_ref",
    }.get(platform)
    if not ref_col:
        return None
    # Только ЖИВЫЕ события: не черновики и не завершённые. Мёртвое/неопубликованное
    # событие не должно перехватывать чат (раньше draft-конференция 14 ловила задания).
    alive = "AND e.status NOT IN ('draft', 'ended')"
    # Для контроля заданий: дополнительно только события с реально настроенными
    # заданиями (есть активный критерий с code_phrase), приоритет турниру.
    if for_tasks:
        # ТОЛЬКО турниры с настроенными заданиями (активный критерий с code_phrase).
        has_tasks = """AND e.module_slug = 'turnir'
              AND EXISTS (
                SELECT 1 FROM tournament_criteria tc
                 WHERE tc.event_id = e.id AND tc.is_active = TRUE
                   AND tc.code_phrase IS NOT NULL AND TRIM(tc.code_phrase) <> '')"""
    else:
        has_tasks = ""
    # Самое свежее по дате старта (NULL — в конец), затем по id.
    order_by = "e.start_at DESC NULLS LAST, e.id DESC"
    if owner_client_id is not None:
        # Событие должно принадлежать клиенту, чей бот/сообщество получило сообщение.
        row = await db.fetchrow(
            f"""
            SELECT e.id AS event_id, eo.client_id AS client_id
              FROM events e
              JOIN client_broadcast_chats cbc ON cbc.id = e.{ref_col}
                   AND cbc.platform = $3 AND cbc.chat_id = $1
              JOIN event_owners eo ON eo.event_id = e.id
                   AND eo.status = 'accepted' AND eo.client_id = $2
             WHERE TRUE {alive} {has_tasks}
             ORDER BY {order_by}
             LIMIT 1
            """,
            str(chat_id), owner_client_id, platform,
        )
    else:
        row = await db.fetchrow(
            f"""
            SELECT e.id AS event_id,
                   (SELECT eo.client_id FROM event_owners eo
                      WHERE eo.event_id = e.id AND eo.status = 'accepted'
                      ORDER BY eo.id LIMIT 1) AS client_id
              FROM events e
              JOIN client_broadcast_chats cbc ON cbc.id = e.{ref_col}
                   AND cbc.platform = $2 AND cbc.chat_id = $1
             WHERE TRUE {alive} {has_tasks}
             ORDER BY {order_by}
             LIMIT 1
            """,
            str(chat_id), platform,
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
          JOIN contacts c_own ON c_own.id = pu.contact_id
         WHERE c_own.client_id = $1
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
    owner_client_id: Optional[int] = None,
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
            resolved = await _resolve_event_for_chat(db, platform, chat_id, owner_client_id)
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

async def _resolve_subject_for_audiences(
    db, event_id: int, contact_id: Optional[int], audiences
) -> Optional[tuple[str, int]]:
    """По contact_id и НАБОРУ ролей этапа вернуть (subject_kind, subject_id).

    audiences — список из 'all' / 'registered' / 'speakers' / 'jury' (множественный
    выбор «Кого слушаем в этапе»). На этапе можно слушать сразу несколько ролей.

    ⚠️ ВАЖНО (правка 2026-06-24): для контроля заданий НЕТ градации «спикер vs
    участник». Один человек = одна строка в турнирной таблице. Поэтому приоритет
    ВСЕГДА у участника (ep): если человек заведён как участник события — балл за
    задание идёт в его участницкую строку, неважно, спикер он или жюри. Это убирает
    раздвоение баллов у тех, кто одновременно и участник, и спикер (многие участники
    становятся спикерами по ходу турнира).

    Резолв:
      1) человек — участник события (ep)? → ('ep', id). 'registered' требует
         is_registered=TRUE; 'all'/'speakers'/'jury' — любой ep (включая незарег).
      2) НЕ участник, но спикер/жюри (ec) — только если такая роль слушается на
         этапе → ('ec', id). Fallback, чтобы балл вообще не потерялся у чисто
         спикера/жюри, не заведённого участником.

    Пустой набор audiences = «не слушать» → всегда None (этап не слушается).
    """
    if not contact_id:
        return None
    auds = set(audiences or [])
    if not auds:
        return None

    # (1) Приоритет — участник события. Любая аудитория, кроме чисто 'registered',
    # засчитывает незарегистрированного тоже; 'registered' — только зарег.
    only_registered = auds == {"registered"}
    if only_registered:
        ep_id = await db.fetchval(
            """SELECT id FROM event_participants
                WHERE event_id = $1 AND contact_id = $2 AND is_registered = TRUE
                ORDER BY id LIMIT 1""",
            event_id, contact_id,
        )
    else:
        ep_id = await db.fetchval(
            """SELECT id FROM event_participants
                WHERE event_id = $1 AND contact_id = $2
                ORDER BY id LIMIT 1""",
            event_id, contact_id,
        )
    if ep_id:
        return ("ep", int(ep_id))

    # (2) Не участник, но спикер/жюри — fallback, чтобы балл не потерялся.
    if "speakers" in auds:
        ec_id = await db.fetchval(
            """SELECT ec.id FROM event_collaborators ec
                 JOIN collaborators co ON co.id = ec.speaker_id
                WHERE ec.event_id = $1 AND co.contact_id = $2
                  AND ec.role IN ('speaker', 'headliner')
                ORDER BY ec.id LIMIT 1""",
            event_id, contact_id,
        )
        if ec_id:
            return ("ec", int(ec_id))

    if "jury" in auds:
        ec_id = await db.fetchval(
            """SELECT ec.id FROM event_collaborators ec
                 JOIN collaborators co ON co.id = ec.speaker_id
                WHERE ec.event_id = $1 AND co.contact_id = $2
                  AND ec.role = 'jury'
                ORDER BY ec.id LIMIT 1""",
            event_id, contact_id,
        )
        if ec_id:
            return ("ec", int(ec_id))

    return None


def _parse_number_after_phrase(text_low: str, phrase_low: str) -> Optional[float]:
    """Число после кодовой фразы для типа «авто-число».

    Поддерживает: «слово:6», «слово: 6», «слово   6», «слово : 6» — везде 6.
    Двоеточие и пробелы между фразой и числом игнорируются. Число — целое или
    дробное (6 / 6.5 / 6,5). Берём ПЕРВОЕ вхождение фразы, за которой идёт число.
    Возвращает float или None, если числа нет.
    """
    import re
    # экранируем фразу, после неё: опц. пробелы/двоеточия, затем число (точка/запятая)
    pat = re.escape(phrase_low) + r"\s*:?\s*(-?\d+(?:[.,]\d+)?)"
    m = re.search(pat, text_low)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "."))
    except ValueError:
        return None


def _fmt_num_short(v) -> str:
    """Короткое число для ответа «Принято»: 6 вместо 6.0, 6.5 как есть."""
    try:
        f = float(v)
        return str(int(f)) if f == int(f) else str(f)
    except (TypeError, ValueError):
        return str(v)


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
        return f"https://{TG_DOMAIN}/c/{cid}/{message_ref}"
    return None


def build_submission_reply_text(info: dict, *, html: bool = False) -> str | None:
    """Текст авто-ответа автору после сдачи задания (самодиагностика).

    Общий для TG (html=True — жирный через <b>) и VK/MAX (plain).
    • Есть зачтённые критерии → «✅ Принято:» + список.
    • Иначе (автор не участник) → пояснение про регистрацию.
    • В конце ВСЕГДА — напоминание прислать ПОВТОРНО НОВЫМ сообщением.
    """
    recognized = info.get("recognized_titles") or []
    new_msg = "<b>новым сообщением</b>" if html else "НОВЫМ сообщением"
    note = (
        "\n\nЕсли что-то не учтено — проверьте корректность кодовых фраз для сдачи "
        f"заданий и отправьте повторно {new_msg} (изменение старого сообщения бот не увидит)."
    )
    if recognized:
        lines = "\n".join(f"• {t}" for t in recognized if t)
        return f"✅ Принято:\n{lines}{note}"
    return (
        "Похоже, вы не регистрировались на чемпионат, поэтому задание не засчитано. "
        "Напишите в личку команду /support — там контакты для связи." + note
    )


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
    owner_client_id: Optional[int] = None,
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
            # for_tasks=True → резолвим ТОЛЬКО живой турнир с настроенными заданиями
            # (а не первую попавшуюся конференцию/черновик на этом же чате).
            resolved = await _resolve_event_for_chat(db, platform, chat_id, owner_client_id, for_tasks=True)
            if not resolved:
                return []
            event_id, client_id = resolved

            # Слушание включено?
            enabled = await db.fetchval(
                "SELECT task_listen_enabled FROM events WHERE id = $1", event_id
            )
            if not enabled:
                return []

            # Критерии с кодовой фразой: manual (1 балл за факт) + auto_number
            # (число после кодовой фразы: replace перезатирает / sum суммирует).
            criteria = await db.fetch(
                """SELECT tc.id, tc.title, tc.code_phrase, tc.scale_max, tc.stage_id,
                          tc.scorer, tc.auto_kind,
                          COALESCE(cs.listen_audiences, ARRAY['registered']::text[]) AS audiences
                     FROM tournament_criteria tc
                     LEFT JOIN conf_stages cs ON cs.id = tc.stage_id
                    WHERE tc.event_id = $1 AND tc.scorer IN ('manual','auto_number')
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
            recognized_titles: list[str] = []   # названия зачтённых критериев (для ответа «Принято»)

            for c in criteria:
                phrase = (c["code_phrase"] or "").strip().lower()
                if not phrase or phrase not in low:
                    continue
                is_auto_number = (c["scorer"] == "auto_number")
                # Для auto_number ОБЯЗАТЕЛЬНО должно быть число после фразы —
                # иначе это не сдача (фраза могла встретиться случайно в тексте).
                parsed_num = _parse_number_after_phrase(low, phrase) if is_auto_number else None
                if is_auto_number and parsed_num is None:
                    continue
                matched_any = True
                subj = await _resolve_subject_for_audiences(
                    db, event_id, contact_id, c["audiences"]
                )
                recognized = subj is not None
                subject_kind = subj[0] if subj else None
                subject_id = subj[1] if subj else None
                score_applied = False

                if recognized and is_auto_number:
                    # auto_number: записываем число после кодовой фразы.
                    #   replace — перезатираем; sum — прибавляем к текущему.
                    mode = c["auto_kind"] or "replace"
                    if mode == "sum":
                        await db.execute(
                            """
                            INSERT INTO tournament_scores
                                (event_id, criterion_id, subject_kind, subject_id,
                                 juror_ec_id, scorer, value_number)
                            VALUES ($1, $2, $3, $4, NULL, 'manual', $5)
                            ON CONFLICT (criterion_id, subject_kind, subject_id)
                                WHERE juror_ec_id IS NULL
                            DO UPDATE SET value_number = tournament_scores.value_number + $5,
                                          updated_at = now()
                            """,
                            event_id, c["id"], subject_kind, subject_id, parsed_num,
                        )
                    else:  # replace
                        await db.execute(
                            """
                            INSERT INTO tournament_scores
                                (event_id, criterion_id, subject_kind, subject_id,
                                 juror_ec_id, scorer, value_number)
                            VALUES ($1, $2, $3, $4, NULL, 'manual', $5)
                            ON CONFLICT (criterion_id, subject_kind, subject_id)
                                WHERE juror_ec_id IS NULL
                            DO UPDATE SET value_number = $5, updated_at = now()
                            """,
                            event_id, c["id"], subject_kind, subject_id, parsed_num,
                        )
                    score_applied = True
                    _title = (c["title"] or c["code_phrase"] or "").strip()
                    recognized_titles.append(f"{_title}: {_fmt_num_short(parsed_num)}")
                elif recognized:
                    # manual: ВСЕГДА 1 балл за факт выполнения задания (важность — через ВЕС).
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
                    recognized_titles.append((c["title"] or c["code_phrase"] or "").strip())

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

            # Один объект-ответ на сообщение: что зачлось + что не распозналось.
            # Бот по нему пишет автору «Принято: …» (самодиагностика для участника).
            if matched_any:
                results.append({
                    "recognized": bool(recognized_titles),
                    "platform": platform,
                    "chat_id": chat_id,
                    "platform_user_id": platform_user_id,
                    "client_id": client_id,
                    "event_id": event_id,
                    "phrases": unrecognized_phrases,           # неопознанные (автор не участник)
                    "recognized_titles": recognized_titles,    # названия зачтённых критериев
                })
    except Exception as e:  # noqa: BLE001 — движок не должен ронять слушалку
        log.warning("process_task_submissions failed (%s chat=%s): %s", platform, chat_id, e)
    return results


# ─────────────────────────────────────────────────────────────────────────────
# ПРИВЕТСТВИЕ В ЧАТАХ — кодовое слово → ответ случайной фразой (миграция 163)
# ─────────────────────────────────────────────────────────────────────────────

# Естественная задержка ответа-приветствия (чтобы бот не отвечал мгновенно,
# как робот). Рандом в этом диапазоне (секунды) для каждого ответа.
GREETING_DELAY_MIN_SEC = 30
GREETING_DELAY_MAX_SEC = 180


def pick_greeting_delay_sec() -> int:
    """Случайная задержка ответа-приветствия 30..180 сек."""
    return random.randint(GREETING_DELAY_MIN_SEC, GREETING_DELAY_MAX_SEC)


DEFAULT_CHAT_GREETINGS = [
    "Добрейшего! Располагайтесь и знакомьтесь! Увидели в закрепе навигацию?",
    "Добро пожаловать в iViSiON! Расскажите о себе? Давно в своей нише развиваетесь?",
    "Рады вам! Как узнали о нас?",
    "Рады вас видеть! Вы только посмотреть или сориентировать что тут у нас происходит? В закрепе есть информация",
    "Здорово! Уже видели форматы участия? Рассказать?",
    "Супер! Уже заглянули в закреп? Там всё что нужно для старта.",
    "Классно! Кстати, у нас можно рассказать о себе. Пишите",
    "Отлично! Расскажите, какие проекты создаете? Видели форматы участия?",
    "Класс! Чтоб не запутаться — у нас есть бот с платформой. Уже сориентировались в платформе?",
    "Добрейшего-богатейшего! Рады вам! Есть задачи, под которые нужны ресурсы? У нас тут много людей с сильной экспертизой",
    "Добрейшего-наибогатейшего! Располагайтесь. Что сейчас актуальнее? Клиенты, партнерства, ресурсы? Сориентируем",
    "Добрейшего-наибогатейшего! Рады вам! Поделитесь, что именно привлекло на мероприятие?",
    "Привет! Супер! Сориентировать вас? Может, есть какие-то определенные цели и запросы?",
]


async def get_or_seed_chat_greetings(db, event_id: int) -> list[dict]:
    """Список фраз приветствия события. Если пусто — засеять дефолтными.

    Возвращает [{id, text, sort}]. Используется и в API (CRUD-список), и при
    обработке сообщения (выбор случайной фразы).
    """
    rows = await db.fetch(
        "SELECT id, text, sort FROM event_chat_greetings WHERE event_id = $1 ORDER BY sort, id",
        event_id,
    )
    if rows:
        return [dict(r) for r in rows]
    # Сидим дефолтный набор — у каждого события (любого типа) свой.
    for i, phrase in enumerate(DEFAULT_CHAT_GREETINGS):
        await db.execute(
            "INSERT INTO event_chat_greetings (event_id, text, sort) VALUES ($1, $2, $3)",
            event_id, phrase, i,
        )
    rows = await db.fetch(
        "SELECT id, text, sort FROM event_chat_greetings WHERE event_id = $1 ORDER BY sort, id",
        event_id,
    )
    return [dict(r) for r in rows]


def _normalize_greeting_match(s: str) -> str:
    """Нормализация для ТОЧНОГО сравнения сообщения с кодовым словом.

    Срезаем регистр, пробелы по краям, финальную/начальную пунктуацию и эмодзи —
    чтобы «Я С ВАМИ», «я с вами!», «  я с вами 🙌» совпали с «я с вами».
    Но «я с вами хотела обсудить» — НЕ совпадёт (лишние слова остаются).
    """
    import re
    s = (s or "").strip().lower()
    # Убрать любые НЕ буквенно-цифровые символы по краям (пунктуация, эмодзи, пробелы).
    s = re.sub(r"^[^0-9a-zа-яё]+", "", s)
    s = re.sub(r"[^0-9a-zа-яё]+$", "", s)
    # Схлопнуть внутренние пробелы в один.
    s = re.sub(r"\s+", " ", s)
    return s


def _apply_greeting_placeholders(text: str, author_name: Optional[str], username: Optional[str]) -> str:
    """Подставить {name} в фразу. Имя → author_name → @username → 'друзья'."""
    name = (author_name or "").strip()
    if not name and username:
        name = "@" + str(username).lstrip("@")
    if not name:
        name = "друзья"
    return text.replace("{name}", name)


async def process_chat_greeting(
    *,
    platform: str,
    chat_id: str,
    author_name: Optional[str] = None,
    username: Optional[str] = None,
    text: Optional[str] = None,
    owner_client_id: Optional[int] = None,
) -> Optional[str]:
    """Если в сообщении чата события есть кодовое слово приветствия — вернуть
    готовую фразу для ответа (reply), иначе None.

    - Резолвит событие по (платформа, chat_id);
    - проверяет events.chat_greeting_enabled и непустое chat_greeting_keyword;
    - ищет кодовое слово в тексте (где угодно, без регистра);
    - берёт СЛУЧАЙНУЮ фразу из набора (auto-seed дефолтных, если пуст);
    - подставляет {name}.

    Отвечает ВСЕМ и на КАЖДОЕ сообщение с кодовым словом (без дедупа, без
    проверки участника — это дружелюбный приветственный ответ).
    """
    if not text:
        return None
    chat_id = str(chat_id)
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            resolved = await _resolve_event_for_chat(db, platform, chat_id, owner_client_id)
            if not resolved:
                return None
            event_id, _client_id = resolved

            row = await db.fetchrow(
                "SELECT chat_greeting_enabled, chat_greeting_keyword, chat_greeting_exact "
                "FROM events WHERE id = $1",
                event_id,
            )
            if not row or not row["chat_greeting_enabled"]:
                return None
            raw_keyword = (row["chat_greeting_keyword"] or "")
            if row["chat_greeting_exact"]:
                # ТОЧНОЕ: всё сообщение = кодовое слово (без регистра/пробелов/
                # пунктуации по краям). «я с вами хочу обсудить» — НЕ сработает.
                keyword = _normalize_greeting_match(raw_keyword)
                if not keyword or _normalize_greeting_match(text) != keyword:
                    return None
            else:
                # ЛЮБОЕ вхождение в текст.
                keyword = raw_keyword.strip().lower()
                if not keyword or keyword not in text.lower():
                    return None

            greetings = await get_or_seed_chat_greetings(db, event_id)
            if not greetings:
                return None
            phrase = random.choice(greetings)["text"]
            return _apply_greeting_placeholders(phrase, author_name, username)
    except Exception as e:  # noqa: BLE001 — движок не должен ронять слушалку
        log.warning("process_chat_greeting failed (%s chat=%s): %s", platform, chat_id, e)
        return None
