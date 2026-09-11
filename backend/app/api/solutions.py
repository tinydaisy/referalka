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

import json
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


# ⚠️⚠️ НОМЕР РЕШЕНИЯ — В НАЗВАНИИ КАЖДОЙ СОЗДАННОЙ ЗАПИСИ. У клиента анкет и
# лид-магнитов десятки, и «Запись на консультацию» среди них ничего не говорит:
# непонятно, откуда запись взялась и к какому решению относится. С номером
# человек находит её глазами и сопоставляет со строкой таблицы решений.
#
# ⚠️ Номера обязаны совпадать с полем `num` во фронтовом каталоге
# ([catalog.ts](web/src/components/solutions/catalog.ts)) — по нему человек и
# приходит. Расходиться нельзя: связь примера со строкой таблицы потеряется.
SOLUTION_NUMS = {
    "magnet-for-subscribe": 1,
    "magnet-package": 2,
    "instagram-reels": 3,
    "consult-support-link": 4,
    "consult-survey-link": 5,
    "consult-survey-only": 6,
    "consult-event-miniapp": 7,
    "consult-event-landing": 8,
    "raffle-subscribe": 9,
    "raffle-survey": 10,
    "raffle-event-miniapp": 11,
    "raffle-event-landing": 12,
    "webinar-miniapp": 13,
    "webinar-landing": 14,
    "paid-webinar-landing": 15,
    "paid-webinar-miniapp": 16,
    "product-landing": 17,
    "quiz-gift-form": 18,
    "quiz-gift-landing": 19,
    "survey-segments": 20,
    "offline-event": 21,
}


def _named(slug: str, what: str) -> str:
    """Название записи с номером решения: «Анкета к решению 5: Запись…».

    ⚠️ Номера нет в словаре → отдаём как есть, без «к решению None»: лучше
    название без пометки, чем с бессмыслицей.
    """
    num = SOLUTION_NUMS.get(slug)
    return f"{what} (решение {num})" if num else what


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


# ⚠️⚠️ «Уровень дохода» — ПОЛЕ КОНТАКТА, а не просто вопрос анкеты. Разница
# принципиальная: ответ на вопрос живёт внутри одного заполнения, а поле
# контакта — на самом человеке. Оно попадает в его карточку, фильтрует базу,
# режется в дашбордах и остаётся, даже если анкету потом удалят.
#
# ⚠️ Вилками, а не числом (решение владельца): «сколько вы зарабатываете»
# цифрой люди не пишут, а по вилкам отвечают охотно. Сравнений «больше 200
# тысяч» у такого поля нет — это выбор нужных вилок галочками (оператор `in`).
#
# ⚠️ Варианты — ТЕ ЖЕ, что у боевого клиента 1 (`contact_fields.code='income'`):
# демо обязано выглядеть один в один с рабочим кабинетом.
INCOME_FIELD_CODE = "income"
INCOME_FIELD_TITLE = "Уровень дохода"
INCOME_OPTIONS = [
    "До 100.000 рублей",
    "100.000- 200.000 рублей",
    "200.000- 300.000 рублей",
    "300.000- 500.000 рублей",
    "500.000- 1.000.000 рублей",
    "Более 1.000.000 рублей",
]


async def ensure_income_field(db, client_id: int) -> int:
    """Поле контакта «Уровень дохода». Есть — берём, нет — заводим.

    ⚠️ Ищем по `code`, а не по названию: название клиент вправе переписать под
    себя, и поиск по нему завёл бы второе поле-дубль.
    """
    existing = await db.fetchval(
        "SELECT id FROM contact_fields WHERE client_id = $1 AND code = $2",
        client_id, INCOME_FIELD_CODE,
    )
    if existing:
        return existing
    return await db.fetchval(
        """INSERT INTO contact_fields
             (client_id, code, title, kind, options, show_in_card, sort_order)
           VALUES ($1,$2,$3,'select',$4::jsonb,TRUE,100)
           RETURNING id""",
        client_id, INCOME_FIELD_CODE, INCOME_FIELD_TITLE,
        json.dumps(INCOME_OPTIONS, ensure_ascii=False),
    )


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
            # ⚠️ `options` — NOT NULL с дефолтом '[]'. Явный None дефолт
            # ПЕРЕБИВАЕТ и роняет вставку: у вопросов без вариантов ответа
            # передаём пустой список, а не «ничего».
            json.dumps(q.get("options") or []),
        )

    # ⚠️⚠️ Вопрос про доход добавляется В КАЖДУЮ анкету решения и привязывается
    # к ПОЛЮ КОНТАКТА (`field_id`). Без привязки ответ осел бы внутри анкеты, и
    # сегментация базы по доходу не заработала бы: дашборды и фильтр контактов
    # читают `contact_field_values`, а не ответы отдельного заполнения.
    #
    # ⚠️ Необязательный: вопрос про деньги в обязательных отпугивает и роняет
    # заполняемость всей анкеты. Кто хочет — ответит.
    income_id = await ensure_income_field(db, client_id)
    await db.execute(
        """INSERT INTO survey_questions
             (survey_id, field_id, title, kind, options, is_required,
              sort_order, filled_by)
           VALUES ($1,$2,$3,'select',$4::jsonb,FALSE,$5,'visitor')""",
        sid, income_id, INCOME_FIELD_TITLE,
        json.dumps(INCOME_OPTIONS, ensure_ascii=False), len(questions) * 10,
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
async def _install_magnet_for_subscribe(db, cid: int, slug: str) -> list[dict]:
    lm = await _new_lead_magnet(
        db, cid,
        name=_named(slug, "Чек-лист «10 шагов»"),
        description="Замените на свой материал: файл, папку или запись.",
        url="https://pluson.ru/",
        button_label="Забрать материал",
    )
    return [{"title": f"Лид-магнит «{lm['name']}»",
             "href": "/dashboard/lead-magnets",
             "hint": "Раздел «Лид-магниты» — здесь замените название, описание "
                     "и ссылку на свой материал, а рядом лежат ссылки для "
                     "раздачи людям."}]


async def _install_consult_support(db, cid: int, slug: str) -> list[dict]:
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
        name=_named(slug, "Запись на консультацию"),
        description="После подписки человек получает ссылку, чтобы написать вам.",
        url="",                      # ⚠️ при link_source='support' url не нужен
        link_source="support",
        support_prefill="Хочу консультацию",
        button_label="Написать нам",
    )
    return [{"title": f"Лид-магнит «{lm['name']}»",
             "href": "/dashboard/lead-magnets",
             "hint": "Раздел «Лид-магниты». Ссылку в личку решение берёт из "
                     "службы заботы — «Настройки» → «Профиль»."}]


CONSULT_QUESTIONS = [
    {"title": "Напишите ваш контакт — куда вам удобнее, чтобы мы написали? "
              "(Telegram, MAX, ВКонтакте)", "kind": "textarea", "required": True},
    {"title": "Расскажите о себе и своём запросе — чем подробнее, тем точнее "
              "будет консультация", "kind": "textarea", "required": True},
]


async def _install_consult_survey_link(db, cid: int, slug: str) -> list[dict]:
    if not await _support_filled(db, cid):
        raise HTTPException(
            400,
            "Сначала заполните контакты службы заботы — «Настройки» → «Профиль». "
            "Заполните и вернитесь сюда.",
        )
    sv = await _new_survey(db, cid, title=_named(slug, "Квиз: запись на консультацию"),
                           questions=CONSULT_QUESTIONS)
    lm = await _new_lead_magnet(
        db, cid,
        name=_named(slug, "Запись на консультацию с анкетой"),
        description="Ссылка в личку выдаётся после заполнения анкеты.",
        url="",
        link_source="support",
        support_prefill="Заполнил анкету, хочу консультацию",
        button_label="Написать нам",
        require_survey_id=sv["id"],
    )
    return [
        {"title": f"Анкета «{sv['title']}»", "href": "/dashboard/surveys",
         "hint": "Раздел «Анкеты». Здесь правятся вопросы, а на вкладке "
                 "«Ответы» лежат заявки с отметкой «Обработано»."},
        {"title": f"Лид-магнит «{lm['name']}»", "href": "/dashboard/lead-magnets",
         "hint": "Раздел «Лид-магниты». Анкета уже привязана: пока она не "
                 "заполнена, ссылка в личку не выдаётся."},
    ]


async def _install_consult_survey_only(db, cid: int, slug: str) -> list[dict]:
    sv = await _new_survey(db, cid, title=_named(slug, "Квиз: запись на консультацию"),
                           questions=CONSULT_QUESTIONS)
    # ⚠️ Здесь сам материал — это ссылка на анкету: человеку выдаётся она.
    base = await _public_base(db, cid)
    lm = await _new_lead_magnet(
        db, cid,
        name=_named(slug, "Запись на консультацию (анкета)"),
        description="Материал — сама анкета. После подписки человек заполняет её.",
        url=f"{base}/f/{sv['slug']}",
        button_label="Заполнить анкету",
    )
    return [
        {"title": f"Анкета «{sv['title']}»", "href": "/dashboard/surveys",
         "hint": "Раздел «Анкеты». Заявки — на вкладке «Ответы»."},
        {"title": f"Лид-магнит «{lm['name']}»", "href": "/dashboard/lead-magnets",
         "hint": "Раздел «Лид-магниты» — материалом выдаётся ссылка на анкету."},
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


async def _install_raffle_subscribe(db, cid: int, slug: str) -> list[dict]:
    lm = await _new_lead_magnet(
        db, cid,
        name=_named(slug, "Розыгрыш приза"),
        description="Участие — подписка на канал. Список участников виден в кабинете.",
        url="https://pluson.ru/",
        button_label="Участвую",
    )
    return [{"title": f"Лид-магнит «{lm['name']}»",
             "href": "/dashboard/lead-magnets",
             "hint": "Раздел «Лид-магниты». Кто участвует — по клику на цифру "
                     "рядом с магнитом."}]


async def _install_raffle_survey(db, cid: int, slug: str) -> list[dict]:
    sv = await _new_survey(db, cid, title=_named(slug, "Квиз: розыгрыш приза"),
                           questions=RAFFLE_QUESTIONS, intro=RAFFLE_INTRO)
    base = await _public_base(db, cid)
    lm = await _new_lead_magnet(
        db, cid,
        name=_named(slug, "Розыгрыш приза с анкетой"),
        description="После подписки человек заполняет анкету участника.",
        url=f"{base}/f/{sv['slug']}",
        button_label="Участвовать",
    )
    return [
        {"title": f"Анкета «{sv['title']}»", "href": "/dashboard/surveys",
         "hint": "Раздел «Анкеты» — участники на вкладке «Ответы»."},
        {"title": f"Лид-магнит «{lm['name']}»", "href": "/dashboard/lead-magnets",
         "hint": "Раздел «Лид-магниты» — материалом выдаётся ссылка на анкету."},
    ]


async def _public_base(db, cid: int) -> str:
    from app.services.client_domains import client_public_url
    return (await client_public_url(db, cid)).rstrip("/")


# ⚠️ Событийные решения ставятся ОДНОЙ функцией с параметрами: у них
# различается только текст и признак бессрочности. Отдельная функция на каждое
# была бы четырьмя копиями одного кода.
async def _install_event(db, cid: int, *, title: str, description: str,
                         evergreen: bool, with_landing: bool,
                         offline: bool = False) -> list[dict]:
    from app.api.events import _make_unique_short_slug

    slug = await _make_unique_short_slug(db)
    # ⚠️ У офлайн-события способ регистрации — `landing`: блок «Место
    # проведения» с картой живёт на собранной странице /e/{slug}, и через
    # простую форму человек его просто не увидит.
    mode = "landing" if (with_landing or offline) else "form"
    ev = await db.fetchrow(
        """INSERT INTO events (title, description, slug, module_slug, status,
                               is_evergreen, registration_mode, welcome_enabled,
                               is_offline)
           VALUES ($1,$2,$3,'base','draft',$4,$5,TRUE,$6)
           RETURNING id, title""",
        title, description, slug, evergreen, mode, offline,
    )
    await db.execute(
        """INSERT INTO event_owners (event_id, client_id, role, status)
           VALUES ($1,$2,'owner','accepted')""",
        ev["id"], cid,
    )
    out = [{"title": f"Событие «{ev['title']}» (черновик)",
            "href": f"/dashboard/events/{ev['id']}",
            "hint": "Раздел «Мероприятия». Событие создано черновиком — "
                    "заполните дату и афишу, потом нажмите «Опубликовать»."}]
    if offline:
        out.append({
            "title": "Адрес и карта — вкладка «Основное»",
            "href": f"/dashboard/events/{ev['id']}",
            "hint": "Впишите адрес места проведения, ВЫБРАВ его из подсказки — "
                    "тогда на странице появится карта с меткой и кнопкой "
                    "«Построить маршрут». Адрес, вписанный руками, покажет "
                    "район без метки.",
        })
    if with_landing or offline:
        out.append({"title": "Лендинг события — вкладка «Лендинг»",
                    "href": f"/dashboard/events/{ev['id']}?tab=landing",
                    "hint": "Соберите страницу из блоков и нажмите "
                            "«Опубликовать» — без публикации она отдаёт 404."})
    return out


CONSULT_EVENT_TEXT = (
    "Здесь опишите, кому подойдёт консультация и что человек получит. "
    "Замените этот текст на свой — и добавьте афишу во вкладке «Афиши»."
)

# ─────────────────────────── квиз за подарок ─────────────────────────────
#
# ⚠️⚠️ КВИЗ — ЭТО НЕ ОТДЕЛЬНАЯ СУЩНОСТЬ, А СПОСОБ ПОКАЗА АНКЕТЫ. Те же вопросы,
# тот же приём ответов, та же аналитика — разница целиком в вёрстке: вопросы
# идут по одному, а не простынёй. Поэтому заводим обычную анкету, а
# «квизовость» включается там, где её показывают (`survey_view='quiz'` у блока
# лендинга). Заводить вторую сущность рядом значило бы чинить всё дважды.
#
# ⚠️ Вопросы — с вариантами ответа, а не текстом: в квизе человек ТЫКАЕТ, а не
# печатает, иначе он бросит его на втором шаге.
QUIZ_QUESTIONS = [
    {"title": "Чем вы занимаетесь?", "kind": "select", "required": True,
     "options": ["Эксперт, консультант", "Онлайн-школа или курсы",
                 "Офлайн-бизнес", "Блогер", "Только начинаю"]},
    {"title": "Сколько человек в вашей базе?", "kind": "select", "required": True,
     "options": ["Меньше 500", "500–3000", "3000–10 000", "Больше 10 000"]},
    {"title": "Как сейчас привлекаете клиентов?", "kind": "multiselect",
     "required": True,
     "options": ["Реклама", "Блог и контент", "Сарафан",
                 "Коллаборации и эфиры", "Пока никак"]},
    {"title": "Что сейчас важнее всего?", "kind": "select", "required": True,
     "options": ["Собрать базу", "Продавать существующей базе",
                 "Провести событие", "Автоматизировать рутину"]},
    {"title": "Куда прислать подборку?", "kind": "text", "required": True},
]

QUIZ_INTRO = (
    "Ответьте на несколько коротких вопросов — и получите подборку материалов "
    "под вашу задачу. Замените вопросы и подарок на свои."
)


async def _install_quiz_gift_form(db, cid: int, slug: str) -> list[dict]:
    """Квиз через простую форму: человек проходит его по ссылке /f/{slug}."""
    sv = await _new_survey(db, cid, title=_named(slug, "Квиз за подарок"),
                           questions=QUIZ_QUESTIONS, intro=QUIZ_INTRO)
    # ⚠️ Подарок выдаётся ТОЛЬКО после прохождения — `require_survey_id`.
    # Без этой привязки квиз превратился бы в необязательный опрос: человек
    # забирал бы материал, не отвечая.
    lm = await _new_lead_magnet(
        db, cid,
        name=_named(slug, "Подборка за прохождение квиза"),
        description="Выдаётся после того, как человек пройдёт квиз. "
                    "Замените материал на свой.",
        url="https://pluson.ru/",
        button_label="Забрать подборку",
        require_survey_id=sv["id"],
    )
    return [
        {"title": f"Анкета-квиз «{sv['title']}»", "href": "/dashboard/surveys",
         "hint": "Раздел «Анкеты». Правьте вопросы, ответы — на вкладке "
                 "«Ответы». Ссылку на квиз копируйте там же."},
        {"title": f"Лид-магнит «{lm['name']}»", "href": "/dashboard/lead-magnets",
         "hint": "Раздел «Лид-магниты». Квиз уже привязан: пока он не пройден, "
                 "подарок не выдаётся."},
    ]


async def _install_quiz_gift_landing(db, cid: int, slug: str) -> list[dict]:
    """Квиз на лендинге события: тот же квиз, но встроенный в страницу.

    ⚠️ Анкета на лендинг подставляется НЕ из блока, а из ФОРМЫ ЗАЯВКИ владельца
    (`request_forms`) — так решено, чтобы два места не задавали одно и то же и
    не разъезжались. Поэтому заводим и форму заявки, и блок показа.
    """
    sv = await _new_survey(db, cid, title=_named(slug, "Квиз за подарок"),
                           questions=QUIZ_QUESTIONS, intro=QUIZ_INTRO)
    lm = await _new_lead_magnet(
        db, cid,
        name=_named(slug, "Подборка за прохождение квиза"),
        description="Выдаётся после прохождения квиза на странице.",
        url="https://pluson.ru/",
        button_label="Забрать подборку",
        require_survey_id=sv["id"],
    )

    created = await _install_event(
        db, cid,
        title=_named(slug, "Страница с квизом"),
        description="Опишите, что человек получит за прохождение квиза. "
                    "Квиз встанет на страницу отдельным блоком.",
        evergreen=True, with_landing=True)

    # Форма заявки события: из неё лендинг берёт анкету для блока.
    ev_id = int(created[0]["href"].rsplit("/", 1)[-1])
    await db.execute(
        """INSERT INTO request_forms (owner_type, owner_id, client_id, survey_id,
                                      title, subtitle)
           VALUES ('event',$1,$2,$3,'Пройдите квиз',
                   'Ответьте на несколько вопросов — и заберите подборку')
           ON CONFLICT (owner_type, owner_id) DO NOTHING""",
        ev_id, cid, sv["id"])

    created.append(
        {"title": f"Анкета-квиз «{sv['title']}»", "href": "/dashboard/surveys",
         "hint": "Раздел «Анкеты» — вопросы и ответы. На страницу события квиз "
                 "подставляется из формы заявки: «Платежи/Заявки» → «Формы "
                 "заявки»."})
    created.append(
        {"title": f"Лид-магнит «{lm['name']}»", "href": "/dashboard/lead-magnets",
         "hint": "Раздел «Лид-магниты» — подарок за прохождение."})
    return created


# ─────────────────────── сегментация по анкете ───────────────────────────
async def _install_survey_segments(db, cid: int, slug: str) -> list[dict]:
    """Дашборд-сегментация базы по ответам анкеты.

    ⚠️⚠️ Разрез строится по ПОЛЮ КОНТАКТА «Уровень дохода», а не по вопросу
    конкретной анкеты. Вопрос живёт внутри одного заполнения, поле — на
    человеке: оно копится со всех анкет сразу и остаётся, даже если анкету
    удалят. Иначе сегментация показывала бы срез по одной анкете и рассыпалась
    бы при её удалении.

    ⚠️ Дашборд создаётся ПУСТЫМ по цифрам — они появятся, когда люди начнут
    отвечать. Это честнее, чем рисовать выдуманные проценты в рабочем кабинете.
    """
    income_id = await ensure_income_field(db, cid)

    dash = await db.fetchrow(
        """INSERT INTO analytics_dashboards (client_id, title, layout)
           VALUES ($1,$2,'cards') RETURNING id, title""",
        cid, _named(slug, "Сегментация базы"))

    # Разрез: полосками по всем вилкам дохода.
    # ⚠️ Колонка называется `source` (не `kind`) и принимает `field|question` —
    # у нас поле контакта, значит `field`, а `ref_id` — его id.
    await db.execute(
        """INSERT INTO analytics_cards
             (dashboard_id, title, source, ref_id, view, sort_order, filters)
           VALUES ($1,$2,'field',$3,'list',10,'{}'::jsonb)""",
        dash["id"], INCOME_FIELD_TITLE, income_id)

    return [
        {"title": f"Дашборд «{dash['title']}»",
         "href": "/dashboard/analytics?tab=dashboards",
         "hint": "«Аналитика» → «Дашборд». Цифры появятся, когда люди начнут "
                 "отвечать на анкеты: разрез идёт по полю контакта «Уровень "
                 "дохода». Клик по любой цифре покажет, кто эти люди."},
        {"title": f"Поле контакта «{INCOME_FIELD_TITLE}»",
         "href": "/dashboard/surveys?tab=fields",
         "hint": "Поле общее на кабинет: оно есть у всех контактов и "
                 "заполняется из любой анкеты, где этот вопрос задан."},
    ]


# ───────────────────────── офлайн-событие с картой ────────────────────────
OFFLINE_EVENT_TEXT = (
    "Пример офлайн-события. Впишите адрес во вкладке «Основное» — и на странице "
    "сам появится блок «Место проведения»: адрес, карта с меткой и кнопка "
    "«Построить маршрут». Карту рисует Яндекс, ключи и оплата не нужны.\n\n"
    "Замените название, дату, описание и афишу на свои."
)


async def _install_offline_event(db, cid: int, slug: str) -> list[dict]:
    return await _install_event(
        db, cid,
        title=_named(slug, "Офлайн-событие"),
        description=OFFLINE_EVENT_TEXT,
        evergreen=False, with_landing=True, offline=True)


# ⚠️ Ключ = slug решения из фронтового каталога. Расходиться им нельзя:
# кнопка «Установить мне» шлёт именно slug.
INSTALLERS = {
    "magnet-for-subscribe": _install_magnet_for_subscribe,
    "consult-support-link": _install_consult_support,
    "consult-survey-link": _install_consult_survey_link,
    "consult-survey-only": _install_consult_survey_only,
    "raffle-subscribe": _install_raffle_subscribe,
    "raffle-survey": _install_raffle_survey,
    "quiz-gift-form": _install_quiz_gift_form,
    "quiz-gift-landing": _install_quiz_gift_landing,
    "survey-segments": _install_survey_segments,
    "offline-event": _install_offline_event,
    "consult-event-miniapp": lambda db, cid, s: _install_event(
        db, cid, title=_named(s, "Консультация — запись открыта"),
        description=CONSULT_EVENT_TEXT, evergreen=True, with_landing=False),
    "consult-event-landing": lambda db, cid, s: _install_event(
        db, cid, title=_named(s, "Консультация — запись открыта"),
        description=CONSULT_EVENT_TEXT, evergreen=True, with_landing=True),
    "raffle-event-miniapp": lambda db, cid, s: _install_event(
        db, cid, title=_named(s, "Розыгрыш приза"),
        description="Опишите приз и условия. Замените афишу на свою.",
        evergreen=False, with_landing=False),
    "raffle-event-landing": lambda db, cid, s: _install_event(
        db, cid, title=_named(s, "Розыгрыш приза"),
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
        created = await fn(db, cid, slug)

    logger.info("solution %s installed for client %s", slug, cid)
    return InstallOut(ok=True, created=created)
