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
    title: str
    intro: Optional[str] = None
    # Обложка анкеты — показывается ДО вопросов.
    image_url: Optional[str] = None
    submit_label: Optional[str] = None
    after_mode: Optional[str] = None
    thanks_text: Optional[str] = None
    redirect_url: Optional[str] = None
    allow_repeat: Optional[bool] = None
    is_active: Optional[bool] = None


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

    # Вопрос привязан к полю контакта → тип и варианты берём у поля, чтобы
    # ответ гарантированно лёг в карточку и совпал с уже накопленными.
    kind, options = data.kind, _norm_options(data.options)
    scale_min, scale_max = data.scale_min, data.scale_max
    if data.field_id:
        f = await db.fetchrow(
            "SELECT * FROM contact_fields WHERE id=$1 AND client_id=$2",
            data.field_id, client_id)
        if not f:
            raise HTTPException(404, "Поле контакта не найдено")
        kind = f["kind"]
        options = f["options"] if isinstance(f["options"], list) else _norm_options(f["options"])
        scale_min, scale_max = f["scale_min"], f["scale_max"]

    import json as _json
    row = await db.fetchrow(
        """INSERT INTO survey_questions
             (survey_id, field_id, title, hint, kind, options,
              scale_min, scale_max, is_required, sort_order, image_url)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,COALESCE($9,FALSE),
                   COALESCE($10,(SELECT COALESCE(MAX(sort_order),0)+1
                                   FROM survey_questions WHERE survey_id=$1)),
                   $11)
        RETURNING *""",
        survey_id, data.field_id, title, data.hint, kind,
        _json.dumps(options if isinstance(options, list) else []),
        scale_min if kind == 'scale' else None,
        scale_max if kind == 'scale' else None,
        data.is_required, data.sort_order, data.image_url,
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
        add('field_id', data.field_id)
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
    async with db.transaction():
        for pos, qid in enumerate(ids, start=1):
            try:
                qid = int(qid)
            except (TypeError, ValueError):
                continue
            await db.execute(
                "UPDATE survey_questions SET sort_order=$1 WHERE id=$2 AND survey_id=$3",
                pos, qid, survey_id)
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
    res = await db.execute(
        "DELETE FROM survey_questions WHERE id=$1 AND survey_id=$2",
        question_id, survey_id)
    if res.endswith("0"):
        raise HTTPException(404, "Вопрос не найден")
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────
#  Аналитика — как в Google Forms: проценты И абсолютные числа
# ──────────────────────────────────────────────────────────────────────────

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
            """SELECT COUNT(*) FROM survey_answers a
                JOIN survey_responses r ON r.id = a.response_id
               WHERE a.question_id = $1 AND COALESCE(a.value,'') <> ''""",
            q["id"]) or 0
        item["answers_count"] = answered

        if q["kind"] in CHOICE_KINDS:
            # multiselect: один ответ = несколько вариантов, разворачиваем.
            rows = await db.fetch(
                """SELECT val AS option, COUNT(*) AS cnt
                     FROM survey_answers a
                     CROSS JOIN LATERAL (
                       SELECT CASE
                         WHEN jsonb_typeof(a.value_json) = 'array'
                           THEN jsonb_array_elements_text(a.value_json)
                         ELSE a.value
                       END AS val
                     ) x
                    WHERE a.question_id = $1 AND COALESCE(val,'') <> ''
                    GROUP BY val ORDER BY cnt DESC""",
                q["id"])
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
                """SELECT AVG(v)::numeric(10,2) AS avg, MIN(v) AS min, MAX(v) AS max
                     FROM (SELECT NULLIF(regexp_replace(value,'[^0-9.-]','','g'),'')::numeric AS v
                             FROM survey_answers WHERE question_id=$1
                              AND value ~ '^-?[0-9]+(\\.[0-9]+)?$') t""",
                q["id"])
            item["avg"] = float(agg["avg"]) if agg and agg["avg"] is not None else None
            item["min"] = float(agg["min"]) if agg and agg["min"] is not None else None
            item["max"] = float(agg["max"]) if agg and agg["max"] is not None else None
            rows = await db.fetch(
                """SELECT value AS option, COUNT(*) AS cnt
                     FROM survey_answers
                    WHERE question_id=$1 AND COALESCE(value,'') <> ''
                    GROUP BY value
                    ORDER BY NULLIF(regexp_replace(value,'[^0-9.-]','','g'),'')::numeric""",
                q["id"])
            item["breakdown"] = [
                {
                    "option": r["option"], "count": r["cnt"],
                    "percent": round(r["cnt"] * 100.0 / answered, 1) if answered else 0.0,
                }
                for r in rows
            ]
        else:
            rows = await db.fetch(
                """SELECT a.value, r.created_at, c.name, c.id AS contact_id
                     FROM survey_answers a
                     JOIN survey_responses r ON r.id = a.response_id
                     JOIN contacts c ON c.id = r.contact_id
                    WHERE a.question_id=$1 AND COALESCE(a.value,'') <> ''
                    ORDER BY r.created_at DESC LIMIT 200""",
                q["id"])
            item["texts"] = [dict(r) for r in rows]
        out.append(item)

    return {"responses_total": total, "people_total": people, "questions": out}


@router.get("/surveys/{survey_id}/responses")
async def list_responses(
    survey_id: int, client=Depends(get_current_client), db=Depends(get_db),
):
    """Кто и когда заполнил — с ответами. Для таблицы «все ответы»."""
    client_id = int(client["sub"])
    await _assert_own_survey(db, survey_id, client_id)
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
                  ) ORDER BY a.question_id) FILTER (WHERE a.id IS NOT NULL), '[]') AS answers
             FROM survey_responses r
             JOIN contacts c ON c.id = r.contact_id
             LEFT JOIN survey_answers a ON a.response_id = r.id
            WHERE r.survey_id = $1
            GROUP BY r.id, c.id
            ORDER BY r.created_at DESC
            LIMIT 500""",
        survey_id)
    # ⚠️ json_agg приходит СТРОКОЙ — без разворота фронт не может пройтись по
    # ответам (та же засада, что с `options`).
    return [{**dict(r), "answers": _jsonb(r["answers"])} for r in rows]
