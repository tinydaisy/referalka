"""Правка материалов Коллабораторной внедренцем (миграция 391).

⚠️⚠️ ПОЧЕМУ ЗДЕСЬ ВЫДАЁТСЯ ТОКЕН, А НЕ ПИШЕТСЯ СВОЙ РЕДАКТОР. Материалы правятся
тремя десятками ручек `products.py` (блоки, разделы, порядок, загрузка файлов), и
все они жёстко фильтруют `WHERE client_id = $2`. Ослабить фильтр нельзя — через
него же идут все ручки ЗАПИСИ у всех клиентов. Написать второй редактор — значит
получить две вёрстки блоков, которые разъедутся: ровно то, чего владелец просил
избегать.

Решение простое: внедренцу с правом на материалы выдаётся ОБЫЧНЫЙ клиентский
токен системного кабинета, где эти материалы лежат. Дальше работает готовый
редактор, слово в слово тот же, что у владельца.

⚠️ Токен КОРОТКИЙ (2 часа) и выдаётся по кнопке, а не лежит постоянно: это
полноценный доступ в системный кабинет, и висеть в браузере неделями он не
должен.

⚠️ Право проверяется В МОМЕНТ ВЫДАЧИ, а не только при входе: галочку могли снять
после того, как человек залогинился.
"""

from __future__ import annotations

from datetime import timedelta

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from app.auth import create_token, get_current_tech
from app.database import get_db

router = APIRouter(prefix="/tech/materials", tags=["Внедренец: материалы"])


@router.post("/session", summary="Открыть правку материалов")
async def open_session(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Выдаёт клиентский токен системного кабинета — там лежат материалы.

    Возвращает и адрес, куда идти: список продуктов системного кабинета.
    """
    spec_id = int(user["sub"])

    spec = await db.fetchrow(
        # ⚠️ Почта и имя — из клиента (миграция 486): внедренец роль над
        # клиентом, своих копий этих полей у него нет.
        """SELECT ts.id, c.email, c.name, ts.can_edit_materials, ts.is_active
             FROM tech_specialists ts
             JOIN clients c ON c.id = ts.client_id
            WHERE ts.id = $1""",
        spec_id,
    )
    if not spec or not spec["is_active"]:
        raise HTTPException(403, "Доступ закрыт")
    if not spec["can_edit_materials"]:
        # ⚠️ Право даётся поимённо: материалы видят все купившие модуль, и
        # ошибка одного человека видна всей платформе.
        raise HTTPException(403, "Правка материалов вам не открыта")

    owner = await db.fetchrow(
        "SELECT id, email FROM clients WHERE is_system_service = TRUE LIMIT 1")
    if not owner:
        raise HTTPException(404, "Системный кабинет не найден")

    # ⚠️ Токен клиентский (`role='client'`) — иначе готовые ручки products.py
    # его не примут. Но помечаем, КТО им пользуется: без этого в логах не
    # отличить правку внедренца от правки владельца.
    token = create_token({
        "sub": str(owner["id"]),
        "email": owner["email"],
        "role": "client",
        "acting_tech_id": spec_id,
    }, timedelta(hours=2))

    product = await db.fetchval(
        """SELECT id FROM products
            WHERE client_id = $1 AND slug = 'collab-hub' LIMIT 1""",
        owner["id"],
    )
    return {
        "token": token,
        "product_id": product,
        # Куда вести. Продукта ещё нет → в общий список, а не в никуда.
        "url": f"/dashboard/products/{product}" if product else "/dashboard/products",
        "expires_hours": 2,
    }
