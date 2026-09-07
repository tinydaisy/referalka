"""
Анкеты для блока «Анкета» на лендинге (миграция 352).

Собирает содержимое анкет, выбранных в блоках страницы, — чтобы форма
рисовалась сразу с самой страницей, без второго запроса и без мигания пустой
секции.

⚠️⚠️ ОДНА ТОЧКА НА СОБЫТИЕ И ПРОДУКТ. Публичных лендингов два
(`event_landing_public` и `product_landing_public`), рендерер у них общий — и
собирать анкеты каждый по-своему нельзя: страницы разъедутся, как уже
разъезжались вычисляемые поля темы (у продукта их забыли, и лендинг выходил
белым).

⚠️ ОТДАЁМ ТОЛЬКО ВОПРОСЫ ПОСЕТИТЕЛЯ (`filled_by = 'visitor'`). Поля сотрудника
(«Обработано», заметки) на публичной странице показывать нельзя — это внутренняя
кухня обработки заявок. То же правило и в `surveys_public`, и по той же причине
там проверка стоит дважды: на выдаче и на приёме.

⚠️ ВАРИАНТЫ ОТВЕТА берём у вопроса, а если их там нет — У СВЯЗАННОГО ПОЛЯ
КОНТАКТА. Вопрос, добавленный кнопкой «Добавить поле контакта», своих вариантов
не хранит: они живут в самом поле. Без этого человек видел заголовок вопроса
без вариантов — выбрать было нечего, и анкету с обязательным вопросом нельзя
было отправить вовсе.
"""
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _jsonb(value: Any) -> Any:
    """asyncpg отдаёт JSONB СТРОКОЙ — без разворота фронт падает на `.map`,
    и список вариантов приходит пустым."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return []
    return value if value is not None else []


async def collect_landing_surveys(db, blocks, client_id: int,
                                  owner_type: str | None = None,
                                  owner_id: int | None = None) -> dict:
    """`{ "<block_id>": {анкета с вопросами} }` для блоков `kind='survey'`.

    Пустой словарь, если таких блоков нет или анкета не выбрана — рендерер
    тогда секцию не рисует.

    ⚠️⚠️ АНКЕТА БЕРЁТСЯ ИЗ «ФОРМЫ ЗАЯВКИ» ВЛАДЕЛЬЦА (миграция 363), а свой
    `survey_id` у блока больше не задаётся — выбор из конструктора убран
    07.09.2026. Два места, задающих одно и то же, разъезжались: клиент менял
    анкету в форме заявки, а на лендинге оставалась старая.
    Собственный `survey_id` блока оставлен как запасной вариант — у блоков,
    созданных до этой правки, он заполнен, и терять их нельзя.

    ⚠️ Ссылку на политику ПД кладём В КАЖДУЮ анкету, а не берём из подвала:
    подвал собирается, только когда блок подвала включён, — а клиент вправе
    его выключить. Форма сбора данных без ссылки на политику существовать не
    должна, поэтому она не может зависеть от чужой секции.
    """
    # Анкета формы заявки владельца — она главнее того, что осталось в блоке.
    form_survey_id = None
    form_title = None
    form_subtitle = None
    form_view = None
    if owner_type and owner_id:
        try:
            form_row = await db.fetchrow(
                """SELECT survey_id, title, subtitle, survey_view
                     FROM request_forms
                    WHERE owner_type = $1 AND owner_id = $2 AND is_active""",
                owner_type, owner_id)
            if form_row:
                form_survey_id = form_row["survey_id"]
                # ⚠️ Заголовок и подпись задаются В ФОРМЕ ЗАЯВКИ, а не в блоке
                # (07.09.2026): в конструкторе их полей больше нет.
                form_title = form_row["title"]
                form_subtitle = form_row["subtitle"]
                # Режим показа тоже задаётся в форме заявки (мигр. 364):
                # в блоке лендинга этой настройки больше нет.
                form_view = form_row["survey_view"]
        except Exception:
            form_survey_id = None   # таблицы ещё нет — работаем по-старому

    wanted = {
        b["id"]: (form_survey_id or b["survey_id"])
        for b in blocks
        if b["kind"] == "survey" and (form_survey_id or b["survey_id"])
    }
    if not wanted:
        return {}

    out: dict = {}
    # ⚠️ Сверяем client_id ещё и здесь, хотя он проверен при сохранении блока:
    # анкету могли перенести или удалить, а страница обязана в этом случае
    # промолчать, а не показать чужую форму.
    # ⚠️ Имена колонок сверены со схемой: «что после отправки» — это
    # `after_mode` ('thanks' | 'url') + `thanks_text` / `redirect_url`.
    # Полей `success_text`/`success_url` в `surveys` не существует.
    rows = await db.fetch(
        """SELECT id, slug, title, intro, submit_label, image_url,
                  after_mode, thanks_text, redirect_url, is_active
             FROM surveys
            WHERE id = ANY($1::int[]) AND client_id = $2""",
        list(set(wanted.values())), client_id,
    )
    by_id = {r["id"]: r for r in rows}
    if not by_id:
        return {}

    # Публичная страница политики появляется только после публикации версии.
    privacy_url = None
    ver = await db.fetchval(
        "SELECT privacy_policy_version FROM clients WHERE id = $1", client_id)
    if ver:
        privacy_url = f"/c/{client_id}/privacy"

    qs = await db.fetch(
        """SELECT q.survey_id, q.id, q.title, q.hint, q.kind,
                  CASE
                    WHEN q.options IS NULL
                      OR jsonb_typeof(q.options) <> 'array'
                      OR jsonb_array_length(q.options) = 0
                    THEN f.options
                    ELSE q.options
                  END AS options,
                  q.scale_min, q.scale_max, q.is_required, q.sort_order,
                  q.field_id, q.image_url
             FROM survey_questions q
             LEFT JOIN contact_fields f ON f.id = q.field_id
            WHERE q.survey_id = ANY($1::int[])
              AND q.filled_by = 'visitor'
            ORDER BY q.sort_order, q.id""",
        list(by_id.keys()),
    )
    q_by_survey: dict = {}
    for q in qs:
        d = dict(q)
        d.pop("survey_id", None)
        d["options"] = _jsonb(d.get("options"))
        q_by_survey.setdefault(q["survey_id"], []).append(d)

    for block_id, survey_id in wanted.items():
        s = by_id.get(survey_id)
        # ⚠️ Выключенную анкету (`is_active = FALSE`) не показываем: клиент
        # выключил её сознательно, и приём ответов на неё всё равно ответит
        # «Анкета не найдена» — форма выглядела бы рабочей, но не отправлялась.
        if not s or not s["is_active"]:
            continue
        questions = q_by_survey.get(survey_id, [])
        # Анкета без вопросов посетителя — пустая форма, показывать нечего.
        if not questions:
            continue
        out[str(block_id)] = {
            "id": s["id"], "slug": s["slug"], "title": s["title"],
            "intro": s["intro"], "submit_label": s["submit_label"],
            "image_url": s["image_url"],
            "after_mode": s["after_mode"],
            "thanks_text": s["thanks_text"], "redirect_url": s["redirect_url"],
            "privacy_url": privacy_url,
            "questions": questions,
            # Заголовок и подпись секции — из формы заявки; пусто → рендерер
            # возьмёт название самой анкеты.
            "form_title": form_title,
            "form_subtitle": form_subtitle,
            "form_view": form_view,
        }
    return out
