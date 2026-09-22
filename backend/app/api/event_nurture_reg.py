"""API воронки догрева для ЗАРЕГИСТРИРОВАННЫХ участников события.

Зеркало event_nurture.py (незарег.), но аудитория другая: человек уже
зарегистрировался. Серия сообщений помогает «не потеряться»: вступить в
чаты события, закрепить бота и т.п.

Триггер запуска: finalize_participant_registration (единая точка регистрации)
при первой регистрации участника → start_nurture_reg_run_if_eligible.

Отправка: Celery beat task `nurture_reg.tick` раз в N минут сканирует
event_nurture_reg_runs где finished_at IS NULL, ищет очередной непосланный шаг
и шлёт через бот клиента (или системный).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

from app.database import get_db
from app.auth import get_current_client

router = APIRouter(prefix="/events", tags=["Воронка догрева (зарег.)"])

# ⚠️ Виды кнопки шага — ОДНИМ списком, а не литералом в каждой проверке
# (миграция 485). Их четыре места: создание, PATCH и такие же две в
# event_nurture.py. Забытый список не падает, а молча схлопывает вид в 'event':
# кнопка «Получить ссылку и материалы» увела бы человека на программу события
# вместо подарков, и понять это можно было бы только нажав.
# Значения обязаны совпадать с CHECK-констрейнтом в БД (миграция 485).
_BUTTON_KINDS = ("event", "support", "gifts")


# ─── Pydantic ─────────────────────────────────────────────────────────

class NurtureRegStepCreate(BaseModel):
    offset_seconds: int = Field(..., ge=0)
    text:           str = ""
    button_label:   str = ""
    button_kind:    str = "event"   # 'event' | 'support'
    is_active:      bool = True


class NurtureRegStepUpdate(BaseModel):
    offset_seconds: Optional[int] = Field(None, ge=0)
    text:           Optional[str] = None
    button_label:   Optional[str] = None
    button_kind:    Optional[str] = None
    is_active:      Optional[bool] = None


# ─── Дефолтные тексты (auto-seed при первом GET) ──────────────────────
# Плейсхолдеры подставляются при отправке (см. tasks/nurture_reg.py):
#   {event_title}   — название события
#   {chats}         — блок ссылок на чаты события (TG/VK/MAX), главный сверху + жирным
#   {bot_handle}    — @ник бота, через который ушло сообщение (VIP или @pluson_bot)
#   {support_link}  — контакт службы поддержки клиента (work_tg_username)
#   {vip_link}, {gifts_link}, {speakers_link}, {program_link} — ссылки на разделы
#   {ref_links}     — ЛИЧНЫЕ реф-ссылки участника по площадкам («Через Телеграм: …»),
#                     только те площадки, что есть у клиента
#   {gift_ladder}   — лестница подарков из настроек реферальной программы события
#                     («За 1 зарегистрированного дарим: 🎁 …»), достигнутые ступени с ✅
#   {gifts_tab}     — название вкладки подарков, как его настроил клиент
# HTML-форматирование (<b>, <i>, <a>) разрешено.

DEFAULT_STEPS = [
    {
        "offset_seconds": 0,  # сразу после регистрации
        "text": (
            "Видим вашу регистрацию на «{event_title}»!\n\n"
            "<b>Чтобы не потеряться — прямо сейчас сделайте эти 3 действия:</b>\n\n"
            "1) Добавьтесь во все чаты события и <b>НАПИШИТЕ «Я С ВАМИ»</b>:\n\n"
            "{chats}\n\n"
            "2) <b>Запомните и закрепите этот бот</b> — {bot_handle}\n\n"
            "3) Запомните и <b>закрепите чаты события</b> в мессенджерах"
        ),
        "button_label": "",
    },
    {
        "offset_seconds": 15 * 60,  # через 15 минут
        "text": (
            "Скажите, всё ли у вас получилось с регистрацией? В чат попали?\n\n"
            # ⚠️ Контакты в текст НЕ подставляем: они приходят отдельным
            # сообщением по нажатию кнопки «Написать в тех.поддержку».
            "<b>Если возникли какие-то проблемы — напишите нам в тех.поддержку</b>"
        ),
        "button_label": "",
    },
    {
        # Подарки за рекомендации (22.09.2026). Отдельным шагом и ПОЗЖЕ первых
        # двух: сразу после регистрации человек занят чатами и ботом, и просьба
        # звать друзей в ту же минуту читается как навязчивость. Через час он
        # уже освоился — самое время показать, что за рекомендации дарят.
        #
        # ⚠️ Шаг приходит ВЫКЛЮЧЕННЫМ у существующих событий (restore-defaults
        # ставит is_active=FALSE): текст про подарки уйдёт людям только когда
        # клиент его прочитает и включит сам. Реферальная программа есть не у
        # каждого события, и у кого её нет — сообщение было бы пустым обещанием.
        "offset_seconds": 60 * 60,  # через час после регистрации
        "text": (
            "Мы щедро благодарим тех, кто рекомендует нас и помогает нам "
            "сделать наше событие еще более масштабным.\n\n"
            "Вы можете получать ценнейшие подарки, просто рекомендуя наше "
            "событие по своей реферальной ссылке.\n\n"
            "<b>Ваши реферальные ссылки:</b>\n"
            "{ref_links}\n\n"
            "А именно:\n\n"
            "{gift_ladder}\n\n"
            "Нажмите на кнопку, чтобы перейти в свой кабинет на вкладку "
            "«{gifts_tab}», чтобы забрать вашу реферальную ссылку и готовые "
            "материалы для анонсов."
        ),
        "button_label": "Получить ссылку и материалы",
        "button_kind": "gifts",
    },
]


# ─── Helpers ──────────────────────────────────────────────────────────

async def _assert_event_belongs_to_client(db, event_id: int, client_id: int):
    ok = await db.fetchval(
        "SELECT 1 FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Событие не найдено")


async def _seed_default_steps_if_empty(db, event_id: int):
    """Один раз на событие добавляем дефолтные reg-шаги.

    ⚠️ Условие — «дефолты ещё НЕ выдавали», а не «список пуст»: иначе
    удаление последнего шага воскрешало их при следующем чтении списка
    (см. пояснение в event_nurture.py).
    """
    seeded = await db.fetchval(
        "SELECT nurture_reg_defaults_seeded FROM events WHERE id = $1", event_id
    )
    if seeded:
        return
    await db.execute(
        "UPDATE events SET nurture_reg_defaults_seeded = TRUE WHERE id = $1", event_id
    )
    cnt = await db.fetchval(
        "SELECT COUNT(*) FROM event_nurture_reg_steps WHERE event_id = $1",
        event_id,
    )
    if cnt > 0:
        return
    for i, step in enumerate(DEFAULT_STEPS):
        await db.execute(
            """INSERT INTO event_nurture_reg_steps
                  (event_id, sort_order, offset_seconds, text, button_label, button_kind, is_active)
               VALUES ($1, $2, $3, $4, $5, $6, TRUE)""",
            event_id, i, step["offset_seconds"], step["text"], step["button_label"],
            step.get("button_kind", "event"),
        )


# ─── Routes ───────────────────────────────────────────────────────────

@router.get("/{event_id}/nurture-reg/preview-urls")
async def nurture_reg_preview_urls(
    event_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Возвращает реальные ссылки на разделы Mini App + чаты — для предпросмотра
    плейсхолдеров в дашборде."""
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT slug, title FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    from app.tasks.nurture_reg import build_section_urls, build_chats_block, _bot_handle
    from app.tasks.nurture import _build_support_contact
    sections = await build_section_urls(db, event_id=event_id, client_id=client_id, slug=row["slug"])
    chats = await build_chats_block(db, event_id=event_id, html=True)
    bot_handle = await _bot_handle(db, client_id=client_id, platform="telegram")
    _wrow = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1", client_id)
    from app.services.support_message import build_support_inline_html
    support_link = build_support_inline_html(
        work_tg=_wrow["work_tg_username"] if _wrow else None,
        work_vk=_wrow["work_vk"] if _wrow else None,
        work_max=_wrow["work_max"] if _wrow else None,
    )
    # Название вкладки подарков — для плейсхолдера {gifts_tab} в предпросмотре:
    # клиент должен видеть в тексте своё слово, а не чужое «Привилегии».
    from app.services.referral_gifts import get_tab_label_game
    gifts_tab = await get_tab_label_game(db, client_id)
    return {
        **sections,
        "chats_html": chats,
        "event_title": row["title"] or "событие",
        "bot_handle": bot_handle,
        "support_link": support_link,
        "gifts_tab": gifts_tab,
    }


@router.get("/{event_id}/nurture-reg/steps")
async def list_nurture_reg_steps(
    event_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Список шагов воронки догрева зарегистрированных. При первом обращении
    auto-seed 2 дефолтных шага (сразу / через 15 мин)."""
    await _assert_event_belongs_to_client(db, event_id, int(client["sub"]))
    await _seed_default_steps_if_empty(db, event_id)
    rows = await db.fetch(
        """SELECT id, sort_order, offset_seconds, text, button_label, button_kind, is_active, updated_at
             FROM event_nurture_reg_steps
            WHERE event_id = $1
            ORDER BY sort_order, id""",
        event_id,
    )
    return {"steps": [dict(r) for r in rows]}


@router.post("/{event_id}/nurture-reg/steps")
async def create_nurture_reg_step(
    event_id: int,
    data: NurtureRegStepCreate,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    await _assert_event_belongs_to_client(db, event_id, int(client["sub"]))
    next_sort = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM event_nurture_reg_steps WHERE event_id = $1",
        event_id,
    )
    bk = data.button_kind if data.button_kind in _BUTTON_KINDS else "event"
    new_id = await db.fetchval(
        """INSERT INTO event_nurture_reg_steps
              (event_id, sort_order, offset_seconds, text, button_label, button_kind, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id""",
        event_id, next_sort, data.offset_seconds, data.text, data.button_label, bk, data.is_active,
    )
    return {"id": new_id}


@router.post("/{event_id}/nurture-reg/restore-defaults", tags=["Воронка догрева (зарег.)"])
async def restore_default_nurture_reg_steps(
    event_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Вернуть шаги по умолчанию — ДОБАВИТЬ к существующим, выключенными
    (см. пояснение в event_nurture.py)."""
    await _assert_event_belongs_to_client(db, event_id, int(client["sub"]))
    next_sort = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM event_nurture_reg_steps WHERE event_id = $1",
        event_id,
    )
    added = 0
    for i, step in enumerate(DEFAULT_STEPS):
        await db.execute(
            """INSERT INTO event_nurture_reg_steps
                  (event_id, sort_order, offset_seconds, text, button_label, button_kind, is_active)
               VALUES ($1, $2, $3, $4, $5, $6, FALSE)""",
            event_id, next_sort + i, step["offset_seconds"], step["text"],
            step["button_label"], step.get("button_kind", "event"),
        )
        added += 1
    return {"ok": True, "added": added}


@router.patch("/nurture-reg/steps/{step_id}", tags=["Воронка догрева (зарег.)"])
async def update_nurture_reg_step(
    step_id: int,
    data: NurtureRegStepUpdate,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    row = await db.fetchrow(
        """SELECT s.event_id, EXISTS (
                        SELECT 1 FROM event_owners eo
                         WHERE eo.event_id = e.id AND eo.status = 'accepted'
                           AND eo.client_id = $2
                    ) AS is_owner
             FROM event_nurture_reg_steps s
             JOIN events e ON e.id = s.event_id
            WHERE s.id = $1""",
        step_id, int(client["sub"]),
    )
    # ⚠️ В КОЛЛАБЕ ОРГАНИЗАТОРЫ РАВНОПРАВНЫ: править и удалять шаги может
    # ЛЮБОЙ принявший приглашение, а не «первый из event_owners».
    # Раньше стоял подзапрос «первый владелец» — и второй организатор
    # получал 404: у него молча не снималась галочка и не удалялся шаг.
    if not row or not row["is_owner"]:
        raise HTTPException(status_code=404, detail="Шаг не найден")

    updates = []
    args = [step_id]
    if data.offset_seconds is not None:
        args.append(data.offset_seconds); updates.append(f"offset_seconds = ${len(args)}")
    if data.text is not None:
        args.append(data.text); updates.append(f"text = ${len(args)}")
    if data.button_label is not None:
        args.append(data.button_label); updates.append(f"button_label = ${len(args)}")
    if data.button_kind is not None and data.button_kind in _BUTTON_KINDS:
        args.append(data.button_kind); updates.append(f"button_kind = ${len(args)}")
    if data.is_active is not None:
        args.append(data.is_active); updates.append(f"is_active = ${len(args)}")
    if not updates:
        return {"ok": True, "noop": True}
    updates.append("updated_at = NOW()")
    await db.execute(
        f"UPDATE event_nurture_reg_steps SET {', '.join(updates)} WHERE id = $1",
        *args,
    )
    return {"ok": True}


@router.delete("/nurture-reg/steps/{step_id}", tags=["Воронка догрева (зарег.)"])
async def delete_nurture_reg_step(
    step_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    row = await db.fetchrow(
        """SELECT s.event_id, EXISTS (
                        SELECT 1 FROM event_owners eo
                         WHERE eo.event_id = e.id AND eo.status = 'accepted'
                           AND eo.client_id = $2
                    ) AS is_owner
             FROM event_nurture_reg_steps s
             JOIN events e ON e.id = s.event_id
            WHERE s.id = $1""",
        step_id, int(client["sub"]),
    )
    # ⚠️ В КОЛЛАБЕ ОРГАНИЗАТОРЫ РАВНОПРАВНЫ: править и удалять шаги может
    # ЛЮБОЙ принявший приглашение, а не «первый из event_owners».
    # Раньше стоял подзапрос «первый владелец» — и второй организатор
    # получал 404: у него молча не снималась галочка и не удалялся шаг.
    if not row or not row["is_owner"]:
        raise HTTPException(status_code=404, detail="Шаг не найден")
    await db.execute("DELETE FROM event_nurture_reg_steps WHERE id = $1", step_id)
    return {"ok": True}


# ─── Trigger (вызывается из finalize_participant_registration) ─────────

async def start_nurture_reg_run_if_eligible(
    db, *, event_id: int, contact_id: int,
) -> bool:
    """Создаёт запись event_nurture_reg_runs при регистрации участника.
    Идемпотентно: ON CONFLICT DO NOTHING (по event_id, contact_id).

    Вызывать ТОЛЬКО когда is_registered=TRUE (проверяет вызывающий —
    finalize_participant_registration).
    """
    has_step = await db.fetchval(
        """SELECT 1 FROM event_nurture_reg_steps
            WHERE event_id = $1 AND is_active = TRUE LIMIT 1""",
        event_id,
    )
    if not has_step:
        return False

    res = await db.fetchval(
        """INSERT INTO event_nurture_reg_runs (event_id, contact_id, started_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (event_id, contact_id) DO NOTHING
        RETURNING id""",
        event_id, contact_id,
    )
    return res is not None
