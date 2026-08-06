"""
Настройки платёжной системы клиента (миграция 257).

Клиент подключает свой кабинет платёжной системы — LeadPay или Продамус
(миграция 269). Вебхук настраивать не нужно ни в той, ни в другой: его адрес
мы передаём сами вместе с заказом.

Подключено → ссылку на оплату создаём сами, оплата приходит вебхуком. Не
подключено → в тарифе внешняя ссылка, оплаты отмечаются вручную.

⚠️ Код товара в тарифе нужен только LeadPay. У Продамуса название и цена
уходят прямо в ссылке — заводить товар заранее не надо (`needs_product_id`).

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
    pay_prodamus_url: Optional[str] = None
    pay_prodamus_secret: Optional[str] = None


class CheckIn(BaseModel):
    # Какую систему проверяем. Не прислали — берём выбранную у клиента.
    pay_provider: Optional[str] = None
    pay_leadpay_login: Optional[str] = None
    pay_leadpay_token: Optional[str] = None
    pay_prodamus_url: Optional[str] = None
    pay_prodamus_secret: Optional[str] = None


@router.get("", summary="Настройки приёма оплаты")
async def get_settings(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    row = await db.fetchrow(
        """SELECT pay_provider, pay_leadpay_login, pay_leadpay_token,
                  pay_prodamus_url, pay_prodamus_secret
             FROM clients WHERE id = $1""",
        client_id,
    )
    d = dict(row or {})
    # ⚠️ Секретные ключи целиком наружу не отдаём — только признак, что они
    # заданы, и хвост для узнавания. Иначе утекут в любой лог фронта.
    token = (d.pop("pay_leadpay_token", None) or "").strip()
    secret = (d.pop("pay_prodamus_secret", None) or "").strip()
    d["has_token"] = bool(token)
    d["token_tail"] = token[-4:] if len(token) >= 4 else ""
    d["has_prodamus_secret"] = bool(secret)
    d["prodamus_secret_tail"] = secret[-4:] if len(secret) >= 4 else ""
    d["is_configured"] = client_payments.is_configured({
        "pay_provider": d.get("pay_provider"),
        "pay_leadpay_login": d.get("pay_leadpay_login"),
        "pay_leadpay_token": token,
        "pay_prodamus_url": d.get("pay_prodamus_url"),
        "pay_prodamus_secret": secret,
    })
    d["providers"] = client_payments.PROVIDERS
    # Нужен ли в тарифе код товара — у Продамуса не нужен.
    d["needs_product_id"] = (d.get("pay_provider") or "") in client_payments.NEEDS_PRODUCT_ID
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
    for field in ("pay_provider", "pay_leadpay_login", "pay_leadpay_token",
                  "pay_prodamus_url", "pay_prodamus_secret"):
        if field not in fs:
            continue
        val = getattr(data, field)
        if isinstance(val, str):
            val = val.strip() or None
        # Пустая строка в системе = «отключить приём оплаты».
        if field == "pay_provider":
            val = (val or "").lower() or None
            if val not in client_payments.PROVIDERS:
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
    """Проверяем настройки, не создавая настоящей оплаты. Незаполненные поля
    берём из сохранённых — клиент обычно жмёт «Проверить» после сохранения."""
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)

    row = await db.fetchrow(
        """SELECT pay_provider, pay_leadpay_login, pay_leadpay_token,
                  pay_prodamus_url, pay_prodamus_secret
             FROM clients WHERE id = $1""",
        client_id,
    )
    saved = dict(row or {})
    provider = (data.pay_provider or saved.get("pay_provider") or "").strip().lower()

    creds = {}
    for field in ("pay_leadpay_login", "pay_leadpay_token",
                  "pay_prodamus_url", "pay_prodamus_secret"):
        creds[field] = (getattr(data, field) or "").strip() or (saved.get(field) or "")

    ok, message = await client_payments.check_credentials(provider, creds)
    return {"ok": ok, "message": message}
