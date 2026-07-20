"""Реф-программа ПЛЮСОНа — кабинет реферера.

Эндпойнты:
- `GET /api/v1/referrals/me` — баланс + ссылки + история транзакций + рефералы.
- `POST /api/v1/referrals/withdraw` — заявка на вывод (≥4000₽, активная платная подписка).
- `POST /api/v1/subscriptions/pay-with-bonus` — оплата подписки бонусами (тут же).
- Admin: `GET /api/v1/admin/withdrawals`, `POST /admin/withdrawals/{id}/complete|cancel`.
"""
import os
import logging
from datetime import timedelta
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.database import get_db
from app.auth import get_current_client, get_current_admin
from app.services.assistant_access import assistant_is_restricted
from app.services.bonuses import (
    get_balance,
    hold_for_withdrawal,
    cancel_withdrawal_return,
    mark_withdrawal_done,
    debit_bonus_for_payment,
)

logger = logging.getLogger(__name__)

WITHDRAWAL_MIN_KOPECKS = 400_000  # 4000₽

router = APIRouter(prefix="/referrals", tags=["Реф-программа"])
pay_router = APIRouter(prefix="/subscriptions", tags=["Оплата подписки бонусами"])
admin_router = APIRouter(prefix="/admin", tags=["Админ: заявки на вывод"])


@router.get("/me", summary="Кабинет реферера: баланс, ссылки, история, рефералы")
async def get_my_referral_dashboard(
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    if await assistant_is_restricted(user):
        raise HTTPException(status_code=403, detail="Реф-программа доступна только владельцу кабинета")

    client_id = int(user["sub"])
    client = await db.fetchrow(
        """SELECT c.referral_code, cs.source AS sub_source, cs.status AS sub_status,
                  (cs.expires_at > NOW()) AS sub_active
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
            WHERE c.id = $1""",
        client_id,
    )
    if not client:
        raise HTTPException(status_code=404, detail="Клиент не найден")

    balance = await get_balance(db, client_id)

    # Может ли клиент вывести: баланс ≥ 4000₽ И подписка активная платная (не trial)
    can_withdraw_threshold = balance >= WITHDRAWAL_MIN_KOPECKS
    sub_is_paid = client["sub_source"] == "paid" and bool(client["sub_active"])
    can_withdraw = can_withdraw_threshold and sub_is_paid
    block_reason = None
    if not can_withdraw_threshold:
        block_reason = f"До вывода нужно ещё {(WITHDRAWAL_MIN_KOPECKS - balance) / 100:.0f}₽"
    elif not sub_is_paid:
        block_reason = "Для вывода нужна активная платная подписка (не trial)"

    # Реф-ссылки
    web_link = f"https://pluson.ru/?pid={client['referral_code']}"
    bot_link = f"https://telegram.me/pluson_bot?start=ref{client['referral_code']}"

    # История бонусных операций — последние 100
    tx_rows = await db.fetch(
        """SELECT bt.id, bt.type, bt.amount_kopecks, bt.description, bt.created_at,
                  bt.source_order_id, bt.source_payer_id, bt.withdrawal_id,
                  c2.name AS source_payer_name
             FROM client_bonus_transactions bt
             LEFT JOIN clients c2 ON c2.id = bt.source_payer_id
            WHERE bt.client_id = $1
            ORDER BY bt.created_at DESC
            LIMIT 100""",
        client_id,
    )

    # Заявки на вывод (последние 20)
    wd_rows = await db.fetch(
        """SELECT id, amount_kopecks, status, payment_details, admin_note,
                  requested_at, completed_at
             FROM client_withdrawal_requests
            WHERE client_id = $1
            ORDER BY requested_at DESC
            LIMIT 20""",
        client_id,
    )

    # Привлечённые рефералы — все клиенты с referred_by_client_id = $1
    referrals = await db.fetch(
        """SELECT c.id, c.name, c.email, c.created_at,
                  cs.source AS sub_source, t.slug AS tariff_slug, t.name AS tariff_name,
                  cs.expires_at, (cs.expires_at > NOW()) AS sub_active,
                  COALESCE(c.referral_rate_percent, 10) AS rate_percent,
                  c.referral_accrual_until AS accrual_until,
                  (c.referral_accrual_until IS NOT NULL
                   AND c.referral_accrual_until < CURRENT_DATE) AS accrual_expired,
                  (SELECT COALESCE(SUM(amount_paid_card_kopecks), 0)
                     FROM subscription_orders WHERE client_id = c.id AND status = 'paid') AS total_paid_kopecks
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             LEFT JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.referred_by_client_id = $1
            ORDER BY c.created_at DESC""",
        client_id,
    )

    return {
        "referral_code": client["referral_code"],
        "links": {
            "web": web_link,
            "telegram": bot_link,
        },
        "balance_kopecks": balance,
        "balance_rub": balance / 100,
        "can_withdraw": can_withdraw,
        "withdrawal_threshold_kopecks": WITHDRAWAL_MIN_KOPECKS,
        "withdrawal_block_reason": block_reason,
        "transactions": [dict(t) for t in tx_rows],
        "withdrawal_requests": [dict(w) for w in wd_rows],
        "referrals": [dict(r) for r in referrals],
        "referrals_count": len(referrals),
    }


class WithdrawRequest(BaseModel):
    amount_kopecks: int
    payment_details: str  # реквизиты в свободной форме


@router.post("/withdraw", summary="Заявка на вывод бонусов")
async def create_withdrawal_request(
    data: WithdrawRequest,
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    if await assistant_is_restricted(user):
        raise HTTPException(status_code=403, detail="Вывод доступен только владельцу кабинета")

    client_id = int(user["sub"])

    # Проверка: активная платная подписка
    sub_check = await db.fetchrow(
        """SELECT cs.source, cs.status, (cs.expires_at > NOW()) AS sub_active
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
            WHERE c.id = $1""",
        client_id,
    )
    if not sub_check or sub_check["source"] != "paid" or not sub_check["sub_active"]:
        raise HTTPException(status_code=400, detail="Для вывода нужна активная платная подписка (не trial)")

    # Проверка минимума и реквизитов
    if data.amount_kopecks < WITHDRAWAL_MIN_KOPECKS:
        raise HTTPException(status_code=400, detail=f"Минимальная сумма для вывода — {WITHDRAWAL_MIN_KOPECKS / 100:.0f}₽")
    if not (data.payment_details or "").strip():
        raise HTTPException(status_code=400, detail="Укажите реквизиты для перевода")

    # Создаём заявку + замораживаем баланс (атомарно)
    async with db.transaction():
        wd_id = await db.fetchval(
            """INSERT INTO client_withdrawal_requests (client_id, amount_kopecks, payment_details)
               VALUES ($1, $2, $3)
               RETURNING id""",
            client_id, data.amount_kopecks, data.payment_details.strip(),
        )
        try:
            new_balance = await hold_for_withdrawal(
                db,
                client_id=client_id,
                amount_kopecks=data.amount_kopecks,
                withdrawal_id=wd_id,
            )
        except ValueError as e:
            # Откатим транзакцию, asyncpg бросит ошибку выше
            raise HTTPException(status_code=400, detail=str(e))

    # Уведомление Маргарите (Owner ПЛЮСОНа) в её notifications_telegram_chat_id
    try:
        await _notify_owner_about_new_withdrawal(db, client_id, wd_id, data.amount_kopecks, data.payment_details)
    except Exception as e:
        logger.exception("Failed to notify owner: %s", e)

    return {"id": wd_id, "balance_kopecks": new_balance, "status": "pending"}


class PayWithBonusRequest(BaseModel):
    tariff_slug: str


@pay_router.post("/pay-with-bonus", summary="Оплатить подписку бонусами (100% покрытие)")
async def pay_with_bonus(
    data: PayWithBonusRequest,
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Если бонусов хватает на полную цену тарифа — списываем баланс и
    продлеваем подписку без Prodamus. Частичная оплата (бонус+карта) НЕ
    поддерживается (требует динамической цены в Prodamus, которой нет).
    """
    if await assistant_is_restricted(user):
        raise HTTPException(status_code=403, detail="Оплата подписки доступна только владельцу кабинета")

    client_id = int(user["sub"])

    tariff = await db.fetchrow(
        """SELECT id, slug, name, price, default_duration_days
             FROM tariffs WHERE slug = $1 AND is_active = TRUE""",
        data.tariff_slug,
    )
    if not tariff:
        raise HTTPException(status_code=404, detail="Тариф не найден или неактивен")
    if float(tariff["price"]) <= 0:
        raise HTTPException(status_code=400, detail="Бесплатный тариф не требует оплаты")

    amount_kopecks = int(round(float(tariff["price"]) * 100))
    balance = await get_balance(db, client_id)
    if balance < amount_kopecks:
        raise HTTPException(
            status_code=400,
            detail=f"Недостаточно бонусов. На балансе {balance / 100:.0f}₽, нужно {amount_kopecks / 100:.0f}₽",
        )

    duration_days = int(tariff["default_duration_days"] or 30)

    async with db.transaction():
        # 1) Создаём subscription_order со 100% покрытием бонусами
        order_id = await db.fetchval(
            """INSERT INTO subscription_orders
                 (client_id, tariff_id, amount_total_kopecks, amount_paid_card_kopecks,
                  amount_paid_bonus_kopecks, status, paid_at)
               VALUES ($1, $2, $3, 0, $3, 'paid', NOW())
               RETURNING id""",
            client_id, tariff["id"], amount_kopecks,
        )

        # 2) Списываем бонусы
        try:
            await debit_bonus_for_payment(
                db,
                client_id=client_id,
                amount_kopecks=amount_kopecks,
                source_order_id=order_id,
                description=f"Оплата {tariff['name']} бонусами",
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # 3) Продлеваем подписку
        existing = await db.fetchrow(
            """SELECT id, expires_at FROM client_subscriptions
                WHERE client_id = $1 AND tariff_id = $2 AND status = 'active' AND expires_at > NOW()
                ORDER BY expires_at DESC LIMIT 1""",
            client_id, tariff["id"],
        )
        if existing:
            new_expires = existing["expires_at"] + timedelta(days=duration_days)
            await db.execute(
                "UPDATE client_subscriptions SET expires_at = $2, subscription_order_id = $3 WHERE id = $1",
                existing["id"], new_expires, order_id,
            )
        else:
            new_sub_id = await db.fetchval(
                """INSERT INTO client_subscriptions
                     (client_id, tariff_id, started_at, expires_at, status, source, subscription_order_id)
                   VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval, 'active', 'paid', $4)
                   RETURNING id""",
                client_id, tariff["id"], str(duration_days), order_id,
            )
            await db.execute(
                "UPDATE clients SET current_subscription_id = $1 WHERE id = $2",
                new_sub_id, client_id,
            )

    new_balance = await get_balance(db, client_id)
    return {
        "ok": True,
        "order_id": order_id,
        "amount_paid_bonus_kopecks": amount_kopecks,
        "new_balance_kopecks": new_balance,
    }


# ─── Админ-эндпоинты обработки заявок ─────────────────────────────────────────

@admin_router.get("/withdrawals", summary="Список заявок на вывод")
async def list_withdrawals(
    status: Optional[str] = None,  # 'pending'|'completed'|'cancelled'
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    where = ""
    args: list = []
    if status:
        where = "WHERE wr.status = $1"
        args.append(status)
    rows = await db.fetch(
        f"""SELECT wr.id, wr.client_id, wr.amount_kopecks, wr.status, wr.payment_details,
                   wr.admin_note, wr.requested_at, wr.completed_at,
                   c.name AS client_name, c.email AS client_email, c.telegram_username
              FROM client_withdrawal_requests wr
              JOIN clients c ON c.id = wr.client_id
             {where}
             ORDER BY wr.requested_at DESC
             LIMIT 200""",
        *args,
    )
    return {"withdrawals": [dict(r) for r in rows]}


class CompleteWithdrawal(BaseModel):
    admin_note: Optional[str] = None


@admin_router.post("/withdrawals/{wd_id}/complete", summary="Отметить выплату завершённой")
async def complete_withdrawal(
    wd_id: int,
    data: CompleteWithdrawal,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    wd = await db.fetchrow(
        "SELECT client_id, amount_kopecks, status FROM client_withdrawal_requests WHERE id = $1",
        wd_id,
    )
    if not wd:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    if wd["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Заявка уже {wd['status']}")

    async with db.transaction():
        await db.execute(
            """UPDATE client_withdrawal_requests
                  SET status = 'completed', admin_note = $2, completed_at = NOW()
                WHERE id = $1""",
            wd_id, data.admin_note,
        )
        await mark_withdrawal_done(
            db,
            client_id=wd["client_id"],
            amount_kopecks=wd["amount_kopecks"],
            withdrawal_id=wd_id,
        )

    # Уведомление клиенту
    try:
        await _notify_client_withdrawal_completed(db, wd["client_id"], wd["amount_kopecks"])
    except Exception as e:
        logger.exception("Failed to notify client about withdrawal_done: %s", e)

    return {"ok": True, "id": wd_id, "status": "completed"}


class CancelWithdrawal(BaseModel):
    admin_note: str  # причина отказа обязательна


@admin_router.post("/withdrawals/{wd_id}/cancel", summary="Отклонить заявку (вернуть бонусы)")
async def cancel_withdrawal(
    wd_id: int,
    data: CancelWithdrawal,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    wd = await db.fetchrow(
        "SELECT client_id, amount_kopecks, status FROM client_withdrawal_requests WHERE id = $1",
        wd_id,
    )
    if not wd:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    if wd["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Заявка уже {wd['status']}")
    if not (data.admin_note or "").strip():
        raise HTTPException(status_code=400, detail="Укажите причину отказа")

    async with db.transaction():
        await db.execute(
            """UPDATE client_withdrawal_requests
                  SET status = 'cancelled', admin_note = $2, completed_at = NOW()
                WHERE id = $1""",
            wd_id, data.admin_note.strip(),
        )
        await cancel_withdrawal_return(
            db,
            client_id=wd["client_id"],
            amount_kopecks=wd["amount_kopecks"],
            withdrawal_id=wd_id,
            reason=data.admin_note.strip(),
        )

    try:
        await _notify_client_withdrawal_cancelled(db, wd["client_id"], wd["amount_kopecks"], data.admin_note.strip())
    except Exception as e:
        logger.exception("Failed to notify client about withdrawal_cancel: %s", e)

    return {"ok": True, "id": wd_id, "status": "cancelled"}


# ─── Уведомления ──────────────────────────────────────────────────────────────

async def _send_tg(chat_id: int, text: str):
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not bot_token or not chat_id:
        return
    import httpx
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            )
        except Exception as e:
            logger.warning("Telegram send failed: %s", e)


async def _notify_owner_about_new_withdrawal(db, client_id: int, wd_id: int, amount_kopecks: int, details: str):
    """Уведомление Маргарите (Owner ПЛЮСОНа) о новой заявке."""
    owner = await db.fetchrow(
        """SELECT notifications_telegram_chat_id FROM clients
            WHERE is_system_service = TRUE OR id = 1
            ORDER BY id LIMIT 1"""
    )
    if not owner or not owner["notifications_telegram_chat_id"]:
        return
    payer = await db.fetchrow(
        "SELECT name, email, telegram_username FROM clients WHERE id = $1",
        client_id,
    )
    text = (
        f"📤 <b>Новая заявка на вывод бонусов</b>\n\n"
        f"Заявка #{wd_id}\n"
        f"Клиент: <b>{payer['name']}</b> ({payer['email']})\n"
        f"TG: @{payer.get('telegram_username') or '—'}\n"
        f"Сумма: <b>{amount_kopecks / 100:.0f}₽</b>\n\n"
        f"Реквизиты:\n<code>{details}</code>\n\n"
        f"Обработать в /admin/withdrawals"
    )
    await _send_tg(owner["notifications_telegram_chat_id"], text)


async def _notify_client_withdrawal_completed(db, client_id: int, amount_kopecks: int):
    row = await db.fetchrow(
        "SELECT notifications_telegram_chat_id FROM clients WHERE id = $1",
        client_id,
    )
    if row and row["notifications_telegram_chat_id"]:
        await _send_tg(
            row["notifications_telegram_chat_id"],
            f"💸 <b>Выплата выполнена</b>\n\n{amount_kopecks / 100:.0f}₽ переведены на указанные реквизиты."
        )


async def _notify_client_withdrawal_cancelled(db, client_id: int, amount_kopecks: int, reason: str):
    row = await db.fetchrow(
        "SELECT notifications_telegram_chat_id FROM clients WHERE id = $1",
        client_id,
    )
    if row and row["notifications_telegram_chat_id"]:
        await _send_tg(
            row["notifications_telegram_chat_id"],
            f"😕 <b>Заявка на вывод отклонена</b>\n\n"
            f"Сумма {amount_kopecks / 100:.0f}₽ возвращена на бонусный баланс.\n\n"
            f"Причина: {reason}"
        )


# ---------------------------------------------------------------------------
# Админ: настройки реф-программы (ставка + сроки). Миграция 227.
# ---------------------------------------------------------------------------

class ReferralSettingsUpdate(BaseModel):
    percent: Optional[int] = None
    signup_until: Optional[str] = None      # 'YYYY-MM-DD'
    accrual_until: Optional[str] = None     # 'YYYY-MM-DD'


@admin_router.get("/referral-settings", summary="Настройки реф-программы")
async def admin_get_referral_settings(
    db=Depends(get_db),
    admin=Depends(get_current_admin),
):
    from app.services.referral_rate import get_settings
    s = await get_settings(db)
    stats = await db.fetchrow(
        """SELECT count(*) AS total,
                  count(*) FILTER (WHERE referral_accrual_until >= CURRENT_DATE) AS active,
                  count(*) FILTER (WHERE referral_accrual_until <  CURRENT_DATE) AS expired
             FROM clients WHERE referred_by_client_id IS NOT NULL"""
    )
    return {
        "percent": s["percent"],
        "signup_until": str(s["signup_until"]),
        "accrual_until": str(s["accrual_until"]),
        "updated_at": s.get("updated_at"),
        "referred_total": stats["total"],
        "referred_active": stats["active"],
        "referred_expired": stats["expired"],
    }


@admin_router.patch("/referral-settings", summary="Изменить ставку и сроки")
async def admin_update_referral_settings(
    data: ReferralSettingsUpdate,
    db=Depends(get_db),
    admin=Depends(get_current_admin),
):
    """Меняет ставку для БУДУЩИХ приведённых. Уже приведённым ничего не меняет —
    у них ставка заморожена на карточке клиента (миграция 227)."""
    fields, args = [], []
    if data.percent is not None:
        if not (0 <= data.percent <= 100):
            raise HTTPException(400, "Процент должен быть от 0 до 100")
        args.append(data.percent)
        fields.append(f"percent = ${len(args)}")
    for key in ("signup_until", "accrual_until"):
        val = getattr(data, key)
        if val:
            from datetime import date as _date
            try:
                args.append(_date.fromisoformat(val))
            except ValueError:
                raise HTTPException(400, f"Неверная дата в {key}: ожидается ГГГГ-ММ-ДД")
            fields.append(f"{key} = ${len(args)}")
    if not fields:
        raise HTTPException(400, "Нечего менять")
    fields.append("updated_at = now()")
    await db.execute(
        f"UPDATE referral_program_settings SET {', '.join(fields)} WHERE id = 1",
        *args,
    )
    return await admin_get_referral_settings(db=db, admin=admin)
