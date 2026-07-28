"""
Настройки платёжной системы клиента (миграция 257).

Клиент подключает свой кабинет LeadPay — двумя значениями из раздела
«Настройки → Для внешних систем»: адрес лендинга и секретный ключ.
Вебхук настраивать не нужно: его адрес мы передаём сами в каждом запросе
за ссылкой оплаты.

Подключено → в тарифе указывается код товара, ссылку создаём сами, оплата
приходит вебхуком. Не подключено → в тарифе внешняя ссылка, оплаты
отмечаются вручную.

Гейт — фича `payments` (никогда по tariff_slug). Ассистенту запись закрыта
общим middleware.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.database import get_db
from app.auth import get_current_client
from app.services.features import client_has_feature
from app.services import client_payments

router = APIRouter(prefix="/clients/me/payment-settings", tags=["Платёжные системы"])


async def _assert_feature(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "payments"):
        raise HTTPException(
            status_code=403,
            detail="Раздел «Платёжные системы» недоступен на вашем тарифе.",
        )


class SettingsIn(BaseModel):
    pay_provider: Optional[str] = None
    pay_leadpay_login: Optional[str] = None
    pay_leadpay_token: Optional[str] = None


class CheckIn(BaseModel):
    pay_leadpay_login: Optional[str] = None
    pay_leadpay_token: Optional[str] = None


@router.get("", summary="Настройки приёма оплаты")
async def get_settings(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    row = await db.fetchrow(
        "SELECT pay_provider, pay_leadpay_login, pay_leadpay_token FROM clients WHERE id = $1",
        client_id,
    )
    d = dict(row or {})
    # ⚠️ Секретный ключ целиком наружу не отдаём — только признак, что он задан,
    # и хвост для узнавания. Иначе он утечёт в любой лог фронта.
    token = (d.pop("pay_leadpay_token", None) or "").strip()
    d["has_token"] = bool(token)
    d["token_tail"] = token[-4:] if len(token) >= 4 else ""
    d["is_configured"] = client_payments.is_configured({
        "pay_provider": d.get("pay_provider"),
        "pay_leadpay_login": d.get("pay_leadpay_login"),
        "pay_leadpay_token": token,
    })
    d["providers"] = client_payments.PROVIDERS
    return d


@router.patch("", summary="Сохранить настройки приёма оплаты")
async def patch_settings(
    data: SettingsIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)

    fs = data.model_fields_set
    sets, vals = [], []
    for field in ("pay_provider", "pay_leadpay_login", "pay_leadpay_token"):
        if field not in fs:
            continue
        val = getattr(data, field)
        if isinstance(val, str):
            val = val.strip() or None
        # Пустая строка в системе = «отключить приём оплаты».
        if field == "pay_provider" and val not in (None, "leadpay"):
            val = None
        vals.append(val)
        sets.append(f"{field} = ${len(vals)}")

    if not sets:
        return {"ok": True}

    vals.append(client_id)
    await db.execute(
        f"UPDATE clients SET {', '.join(sets)} WHERE id = ${len(vals)}", *vals
    )
    return await get_settings(client=client, db=db)


@router.post("/check", summary="Проверить связь с платёжной системой")
async def check_settings(
    data: CheckIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Проверяем ключи, не создавая настоящей оплаты. Если поля пришли
    пустыми — берём сохранённые (клиент жмёт «Проверить» после сохранения)."""
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)

    login = (data.pay_leadpay_login or "").strip()
    token = (data.pay_leadpay_token or "").strip()
    if not login or not token:
        row = await db.fetchrow(
            "SELECT pay_leadpay_login, pay_leadpay_token FROM clients WHERE id = $1",
            client_id,
        )
        login = login or (row["pay_leadpay_login"] or "")
        token = token or (row["pay_leadpay_token"] or "")

    ok, message = await client_payments.check_credentials(login, token)
    return {"ok": ok, "message": message}
