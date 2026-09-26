"""
Формы заявки — «оставить заявку» вместо регистрации и оплаты (миграция 363).

Человек НЕ регистрируется и НЕ платит: заполняет анкету и получает «с вами
свяжутся». Ответ падает в заявки анкеты со всей готовой обвязкой —
«Обработано» и заметка, счётчик необработанных, уведомления в чат и на почту,
таблица заявок, CRM-колонки, дашборды, выгрузка.

⚠️⚠️ ОТДЕЛЬНОЙ СУЩНОСТИ «ЗАЯВКА» НЕТ — это анкета. Здесь только связка «у
этого события/продукта заявки собирает вот эта анкета». Своего приёма ответов
не заводим: отправка идёт в `/public/surveys/{slug}/submit`, ту же ручку, что
и публичная страница `/f/{slug}`. Иначе разъедутся проверка обязательных,
«Это вы?», согласие ПД и уведомления.

⚠️ ОДНА ФОРМА НА ВЛАДЕЛЬЦА (UNIQUE в миграции): кнопка участия одна, при двух
формах непонятно, какую открывать.

⚠️ ЗАЯВКА РЕГИСТРАЦИИ НЕ ДАЁТ — человек остаётся «интересовался», внутрянка
события ему не открывается. Это работает само (вкладки идут по
`is_registered`), закрывать отдельно нечего.

API (JWT владельца кабинета):
  GET    /api/v1/{events|products}/{owner_id}/request-form
  PUT    /api/v1/{events|products}/{owner_id}/request-form
  DELETE /api/v1/{events|products}/{owner_id}/request-form
  GET    /api/v1/{events|products}/{owner_id}/request-form/responses
         — заявки, пришедшие с формы этого события/продукта (вкладка «Заявки»)

⚠️ Текст «спасибо» и что показать после отправки — ТОЛЬКО в анкете
(миграция 519). Своего `success_text` у формы больше нет: он доходил лишь до
Mini App, а лендинг показывал текст анкеты — два места разъезжались.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.database import get_db
from app.auth import get_current_client

# ⚠️ `get_current_client` отдаёт ДЕКОДИРОВАННЫЙ ТОКЕН, а не карточку клиента:
# id кабинета лежит в `sub` СТРОКОЙ. Ключа `client_id` там нет — обращение к
# нему даёт KeyError и 500 «что-то пошло не так» (так и было: форма заявки не
# сохранялась вовсе). Везде брать `int(user["sub"])`, как в event_tariffs.

event_router = APIRouter(prefix="/events/{owner_id}/request-form",
                         tags=["Формы заявки"])
product_router = APIRouter(prefix="/products/{owner_id}/request-form",
                           tags=["Формы заявки"])


class RequestFormIn(BaseModel):
    survey_id: int
    title: Optional[str] = None
    subtitle: Optional[str] = None
    # Как показывать вопросы: 'quiz' (по одному, по умолчанию) | 'form' (все сразу).
    survey_view: Optional[str] = None
    is_active: Optional[bool] = True


async def _assert_owner(db, client_id: int, owner_type: str, owner_id: int):
    """Владелец лендинга принадлежит этому кабинету.

    ⚠️ У события владельцев может быть несколько (коллаба) — проверяем через
    `event_owners`, у `events` своего `client_id` нет.
    """
    if owner_type == "event":
        ok = await db.fetchval(
            """SELECT 1 FROM event_owners
                WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'
                LIMIT 1""",
            owner_id, client_id)
    else:
        ok = await db.fetchval(
            "SELECT 1 FROM products WHERE id = $1 AND client_id = $2",
            owner_id, client_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Не найдено или нет доступа")


async def _assert_survey_owned(db, client_id: int, survey_id: int):
    """Анкета принадлежит этому кабинету.

    ⚠️ `survey_id` приходит из браузера: без проверки, зная чужой id, можно
    поставить себе чужую анкету — и заявки уходили бы постороннему в базу.
    """
    ok = await db.fetchval(
        "SELECT 1 FROM surveys WHERE id = $1 AND client_id = $2",
        survey_id, client_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Анкета не найдена")


async def _get_form(db, owner_type: str, owner_id: int):
    return await db.fetchrow(
        """SELECT f.id, f.survey_id, f.title, f.subtitle,
                  f.survey_view, f.is_active,
                  s.title AS survey_title, s.slug AS survey_slug
             FROM request_forms f
             JOIN surveys s ON s.id = f.survey_id
            WHERE f.owner_type = $1 AND f.owner_id = $2""",
        owner_type, owner_id)


async def _list_form(owner_type, owner_id, user, db):
    await _assert_owner(db, int(user["sub"]), owner_type, owner_id)
    row = await _get_form(db, owner_type, owner_id)
    return {"form": dict(row) if row else None}


async def _save_form(owner_type, owner_id, data: RequestFormIn, user, db):
    await _assert_owner(db, int(user["sub"]), owner_type, owner_id)
    await _assert_survey_owned(db, int(user["sub"]), data.survey_id)

    # ⚠️ UPSERT по владельцу — форма одна, второй раз не плодим.
    row = await db.fetchrow(
        """INSERT INTO request_forms
               (client_id, owner_type, owner_id, survey_id,
                title, subtitle, survey_view, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (owner_type, owner_id) DO UPDATE
           SET survey_id    = EXCLUDED.survey_id,
               title        = EXCLUDED.title,
               subtitle     = EXCLUDED.subtitle,
               survey_view  = EXCLUDED.survey_view,
               is_active    = EXCLUDED.is_active,
               updated_at   = NOW()
         RETURNING id""",
        int(user["sub"]), owner_type, owner_id, data.survey_id,
        (data.title or "").strip() or None,
        (data.subtitle or "").strip() or None,
        # ⚠️ Мусор приводим к дефолту, а не роняем запрос — как у btn_width
        # и card_style. По умолчанию КВИЗ.
        "form" if data.survey_view == "form" else "quiz",
        data.is_active if data.is_active is not None else True,
    )
    saved = await _get_form(db, owner_type, owner_id)
    return {"ok": True, "id": row["id"], "form": dict(saved) if saved else None}


async def _delete_form(owner_type, owner_id, user, db):
    await _assert_owner(db, int(user["sub"]), owner_type, owner_id)
    await db.execute(
        "DELETE FROM request_forms WHERE owner_type = $1 AND owner_id = $2",
        owner_type, owner_id)
    return {"ok": True}


async def _list_responses(owner_type, owner_id, user, db):
    """Заявки, пришедшие с формы заявки ЭТОГО события/продукта.

    ⚠️ Отбор — по источнику в самом ответе (`survey_responses.event_id` /
    `product_id`, миграция 519), а НЕ «все ответы анкеты формы»: одна анкета
    стоит на нескольких событиях, и список смешал бы чужие заявки. Анкету
    формы могли поменять — старые заявки всё равно остаются в списке.

    ⚠️ «Обработано» и заметка — те же поля сотрудника анкеты, что в разделе
    «Анкеты» (пишутся общей ручкой `.../staff-answers`). Заявка одна — двух
    отметок не бывает.
    """
    client_id = int(user["sub"])
    await _assert_owner(db, client_id, owner_type, owner_id)
    col = "event_id" if owner_type == "event" else "product_id"
    rows = await db.fetch(
        f"""SELECT r.id, r.survey_id, r.created_at, r.platform_slug,
                  s.title AS survey_title,
                  c.id AS contact_id, c.name, c.phone,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                    ORDER BY pu.id LIMIT 1) AS email,
                  (SELECT COALESCE(pu.username, pu.platform_user_id) FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
                    LIMIT 1) AS telegram,
                  (SELECT COALESCE(pu.username, pu.platform_user_id) FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk'
                    LIMIT 1) AS vk,
                  (SELECT COALESCE(pu.username, pu.platform_user_id) FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max'
                    LIMIT 1) AS max_nick
             FROM survey_responses r
             JOIN surveys s  ON s.id = r.survey_id AND s.client_id = $2
             JOIN contacts c ON c.id = r.contact_id
            WHERE r.{col} = $1
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT 500""",
        owner_id, client_id)
    if not rows:
        return {"responses": [], "unprocessed": 0}

    ids = [r["id"] for r in rows]
    answers = await db.fetch(
        """SELECT a.response_id, a.question_id, a.value,
                  q.title, q.kind, q.filled_by, q.is_protected, q.sort_order
             FROM survey_answers a
             JOIN survey_questions q ON q.id = a.question_id
            WHERE a.response_id = ANY($1::int[])
            ORDER BY q.sort_order, q.id""",
        ids)
    # Поля сотрудника каждой анкеты: «Обработано» (защищённая галочка) и
    # «Заметка». ⚠️ «Обработано» — первый защищённый по id, как у счётчика
    # необработанных в surveys.py, иначе цифры разойдутся.
    survey_ids = list({r["survey_id"] for r in rows})
    staff = await db.fetch(
        """SELECT id, survey_id, title, kind, is_protected
             FROM survey_questions
            WHERE survey_id = ANY($1::int[]) AND filled_by = 'staff'
            ORDER BY id""",
        survey_ids)
    flag_q: dict = {}
    note_q: dict = {}
    for q in staff:
        if q["is_protected"] and q["survey_id"] not in flag_q:
            flag_q[q["survey_id"]] = q["id"]
        elif q["kind"] == "textarea" and q["title"] == "Заметка" \
                and q["survey_id"] not in note_q:
            note_q[q["survey_id"]] = q["id"]

    by_resp: dict = {}
    for a in answers:
        by_resp.setdefault(a["response_id"], []).append(a)

    out = []
    unprocessed = 0
    for r in rows:
        items = by_resp.get(r["id"], [])
        fq, nq = flag_q.get(r["survey_id"]), note_q.get(r["survey_id"])
        processed = any(a["question_id"] == fq and a["value"] == "Да" for a in items)
        note = next((a["value"] for a in items if a["question_id"] == nq), "")
        if fq and not processed:
            unprocessed += 1
        d = dict(r)
        d["answers"] = [{"title": a["title"], "value": a["value"]}
                        for a in items if a["filled_by"] == "visitor"]
        d["processed"] = processed
        d["note"] = note or ""
        d["processed_qid"] = fq
        d["note_qid"] = nq
        out.append(d)
    return {"responses": out, "unprocessed": unprocessed}


@event_router.get("/responses", summary="Заявки с формы заявки события")
async def get_event_responses(owner_id: int, user=Depends(get_current_client),
                              db: asyncpg.Connection = Depends(get_db)):
    return await _list_responses("event", owner_id, user, db)


@product_router.get("/responses", summary="Заявки с формы заявки продукта")
async def get_product_responses(owner_id: int, user=Depends(get_current_client),
                                db: asyncpg.Connection = Depends(get_db)):
    return await _list_responses("product", owner_id, user, db)


@event_router.get("", summary="Форма заявки события")
async def get_event_form(owner_id: int, user=Depends(get_current_client),
                         db: asyncpg.Connection = Depends(get_db)):
    return await _list_form("event", owner_id, user, db)


@event_router.put("", summary="Сохранить форму заявки события")
async def put_event_form(owner_id: int, data: RequestFormIn,
                         user=Depends(get_current_client),
                         db: asyncpg.Connection = Depends(get_db)):
    return await _save_form("event", owner_id, data, user, db)


@event_router.delete("", summary="Убрать форму заявки события")
async def del_event_form(owner_id: int, user=Depends(get_current_client),
                         db: asyncpg.Connection = Depends(get_db)):
    return await _delete_form("event", owner_id, user, db)


@product_router.get("", summary="Форма заявки продукта")
async def get_product_form(owner_id: int, user=Depends(get_current_client),
                           db: asyncpg.Connection = Depends(get_db)):
    return await _list_form("product", owner_id, user, db)


@product_router.put("", summary="Сохранить форму заявки продукта")
async def put_product_form(owner_id: int, data: RequestFormIn,
                           user=Depends(get_current_client),
                           db: asyncpg.Connection = Depends(get_db)):
    return await _save_form("product", owner_id, data, user, db)


@product_router.delete("", summary="Убрать форму заявки продукта")
async def del_product_form(owner_id: int, user=Depends(get_current_client),
                           db: asyncpg.Connection = Depends(get_db)):
    return await _delete_form("product", owner_id, user, db)


async def load_request_form(db, owner_type: str, owner_id: int,
                            client_id: int) -> dict | None:
    """Форма заявки владельца с ВОПРОСАМИ анкеты — для публичных страниц.

    ⚠️ Единая точка: её зовут и лендинг (блок `survey`), и витрина Mini App.
    Свой SELECT в потребителе не писать — разъедется.

    ⚠️ Вопросы собирает общая `collect_landing_surveys`: она отдаёт только
    вопросы ПОСЕТИТЕЛЯ (`filled_by='visitor'`), поля сотрудника («Обработано»,
    заметки) на публичной странице показывать нельзя.
    """
    row = await db.fetchrow(
        """SELECT f.survey_id, f.title, f.subtitle,
                  f.survey_view,
                  s.slug AS survey_slug, s.title AS survey_title
             FROM request_forms f
             JOIN surveys s ON s.id = f.survey_id
            WHERE f.owner_type = $1 AND f.owner_id = $2 AND f.is_active""",
        owner_type, owner_id)
    if not row:
        return None

    out = dict(row)
    try:
        # ⚠️ `collect_landing_surveys` принимает БЛОКИ (она собирает анкеты
        # для блоков лендинга) — подаём ей псевдо-блок с нашей анкетой, чтобы
        # не заводить второй сборщик вопросов. `client_id` обязателен: внутри
        # ещё раз сверяется, что анкета принадлежит этому кабинету.
        from app.services.landing_survey import collect_landing_surveys
        pseudo = [{"id": 0, "kind": "survey", "survey_id": row["survey_id"]}]
        surveys = await collect_landing_surveys(db, pseudo, client_id)
        # ⚠️ Ключи там — СТРОКИ (`out[str(block_id)]`), не числа.
        out["survey"] = surveys.get("0")
    except Exception:
        out["survey"] = None
    return out
