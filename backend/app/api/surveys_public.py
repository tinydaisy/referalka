"""
Публичная часть анкет: отдать анкету по ссылке и принять ответы (миграция 280).

⚠️ Никаких вебхуков тут нет и не нужно: анкета живёт на нашем же сервере,
ответ пишется в нашу базу тем же кодом. Узнавать «заполнил ли» не у кого —
смотрим в `survey_responses`.

Человек, пришедший из бота, опознаётся по `?c={contact_id}` в ссылке: его имя,
почта и телефон подставляются заполненными, спрашивать заново не нужно (в
GetCourse так нельзя — там форма человека не знает). Пришёл по прямой ссылке и
в базе его нет → создаём новый контакт при отправке.
"""
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/surveys", tags=["Анкеты (публично)"])


def _jsonb(value: Any) -> Any:
    """asyncpg отдаёт JSONB СТРОКОЙ, а не списком.

    ⚠️ Без разворота фронт получал `options` строкой и не мог отрисовать
    варианты ответа — список выбора приходил пустым.
    """
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return []
    return value if value is not None else []


def _answer_to_text(value: Any) -> str:
    """Человекочитаемое представление ответа — оно идёт в карточку контакта,
    выгрузки и отчёт. Для нескольких вариантов — через запятую."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    if isinstance(value, list):
        return ", ".join(str(v).strip() for v in value if str(v).strip())
    return str(value).strip()


@router.get("/{slug}")
async def get_public_survey(
    slug: str,
    c: Optional[int] = None,       # contact_id из ссылки (пришёл из бота)
    lm: Optional[int] = None,      # за каким лид-магнитом идёт
    pkg: Optional[int] = None,     # ...или пакетом
    db=Depends(get_db),
):
    """Анкета для показа + уже известные данные человека."""
    s = await db.fetchrow(
        "SELECT * FROM surveys WHERE slug = $1 AND is_active = TRUE", slug)
    if not s:
        raise HTTPException(404, "Анкета не найдена")

    qs = await db.fetch(
        """SELECT id, title, hint, kind, options, scale_min, scale_max,
                  is_required, sort_order, field_id, image_url
             FROM survey_questions WHERE survey_id = $1
            ORDER BY sort_order, id""",
        s["id"])

    known: dict = {}
    already: list = []
    if c:
        # ⚠️ Общая точка предзаполнения (contact_merge) — она же питает форму
        # заказа тарифа и авторизацию вебинарной комнаты. Внутри проверка, что
        # контакт принадлежит владельцу: иначе по чужому id можно было бы
        # подсмотреть имя и телефон постороннего человека.
        from app.services.contact_merge import known_contact_fields
        known = await known_contact_fields(db, s["client_id"], c)
        if known:
            # Уже заполненные значения полей — подставим в форму, чтобы человек
            # только проверил, а не вводил заново.
            vals = await db.fetch(
                """SELECT v.field_id, v.value FROM contact_field_values v
                    WHERE v.contact_id = $1""", c)
            known["fields"] = {str(v["field_id"]): v["value"] for v in vals}
            if not s["allow_repeat"]:
                already = [dict(r) for r in await db.fetch(
                    "SELECT id, created_at FROM survey_responses "
                    "WHERE survey_id=$1 AND contact_id=$2 ORDER BY id DESC LIMIT 1",
                    s["id"], c)]

    # Оформление берём из «Стилей лендингов» клиента — анкета должна выглядеть
    # как его лендинг, а не как чужая страница (решение владельца 2026-08-12).
    theme = {}
    try:
        t = await db.fetchrow(
            """SELECT lp_bg_color, lp_bg_color_2, lp_bg_angle, lp_color_heading,
                      lp_color_body, lp_card_bg, lp_card_text_color,
                      lp_btn_color, lp_btn_text_color, lp_btn_radius,
                      lp_font_heading, lp_font_body, lp_content_width
                 FROM clients WHERE id = $1""", s["client_id"])
        if t:
            theme = {k: v for k, v in dict(t).items() if v is not None}
    except Exception:
        logger.exception("survey: не удалось получить тему клиента")

    return {
        "theme": theme,
        "id": s["id"], "slug": s["slug"], "title": s["title"],
        "intro": s["intro"], "submit_label": s["submit_label"],
        "image_url": s["image_url"],
        "allow_repeat": s["allow_repeat"],
        "questions": [{**dict(q), "options": _jsonb(q["options"])} for q in qs],
        "known": known,
        "already_filled": bool(already),
        # Есть ли на выходе подарок — чтобы страница честно написала об этом
        # ДО заполнения, а не обещала абстрактное «спасибо».
        "has_gift": bool(lm or pkg),
    }


class SurveySubmit(BaseModel):
    # {question_id: значение}. Значение — строка, число, bool или список.
    answers: dict
    contact_id: Optional[int] = None
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None
    lead_magnet_id: Optional[int] = None
    package_id: Optional[int] = None
    platform: Optional[str] = None
    utm: Optional[dict] = None
    # Экран «Это вы?»: человек выбрал себя из найденных / сказал «я впервые».
    chosen_contact_id: Optional[int] = None
    force_new: Optional[bool] = None


@router.post("/{slug}/submit")
async def submit_survey(
    slug: str, data: SurveySubmit, request: Request, db=Depends(get_db),
):
    """Приём ответов. Возвращает, что показать человеку дальше:
    текст «спасибо», переход на свою ссылку или сразу материалы подарка.
    """
    s = await db.fetchrow(
        "SELECT * FROM surveys WHERE slug = $1 AND is_active = TRUE", slug)
    if not s:
        raise HTTPException(404, "Анкета не найдена")
    client_id = s["client_id"]

    qs = await db.fetch(
        "SELECT * FROM survey_questions WHERE survey_id = $1 ORDER BY sort_order, id",
        s["id"])
    by_id = {q["id"]: q for q in qs}

    # Обязательные вопросы — проверяем ДО создания контакта, чтобы неудачная
    # отправка не плодила пустых людей в базе.
    missing = []
    for q in qs:
        if not q["is_required"]:
            continue
        raw = data.answers.get(str(q["id"]), data.answers.get(q["id"]))
        if not _answer_to_text(raw):
            missing.append(q["title"])
    if missing:
        raise HTTPException(400, "Заполните обязательные вопросы: " + "; ".join(missing[:5]))

    # ⚠️ Резолв человека — ТОЛЬКО через общую точку (правило проекта): свои
    # SELECT по email плодят дубли. known_contact_id из ссылки главнее всего —
    # он цепляет новую идентичность к тому же человеку.
    contact_id = data.contact_id
    if contact_id:
        ok = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id=$1 AND client_id=$2 AND is_active=TRUE",
            contact_id, client_id)
        if not ok:
            contact_id = None

    # Человек выбрал себя на экране «Это вы?».
    if not contact_id and data.chosen_contact_id:
        ok = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id=$1 AND client_id=$2 AND is_active=TRUE",
            data.chosen_contact_id, client_id)
        if ok:
            contact_id = data.chosen_contact_id

    if not contact_id:
        from app.services.contact_merge import (
            find_contact_candidates, find_or_create_contact,
        )
        # ⚠️ Данные могут указывать на РАЗНЫХ людей: почта — на один контакт,
        # телефон — на другой. Молча взять первый нельзя, слить автоматически
        # тоже. Спрашиваем человека — та же механика, что в вебинарной
        # авторизации и форме заказа тарифа (общая точка `contact_merge`).
        #
        # Сюда попадаем, только когда контакта входа НЕТ (или он чужой) —
        # подмешивать его в кандидаты нечего, ветка выше уже забрала бы его.
        if not data.force_new:
            candidates = await find_contact_candidates(
                db, client_id,
                (data.email or "").strip() or None,
                (data.phone or "").strip() or None,
                (data.telegram_username or "").strip().lstrip("@") or None,
            )
            if len(candidates) > 1:
                return {"ok": False, "need_choice": True, "candidates": candidates}

        contact_id, _is_new = await find_or_create_contact(
            db, client_id=client_id,
            name=(data.name or "").strip() or None,
            email=(data.email or "").strip() or None,
            phone=(data.phone or "").strip() or None,
            lookup_telegram_username=(data.telegram_username or "").strip().lstrip("@") or None,
        )
    else:
        # Человек мог дописать то, чего мы про него не знали.
        if (data.phone or "").strip():
            await db.execute(
                "UPDATE contacts SET phone = COALESCE(phone, $2), updated_at = NOW() "
                "WHERE id = $1", contact_id, data.phone.strip())
        if (data.email or "").strip():
            try:
                from app.services.contact_merge import (
                    normalize_email, sync_email_identity_and_subscription,
                )
                em = normalize_email(data.email)
                if em:
                    await sync_email_identity_and_subscription(
                        db, client_id=client_id, contact_id=contact_id,
                        email=em, first_name=(data.name or "").strip() or None)
            except Exception:
                logger.exception("survey: не удалось привязать email контакту %s", contact_id)

    # Повторное заполнение — если запрещено, молча возвращаем прежний результат,
    # а не ошибку: человек мог просто обновить страницу.
    if not s["allow_repeat"]:
        seen = await db.fetchval(
            "SELECT 1 FROM survey_responses WHERE survey_id=$1 AND contact_id=$2 LIMIT 1",
            s["id"], contact_id)
        if seen:
            return await _after_submit(db, s, contact_id, data, repeated=True)

    async with db.transaction():
        resp_id = await db.fetchval(
            """INSERT INTO survey_responses
                 (survey_id, contact_id, platform_slug, lead_magnet_id, package_id, utm)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id""",
            s["id"], contact_id, data.platform,
            data.lead_magnet_id, data.package_id,
            json.dumps(data.utm or {}))

        for qid, raw in (data.answers or {}).items():
            try:
                q = by_id[int(qid)]
            except (ValueError, KeyError):
                continue
            text = _answer_to_text(raw)
            if not text:
                continue
            await db.execute(
                """INSERT INTO survey_answers (response_id, question_id, value, value_json)
                   VALUES ($1,$2,$3,$4::jsonb)
                   ON CONFLICT (response_id, question_id)
                   DO UPDATE SET value = EXCLUDED.value, value_json = EXCLUDED.value_json""",
                resp_id, q["id"], text, json.dumps(raw))

            # Вопрос привязан к полю контакта → пишем актуальное значение в
            # карточку. Так «Доход» виден в контакте и фильтрует базу.
            if q["field_id"]:
                await db.execute(
                    """INSERT INTO contact_field_values
                         (contact_id, field_id, value, value_json, updated_at)
                       VALUES ($1,$2,$3,$4::jsonb,NOW())
                       ON CONFLICT (contact_id, field_id)
                       DO UPDATE SET value = EXCLUDED.value,
                                     value_json = EXCLUDED.value_json,
                                     updated_at = NOW()""",
                    contact_id, q["field_id"], text, json.dumps(raw))

    return await _after_submit(db, s, contact_id, data, repeated=False)


async def _after_submit(db, survey, contact_id: int, data: SurveySubmit, *, repeated: bool):
    """Что показать после отправки.

    Если человек шёл за подарком — отдаём материалы прямо на странице И
    дублируем их в бот той площадки, откуда он пришёл (решение владельца):
    забрал сразу — хорошо, закрыл страницу — подарок ждёт в переписке.
    """
    out: dict = {
        "ok": True,
        "repeated": repeated,
        "after_mode": survey["after_mode"],
        "thanks_text": survey["thanks_text"],
        "redirect_url": survey["redirect_url"],
        "materials": [],
        "sent_to_bot": False,
    }

    if not (data.lead_magnet_id or data.package_id):
        return out

    # ⚠️ Материалы собираем ТОЙ ЖЕ функцией, что и обычная воронка
    # (`_materials_for_run`) — второй механики выдачи быть не должно, иначе
    # разъедутся плейсхолдеры реф-кодов в ссылках.
    run_like = {
        "client_id": survey["client_id"],
        "contact_id": contact_id,
        "lead_magnet_id": data.lead_magnet_id,
        "package_id": data.package_id,
        "referrer_contact_id": None,
    }
    try:
        from app.services.funnel_service import _materials_for_run
        out["materials"] = await _materials_for_run(run_like, db)
    except Exception:
        logger.exception("survey: не удалось собрать материалы подарка")
        return out

    # Дубль в бот — по площадке, с которой человек пришёл.
    try:
        out["sent_to_bot"] = await _send_materials_to_bot(
            db, survey["client_id"], contact_id, data.platform, out["materials"], survey)
    except Exception:
        logger.exception("survey: не удалось продублировать подарок в бот")
    return out


async def _send_materials_to_bot(
    db, client_id: int, contact_id: int, platform: Optional[str],
    materials: list, survey,
) -> bool:
    """Отправляет материалы в мессенджер, из которого пришёл человек.

    ⚠️ Площадка берётся из ссылки, но если её нет — ищем ЛЮБУЮ известную
    идентичность контакта: подарок должен дойти, даже если метка потерялась.
    Нет ни одной (человек с прямой браузерной ссылки) → отправлять некуда,
    материалы он уже видит на странице.
    """
    order = [platform] if platform else []
    order += [p for p in ('telegram', 'max', 'vk') if p != platform]

    lines = [f"🎁 <b>{survey['title']}</b> — ваш подарок:"]
    for i, m in enumerate(materials, 1):
        lines.append(f"{i}. <b>{m['name']}</b>\n{m['url']}")
    html = "\n\n".join(lines)
    plain = html.replace("<b>", "").replace("</b>", "")

    for p in order:
        if not p:
            continue
        ident = await db.fetchrow(
            """SELECT platform_user_id FROM platform_users
                WHERE contact_id = $1 AND platform_slug = $2
                  AND platform_user_id !~ '^@' LIMIT 1""",
            contact_id, p)
        if not ident:
            continue
        uid = ident["platform_user_id"]
        try:
            if p == 'telegram':
                import httpx
                from app.services.channels import get_client_telegram_token
                from app.services.message_builder import send_telegram_message
                token = await get_client_telegram_token(client_id, db)
                if not token:
                    continue
                async with httpx.AsyncClient(timeout=30) as http:
                    await send_telegram_message(http, token, str(uid), html)
                return True
            if p == 'max':
                from app.services.channels import get_client_max_token
                from app.services.max_api import send_message as max_send
                token = await get_client_max_token(client_id, db)
                if not token:
                    continue
                await max_send(int(uid), plain, token=token, recipient_kind='user')
                return True
            if p == 'vk':
                from app.services.funnel_service import _vk_token_for_client
                from app.services.vk_api import send_message as vk_send
                token = await _vk_token_for_client(client_id, db)
                if not token:
                    continue
                await vk_send(int(uid), plain, token=token)
                return True
        except Exception:
            logger.exception("survey: отправка подарка в %s не удалась", p)
            continue
    return False
