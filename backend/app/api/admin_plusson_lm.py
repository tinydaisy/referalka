"""
Админка → «Плюсоновский лид-магнит» (миграция 472).

Один экран, на котором владелец задаёт текст предложения самого ПЛЮСОНа и
решает, куда ведёт прямая ссылка подарка. Настройка одна на всю платформу:
сохранил здесь — поменялось у всех клиентов разом.

⚠️ Отдельным файлом, а не строчками в `admin.py`: тот уже под 1800 строк, и
тема у него общая («клиенты, тарифы, служебное»). Разбор по темам — правило
проекта.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_admin
from app.database import get_db
from app.services.plusson_lead_magnet import (
    DEFAULT_NAME, SOURCE_CODE, get_settings, sync_all,
)

router = APIRouter(prefix="/admin/plusson-lead-magnet", tags=["Администратор"])


class PlussonLmUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    # 'direct' — сразу в бот ПЛЮСОНа; 'funnel' — через бот клиента.
    delivery: Optional[str] = None
    # 'testing' — виден только админскому и сервисному аккаунту (миграция 473);
    # 'all' — всем клиентам.
    visibility: Optional[str] = None


async def _stats(db, visibility: str) -> dict:
    """Сколько экземпляров живёт, сколько клиентов без них и что он принёс."""
    row = await db.fetchrow(
        """SELECT
             (SELECT count(*) FROM lead_magnets WHERE is_plusson)             AS magnets,
             (SELECT count(*) FROM clients c
               WHERE NOT EXISTS (SELECT 1 FROM lead_magnets lm
                                  WHERE lm.client_id = c.id AND lm.is_plusson)) AS missing,
             -- Переходы по ссылке подарка: забеги живут и в прямом режиме,
             -- это единственное место, где виден сам факт клика.
             (SELECT count(*) FROM funnel_runs fr
                JOIN lead_magnets lm ON lm.id = fr.lead_magnet_id
               WHERE lm.is_plusson)                                            AS clicks,
             -- Дошли до кабинета: клиенты, помеченные этим источником.
             (SELECT count(*) FROM clients WHERE referred_source = $1)         AS signups,
             -- Сколько клиентов видят подарок ПРЯМО СЕЙЧАС: на обкатке это
             -- админский и сервисный аккаунт, после переключения — все.
             (SELECT count(*) FROM clients c
                LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
                LEFT JOIN tariffs t ON t.id = cs.tariff_id
               WHERE $2 = 'all' OR c.is_system_service OR t.slug = 'admin') AS visible""",
        SOURCE_CODE, visibility,
    )
    return {
        "magnets": int(row["magnets"] or 0),
        "missing": int(row["missing"] or 0),
        "clicks": int(row["clicks"] or 0),
        "signups": int(row["signups"] or 0),
        "visible": int(row["visible"] or 0),
    }


@router.get("", summary="Настройки Плюсоновского лид-магнита")
async def admin_get_plusson_lm(
    db=Depends(get_db),
    admin=Depends(get_current_admin),
):
    st = await get_settings(db)
    return {**st, "default_name": DEFAULT_NAME, **await _stats(db, st["visibility"])}


@router.patch("", summary="Изменить название, описание и режим выдачи")
async def admin_update_plusson_lm(
    data: PlussonLmUpdate,
    db=Depends(get_db),
    admin=Depends(get_current_admin),
):
    """Сохранение разносит текст по ВСЕМ экземплярам сразу.

    ⚠️ Текст и режим правятся одним запросом, и текст разносится в той же
    транзакции: иначе между записью настройки и рассылкой по клиентам
    существовал бы промежуток, в котором в админке уже новый текст, а у людей
    ещё старый — и понять, сохранилось ли, стало бы невозможно.
    """
    fields, args = [], []

    if data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(400, "Название не может быть пустым")
        args.append(name)
        fields.append(f"plusson_lm_name = ${len(args)}")

    if data.description is not None:
        args.append(data.description.strip() or None)
        fields.append(f"plusson_lm_description = ${len(args)}")

    if data.delivery is not None:
        if data.delivery not in ("direct", "funnel"):
            raise HTTPException(400, "Режим выдачи: direct или funnel")
        args.append(data.delivery)
        fields.append(f"plusson_lm_delivery = ${len(args)}")

    if data.visibility is not None:
        if data.visibility not in ("testing", "all"):
            raise HTTPException(400, "Видимость: testing или all")
        args.append(data.visibility)
        fields.append(f"plusson_lm_visibility = ${len(args)}")

    if not fields:
        raise HTTPException(400, "Нечего менять")

    async with db.transaction():
        await db.execute(
            f"UPDATE platform_settings SET {', '.join(fields)}, updated_at = now() WHERE id = 1",
            *args,
        )
        if data.name is not None or data.description is not None:
            st = await get_settings(db)
            await sync_all(db, st["name"], st["description"])

    return await admin_get_plusson_lm(db=db, admin=admin)
