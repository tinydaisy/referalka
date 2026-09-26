"""Уведомление о заполненной анкете: чат уведомлений + письмо.

Зачем. Анкету заполнили — узнать об этом надо сразу, а не при следующем заходе
в кабинет: заявку обрабатывают руками (звонят, отмечают «Обработано»), и чем
позже её увидели, тем холоднее человек.

⚠️ В ЧАТ уведомлений шлём ВСЕГДА (решение владельца) — туда смотрит команда,
это тот же канал, что «Новый интерес» по событиям. Настраивается только ПОЧТА:
у кабинета бывает несколько помощников, и заваливать письмами тех, кто заявки
не обрабатывает, незачем.

⚠️ Название анкеты — ССЫЛКА НА ОТВЕТЫ ЭТОГО ЧЕЛОВЕКА
(`/dashboard/surveys/{id}/responses/{rid}`), а не на публичную анкету: из
уведомления нужно попасть в обработку, а не в форму, которую и так только что
заполнили.

⚠️ Ссылка ведёт на `platform_base_url()`, а НЕ на домен клиента: кабинет на
свой домен не переезжает (JWT и cookies завязаны на один origin), и ссылка на
`домен-клиента/dashboard/...` увела бы человека на страницу, которая его
разлогинит.
"""
import asyncio
import logging
from typing import Optional

log = logging.getLogger(__name__)

# Сколько ответов показываем в уведомлении. В анкете бывает и тридцать
# вопросов — целиком они не влезут ни в сообщение бота, ни в беглый взгляд.
_MAX_ANSWERS = 12
_MAX_VALUE_LEN = 160


def _esc(s) -> str:
    return (str(s or "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


async def notify_recipients(db, client_id: int) -> list[dict]:
    """Кому МОЖНО слать письмо о заполненной анкете — для выпадающего списка.

    Владелец кабинета + все его помощники. У каждого `is_default` — отмечать
    ли галочку, когда клиент настройку ещё не открывал: владелец и «менеджеры
    заказов» отмечены (им заявки и отдают), остальные помощники — нет.
    """
    out: list[dict] = []
    owner = await db.fetchrow(
        "SELECT email, name, brand_name FROM clients WHERE id = $1", client_id)
    if owner and (owner["email"] or "").strip():
        out.append({
            "email": owner["email"].strip(),
            "label": f"Основатель — {owner['name'] or owner['email']}",
            "role": "owner",
            "is_default": True,
        })

    rows = await db.fetch(
        """SELECT a.email, a.name, g.access_level
             FROM assistant_grants g
             JOIN assistants a ON a.id = g.assistant_id
            WHERE g.client_id = $1
            ORDER BY a.email""",
        client_id)
    role_label = {
        "orders": "Менеджер заказов",
        "leads": "Менеджер лидов",
        "full": "Помощник (полный доступ)",
        "limited": "Помощник",
    }
    seen = {r["email"] for r in out}
    for r in rows:
        email = (r["email"] or "").strip()
        if not email or email in seen:
            continue
        seen.add(email)
        who = role_label.get(r["access_level"], "Помощник")
        out.append({
            "email": email,
            "label": f"{who} — {r['name'] or email}",
            "role": r["access_level"],
            # Менеджер заказов отмечен сразу: заявки — его работа.
            "is_default": r["access_level"] == "orders",
        })
    return out


async def resolve_notify_emails(db, client_id: int, notify_emails) -> list[str]:
    """Итоговый список почт, куда реально уходит письмо.

    ⚠️ NULL в `surveys.notify_emails` — это «по умолчанию», а не «никому»:
    иначе у всех анкет, где настройку не открывали, письма не уходили бы
    вовсе. Пустой массив — осознанное «не слать».

    ⚠️ Сохранённый список ФИЛЬТРУЕМ по актуальным получателям: помощника
    могли отозвать из кабинета, и слать ему заявки клиента после этого нельзя.
    """
    people = await notify_recipients(db, client_id)
    if notify_emails is None:
        return [p["email"] for p in people if p["is_default"]]
    allowed = {p["email"].lower(): p["email"] for p in people}
    out: list[str] = []
    for e in notify_emails:
        real = allowed.get((e or "").strip().lower())
        if real and real not in out:
            out.append(real)
    return out


async def _who_filled(db, contact_id: int) -> tuple[str, list[str]]:
    """(имя, строки с контактами) — по тому же принципу, что «Новый интерес»."""
    r = await db.fetchrow(
        """SELECT c.name, c.phone,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug='email'
                    LIMIT 1) AS email,
                  (SELECT COALESCE(pu.username, pu.platform_user_id)
                     FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug='telegram'
                    LIMIT 1) AS telegram,
                  (SELECT COALESCE(pu.username, pu.platform_user_id)
                     FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug='vk'
                    LIMIT 1) AS vk,
                  (SELECT COALESCE(pu.username, pu.platform_user_id)
                     FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug='max'
                    LIMIT 1) AS max_nick
             FROM contacts c WHERE c.id = $1""",
        contact_id)
    if not r:
        return "Без имени", []
    name = (r["name"] or "").strip() or "Без имени"
    lines = []
    for label, key in (("Почта", "email"), ("Телефон", "phone"),
                       ("Telegram", "telegram"), ("ВКонтакте", "vk"),
                       ("MAX", "max_nick")):
        val = (r[key] or "").strip() if r[key] else ""
        if val:
            lines.append(f"{label}: {val}")
    return name, lines


async def _answers(db, response_id: int, survey_id: int) -> list[tuple[str, str]]:
    """Ответы посетителя — вопрос и что он написал.

    ⚠️ Только `filled_by='visitor'`: поля сотрудника («Обработано», заметка) в
    момент заполнения пусты, показывать их в уведомлении нечего.
    """
    rows = await db.fetch(
        """SELECT q.title, a.value
             FROM survey_answers a
             JOIN survey_questions q ON q.id = a.question_id
            WHERE a.response_id = $1 AND q.survey_id = $2
              AND q.filled_by = 'visitor'
            ORDER BY q.sort_order, q.id""",
        response_id, survey_id)
    out = []
    for r in rows:
        val = (r["value"] or "").strip()
        if not val:
            continue
        if len(val) > _MAX_VALUE_LEN:
            val = val[:_MAX_VALUE_LEN] + "…"
        out.append((r["title"] or "Вопрос", val))
    return out


async def response_source_label(db, response_id: int) -> str:
    """Откуда пришло заполнение — одной строкой (миграция 519).

    «Форма заявки: <событие>» / «Форма заявки: <продукт>» / «Лид-магнит: …» /
    «Прямая ссылка на анкету». ⚠️ Одна функция на уведомление и кабинет —
    чтобы подпись не разъезжалась.
    """
    r = await db.fetchrow(
        """SELECT e.title AS event_title, p.title AS product_title,
                  lm.name AS lm_name, pk.name AS pkg_name
             FROM survey_responses r
             LEFT JOIN events e ON e.id = r.event_id
             LEFT JOIN products p ON p.id = r.product_id
             LEFT JOIN lead_magnets lm ON lm.id = r.lead_magnet_id
             LEFT JOIN lead_magnet_packages pk ON pk.id = r.package_id
            WHERE r.id = $1""",
        response_id)
    return source_label(r)


def source_label(r) -> str:
    """Подпись источника по полям строки (event_title, product_title,
    lm_name, pkg_name) — для списков, где строки уже выбраны."""
    if not r:
        return "Прямая ссылка на анкету"
    if r["event_title"]:
        return f"Форма заявки: {r['event_title']}"
    if r["product_title"]:
        return f"Форма заявки: {r['product_title']}"
    if r["lm_name"]:
        return f"Лид-магнит: {r['lm_name']}"
    if r["pkg_name"]:
        return f"Лид-магнит: {r['pkg_name']}"
    return "Прямая ссылка на анкету"


async def notify_survey_filled(db, survey, response_id: int, contact_id: int) -> None:
    """Уведомление о заполненной анкете. Никогда не бросает исключение:
    сбой отправки не должен ломать человеку отправку анкеты."""
    try:
        client_id = survey["client_id"]
        survey_id = survey["id"]
        title = survey["title"] or "Анкета"

        from app.services.client_domains import platform_base_url
        link = (f"{platform_base_url().rstrip('/')}"
                f"/dashboard/surveys/{survey_id}/responses/{response_id}")

        name, contacts = await _who_filled(db, contact_id)
        answers = await _answers(db, response_id, survey_id)

        # ── Текст: один на бот и на письмо, чтобы не разъезжался ──
        head_html = (f"📋 <b>Заполнена анкета:</b> "
                     f"<a href=\"{link}\">{_esc(title)}</a>")
        head_text = f"📋 Заполнена анкета: {title}\n{link}"

        source = await response_source_label(db, response_id)
        body_lines = [f"<b>Источник:</b> {_esc(source)}",
                      f"<b>Кто заполнил:</b> {_esc(name)}"]
        body_plain = [f"Источник: {source}", f"Кто заполнил: {name}"]
        for c in contacts:
            body_lines.append(_esc(c))
            body_plain.append(c)

        if answers:
            body_lines.append("")
            body_plain.append("")
            body_lines.append("<b>Ответы:</b>")
            body_plain.append("Ответы:")
            for q, v in answers[:_MAX_ANSWERS]:
                body_lines.append(f"• {_esc(q)}: {_esc(v)}")
                body_plain.append(f"• {q}: {v}")
            if len(answers) > _MAX_ANSWERS:
                more = len(answers) - _MAX_ANSWERS
                body_lines.append(f"…и ещё {more} — смотрите по ссылке")
                body_plain.append(f"…и ещё {more} — смотрите по ссылке")

        html = head_html + "\n\n" + "\n".join(body_lines)
        plain = head_text + "\n\n" + "\n".join(body_plain)

        # ── Чат уведомлений: ВСЕГДА, во все площадки клиента ──
        try:
            from app.services.channels import notify_organizer_all_channels
            await notify_organizer_all_channels(client_id, html, db, text_plain=plain)
        except Exception:
            log.exception("survey_notify: чат уведомлений (анкета %s)", survey_id)

        # ── Почта: по списку из настроек анкеты ──
        try:
            emails = await resolve_notify_emails(db, client_id, survey["notify_emails"])
            if emails:
                await _send_emails(db, client_id, emails,
                                   subject=f"Заполнена анкета: {title}",
                                   body_text=plain + "\n\n— iViSiON: ПЛЮСОН")
        except Exception:
            log.exception("survey_notify: письма (анкета %s)", survey_id)

    except Exception:  # noqa: BLE001 — уведомление не повод ломать анкету
        log.exception("survey_notify: не удалось уведомить о заполнении")


async def _send_emails(db, client_id: int, emails: list[str],
                       *, subject: str, body_text: str) -> None:
    """Письма получателям через email-канал клиента.

    ⚠️ Отправка синхронная (SMTP), поэтому уводим её в поток: получателей
    может быть несколько, и держать на них цикл событий, пока человек ждёт
    ответа на отправку анкеты, незачем.
    """
    ch = await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local, ch.email_from_name
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'email'
            LIMIT 1""",
        client_id)
    if not ch:
        log.info("survey_notify: у клиента %s нет email-канала", client_id)
        return

    from app.services.email_sender import EmailSender
    from app.services.unsubscribe_token import make_email_unsubscribe_token

    channel_dict = dict(ch)
    channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"
    # ⚠️ Получатель — сотрудник кабинета, а не контакт из базы: отписываться
    # ему не от чего. Токен нужен только формально, тот же приём, что в
    # письмах помощникам (`assistants.py`).
    token = make_email_unsubscribe_token(
        client_id=client_id, contact_id=0,
        client_channel_id=ch["client_channel_id"])

    def _send_one(to_email: str) -> None:
        EmailSender().send(
            channel=channel_dict,
            client_brand_name="iViSiON: ПЛЮСОН",
            to_email=to_email,
            subject=subject,
            body_text=body_text,
            unsubscribe_token=token,
        )

    for email in emails:
        try:
            await asyncio.to_thread(_send_one, email)
        except Exception as e:  # noqa: BLE001 — один битый адрес не должен
            log.warning("survey_notify: письмо на %s не ушло: %s", email, e)
