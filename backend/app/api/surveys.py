"""
Анкеты клиента + дополнительные поля контакта (миграция 280).

Зачем. Уход с GetCourse, где анкету нельзя было просто отправить: чтобы её
заполнили, приходилось собирать отдельную страницу с формой. Здесь анкета —
сразу готовая ссылка `pluson.ru/f/{slug}` (браузер + TG/VK/MAX), как у
лид-магнитов.

⚠️ Поле анкеты и дополнительное поле контакта — ОДНА сущность
(`contact_fields`). «Доход», «Ниша», «Статус» — постоянные свойства человека:
живут в карточке, по ним фильтруется база. Анкета их заполняет. Заводить один
и тот же список дважды клиенту не придётся.

⚠️ Анкета подарки НЕ выдаёт сама по себе. Выдача включается с другой стороны —
полем `lead_magnets.require_survey_id`. Порядок в воронке: подписка → анкета →
файл. Поэтому цикл «анкета выдаёт подарок, который требует эту же анкету»
невозможен by design.
"""
import re
import secrets
from typing import Any, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.assistant_access import assistant_is_restricted
from app.services.features import client_has_feature

router = APIRouter(tags=["Анкеты"])


async def _assert_feature(db, client_id: int) -> None:
    """Гейт раздела «Анкеты» — фича `surveys` (Экстра и админ).

    ⚠️ Ставится только на ЗАПИСЬ. Читать своё можно всегда: это данные
    клиента, отбирать у него собранные ответы при смене тарифа нельзя
    (общее правило проекта «смотреть можно, менять нельзя»).

    ⚠️ Публичная страница анкеты (`surveys_public`) не гейтится вовсе —
    человек, заполняющий анкету, не виноват в тарифе организатора.
    """
    if not await client_has_feature(db, client_id, "surveys"):
        raise HTTPException(
            status_code=403,
            detail="Раздел «Анкеты» доступен на тарифе Экстра.",
        )

_SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

# Файлов среди типов нет намеренно (решение владельца 2026-08-12).
KINDS = ('text', 'textarea', 'number', 'date', 'scale', 'select', 'multiselect', 'bool')
# Типы, у которых ответ выбирается из готовых вариантов — по ним считается
# разбивка «сколько процентов выбрали каждый вариант» (как в Google Forms).
CHOICE_KINDS = ('select', 'multiselect', 'bool')


async def _make_unique_survey_slug(db: asyncpg.Connection) -> str:
    """5-символьный код ссылки. Тот же алфавит, что у лид-магнитов —
    без визуально похожих символов (0/o, 1/l/i)."""
    while True:
        candidate = ''.join(secrets.choice(_SLUG_ALPHABET) for _ in range(5))
        exists = await db.fetchval("SELECT 1 FROM surveys WHERE slug = $1", candidate)
        if not exists:
            return candidate


def _code_from_title(title: str) -> str:
    """Машинное имя поля из названия. Только латиница/цифры — код уходит в
    выгрузки и фильтры, кириллица там мешает."""
    translit = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
        'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
        'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
        'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
        'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    }
    s = ''.join(translit.get(ch, ch) for ch in (title or '').strip().lower())
    s = re.sub(r'[^a-z0-9]+', '_', s).strip('_')
    return (s or 'field')[:40]


def _jsonb(value: Any) -> Any:
    """asyncpg отдаёт JSONB СТРОКОЙ. ⚠️ Без разворота фронт получает
    `options` строкой и не может отрисовать варианты ответа."""
    import json as _json
    if isinstance(value, str):
        try:
            return _json.loads(value)
        except Exception:
            return []
    return value if value is not None else []


def _norm_options(options: Any) -> list:
    """Варианты ответа — плоский список непустых строк."""
    if not isinstance(options, list):
        return []
    out = []
    for o in options:
        v = (str(o) if o is not None else '').strip()
        if v and v not in out:
            out.append(v)
    return out


# ──────────────────────────────────────────────────────────────────────────
#  Дополнительные поля контакта
# ──────────────────────────────────────────────────────────────────────────

class FieldIn(BaseModel):
    title: str
    code: Optional[str] = None
    kind: str = 'text'
    options: Optional[list] = None
    scale_min: Optional[int] = None
    scale_max: Optional[int] = None
    show_in_card: Optional[bool] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


@router.get("/contact-fields")
async def list_contact_fields(client=Depends(get_current_client), db=Depends(get_db)):
    """Поля контакта клиента + сколько людей их заполнили (для среза базы)."""
    rows = await db.fetch(
        """SELECT f.*,
                  (SELECT COUNT(*) FROM contact_field_values v
                    WHERE v.field_id = f.id AND COALESCE(v.value, '') <> '') AS filled_count
             FROM contact_fields f
            WHERE f.client_id = $1
            ORDER BY f.sort_order, f.id""",
        int(client["sub"]),
    )
    return [{**dict(r), "options": _jsonb(r["options"])} for r in rows]


@router.post("/contact-fields")
async def create_contact_field(
    data: FieldIn, client=Depends(get_current_client), db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    client_id = int(client["sub"])
    if data.kind not in KINDS:
        raise HTTPException(400, "Неизвестный тип поля")
    title = (data.title or '').strip()
    if not title:
        raise HTTPException(400, "Впишите название поля")

    base = (data.code or '').strip() or _code_from_title(title)
    code = base
    # Код уникален в пределах клиента — при совпадении дописываем номер.
    for i in range(2, 50):
        exists = await db.fetchval(
            "SELECT 1 FROM contact_fields WHERE client_id = $1 AND code = $2",
            client_id, code,
        )
        if not exists:
            break
        code = f"{base}_{i}"

    row = await db.fetchrow(
        """INSERT INTO contact_fields
             (client_id, code, title, kind, options, scale_min, scale_max,
              show_in_card, sort_order)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,
                   COALESCE($9, (SELECT COALESCE(MAX(sort_order),0)+1
                                   FROM contact_fields WHERE client_id=$1)))
        RETURNING *""",
        client_id, code, title, data.kind,
        __import__('json').dumps(_norm_options(data.options)),
        data.scale_min if data.kind == 'scale' else None,
        data.scale_max if data.kind == 'scale' else None,
        True if data.show_in_card is None else bool(data.show_in_card),
        data.sort_order,
    )
    return {**dict(row), "options": _jsonb(row["options"])}


@router.patch("/contact-fields/{field_id}")
async def update_contact_field(
    field_id: int, data: FieldIn,
    client=Depends(get_current_client), db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    client_id = int(client["sub"])
    own = await db.fetchval(
        "SELECT 1 FROM contact_fields WHERE id=$1 AND client_id=$2", field_id, client_id)
    if not own:
        raise HTTPException(404, "Поле не найдено")

    fs = data.model_fields_set
    sets, vals = [], []

    def add(col: str, val):
        vals.append(val)
        sets.append(f"{col} = ${len(vals)}")

    if 'title' in fs and (data.title or '').strip():
        add('title', data.title.strip())
    if 'kind' in fs:
        if data.kind not in KINDS:
            raise HTTPException(400, "Неизвестный тип поля")
        add('kind', data.kind)
    if 'options' in fs:
        vals.append(__import__('json').dumps(_norm_options(data.options)))
        sets.append(f"options = ${len(vals)}::jsonb")
    if 'scale_min' in fs:
        add('scale_min', data.scale_min)
    if 'scale_max' in fs:
        add('scale_max', data.scale_max)
    if 'show_in_card' in fs:
        add('show_in_card', bool(data.show_in_card))
    if 'sort_order' in fs:
        add('sort_order', data.sort_order)
    if 'is_active' in fs:
        add('is_active', bool(data.is_active))
    if not sets:
        raise HTTPException(400, "Нечего менять")

    vals.append(field_id)
    row = await db.fetchrow(
        f"UPDATE contact_fields SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(vals)} RETURNING *", *vals)
    return {**dict(row), "options": _jsonb(row["options"])}


@router.delete("/contact-fields/{field_id}")
async def delete_contact_field(
    field_id: int, client=Depends(get_current_client), db=Depends(get_db),
):
    """⚠️ Удаляет поле ВМЕСТЕ со значениями у всех контактов (CASCADE).
    Чтобы просто убрать поле из карточки — снимите «Показывать в карточке»."""
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    res = await db.execute(
        "DELETE FROM contact_fields WHERE id=$1 AND client_id=$2",
        field_id, int(client["sub"]))
    if res.endswith("0"):
        raise HTTPException(404, "Поле не найдено")
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────
#  Анкеты
# ──────────────────────────────────────────────────────────────────────────

class SurveyIn(BaseModel):
    # ⚠️ Название НЕобязательно, хотя при создании оно нужно.
    #
    # Модель одна на создание и на правку. Пока `title` был обязательным,
    # сохранение настроек анкеты (текст «спасибо», галочка «заполнять
    # повторно», обложка) отвечало 422 и НЕ РАБОТАЛО ВООБЩЕ: кнопка нажималась
    # и отжималась, а после перезагрузки страницы всё оставалось прежним —
    # фронт шлёт только изменённые поля, без названия.
    #
    # Обязательность при создании проверяется в самой ручке создания.
    title: Optional[str] = None
    intro: Optional[str] = None
    # Обложка анкеты — показывается ДО вопросов.
    image_url: Optional[str] = None
    submit_label: Optional[str] = None
    after_mode: Optional[str] = None
    thanks_text: Optional[str] = None
    redirect_url: Optional[str] = None
    allow_repeat: Optional[bool] = None
    is_active: Optional[bool] = None
    # Подарок, который анкета выдаёт после заполнения (миграция 283).
    gift_lead_magnet_id: Optional[int] = None
    gift_package_id: Optional[int] = None


class QuestionIn(BaseModel):
    title: str
    hint: Optional[str] = None
    # Своя картинка у каждого вопроса (пример, схема, вариант дизайна).
    image_url: Optional[str] = None
    kind: str = 'text'
    options: Optional[list] = None
    scale_min: Optional[int] = None
    scale_max: Optional[int] = None
    is_required: Optional[bool] = None
    sort_order: Optional[int] = None
    # Привязка к полю контакта: ответ ляжет в карточку человека.
    field_id: Optional[int] = None
    # Кто заполняет: 'visitor' — посетитель в анкете, 'staff' — основатель и
    # сотрудники при обработке заявки (посетитель такой вопрос не видит).
    filled_by: Optional[str] = None


async def _survey_links(db, client_id: int, slug: str) -> dict:
    """4 ссылки входа: прямая в браузер + по одной на каждую площадку,
    где у клиента подключён свой бот. Формат тот же, что у воронок
    лид-магнитов — `?to=tg|vk|max` разруливает редирект в нужный бот."""
    from app.services.client_domains import client_public_url
    base = (await client_public_url(db, client_id)).rstrip('/')
    web = f"{base}/f/{slug}"
    out = {"web": web}
    try:
        from app.services.share_links import get_active_platforms
        active = await get_active_platforms(db, client_id)
    except Exception:
        active = []
    for slug_p, key in (('telegram', 'telegram'), ('vk', 'vk'), ('max', 'max')):
        if slug_p in active:
            short = {'telegram': 'tg', 'vk': 'vk', 'max': 'max'}[slug_p]
            out[key] = f"{web}?to={short}"
    return out


@router.get("/surveys")
async def list_surveys(client=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT s.*,
                  (SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id = s.id)
                      AS questions_count,
                  (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id)
                      AS responses_count,
                  (SELECT COUNT(DISTINCT r.contact_id) FROM survey_responses r
                    WHERE r.survey_id = s.id) AS people_count
             FROM surveys s
            WHERE s.client_id = $1
            ORDER BY s.id DESC""",
        client_id,
    )
    out = []
    for r in rows:
        d = dict(r)
        d["links"] = await _survey_links(db, client_id, d["slug"])
        out.append(d)
    return out


@router.post("/surveys")
async def create_survey(
    data: SurveyIn, client=Depends(get_current_client), db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    client_id = int(client["sub"])
    title = (data.title or '').strip()
    if not title:
        raise HTTPException(400, "Впишите название анкеты")
    slug = await _make_unique_survey_slug(db)
    row = await db.fetchrow(
        """INSERT INTO surveys (client_id, slug, title, intro, submit_label,
                                after_mode, thanks_text, redirect_url, allow_repeat)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,'thanks'),$7,$8,COALESCE($9,FALSE))
        RETURNING *""",
        client_id, slug, title, data.intro, data.submit_label,
        data.after_mode, data.thanks_text, data.redirect_url, data.allow_repeat,
    )
    d = dict(row)
    d["links"] = await _survey_links(db, client_id, slug)
    return d


@router.get("/surveys/{survey_id}")
async def get_survey(
    survey_id: int, client=Depends(get_current_client), db=Depends(get_db),
):
    client_id = int(client["sub"])
    s = await db.fetchrow(
        "SELECT * FROM surveys WHERE id=$1 AND client_id=$2", survey_id, client_id)
    if not s:
        raise HTTPException(404, "Анкета не найдена")
    qs = await db.fetch(
        """SELECT q.*, f.title AS field_title, f.code AS field_code
             FROM survey_questions q
             LEFT JOIN contact_fields f ON f.id = q.field_id
            WHERE q.survey_id = $1
            ORDER BY q.sort_order, q.id""",
        survey_id,
    )
    d = dict(s)
    d["questions"] = [{**dict(q), "options": _jsonb(q["options"])} for q in qs]
    d["links"] = await _survey_links(db, client_id, d["slug"])
    return d


@router.patch("/surveys/{survey_id}")
async def update_survey(
    survey_id: int, data: SurveyIn,
    client=Depends(get_current_client), db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    own = await db.fetchval(
        "SELECT 1 FROM surveys WHERE id=$1 AND client_id=$2",
        survey_id, int(client["sub"]))
    if not own:
        raise HTTPException(404, "Анкета не найдена")

    fs = data.model_fields_set
    sets, vals = [], []

    def add(col, val):
        vals.append(val)
        sets.append(f"{col} = ${len(vals)}")

    if 'title' in fs and (data.title or '').strip():
        add('title', data.title.strip())
    # ⚠️ Пустая строка — осмысленная очистка (текст «спасибо» убрали).
    for col in ('intro', 'submit_label', 'thanks_text', 'redirect_url', 'image_url'):
        if col in fs:
            add(col, getattr(data, col))
    if 'after_mode' in fs:
        if data.after_mode not in ('thanks', 'url'):
            raise HTTPException(400, "Неизвестное действие после заполнения")
        add('after_mode', data.after_mode)
    for col in ('gift_lead_magnet_id', 'gift_package_id'):
        if col in fs:
            val = getattr(data, col)
            # ⚠️ Защита от цикла: подарок, который сам требует ЭТУ анкету,
            # назначать нельзя — человек ходил бы по кругу.
            if val and col == 'gift_lead_magnet_id':
                loop = await db.fetchval(
                    "SELECT 1 FROM lead_magnets WHERE id=$1 AND require_survey_id=$2",
                    val, survey_id)
                if loop:
                    raise HTTPException(
                        400,
                        "Этот подарок уже требует заполнить эту же анкету — "
                        "получилось бы хождение по кругу. Снимите у него "
                        "настройку «Сначала анкета».")
            add(col, val)

    if 'allow_repeat' in fs:
        add('allow_repeat', bool(data.allow_repeat))
    if 'is_active' in fs:
        add('is_active', bool(data.is_active))
    if not sets:
        raise HTTPException(400, "Нечего менять")

    vals.append(survey_id)
    row = await db.fetchrow(
        f"UPDATE surveys SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(vals)} RETURNING *", *vals)
    return dict(row)


@router.delete("/surveys/{survey_id}")
async def delete_survey(
    survey_id: int, client=Depends(get_current_client), db=Depends(get_db),
):
    """⚠️ Удаляет анкету вместе со всеми ответами (CASCADE). Чтобы просто
    перестать её показывать — снимите «Активна»."""
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    res = await db.execute(
        "DELETE FROM surveys WHERE id=$1 AND client_id=$2",
        survey_id, int(client["sub"]))
    if res.endswith("0"):
        raise HTTPException(404, "Анкета не найдена")
    return {"ok": True}


# ── Вопросы ───────────────────────────────────────────────────────────────

async def _assert_own_survey(db, survey_id: int, client_id: int):
    own = await db.fetchval(
        "SELECT 1 FROM surveys WHERE id=$1 AND client_id=$2", survey_id, client_id)
    if not own:
        raise HTTPException(404, "Анкета не найдена")


@router.post("/surveys/{survey_id}/questions")
async def add_question(
    survey_id: int, data: QuestionIn,
    client=Depends(get_current_client), db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    client_id = int(client["sub"])
    await _assert_own_survey(db, survey_id, client_id)
    if data.kind not in KINDS:
        raise HTTPException(400, "Неизвестный тип вопроса")
    title = (data.title or '').strip()
    if not title:
        raise HTTPException(400, "Впишите текст вопроса")

    # ⚠️ Поле сотрудника с полем контакта не связывается. Поле контакта — одно
    # значение на человека, а обрабатывают КАЖДУЮ заявку отдельно: у человека
    # с двумя заявками отметки должны быть независимыми.
    filled_by = 'staff' if data.filled_by == 'staff' else 'visitor'
    field_id = None if filled_by == 'staff' else data.field_id

    # Вопрос привязан к полю контакта → тип и варианты берём у поля, чтобы
    # ответ гарантированно лёг в карточку и совпал с уже накопленными.
    kind, options = data.kind, _norm_options(data.options)
    scale_min, scale_max = data.scale_min, data.scale_max
    if field_id:
        f = await db.fetchrow(
            "SELECT * FROM contact_fields WHERE id=$1 AND client_id=$2",
            field_id, client_id)
        if not f:
            raise HTTPException(404, "Поле контакта не найдено")
        kind = f["kind"]
        options = f["options"] if isinstance(f["options"], list) else _norm_options(f["options"])
        scale_min, scale_max = f["scale_min"], f["scale_max"]

    import json as _json
    # Порядок считаем внутри своей группы: поля сотрудника живут за отметкой
    # 10000, чтобы не перемешиваться с вопросами посетителя при перетаскивании.
    base_order = 10000 if filled_by == 'staff' else 0
    row = await db.fetchrow(
        """INSERT INTO survey_questions
             (survey_id, field_id, title, hint, kind, options,
              scale_min, scale_max, is_required, sort_order, image_url,
              filled_by)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,COALESCE($9,FALSE),
                   COALESCE($10,(SELECT COALESCE(MAX(sort_order),$12)+10
                                   FROM survey_questions
                                  WHERE survey_id=$1 AND filled_by=$13)),
                   $11, $13)
        RETURNING *""",
        survey_id, field_id, title, data.hint, kind,
        _json.dumps(options if isinstance(options, list) else []),
        scale_min if kind == 'scale' else None,
        scale_max if kind == 'scale' else None,
        data.is_required, data.sort_order, data.image_url,
        base_order, filled_by,
    )
    return {**dict(row), "options": _jsonb(row["options"])}


@router.patch("/surveys/{survey_id}/questions/{question_id}")
async def update_question(
    survey_id: int, question_id: int, data: QuestionIn,
    client=Depends(get_current_client), db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    await _assert_own_survey(db, survey_id, int(client["sub"]))

    cur = await db.fetchrow(
        "SELECT filled_by, is_protected FROM survey_questions "
        "WHERE id=$1 AND survey_id=$2", question_id, survey_id)
    if not cur:
        raise HTTPException(404, "Вопрос не найден")

    fs = data.model_fields_set
    sets, vals = [], []

    def add(col, val):
        vals.append(val)
        sets.append(f"{col} = ${len(vals)}")

    if 'title' in fs and (data.title or '').strip():
        add('title', data.title.strip())
    if 'hint' in fs:
        add('hint', data.hint)
    if 'image_url' in fs:
        add('image_url', data.image_url)
    if 'kind' in fs:
        if data.kind not in KINDS:
            raise HTTPException(400, "Неизвестный тип вопроса")
        add('kind', data.kind)
    if 'options' in fs:
        vals.append(__import__('json').dumps(_norm_options(data.options)))
        sets.append(f"options = ${len(vals)}::jsonb")
    if 'scale_min' in fs:
        add('scale_min', data.scale_min)
    if 'scale_max' in fs:
        add('scale_max', data.scale_max)
    if 'is_required' in fs:
        add('is_required', bool(data.is_required))
    if 'sort_order' in fs:
        add('sort_order', data.sort_order)
    if 'field_id' in fs:
        # Поле сотрудника с полем контакта не связывается — см. add_question.
        add('field_id', None if cur["filled_by"] == 'staff' else data.field_id)
    if 'filled_by' in fs and data.filled_by in ('visitor', 'staff'):
        # ⚠️ Защищённое поле переключить в вопрос посетителя нельзя: иначе
        # «Обработано» уехало бы в публичную анкету, и её заполняли бы люди.
        if cur["is_protected"] and data.filled_by != 'staff':
            raise HTTPException(
                400, "Поле «Обработано» заполняете вы и ваши сотрудники — "
                     "посетителю его показать нельзя.")
        add('filled_by', data.filled_by)
    if not sets:
        raise HTTPException(400, "Нечего менять")

    vals.extend([question_id, survey_id])
    row = await db.fetchrow(
        f"UPDATE survey_questions SET {', '.join(sets)} "
        f"WHERE id = ${len(vals)-1} AND survey_id = ${len(vals)} RETURNING *", *vals)
    if not row:
        raise HTTPException(404, "Вопрос не найден")
    return {**dict(row), "options": _jsonb(row["options"])}


@router.post("/surveys/{survey_id}/questions/reorder")
async def reorder_questions(
    survey_id: int, data: dict,
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Новый порядок вопросов — список id в нужной последовательности.

    ⚠️ Пишем одной транзакцией: наполовину переставленный порядок хуже, чем
    непереставленный. Чужие id молча игнорируются — фильтр по survey_id.
    """
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    await _assert_own_survey(db, survey_id, int(client["sub"]))
    ids = data.get("ids") or []
    if not isinstance(ids, list):
        raise HTTPException(400, "Ожидается список ids")

    # ⚠️ Порядок считаем ВНУТРИ группы, а не сквозным 1,2,3: поля сотрудника
    # живут за отметкой 10000, и сквозная нумерация перемешала бы их с
    # вопросами посетителя. Список приходит по одной группе за раз.
    kinds = {
        r["id"]: r["filled_by"] for r in await db.fetch(
            "SELECT id, filled_by FROM survey_questions WHERE survey_id=$1", survey_id)
    }
    async with db.transaction():
        pos = {'visitor': 0, 'staff': 10000}
        for qid in ids:
            try:
                qid = int(qid)
            except (TypeError, ValueError):
                continue
            grp = kinds.get(qid)
            if grp is None:
                continue
            pos[grp] += 10
            await db.execute(
                "UPDATE survey_questions SET sort_order=$1 WHERE id=$2 AND survey_id=$3",
                pos[grp], qid, survey_id)
    return {"ok": True}


@router.delete("/surveys/{survey_id}/questions/{question_id}")
async def delete_question(
    survey_id: int, question_id: int,
    client=Depends(get_current_client), db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Этот раздел доступен только владельцу кабинета.")
    await _assert_feature(db, int(client["sub"]))
    await _assert_own_survey(db, survey_id, int(client["sub"]))

    # ⚠️ «Обработано» удалить нельзя: на неё опирается разбор заявок — по ней
    # красится строка в таблице и строится дашборд анкеты. Проверка по флагу,
    # а не по названию: клиент вправе переписать заголовок под свой процесс,
    # и после переименования защита не должна отваливаться.
    q = await db.fetchrow(
        "SELECT is_protected FROM survey_questions WHERE id=$1 AND survey_id=$2",
        question_id, survey_id)
    if not q:
        raise HTTPException(404, "Вопрос не найден")
    if q["is_protected"]:
        raise HTTPException(
            400, "Поле «Обработано» удалить нельзя — по нему ведётся разбор "
                 "заявок. Его можно переименовать.")

    await db.execute(
        "DELETE FROM survey_questions WHERE id=$1 AND survey_id=$2",
        question_id, survey_id)
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────
#  Аналитика — как в Google Forms: проценты И абсолютные числа
# ──────────────────────────────────────────────────────────────────────────

# ⚠️ В аналитике считаем ТОЛЬКО ПОСЛЕДНЕЕ заполнение каждого человека.
# Анкету с разрешённым повтором (`allow_repeat`) один и тот же человек
# проходит несколько раз — и в отчёте он учитывался бы дважды, перекашивая
# проценты: «60% выбрали А» могло означать, что один человек ответил трижды.
# Берём свежий ответ, прошлые остаются в истории заполнений.
#
# Анонимные заполнения (contact_id IS NULL) не схлопываем — там непонятно,
# один это человек или разные, и объединять их было бы догадкой.
_LATEST_RESPONSES = """
    SELECT DISTINCT ON (COALESCE(r.contact_id::text, 'anon:'||r.id::text))
           r.id
      FROM survey_responses r
     WHERE r.survey_id = $1
     ORDER BY COALESCE(r.contact_id::text, 'anon:'||r.id::text), r.id DESC
"""


@router.get("/surveys/{survey_id}/analytics")
async def survey_analytics(
    survey_id: int, client=Depends(get_current_client), db=Depends(get_db),
):
    """Сводка по каждому вопросу.

    Для выбора из списка — разбивка по вариантам (сколько человек и процент).
    Для шкалы — средний балл и распределение по значениям.
    Для текста — последние ответы списком (считать там нечего).

    ⚠️ Процент считается от числа ОТВЕТИВШИХ на этот вопрос, а не от всех
    заполнивших анкету: необязательный вопрос могли пропустить, и от общего
    числа проценты не сошлись бы в 100.
    """
    client_id = int(client["sub"])
    await _assert_own_survey(db, survey_id, client_id)

    # «Всего заполнений» — ВСЕ отправки, включая повторные: клиенту важно
    # видеть, сколько раз анкету заполняли. А проценты ниже считаются уже по
    # последним ответам, иначе один человек с тремя заходами перекашивал бы их.
    total = await db.fetchval(
        "SELECT COUNT(*) FROM survey_responses WHERE survey_id=$1", survey_id) or 0
    people = await db.fetchval(
        "SELECT COUNT(DISTINCT contact_id) FROM survey_responses WHERE survey_id=$1",
        survey_id) or 0

    qs = await db.fetch(
        "SELECT * FROM survey_questions WHERE survey_id=$1 ORDER BY sort_order, id",
        survey_id)

    out = []
    for q in qs:
        item = {
            "id": q["id"], "title": q["title"], "kind": q["kind"],
            "options": _jsonb(q["options"]), "answers_count": 0,
        }
        answered = await db.fetchval(
            f"""SELECT COUNT(*) FROM survey_answers a
                 WHERE a.question_id = $2 AND COALESCE(a.value,'') <> ''
                   AND a.response_id IN ({_LATEST_RESPONSES})""",
            survey_id, q["id"]) or 0
        item["answers_count"] = answered

        if q["kind"] in CHOICE_KINDS:
            # multiselect: один ответ = несколько вариантов, разворачиваем.
            rows = await db.fetch(
                f"""SELECT val AS option, COUNT(*) AS cnt
                      FROM survey_answers a
                      CROSS JOIN LATERAL (
                        SELECT CASE
                          WHEN jsonb_typeof(a.value_json) = 'array'
                            THEN jsonb_array_elements_text(a.value_json)
                          ELSE a.value
                        END AS val
                      ) x
                     WHERE a.question_id = $2 AND COALESCE(val,'') <> ''
                       AND a.response_id IN ({_LATEST_RESPONSES})
                     GROUP BY val ORDER BY cnt DESC""",
                survey_id, q["id"])
            item["breakdown"] = [
                {
                    "option": r["option"],
                    "count": r["cnt"],
                    "percent": round(r["cnt"] * 100.0 / answered, 1) if answered else 0.0,
                }
                for r in rows
            ]
        elif q["kind"] in ('scale', 'number'):
            agg = await db.fetchrow(
                f"""SELECT AVG(v)::numeric(10,2) AS avg, MIN(v) AS min, MAX(v) AS max
                      FROM (SELECT NULLIF(regexp_replace(value,'[^0-9.-]','','g'),'')::numeric AS v
                              FROM survey_answers
                             WHERE question_id=$2
                               AND value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                               AND response_id IN ({_LATEST_RESPONSES})) t""",
                survey_id, q["id"])
            item["avg"] = float(agg["avg"]) if agg and agg["avg"] is not None else None
            item["min"] = float(agg["min"]) if agg and agg["min"] is not None else None
            item["max"] = float(agg["max"]) if agg and agg["max"] is not None else None
            rows = await db.fetch(
                f"""SELECT value AS option, COUNT(*) AS cnt
                      FROM survey_answers
                     WHERE question_id=$2 AND COALESCE(value,'') <> ''
                       AND response_id IN ({_LATEST_RESPONSES})
                     GROUP BY value
                     ORDER BY NULLIF(regexp_replace(value,'[^0-9.-]','','g'),'')::numeric""",
                survey_id, q["id"])
            item["breakdown"] = [
                {
                    "option": r["option"], "count": r["cnt"],
                    "percent": round(r["cnt"] * 100.0 / answered, 1) if answered else 0.0,
                }
                for r in rows
            ]
        else:
            rows = await db.fetch(
                f"""SELECT a.value, r.created_at, c.name, c.id AS contact_id
                      FROM survey_answers a
                      JOIN survey_responses r ON r.id = a.response_id
                      JOIN contacts c ON c.id = r.contact_id
                     WHERE a.question_id=$2 AND COALESCE(a.value,'') <> ''
                       AND a.response_id IN ({_LATEST_RESPONSES})
                     ORDER BY r.created_at DESC LIMIT 200""",
                survey_id, q["id"])
            item["texts"] = [dict(r) for r in rows]
        out.append(item)

    return {"responses_total": total, "people_total": people, "questions": out}




@router.delete("/surveys/{survey_id}/responses/{response_id}")
async def delete_response(
    survey_id: int, response_id: int,
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Удалить одно заполнение анкеты.

    Нужно, чтобы убрать из отчёта тестовые прогоны и явный мусор: иначе они
    навсегда искажают проценты, а перезаполнить анкету «правильно» нельзя.

    ⚠️ Удаляется только ЗАПОЛНЕНИЕ. Контакт человека, его участия в событиях
    и значения полей контакта остаются: анкета их наполнила, и терять данные
    из-за удаления одной строки отчёта неправильно. Сами ответы на вопросы
    (`survey_answers`) уходят каскадом — они принадлежат заполнению.

    ⚠️ Ассистенту с ограниченными правами — 403: это безвозвратное удаление
    собранных данных.
    """
    from app.services.assistant_access import assistant_is_restricted
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Ассистент не может удалять ответы анкет")

    client_id = int(client["sub"])
    await _assert_own_survey(db, survey_id, client_id)

    deleted = await db.fetchval(
        "DELETE FROM survey_responses WHERE id = $1 AND survey_id = $2 RETURNING id",
        response_id, survey_id,
    )
    if not deleted:
        raise HTTPException(404, "Ответ не найден")
    return {"ok": True, "deleted": deleted}


@router.get("/surveys/{survey_id}/responses/{response_id}")
async def get_response(
    survey_id: int, response_id: int,
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Одно заполнение целиком — для страницы ответа конкретного человека."""
    client_id = int(client["sub"])
    await _assert_own_survey(db, survey_id, client_id)

    r = await db.fetchrow(
        """SELECT r.id, r.created_at, r.platform_slug, r.contact_id,
                  c.name, c.phone,
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
             FROM survey_responses r
             JOIN contacts c ON c.id = r.contact_id
            WHERE r.id = $1 AND r.survey_id = $2""",
        response_id, survey_id)
    if not r:
        raise HTTPException(404, "Заполнение не найдено")

    # Все вопросы анкеты, чтобы показать и те, на которые не ответили:
    # пустой ответ — тоже информация.
    # ⚠️ Вопрос могли добавить в анкету ПОСЛЕ того, как человек её заполнил
    # (так и было у клиента: поля «Доход», «Статус» привязали позже). Ответа
    # в `survey_answers` тогда нет, но значение поля в карточке есть — берём
    # его и помечаем `from_field`, иначе страница пишет «не ответил» там, где
    # в карточке значение прекрасно видно.
    rows = await db.fetch(
        """SELECT q.id, q.title, q.kind, q.sort_order, q.options,
                  q.filled_by, q.is_protected,
                  COALESCE(a.value, v.value) AS value,
                  (a.value IS NULL AND v.value IS NOT NULL) AS from_field
             FROM survey_questions q
             LEFT JOIN survey_answers a
                    ON a.question_id = q.id AND a.response_id = $1
             LEFT JOIN contact_field_values v
                    ON v.field_id = q.field_id AND v.contact_id = $3
            WHERE q.survey_id = $2
            ORDER BY q.sort_order, q.id""",
        response_id, survey_id, r["contact_id"])

    survey = await db.fetchrow(
        "SELECT id, title FROM surveys WHERE id = $1", survey_id)

    # ⚠️ Дополнительные поля контакта — ОТДЕЛЬНЫМ блоком, а не вперемешку с
    # ответами (решение владельца): ответ на анкету — что человек сказал
    # ОДИН раз, поле — его текущее свойство, которое могло измениться позже.
    fields = await db.fetch(
        """SELECT f.id, f.title, f.kind, v.value, v.updated_at
             FROM contact_fields f
             LEFT JOIN contact_field_values v
                    ON v.field_id = f.id AND v.contact_id = $1
            WHERE f.client_id = $2 AND f.is_active = TRUE
            ORDER BY f.sort_order, f.id""",
        r["contact_id"], client_id)

    return {
        **dict(r),
        "survey": dict(survey) if survey else None,
        # ⚠️ options разворачиваем: asyncpg отдаёт JSONB СТРОКОЙ, и без этого
        # выпадающий список у поля сотрудника не отрисуется (та же засада,
        # что с вариантами вопросов).
        "answers": [{**dict(x), "options": _jsonb(x["options"])} for x in rows],
        "contact_fields": [dict(x) for x in fields],
    }


@router.get("/surveys/{survey_id}/responses")
async def list_responses(
    survey_id: int,
    sort: str = "created_at",
    dir: str = "desc",
    q: str = "",
    processed: str = "all",
    filters: str = "",
    limit: int = 500,
    offset: int = 0,
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Таблица заявок: кто заполнил, что ответил, что отметил сотрудник.

    Сортировка — по любому столбцу (клик по заголовку), по умолчанию свежие
    сверху. Фильтры — тем же конструктором условий, что в дашбордах: люди
    одни и те же, и два разных языка отбора клиента бы запутали.
    """
    client_id = int(client["sub"])
    await _assert_own_survey(db, survey_id, client_id)

    # Поле «Обработано» — по нему красится строка и фильтруется список.
    flag = await db.fetchrow(
        "SELECT id FROM survey_questions "
        "WHERE survey_id=$1 AND filled_by='staff' AND is_protected LIMIT 1",
        survey_id)
    flag_id = flag["id"] if flag else None

    params: list = [survey_id]
    where = ["r.survey_id = $1"]

    # Поиск по человеку: имя, почта, телефон, ники площадок.
    if (q or "").strip():
        params.append(f"%{q.strip()}%")
        n = len(params)
        where.append(
            f"""(c.name ILIKE ${n} OR c.phone ILIKE ${n}
                 OR EXISTS (SELECT 1 FROM platform_users pu
                             WHERE pu.contact_id = c.id
                               AND (pu.platform_user_id ILIKE ${n}
                                    OR pu.username ILIKE ${n})))""")

    # «Обработано / не обработано» — самый частый отбор, поэтому отдельно
    # от конструктора условий: ради него не надо собирать дерево.
    if flag_id and processed in ("yes", "no"):
        params.append(flag_id)
        n = len(params)
        exists = (f"EXISTS (SELECT 1 FROM survey_answers sa WHERE sa.response_id = r.id "
                  f"AND sa.question_id = ${n} AND sa.value = 'Да')")
        where.append(exists if processed == "yes" else f"NOT {exists}")

    # Конструктор условий из дашбордов — работает по контакту.
    if (filters or "").strip():
        from app.services.analytics_cards import build_filters_sql, _Params
        import json as _json
        try:
            tree = _json.loads(filters)
        except ValueError:
            tree = None
        if tree:
            # ⚠️ _Params копирует список, поэтому параметры забираем обратно —
            # иначе добавленные им значения потеряются и номера $N разъедутся.
            p = _Params(params)
            cond = build_filters_sql(tree, p)
            if cond != "TRUE":
                where.append(cond)
                params = p.values

    # ⚠️ Сортировка — только по разрешённому списку: имя столбца подставляется
    # в SQL, и принимать его от браузера как есть нельзя.
    sort_map = {
        "created_at": "r.created_at",
        "name": "c.name",
        "phone": "c.phone",
        "email": "email",
        "processed": "processed",
    }
    order_col = sort_map.get(sort)
    if order_col is None and sort.startswith("q:"):
        # Сортировка по ответу на конкретный вопрос.
        try:
            qid = int(sort[2:])
        except ValueError:
            qid = 0
        if qid:
            params.append(qid)
            order_col = (f"(SELECT sa.value FROM survey_answers sa "
                         f"WHERE sa.response_id = r.id AND sa.question_id = ${len(params)})")
    order_col = order_col or "r.created_at"
    order_dir = "ASC" if (dir or "").lower() == "asc" else "DESC"

    limit = max(1, min(int(limit or 500), 2000))
    offset = max(0, int(offset or 0))
    params.extend([limit, offset])
    lim_n, off_n = len(params) - 1, len(params)

    rows = await db.fetch(
        """SELECT r.id, r.created_at, r.platform_slug, r.contact_id,
                  c.name, c.phone,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug='email'
                    LIMIT 1) AS email,
                  -- Ники площадок: организатору нужно написать человеку, а
                  -- контакт у каждого свой — у кого-то только Telegram.
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
                    LIMIT 1) AS max_nick,
                  COALESCE(json_agg(json_build_object(
                      'question_id', a.question_id, 'value', a.value
                  ) ORDER BY a.question_id) FILTER (WHERE a.id IS NOT NULL), '[]') AS answers,
                  """ + (
                      f"EXISTS (SELECT 1 FROM survey_answers sa "
                      f"WHERE sa.response_id = r.id AND sa.question_id = {int(flag_id)} "
                      f"AND sa.value = 'Да')" if flag_id else "FALSE"
                  ) + """ AS processed
             FROM survey_responses r
             JOIN contacts c ON c.id = r.contact_id
             LEFT JOIN survey_answers a ON a.response_id = r.id
            WHERE """ + " AND ".join(where) + f"""
            GROUP BY r.id, c.id
            ORDER BY {order_col} {order_dir} NULLS LAST, r.id DESC
            LIMIT ${lim_n} OFFSET ${off_n}""",
        *params)

    total = await db.fetchval(
        "SELECT COUNT(*) FROM survey_responses r JOIN contacts c ON c.id = r.contact_id "
        "WHERE " + " AND ".join(where), *params[:-2])

    # ⚠️ json_agg приходит СТРОКОЙ — без разворота фронт не может пройтись по
    # ответам (та же засада, что с `options`).
    return {
        "responses": [{**dict(r), "answers": _jsonb(r["answers"])} for r in rows],
        "total": total,
    }


@router.put("/surveys/{survey_id}/responses/{response_id}/staff-answers")
async def save_staff_answers(
    survey_id: int, response_id: int, data: dict,
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Отметки сотрудника по заявке: галочка «Обработано», заметка и прочее.

    Правится из ДВУХ мест — прямо в таблице и в карточке заявки; эндпоинт
    один, чтобы поведение в них не разъехалось.

    ⚠️ Ответ сотрудника ложится в ту же `survey_answers`, что и ответ
    посетителя: поле сотрудника — это обычный вопрос анкеты, просто с другим
    заполняющим. Отдельного хранилища нет, поэтому дашборды и выгрузка видят
    эти отметки наравне с остальными ответами, без единой строчки правок.
    """
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    await _assert_own_survey(db, survey_id, client_id)

    # Помощнику с ограниченными правами обработка заявок РАЗРЕШЕНА: ради неё
    # его и заводят. Закрыто у него другое — правка самих анкет и вопросов.
    r = await db.fetchrow(
        "SELECT id FROM survey_responses WHERE id=$1 AND survey_id=$2",
        response_id, survey_id)
    if not r:
        raise HTTPException(404, "Заявка не найдена")

    answers = data.get("answers") or {}
    if not isinstance(answers, dict):
        raise HTTPException(400, "Ожидается объект с ответами")

    # ⚠️ Писать можно ТОЛЬКО в поля сотрудника этой анкеты: иначе через эту
    # ручку правились бы ответы посетителя, и было бы не разобрать, что
    # человек написал сам, а что дописали за него.
    allowed = {
        q["id"]: q for q in await db.fetch(
            "SELECT id, kind FROM survey_questions "
            "WHERE survey_id=$1 AND filled_by='staff'", survey_id)
    }

    # Общий хелпер с публичной анкетой — второй реализации быть не должно,
    # иначе «Да»/«Нет» в кабинете и в анкете начнут писаться по-разному.
    from app.api.surveys_public import _answer_to_text

    import json as _json
    saved = 0
    for qid, raw in answers.items():
        try:
            q = allowed[int(qid)]
        except (ValueError, KeyError):
            continue
        text = _answer_to_text(raw, q["kind"])
        if text:
            await db.execute(
                """INSERT INTO survey_answers (response_id, question_id, value, value_json)
                   VALUES ($1,$2,$3,$4::jsonb)
                   ON CONFLICT (response_id, question_id)
                   DO UPDATE SET value = EXCLUDED.value,
                                 value_json = EXCLUDED.value_json""",
                response_id, q["id"], text, _json.dumps(raw))
        else:
            # Пустое значение — это снятая галочка или стёртая заметка.
            # Пустую строку не храним: тогда «не отвечено» и «ответили пусто»
            # считались бы разным, и дашборд врал бы.
            await db.execute(
                "DELETE FROM survey_answers WHERE response_id=$1 AND question_id=$2",
                response_id, q["id"])
        saved += 1

    return {"ok": True, "saved": saved}
