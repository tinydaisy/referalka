"""
Настройки платёжной системы клиента (миграция 257).

Клиент подключает свой кабинет платёжной системы — LeadPay, Продамус
(миграция 269) или эквайринг Т-Банка (миграция 277). Вебхук настраивать не
нужно ни в одной: его адрес мы передаём сами вместе с заказом.

Подключено → ссылку на оплату создаём сами, оплата приходит вебхуком. Не
подключено → в тарифе внешняя ссылка, оплаты отмечаются вручную.

⚠️ Код товара в тарифе нужен только LeadPay. У Продамуса и Т-Банка название и
цена уходят прямо в запросе — заводить товар заранее не надо
(`needs_product_id`).

⚠️ «Т-Чеки» — не отдельная система, а сервис фискализации поверх эквайринга
Т-Банка: клиент включает его у себя в кабинете банка, чеки выдаёт сам банк.
От нас нужны только система налогообложения и ставка НДС — без них банк не
соберёт чек. Отдельной галочки «включить Т-Чеки» здесь нет и не нужно.

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
    pay_tbank_terminal_key: Optional[str] = None
    pay_tbank_password: Optional[str] = None
    pay_tbank_test_terminal_key: Optional[str] = None
    pay_tbank_test_password: Optional[str] = None
    pay_tbank_test_mode: Optional[bool] = None
    pay_tbank_taxation: Optional[str] = None
    pay_tbank_vat: Optional[str] = None


class CheckIn(BaseModel):
    # Какую систему проверяем. Не прислали — берём выбранную у клиента.
    pay_provider: Optional[str] = None
    pay_leadpay_login: Optional[str] = None
    pay_leadpay_token: Optional[str] = None
    pay_prodamus_url: Optional[str] = None
    pay_prodamus_secret: Optional[str] = None
    pay_tbank_terminal_key: Optional[str] = None
    pay_tbank_password: Optional[str] = None
    pay_tbank_test_terminal_key: Optional[str] = None
    pay_tbank_test_password: Optional[str] = None
    pay_tbank_test_mode: Optional[bool] = None
    pay_tbank_taxation: Optional[str] = None
    pay_tbank_vat: Optional[str] = None


@router.get("", summary="Настройки приёма оплаты")
async def get_settings(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    row = await db.fetchrow(
        """SELECT pay_provider, pay_leadpay_login, pay_leadpay_token,
                  pay_prodamus_url, pay_prodamus_secret,
                  pay_tbank_terminal_key, pay_tbank_password,
                  pay_tbank_test_terminal_key, pay_tbank_test_password,
                  pay_tbank_test_mode,
                  pay_tbank_taxation, pay_tbank_vat
             FROM clients WHERE id = $1""",
        client_id,
    )
    d = dict(row or {})
    # ⚠️ Секретные ключи целиком наружу не отдаём — только признак, что они
    # заданы, и хвост для узнавания. Иначе утекут в любой лог фронта.
    token = (d.pop("pay_leadpay_token", None) or "").strip()
    secret = (d.pop("pay_prodamus_secret", None) or "").strip()
    tb_pass = (d.pop("pay_tbank_password", None) or "").strip()
    tb_test_pass = (d.pop("pay_tbank_test_password", None) or "").strip()
    d["has_token"] = bool(token)
    d["token_tail"] = token[-4:] if len(token) >= 4 else ""
    d["has_prodamus_secret"] = bool(secret)
    d["prodamus_secret_tail"] = secret[-4:] if len(secret) >= 4 else ""
    d["has_tbank_password"] = bool(tb_pass)
    d["tbank_password_tail"] = tb_pass[-4:] if len(tb_pass) >= 4 else ""
    d["has_tbank_test_password"] = bool(tb_test_pass)
    d["tbank_test_password_tail"] = tb_test_pass[-4:] if len(tb_test_pass) >= 4 else ""
    d["is_configured"] = client_payments.is_configured({
        "pay_provider": d.get("pay_provider"),
        "pay_leadpay_login": d.get("pay_leadpay_login"),
        "pay_leadpay_token": token,
        "pay_prodamus_url": d.get("pay_prodamus_url"),
        "pay_prodamus_secret": secret,
        "pay_tbank_terminal_key": d.get("pay_tbank_terminal_key"),
        "pay_tbank_password": tb_pass,
        "pay_tbank_test_terminal_key": d.get("pay_tbank_test_terminal_key"),
        "pay_tbank_test_password": tb_test_pass,
        "pay_tbank_test_mode": d.get("pay_tbank_test_mode"),
    })
    d["providers"] = client_payments.PROVIDERS
    # Нужен ли в тарифе код товара — у Продамуса и Т-Банка не нужен.
    d["needs_product_id"] = (d.get("pay_provider") or "") in client_payments.NEEDS_PRODUCT_ID
    # Справочники для чека Т-Банка (сервис «Чеки от Т-Бизнеса»).
    d["tbank_taxations"] = client_payments.TBANK_TAXATIONS
    d["tbank_vats"] = client_payments.TBANK_VATS
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
                  "pay_prodamus_url", "pay_prodamus_secret",
                  "pay_tbank_terminal_key", "pay_tbank_password",
                  "pay_tbank_test_terminal_key", "pay_tbank_test_password",
                  "pay_tbank_test_mode",
                  "pay_tbank_taxation", "pay_tbank_vat"):
        if field not in fs:
            continue
        val = getattr(data, field)
        if isinstance(val, str):
            val = val.strip() or None
        # Галочка режима — не текст: NULL в NOT NULL-колонку не пройдёт.
        if field == "pay_tbank_test_mode":
            val = bool(val)
        # Пустая строка в системе = «отключить приём оплаты».
        if field == "pay_provider":
            val = (val or "").lower() or None
            if val not in client_payments.PROVIDERS:
                val = None
        # Чужие значения в справочниках чека не храним — банк такой чек
        # отвергнет, а сервис подставит значение по умолчанию.
        if field == "pay_tbank_taxation" and val not in client_payments.TBANK_TAXATIONS:
            val = None
        if field == "pay_tbank_vat" and val not in client_payments.TBANK_VATS:
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
                  pay_prodamus_url, pay_prodamus_secret,
                  pay_tbank_terminal_key, pay_tbank_password,
                  pay_tbank_test_terminal_key, pay_tbank_test_password,
                  pay_tbank_test_mode,
                  pay_tbank_taxation, pay_tbank_vat
             FROM clients WHERE id = $1""",
        client_id,
    )
    saved = dict(row or {})
    provider = (data.pay_provider or saved.get("pay_provider") or "").strip().lower()

    creds = {}
    for field in ("pay_leadpay_login", "pay_leadpay_token",
                  "pay_prodamus_url", "pay_prodamus_secret",
                  "pay_tbank_terminal_key", "pay_tbank_password",
                  "pay_tbank_test_terminal_key", "pay_tbank_test_password"):
        creds[field] = (getattr(data, field) or "").strip() or (saved.get(field) or "")
    # ⚠️ Режим — из формы, если прислали: клиент жмёт «Проверить» сразу после
    # переключения галочки, до сохранения, и ждёт проверки НОВОГО режима.
    creds["pay_tbank_test_mode"] = (
        data.pay_tbank_test_mode if data.pay_tbank_test_mode is not None
        else saved.get("pay_tbank_test_mode"))

    ok, message = await client_payments.check_credentials(provider, creds)
    return {"ok": ok, "message": message}
