"""Админская панель автонастройки Telegram (миграция 364).

Владелец платформы видит здесь сервисные аккаунты (телефон, пароль двухфакторки,
прокси, свободные слоты, состояние спам-блока) и все заказы услуги.

⚠️ ПОЧЕМУ ПАРОЛЬ ВИДЕН В ПАНЕЛИ.
Аккаунты — расходники: сгорел один, завели другой. Владельцу нужно уметь зайти
в такой аккаунт руками (переложить сессию, разобраться с блокировкой), а для
этого нужны телефон и облачный пароль. Прятать их от единственного человека,
который имеет право их знать, — только мешать. Эндпоинты закрыты ролью админа
платформы, клиентам сюда хода нет.

⚠️ ПОЧЕМУ ЗДЕСЬ ЖЕ ЗАГРУЗКА СЕССИИ.
Сессия Telethon — обычный файл. Заводя аккаунт, владелец кладёт его сюда, и
файл ложится в каталог на сервере. Иначе пришлось бы каждый раз ходить по SSH.
"""
import logging
import re
from pathlib import Path

import asyncpg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_admin
from app.config import settings
from app.database import get_db
from app.services import tg_setup as tgs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/tg-setup", tags=["Админ: автонастройка"])


# ─────────────────────────────────────────────────────────────────────────
# Аккаунты
# ─────────────────────────────────────────────────────────────────────────
@router.get("/accounts")
async def list_accounts(admin=Depends(get_current_admin), db=Depends(get_db)):
    """Список сервисных аккаунтов со свободными слотами."""
    rows = await db.fetch(
        """
        SELECT a.*,
               (SELECT COUNT(*) FROM service_orders so
                 WHERE so.setup_account_id = a.id
                   AND so.bot_created_at IS NOT NULL
                   AND so.bot_transferred_at IS NULL
                   AND so.setup_state IN ('running','awaiting_user')) AS busy_slots
          FROM tg_setup_accounts a
         ORDER BY a.is_active DESC, a.id
        """
    )
    out = []
    for r in rows:
        d = dict(r)
        d["free_slots"] = max(0, int(r["max_slots"]) - int(r["busy_slots"]))
        d["session_exists"] = bool(
            r["session_path"] and Path(str(r["session_path"]) + ".session").exists()
            or (r["session_path"] and Path(str(r["session_path"])).exists())
        )
        out.append(d)
    return {"accounts": out}


class AccountIn(BaseModel):
    phone: str
    title: Optional[str] = None
    twofa_password: Optional[str] = None
    proxy: Optional[str] = None
    max_slots: Optional[int] = None
    is_active: Optional[bool] = None


@router.post("/accounts")
async def create_account(data: AccountIn,
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    phone = re.sub(r"\D", "", data.phone or "")
    if not phone:
        raise HTTPException(400, "Укажите телефон аккаунта")

    exists = await db.fetchval(
        "SELECT id FROM tg_setup_accounts WHERE phone=$1", phone
    )
    if exists:
        raise HTTPException(409, "Такой аккаунт уже добавлен")

    session_dir = Path(settings.tg_setup_sessions_dir)
    account_id = await db.fetchval(
        """INSERT INTO tg_setup_accounts (phone, title, twofa_password, proxy,
                                          session_path, max_slots, is_active)
                VALUES ($1, $2, $3, $4, $5, COALESCE($6, 5), COALESCE($7, TRUE))
             RETURNING id""",
        phone, data.title, data.twofa_password, data.proxy,
        str(session_dir / phone), data.max_slots, data.is_active,
    )
    return {"ok": True, "id": account_id}


@router.patch("/accounts/{account_id}")
async def update_account(account_id: int, data: AccountIn,
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    fields, values = [], []
    for name in ("title", "twofa_password", "proxy", "max_slots", "is_active"):
        value = getattr(data, name)
        if value is not None:
            values.append(value)
            fields.append(f"{name} = ${len(values) + 1}")
    if not fields:
        return {"ok": True, "unchanged": True}
    await db.execute(
        f"UPDATE tg_setup_accounts SET {', '.join(fields)}, updated_at=NOW() WHERE id=$1",
        account_id, *values,
    )
    return {"ok": True}


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: int,
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    """Удаляет аккаунт.

    ⚠️ Отказываем, если на нём висят непереданные боты: удалив аккаунт, мы
    потеряли бы к ним доступ, а клиенты остались бы без ботов.
    """
    busy = await db.fetchval(
        """SELECT COUNT(*) FROM service_orders
            WHERE setup_account_id=$1 AND bot_created_at IS NOT NULL
              AND bot_transferred_at IS NULL""",
        account_id,
    )
    if busy:
        raise HTTPException(
            409,
            f"На аккаунте {busy} непереданных ботов — сначала передайте их клиентам",
        )
    await db.execute("DELETE FROM tg_setup_accounts WHERE id=$1", account_id)
    return {"ok": True}


@router.post("/accounts/{account_id}/session")
async def upload_session(account_id: int, file: UploadFile = File(...),
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    """Кладёт файл сессии Telethon на сервер.

    ⚠️ Одна сессия — один сервер. Если этот же файл продолжает использовать
    другой сервис (например мейлер), Telegram сломает ключ авторизации, и
    аккаунт придётся логинить заново. Аккаунт должен быть выведен оттуда.
    """
    row = await db.fetchrow(
        "SELECT phone, session_path FROM tg_setup_accounts WHERE id=$1", account_id
    )
    if not row:
        raise HTTPException(404, "Аккаунт не найден")

    session_dir = Path(settings.tg_setup_sessions_dir)
    session_dir.mkdir(parents=True, exist_ok=True)
    target = Path(row["session_path"] or str(session_dir / row["phone"]))
    if target.suffix != ".session":
        target = target.with_suffix(".session")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Пустой файл")
    target.write_bytes(data)
    # ⚠️ Файл содержит ключ авторизации аккаунта — читать его должен только root.
    target.chmod(0o600)

    base = str(target)[: -len(".session")]
    await db.execute(
        "UPDATE tg_setup_accounts SET session_path=$2, health='unknown', updated_at=NOW() "
        " WHERE id=$1", account_id, base,
    )
    return {"ok": True, "path": str(target), "size": len(data)}


@router.post("/accounts/{account_id}/check")
async def check_account(account_id: int,
                        admin=Depends(get_current_admin), db=Depends(get_db)):
    """Проверяет аккаунт вживую: жив ли, не под спам-блоком, сколько ботов."""
    row = await db.fetchrow("SELECT * FROM tg_setup_accounts WHERE id=$1", account_id)
    if not row:
        raise HTTPException(404, "Аккаунт не найден")

    acc = tgs.SetupAccount(
        id=row["id"], phone=row["phone"],
        twofa_password=row["twofa_password"] or "",
        proxy=row["proxy"] or "", session_path=row["session_path"] or "",
    )
    health = await tgs.check_health(acc)
    await db.execute(
        """UPDATE tg_setup_accounts
              SET health=$2, health_note=$3, health_checked_at=NOW(),
                  username=COALESCE(NULLIF($4,''), username),
                  tg_user_id=COALESCE(NULLIF($5,0), tg_user_id), updated_at=NOW()
            WHERE id=$1""",
        account_id, health.state, health.note, health.username, health.tg_user_id,
    )
    return {
        "ok": True,
        "health": health.state,
        "note": health.note,
        "username": health.username,
        "bots_count": health.bots_count,
    }


# ─────────────────────────────────────────────────────────────────────────
# Заказы
# ─────────────────────────────────────────────────────────────────────────
@router.get("/orders")
async def list_orders(admin=Depends(get_current_admin), db=Depends(get_db),
                      limit: int = 100):
    rows = await db.fetch(
        """SELECT so.*, c.name AS client_name, c.email AS client_email,
                  c.telegram_username, a.phone AS account_phone
             FROM service_orders so
             JOIN clients c ON c.id = so.client_id
        LEFT JOIN tg_setup_accounts a ON a.id = so.setup_account_id
            ORDER BY so.id DESC
            LIMIT $1""",
        min(limit, 500),
    )
    return {"orders": [dict(r) for r in rows]}


class ServiceIn(BaseModel):
    price: Optional[int] = None
    coming_soon: Optional[bool] = None
    is_active: Optional[bool] = None
    leadpay_product_id: Optional[str] = None
    prodamus_payment_url: Optional[str] = None
    require_feature: Optional[str] = None


@router.get("/services")
async def list_services(admin=Depends(get_current_admin), db=Depends(get_db)):
    rows = await db.fetch("SELECT * FROM services ORDER BY sort, id")
    return {"services": [dict(r) for r in rows]}


@router.patch("/services/{slug}")
async def update_service(slug: str, data: ServiceIn,
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    """Правит услугу: цену, «скоро», карточку оплаты.

    ⚠️ `coming_soon` — тот самый рычаг «показывать без кнопки оплаты».
    Снял галочку → услуга начинает продаваться. Отдельного релиза не нужно.
    """
    fields, values = [], []
    for name in ("price", "coming_soon", "is_active", "leadpay_product_id",
                 "prodamus_payment_url", "require_feature"):
        value = getattr(data, name)
        if value is not None:
            values.append(value)
            fields.append(f"{name} = ${len(values) + 1}")
    if not fields:
        return {"ok": True, "unchanged": True}
    await db.execute(
        f"UPDATE services SET {', '.join(fields)}, updated_at=NOW() WHERE slug=$1",
        slug, *values,
    )
    return {"ok": True}


@router.post("/orders/{order_id}/retry")
async def retry_order(order_id: int,
                      admin=Depends(get_current_admin), db=Depends(get_db)):
    """Возвращает заказ в очередь — когда сорвалось по нашей вине."""
    order = await db.fetchrow("SELECT * FROM service_orders WHERE id=$1", order_id)
    if not order:
        raise HTTPException(404, "Заказ не найден")
    if order["status"] != "paid":
        raise HTTPException(400, "Заказ не оплачен")
    await db.execute(
        """UPDATE service_orders
              SET setup_state='queued', setup_error=NULL, setup_account_id=NULL,
                  updated_at=NOW()
            WHERE id=$1""",
        order_id,
    )
    return {"ok": True}


@router.post("/orders/{order_id}/mark-paid")
async def mark_paid(order_id: int,
                    admin=Depends(get_current_admin), db=Depends(get_db)):
    """Отмечает заказ оплаченным вручную — для теста и для оплаты мимо кассы."""
    order = await db.fetchrow("SELECT * FROM service_orders WHERE id=$1", order_id)
    if not order:
        raise HTTPException(404, "Заказ не найден")
    next_state = "queued" if order["bot_username"] else "new"
    await db.execute(
        """UPDATE service_orders
              SET status='paid', paid_at=COALESCE(paid_at, NOW()),
                  payment_provider='manual', setup_state=$2, updated_at=NOW()
            WHERE id=$1""",
        order_id, next_state,
    )
    return {"ok": True, "setup_state": next_state}
