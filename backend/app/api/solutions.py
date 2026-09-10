"""Установка готовых решений — «Установить мне» одной кнопкой.

Решение — это связка уже существующих сущностей: лид-магнит, анкета, событие.
Здесь они создаются в кабинете клиента за один запрос.

⚠️⚠️ СОЗДАЁМ ТОЛЬКО НОВОЕ, СУЩЕСТВУЮЩЕЕ НЕ ТРОГАЕМ. Установка не меняет
настройки клиента, не переписывает его воронку и не переключает тумблеры: она
добавляет записи, которые он потом правит или удаляет. Иначе одно нажатие
кнопки «посмотреть, что это» затирало бы рабочие настройки — и доверия к
разделу не будет.

⚠️ Каждая сущность создаётся ТЕМИ ЖЕ функциями и полями, что и вручную. Свои
INSERT-ы мимо общих правил (slug лид-магнита, порядок вопросов анкеты, дефолты
события) разъехались бы с остальным кабинетом.

⚠️ Гейт по фиче `ready_solutions` — раздел пока обкатывается и открыт только
админу (миграция 400).
"""

from __future__ import annotations

import logging
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.features import client_has_feature

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/solutions", tags=["Готовые решения"])


class InstallOut(BaseModel):
    ok: bool
    created: list[dict]


async def _assert_access(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "ready_solutions"):
        raise HTTPException(403, "Раздел готовых решений пока недоступен.")


async def _support_filled(db, client_id: int) -> bool:
    """Заполнена ли служба заботы хоть на одной площадке.

    ⚠️ Проверяем ДО установки решения, которое ведёт человека в личку: без
    контакта воронка доведёт его до кнопки, которая никуда не ведёт.
    """
    row = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1",
        client_id,
    )
    return bool(row and (row["work_tg_username"] or row["work_vk"] or row["work_max"]))


# ─────────────────────────── сборка кусочков ────────────────────────────
async def _new_lead_magnet(db, client_id: int, *, name: str, description: str,
                           url: str, link_source: str = "fixed",
                           support_prefill: Optional[str] = None,
                           button_label: Optional[str] = None,
                           require_survey_id: Optional[int] = None) -> dict:
    """Лид-магнит теми же правилами, что и созданный руками."""
    # ⚠️ slug генерирует общая функция: свой генератор дал бы коды другого
    # формата, и ссылки решений отличались бы от обычных.
    from app.api.lead_magnets import _make_unique_lead_magnet_slug

    slug = await _make_unique_lead_magnet_slug(db)
    row = await db.fetchrow(
        """INSERT INTO lead_magnets
             (client_id, name, description, url, slug, link_mode, button_label,
              link_source, support_prefill, require_survey_id)
           VALUES ($1,$2,$3,$4,$5,'both',$6,$7,$8,$9)
           RETURNING id, name, slug""",
        client_id, name, description, url, slug,
        button_label, link_source, support_prefill, require_survey_id,
    )
    return dict(row)


async def _new_survey(db, client_id: int, *, title: str,
                      questions: list[dict], intro: Optional[str] = None) -> dict:
    """Анкета с вопросами и служебными полями сотрудника.

    ⚠️ Поля сотрудника («Обработано» и «Заметка») добавляются ВСЕГДА — на них
    держится вся обработка заявок: счётчик необработанных, отбор в таблице и
    дашборд. Анкета без них выглядит рабочей, но заявки в ней некуда двигать.
    """
    from app.api.surveys import _make_unique_survey_slug

    slug = await _make_unique_survey_slug(db)
    s = await db.fetchrow(
        """INSERT INTO surveys (client_id, title, slug, intro, is_active)
           VALUES ($1,$2,$3,$4,TRUE) RETURNING id, title, slug""",
        client_id, title, slug, intro,
    )
    sid = s["id"]

    for i, q in enumerate(questions):
        await db.execute(
            """INSERT INTO survey_questions
                 (survey_id, title, kind, is_required, sort_order, filled_by, options)
               VALUES ($1,$2,$3,$4,$5,'visitor',$6)""",
            sid, q["title"], q.get("kind", "text"),
            bool(q.get("required", False)), i * 10,
            q.get("options"),
        )

    # ⚠️ sort_order у полей сотрудника начинается с 10000 — чтобы они не
    # перемешивались с вопросами посетителя (правило миграции 338).
    await db.execute(
        """INSERT INTO survey_questions
             (survey_id, title, kind, is_required, sort_order, filled_by, is_protected)
           VALUES ($1,'Обработано','bool',FALSE,10000,'staff',TRUE)""",
        sid,
    )
    await db.execute(
        """INSERT INTO survey_questions
             (survey_id, title, kind, is_required, sort_order, filled_by)
           VALUES ($1,'Заметка','textarea',FALSE,10010,'staff')""",
        sid,
    )
    return dict(s)


# ────────────────────────────── решения ──────────────────────────────────
async def _install_magnet_for_subscribe(db, cid: int) -> list[dict]:
    lm = await _new_lead_magnet(
        db, cid,
        name="Чек-лист «10 шагов» (пример)",
        description="Замените на свой материал: файл, папку или запись.",
        url="https://pluson.ru/",
        button_label="Забрать материал",
    )
    return [{"title": f"Лид-магнит «{lm['name']}»",
             "href": "/dashboard/lead-magnets"}]


async def _install_consult_support(db, cid: int) -> list[dict]:
    # ⚠️ Проверка ДО создания: решение целиком построено вокруг ссылки в личку.
    if not await _support_filled(db, cid):
        raise HTTPException(
            400,
            "Сначала заполните контакты службы заботы — «Настройки» → «Профиль». "
            "Без них человеку некуда написать, и решение не заработает. "
            "Заполните и вернитесь сюда.",
        )
    lm = await _new_lead_magnet(
        db, cid,
        name="Запись на консультацию (пример)",
        description="После подписки человек получает ссылку, чтобы написать вам.",
        url="",                      # ⚠️ при link_source='support' url не нужен
        link_source="support",
        support_prefill="Хочу консультацию",
        button_label="Написать нам",
    )
    return [{"title": f"Лид-магнит «{lm['name']}»",
             "href": "/dashboard/lead-magnets"}]


CONSULT_QUESTIONS = [
    {"title": "Напишите ваш контакт — куда вам удобнее, чтобы мы написали? "
              "(Telegram, MAX, ВКонтакте)", "kind": "textarea", "required": True},
    {"title": "Расскажите о себе и своём запросе — чем подробнее, тем точнее "
              "будет консультация", "kind": "textarea", "required": True},
]


async def _install_consult_survey_link(db, cid: int) -> list[dict]:
    if not await _support_filled(db, cid):
        raise HTTPException(
            400,
            "Сначала заполните контакты службы заботы — «Настройки» → «Профиль». "
            "Заполните и вернитесь сюда.",
        )
    sv = await _new_survey(db, cid, title="Запись на консультацию",
                           questions=CONSULT_QUESTIONS)
    lm = await _new_lead_magnet(
        db, cid,
        name="Запись на консультацию с анкетой (пример)",
        description="Ссылка в личку выдаётся после заполнения анкеты.",
        url="",
        link_source="support",
        support_prefill="Заполнил анкету, хочу консультацию",
        button_label="Написать нам",
        require_survey_id=sv["id"],
    )
    return [
        {"title": f"Анкета «{sv['title']}»", "href": "/dashboard/surveys"},
        {"title": f"Лид-магнит «{lm['name']}»", "href": "/dashboard/lead-magnets"},
    ]


async def _install_consult_survey_only(db, cid: int) -> list[dict]:
    sv = await _new_survey(db, cid, title="Запись на консультацию",
                           questions=CONSULT_QUESTIONS)
    # ⚠️ Здесь сам материал — это ссылка на анкету: человеку выдаётся она.
    base = await _public_base(db, cid)
    lm = await _new_lead_magnet(
        db, cid,
        name="Запись на консультацию (анкета)",
        description="Материал — сама анкета. После подписки человек заполняет её.",
        url=f"{base}/f/{sv['slug']}",
        button_label="Заполнить анкету",
    )
    return [
        {"title": f"Анкета «{sv['title']}»", "href": "/dashboard/surveys"},
        {"title": f"Лид-магнит «{lm['name']}»", "href": "/dashboard/lead-magnets"},
    ]


RAFFLE_INTRO = (
    "Как проходит розыгрыш: победителя выберем случайным образом среди всех, "
    "кто заполнил эту анкету. Результат опубликуем в нашем канале — "
    "оставайтесь подписаны, чтобы не пропустить."
)

RAFFLE_QUESTIONS = [
    {"title": "Как вас зовут?", "kind": "text", "required": True},
    {"title": "Куда написать, если выиграете? (Telegram, MAX, ВКонтакте)",
     "kind": "text", "required": True},
    # ⚠️ Третий вопрос — не ради данных, а чтобы показать: вопросы можно
    # добавлять любые (просьба владельца).
    {"title": "Как вы о нас узнали?", "kind": "text", "required": False},
]


async def _install_raffle_subscribe(db, cid: int) -> list[dict]:
    lm = await _new_lead_magnet(
        db, cid,
        name="Розыгрыш приза (пример)",
        description="Участие — подписка на канал. Список участников виден в кабинете.",
        url="https://pluson.ru/",
        button_label="Участвую",
    )
    return [{"title": f"Лид-магнит «{lm['name']}»",
             "href": "/dashboard/lead-magnets"}]


async def _install_raffle_survey(db, cid: int) -> list[dict]:
    sv = await _new_survey(db, cid, title="Розыгрыш приза",
                           questions=RAFFLE_QUESTIONS, intro=RAFFLE_INTRO)
    base = await _public_base(db, cid)
    lm = await _new_lead_magnet(
        db, cid,
        name="Розыгрыш приза с анкетой (пример)",
        description="После подписки человек заполняет анкету участника.",
        url=f"{base}/f/{sv['slug']}",
        button_label="Участвовать",
    )
    return [
        {"title": f"Анкета «{sv['title']}»", "href": "/dashboard/surveys"},
        {"title": f"Лид-магнит «{lm['name']}»", "href": "/dashboard/lead-magnets"},
    ]


async def _public_base(db, cid: int) -> str:
    from app.services.client_domains import client_public_url
    return (await client_public_url(db, cid)).rstrip("/")


# ⚠️ Событийные решения ставятся ОДНОЙ функцией с параметрами: у них
# различается только текст и признак бессрочности. Отдельная функция на каждое
# была бы четырьмя копиями одного кода.
async def _install_event(db, cid: int, *, title: str, description: str,
                         evergreen: bool, with_landing: bool) -> list[dict]:
    from app.api.events import _make_unique_short_slug

    slug = await _make_unique_short_slug(db)
    ev = await db.fetchrow(
        """INSERT INTO events (title, description, slug, module_slug, status,
                               is_evergreen, registration_mode, welcome_enabled)
           VALUES ($1,$2,$3,'base','draft',$4,'form',TRUE)
           RETURNING id, title""",
        title, description, slug, evergreen,
    )
    await db.execute(
        """INSERT INTO event_owners (event_id, client_id, role, status)
           VALUES ($1,$2,'owner','accepted')""",
        ev["id"], cid,
    )
    out = [{"title": f"Событие «{ev['title']}» (черновик)",
            "href": f"/dashboard/events/{ev['id']}"}]
    if with_landing:
        out.append({"title": "Лендинг события — соберите его во вкладке «Лендинг»",
                    "href": f"/dashboard/events/{ev['id']}?tab=landing"})
    return out


CONSULT_EVENT_TEXT = (
    "Здесь опишите, кому подойдёт консультация и что человек получит. "
    "Замените этот текст на свой — и добавьте афишу во вкладке «Афиши»."
)

# ⚠️ Ключ = slug решения из фронтового каталога. Расходиться им нельзя:
# кнопка «Установить мне» шлёт именно slug.
INSTALLERS = {
    "magnet-for-subscribe": _install_magnet_for_subscribe,
    "consult-support-link": _install_consult_support,
    "consult-survey-link": _install_consult_survey_link,
    "consult-survey-only": _install_consult_survey_only,
    "raffle-subscribe": _install_raffle_subscribe,
    "raffle-survey": _install_raffle_survey,
    "consult-event-miniapp": lambda db, cid: _install_event(
        db, cid, title="Консультация — запись открыта",
        description=CONSULT_EVENT_TEXT, evergreen=True, with_landing=False),
    "consult-event-landing": lambda db, cid: _install_event(
        db, cid, title="Консультация — запись открыта",
        description=CONSULT_EVENT_TEXT, evergreen=True, with_landing=True),
    "raffle-event-miniapp": lambda db, cid: _install_event(
        db, cid, title="Розыгрыш приза",
        description="Опишите приз и условия. Замените афишу на свою.",
        evergreen=False, with_landing=False),
    "raffle-event-landing": lambda db, cid: _install_event(
        db, cid, title="Розыгрыш приза",
        description="Опишите приз и условия. Замените афишу на свою.",
        evergreen=False, with_landing=True),
}


@router.post("/{slug}/install", summary="Установить решение себе")
async def install(slug: str, client=Depends(get_current_client),
                  db: asyncpg.Connection = Depends(get_db)) -> InstallOut:
    cid = int(client["sub"])
    await _assert_access(db, cid)

    fn = INSTALLERS.get(slug)
    if not fn:
        raise HTTPException(
            404, "Это решение пока ставится вручную — откройте описание, там все шаги.")

    # ⚠️ Всё создаётся ОДНОЙ транзакцией: наполовину поставленное решение
    # (анкета есть, воронки нет) хуже, чем непоставленное — человек не поймёт,
    # что сломалось, и повторная установка наплодит дублей.
    async with db.transaction():
        created = await fn(db, cid)

    logger.info("solution %s installed for client %s", slug, cid)
    return InstallOut(ok=True, created=created)
