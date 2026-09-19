"""Частые вопросы техспецов — общая база готовых ответов (миграция 460).

⚠️⚠️ БАЗА ОБЩАЯ. Что завёл один — видят и правят все: и техспецы, и админы.
Автор хранится только как ПОДПИСЬ «кто завёл», проверки «твоё — не твоё» здесь
нет намеренно. Личная база вернула бы ровно ту проблему, ради которой раздел
заводится: пять человек — пять разных ответов на один вопрос.

⚠️ ДВА РОУТЕРА НА ОДНИ ЭНДПОИНТЫ — как в custom_orders.py: `router` для
админки (`/admin/tech/faq`) и `tech_router` для кабинета (`/tech/faq`).
Разные они только входом (get_current_admin против get_current_tech), а
работают с одной таблицей и одной логикой — она вынесена в `_list`, `_create`,
`_update`, `_delete` и не дублируется.
"""
from __future__ import annotations

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_admin, get_current_tech
from app.database import get_db

router = APIRouter(prefix="/admin/tech/faq", tags=["Админ: частые вопросы"])
tech_router = APIRouter(prefix="/tech/faq", tags=["Кабинет: частые вопросы"])


class FaqIn(BaseModel):
    question: str
    answer: str


class FaqPatch(BaseModel):
    """⚠️ Отдельная модель от FaqIn: в PATCH оба поля НЕобязательны.

    Одна модель на создание и правку заставляла бы присылать вопрос целиком
    ради смены одного ответа (правило проекта).
    """
    question: Optional[str] = None
    answer: Optional[str] = None


async def _spec_name(db: asyncpg.Connection, spec_id: int) -> str:
    """Имя специалиста для подписи. Пусто — почта, иначе хоть что-то."""
    row = await db.fetchrow(
        "SELECT name, email FROM tech_specialists WHERE id = $1", spec_id)
    if not row:
        return "Техспец"
    return (row["name"] or "").strip() or row["email"] or "Техспец"


async def _list(db: asyncpg.Connection, q: str) -> dict:
    """Список вопросов, свежие сверху.

    ⚠️ Поиск идёт и по вопросу, И ПО ОТВЕТУ: человек ищет по словам, которые
    помнит, а помнит он чаще формулировку из ответа («ссылка у чата»), а не
    заголовок вопроса.
    """
    args: list = []
    where = ""
    if (q or "").strip():
        args.append(f"%{q.strip()}%")
        where = "WHERE question ILIKE $1 OR answer ILIKE $1"
    rows = await db.fetch(
        f"""SELECT f.id, f.question, f.answer, f.author_spec_id,
                   f.author_name, f.updated_by_name, f.created_at, f.updated_at,
                   ts.name AS author_current_name
              FROM tech_faq f
              LEFT JOIN tech_specialists ts ON ts.id = f.author_spec_id
              {where}
             ORDER BY f.created_at DESC
             LIMIT 500""",
        *args,
    )
    return {"items": [dict(r) for r in rows]}


async def _create(db: asyncpg.Connection, data: FaqIn,
                  spec_id: Optional[int], author: str) -> dict:
    question = (data.question or "").strip()
    answer = (data.answer or "").strip()
    if not question:
        raise HTTPException(400, "Напишите вопрос")
    if not answer:
        raise HTTPException(400, "Напишите ответ")
    row = await db.fetchrow(
        """INSERT INTO tech_faq (question, answer, author_spec_id, author_name)
           VALUES ($1, $2, $3, $4)
           RETURNING id, question, answer, author_spec_id, author_name,
                     updated_by_name, created_at, updated_at""",
        question, answer, spec_id, author,
    )
    return dict(row)


async def _update(db: asyncpg.Connection, faq_id: int, data: FaqPatch,
                  editor: str) -> dict:
    """Правка. ⚠️ Права не проверяем — база общая, править может каждый."""
    fs = data.model_fields_set
    sets, args = [], []
    for col in ("question", "answer"):
        if col in fs:
            val = (getattr(data, col) or "").strip()
            if not val:
                raise HTTPException(400, "Вопрос и ответ не должны быть пустыми")
            args.append(val)
            sets.append(f"{col} = ${len(args)}")
    if not sets:
        raise HTTPException(400, "Нечего менять")
    args.append(editor)
    sets.append(f"updated_by_name = ${len(args)}")
    args.append(faq_id)
    row = await db.fetchrow(
        f"""UPDATE tech_faq SET {', '.join(sets)}, updated_at = NOW()
             WHERE id = ${len(args)}
         RETURNING id, question, answer, author_spec_id, author_name,
                   updated_by_name, created_at, updated_at""",
        *args,
    )
    if not row:
        raise HTTPException(404, "Вопрос не найден")
    return dict(row)


async def _delete(db: asyncpg.Connection, faq_id: int) -> dict:
    res = await db.execute("DELETE FROM tech_faq WHERE id = $1", faq_id)
    # asyncpg возвращает строку вида «DELETE 1» — ноль означает, что вопрос
    # уже удалил кто-то другой (база общая, работают одновременно).
    if res.endswith(" 0"):
        raise HTTPException(404, "Вопрос не найден — возможно, его уже удалили")
    return {"ok": True}


# ── Админка ──────────────────────────────────────────────────────────────

@router.get("", summary="Частые вопросы")
async def admin_list(q: str = "", _admin=Depends(get_current_admin),
                     db: asyncpg.Connection = Depends(get_db)):
    return await _list(db, q)


@router.post("", summary="Добавить вопрос")
async def admin_create(data: FaqIn, _admin=Depends(get_current_admin),
                       db: asyncpg.Connection = Depends(get_db)):
    return await _create(db, data, None, "Администратор")


@router.patch("/{faq_id}", summary="Изменить вопрос")
async def admin_update(faq_id: int, data: FaqPatch,
                       _admin=Depends(get_current_admin),
                       db: asyncpg.Connection = Depends(get_db)):
    return await _update(db, faq_id, data, "Администратор")


@router.delete("/{faq_id}", summary="Удалить вопрос")
async def admin_delete(faq_id: int, _admin=Depends(get_current_admin),
                       db: asyncpg.Connection = Depends(get_db)):
    return await _delete(db, faq_id)


# ── Кабинет техспеца ─────────────────────────────────────────────────────

@tech_router.get("", summary="Частые вопросы")
async def tech_list(q: str = "", user: dict = Depends(get_current_tech),
                    db: asyncpg.Connection = Depends(get_db)):
    return await _list(db, q)


@tech_router.post("", summary="Добавить вопрос")
async def tech_create(data: FaqIn, user: dict = Depends(get_current_tech),
                      db: asyncpg.Connection = Depends(get_db)):
    spec_id = int(user["sub"])
    return await _create(db, data, spec_id, await _spec_name(db, spec_id))


@tech_router.patch("/{faq_id}", summary="Изменить вопрос")
async def tech_update(faq_id: int, data: FaqPatch,
                      user: dict = Depends(get_current_tech),
                      db: asyncpg.Connection = Depends(get_db)):
    spec_id = int(user["sub"])
    return await _update(db, faq_id, data, await _spec_name(db, spec_id))


@tech_router.delete("/{faq_id}", summary="Удалить вопрос")
async def tech_delete(faq_id: int, user: dict = Depends(get_current_tech),
                      db: asyncpg.Connection = Depends(get_db)):
    """⚠️⚠️ Удаление — ПО ПРАВУ `can_delete_faq` (миграция 461).

    Добавлять и править может каждый: ошибку в ответе должен уметь поправить
    тот, кто её заметил. А удаление убирает ответ у ВСЕХ сразу и безвозвратно,
    поэтому право выдаётся поимённо галочкой в карточке специалиста.

    ⚠️ Проверка стоит ЗДЕСЬ, а не только в интерфейсе. Спрятать кнопку, оставив
    путь рабочим, значило бы запретить лишь на вид.
    """
    spec_id = int(user["sub"])
    allowed = await db.fetchval(
        "SELECT can_delete_faq FROM tech_specialists WHERE id = $1", spec_id)
    if not allowed:
        raise HTTPException(
            403, "Удалять вопросы могут не все — попросите админа выдать право "
                 "в вашей карточке")
    return await _delete(db, faq_id)
