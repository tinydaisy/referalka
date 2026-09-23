"""Реф-программа ПЛЮСОНа — кабинет реферера.

Эндпойнты:
- `GET /api/v1/referrals/me` — баланс + ссылки + история транзакций + рефералы.
- `POST /api/v1/referrals/withdraw` — заявка на вывод (≥4000₽ + принятая партнёрская оферта со статусом).
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
from app.services.person_name import DISPLAY_NAME_SQL
from app.services.bonuses import (
    get_balance,
    hold_for_withdrawal,
    cancel_withdrawal_return,
    mark_withdrawal_done,
    debit_bonus_for_payment,
)
from app.services import tariff_periods

logger = logging.getLogger(__name__)

WITHDRAWAL_MIN_KOPECKS = 400_000  # 4000₽

router = APIRouter(prefix="/referrals", tags=["Реф-программа"])
pay_router = APIRouter(prefix="/subscriptions", tags=["Оплата подписки бонусами"])
class PartnerAcceptRequest(BaseModel):
    """Акцепт партнёрской оферты (миграция 319)."""
    tax_status: str          # ip | company | self_employed


@router.post("/partner/accept", summary="Принять условия партнёрской программы")
async def accept_partner_offer(
    data: PartnerAcceptRequest,
    request: Request,
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Акцепт партнёрской оферты нажатием кнопки «Стать партнёром».

    ⚠️ Отдельное действие, а не часть регистрации: в партнёрской программе
    платит Оферент, а не Клиент, поэтому акцептовать оплатой нечем. Нажатие
    кнопки — конклюдентное действие по п. 3 ст. 438 ГК.

    ⚠️ Статус обязателен: выплаты возможны только ИП, юрлицам и самозанятым
    (см. комментарий в withdraw-проверке).
    """
    if await assistant_is_restricted(user):
        raise HTTPException(status_code=403, detail="Партнёрская программа доступна только владельцу кабинета")

    if data.tax_status not in ("ip", "company", "self_employed"):
        raise HTTPException(status_code=422, detail="Укажите статус: ИП, юридическое лицо или самозанятый")

    from app.services.legal_docs import PARTNER_OFFER_VERSION

    _fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    ip = _fwd or (request.client.host if request.client else None)

    row = await db.fetchrow(
        """UPDATE clients
              SET partner_offer_accepted_at = COALESCE(partner_offer_accepted_at, NOW()),
                  partner_offer_accepted_version = COALESCE(partner_offer_accepted_version, $2),
                  partner_offer_accepted_ip = COALESCE(partner_offer_accepted_ip, $3),
                  partner_tax_status = $4
            WHERE id = $1
        RETURNING partner_offer_accepted_at, partner_offer_accepted_version, partner_tax_status""",
        int(user["sub"]), PARTNER_OFFER_VERSION, ip, data.tax_status,
    )
    return {
        "accepted_at": row["partner_offer_accepted_at"],
        "accepted_version": row["partner_offer_accepted_version"],
        "tax_status": row["partner_tax_status"],
    }


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
                  (cs.expires_at > NOW()) AS sub_active,
                  c.partner_offer_accepted_at, c.partner_offer_accepted_version,
                  c.partner_tax_status
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
            WHERE c.id = $1""",
        client_id,
    )
    if not client:
        raise HTTPException(status_code=404, detail="Клиент не найден")

    balance = await get_balance(db, client_id)

    # Условия вывода: баланс ≥ минимума и принятая партнёрская оферта с
    # подтверждённым налоговым статусом.
    #
    # ⚠️ Статус обязателен (миграция 319): выплачивая вознаграждение обычному
    # физлицу, Оферент становится налоговым агентом (ст. 226 НК) и обязан
    # удержать НДФЛ и заплатить взносы. ИП на НПД налоговым агентом быть не
    # может — значит такая выплата для нас невозможна в принципе.
    #
    # ⚠️ Своя платная подписка НЕ требуется (решение владельца, 2026-08-20):
    # партнёром может быть кто угодно, а не только действующий пользователь
    # Платформы. Привёл клиента — заработал, пользуешься ты сам или нет.
    can_withdraw_threshold = balance >= WITHDRAWAL_MIN_KOPECKS
    partner_ok = bool(client["partner_offer_accepted_at"]) and bool(client["partner_tax_status"])
    can_withdraw = can_withdraw_threshold and partner_ok
    block_reason = None
    if not can_withdraw_threshold:
        block_reason = f"До вывода нужно ещё {(WITHDRAWAL_MIN_KOPECKS - balance) / 100:.0f}₽"
    elif not partner_ok:
        block_reason = ("Примите условия партнёрской программы и укажите свой статус "
                        "(ИП, юрлицо или самозанятый) — выплаты возможны только им")

    partner_info = {
        "accepted_at": client["partner_offer_accepted_at"],
        "accepted_version": client["partner_offer_accepted_version"],
        "tax_status": client["partner_tax_status"],
    }

    # Реф-ссылки. Payload `ref<код>` — один формат на все площадки; ветку его
    # разбора обязан иметь бот КАЖДОЙ площадки, иначе код молча теряется.
    #
    # ⚠️⚠️ ПЛОЩАДКИ СПРАШИВАЕМ У ОБЩЕЙ ФУНКЦИИ (`plusson_platforms`), своего
    # списка здесь больше НЕТ. Раньше три ссылки склеивались тут руками, вместе
    # с копией запроса про живой токен MAX-бота, — и ветку ВК в эту копию
    # просто не добавили: в Плюсоновском подарке ВК был, в партнёрке его не
    # было вовсе. Что показывать, решает админка, и решает один раз на все
    # места сразу.
    ref_code = client["referral_code"]
    web_link = f"https://pluson.ru/?pid={ref_code}"

    from app.services.plusson_ref_links import plusson_ref_links
    # source не передаём: это ОБЫЧНАЯ реф-ссылка клиента. Метка `-lm` в payload
    # означает «пришёл с Плюсоновского подарка», и ставить её здесь нельзя —
    # иначе в «Приведённых» все станут пришедшими с подарка.
    links: dict[str, str] = {"web": web_link}
    links.update(await plusson_ref_links(db, ref_code))

    # История бонусных операций — последние 100
    tx_rows = await db.fetch(
        """SELECT bt.id, bt.type, bt.amount_kopecks, bt.description, bt.created_at,
                  bt.source_order_id, bt.source_payer_id, bt.withdrawal_id,
                  -- ⚠️ Имя + фамилия (23.09.2026): «бонус от <кого>».
                  """ + DISPLAY_NAME_SQL("c2") + """ AS source_payer_name
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
        # ⚠️ `referred_source` (миграция 472) — чем привели человека: пусто —
        # обычной реф-ссылкой, `plusson_lm` — Плюсоновским лид-магнитом. Без
        # этого поля два потока в списке неразличимы: реф-код у них один.
        # ⚠️ Имя + фамилия (23.09.2026): список «мои рефералы» — кого я привёл.
        """SELECT c.id, """ + DISPLAY_NAME_SQL("c") + """ AS name,
                  c.email, c.created_at, c.referred_source,
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
        "links": links,
        "balance_kopecks": balance,
        "balance_rub": balance / 100,
        "can_withdraw": can_withdraw,
        "partner": partner_info,
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

    # ⚠️ Своя платная подписка для вывода НЕ требуется (решение владельца,
    # 2026-08-20): партнёром может быть кто угодно, а не только действующий
    # пользователь Платформы. Привёл клиента — заработал.
    #
    # ⚠️ А вот принятая партнёрская оферта и налоговый статус обязательны —
    # и проверять их надо ЗДЕСЬ, а не только при отрисовке кнопки: без этой
    # проверки заявку можно подать прямым запросом мимо интерфейса, и деньги
    # уйдут обычному физлицу, из-за чего Оферент станет налоговым агентом.
    partner_check = await db.fetchrow(
        "SELECT partner_offer_accepted_at, partner_tax_status FROM clients WHERE id = $1",
        client_id,
    )
    if not partner_check or not partner_check["partner_offer_accepted_at"] \
            or not partner_check["partner_tax_status"]:
        raise HTTPException(
            status_code=400,
            detail="Примите условия партнёрской программы и укажите свой статус "
                   "(ИП, юридическое лицо или самозанятый)",
        )


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
    # ⚠️ Тот же набор периодов, что у оплаты картой (1/6/12, миграция 360):
    # иначе бонусами нельзя было бы купить год со скидкой, хотя картой — можно.
    months: int = 1


@pay_router.post("/pay-with-bonus", summary="Оплатить подписку бонусами (100% покрытие)")
async def pay_with_bonus(
    data: PayWithBonusRequest,
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Если бонусов хватает на полную цену тарифа — списываем баланс и
    продлеваем подписку без Prodamus. Частичная оплата (бонус+карта) НЕ
    поддерживается (требует динамической цены в Prodamus, которой нет).

    ⚠️ Период (1/6/12 мес) считает та же точка, что и оплата картой —
    services/tariff_periods.py. Карточка LeadPay здесь не нужна: деньги не
    ходят наружу, поэтому провайдер передаётся как 'bonus'.

    ⚠️ Правило «только вся сумма целиком» сохранено, но при нехватке бонусов на
    длинный срок предлагаем срок КОРОЧЕ, а не просто отказываем: у человека
    может хватать на месяц, и молчать об этом незачем.
    """
    if await assistant_is_restricted(user):
        raise HTTPException(status_code=403, detail="Оплата подписки доступна только владельцу кабинета")

    client_id = int(user["sub"])

    tariff = await db.fetchrow(
        """SELECT id, slug, name, price, price_6mo, price_12mo, default_duration_days
             FROM tariffs WHERE slug = $1 AND is_active = TRUE""",
        data.tariff_slug,
    )
    if not tariff:
        raise HTTPException(status_code=404, detail="Тариф не найден или неактивен")
    if float(tariff["price"]) <= 0:
        raise HTTPException(status_code=400, detail="Бесплатный тариф не требует оплаты")

    try:
        period = tariff_periods.assert_payable(tariff, data.months, "bonus")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    months = period["months"]
    amount_kopecks = period["total_kopecks"]
    balance = await get_balance(db, client_id)
    if balance < amount_kopecks:
        # Подсказываем самый длинный срок, который бонусами уже закрывается.
        affordable = tariff_periods.affordable_months(tariff, balance, "bonus")
        hint = (
            f" Бонусов хватает на {affordable} мес.— выберите этот срок."
            if affordable and affordable != months else ""
        )
        raise HTTPException(
            status_code=400,
            detail=(
                f"Недостаточно бонусов. На балансе {balance / 100:.0f} ₽, "
                f"нужно {amount_kopecks / 100:.0f} ₽ за {months} мес.{hint}"
            ),
        )

    duration_days = int(tariff["default_duration_days"] or 30) * max(months, 1)

    async with db.transaction():
        # 1) Создаём subscription_order со 100% покрытием бонусами
        order_id = await db.fetchval(
            """INSERT INTO subscription_orders
                 (client_id, tariff_id, amount_total_kopecks, amount_paid_card_kopecks,
                  amount_paid_bonus_kopecks, status, paid_at, months)
               VALUES ($1, $2, $3, 0, $3, 'paid', NOW(), $4)
               RETURNING id""",
            client_id, tariff["id"], amount_kopecks, months,
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

class BonusAdjustRequest(BaseModel):
    """Ручное начисление или списание бонусов администратором."""
    amount_rub: float           # положительное — начислить, отрицательное — списать
    description: str


@admin_router.post("/clients/{client_id}/bonus-adjust", summary="Начислить/списать бонусы вручную")
async def admin_adjust_bonus_endpoint(
    client_id: int,
    data: BonusAdjustRequest,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Ручная корректировка бонусного баланса клиента.

    Нужна, когда вознаграждение начисляется вне автоматики: договорённость
    с партнёром, компенсация, а также списание при возврате оплаты
    Приведённым клиентом (п. 4.5 партнёрской Оферты).

    ⚠️ Операция видна клиенту в истории — поэтому причина обязательна.
    """
    from app.services.bonuses import admin_adjust_bonus

    if not (data.description or "").strip():
        raise HTTPException(status_code=422, detail="Укажите причину — она видна клиенту в истории")

    # Рубли → копейки через Decimal: float даёт 199.0*100 = 19899.999…
    from decimal import Decimal
    kopecks = int(Decimal(str(data.amount_rub)) * 100)
    if kopecks == 0:
        raise HTTPException(status_code=422, detail="Сумма не может быть нулевой")

    try:
        new_balance = await admin_adjust_bonus(
            db, client_id=client_id, amount_kopecks=kopecks,
            description=data.description,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {"balance_kopecks": new_balance, "balance_rub": new_balance / 100}


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
                   -- ⚠️ Имя + фамилия (23.09.2026): это заявка на ВЫПЛАТУ
                   -- денег («Заявка #12 от Ольга на 15 000 ₽») — по одному
                   -- имени не сверить человека с реквизитами перевода.
                   {DISPLAY_NAME_SQL("c")} AS client_name,
                   c.email AS client_email, c.telegram_username,
                   -- Налоговый статус партнёра (миграция 319): без него выплата
                   -- невозможна — Оферент не может быть налоговым агентом.
                   c.partner_tax_status, c.partner_offer_accepted_at
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
    trial_bonus_days: Optional[int] = None  # +дней триала за реф-ссылку (мигр. 306)


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
    # База триала — из самого тарифа: админу надо видеть итог («7 + 23 = 30»),
    # иначе непонятно, что реально получит пришедший по ссылке.
    trial_base = await db.fetchval(
        "SELECT default_duration_days FROM tariffs WHERE slug = 'trial'"
    ) or 7
    bonus = int(s.get("trial_bonus_days") or 0)
    return {
        "percent": s["percent"],
        "signup_until": str(s["signup_until"]),
        "accrual_until": str(s["accrual_until"]),
        "trial_bonus_days": bonus,
        "trial_base_days": int(trial_base),
        "trial_total_days": int(trial_base) + bonus,
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
    if data.trial_bonus_days is not None:
        if not (0 <= data.trial_bonus_days <= 365):
            raise HTTPException(400, "Бонус к триалу должен быть от 0 до 365 дней")
        args.append(data.trial_bonus_days)
        fields.append(f"trial_bonus_days = ${len(args)}")
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


# ─────────────────────────────────────────────────────────────────────────────
# Настройки Коллабораторной (миграция 264)
# ─────────────────────────────────────────────────────────────────────────────
class CollabHubSettingsUpdate(BaseModel):
    chat_url: Optional[str] = None       # Telegram
    chat_url_max: Optional[str] = None   # MAX (миграция 266)
    chat_title: Optional[str] = None


@admin_router.get("/collab-hub-settings", summary="Настройки Коллабораторной")
async def admin_get_collab_hub_settings(db=Depends(get_db), admin=Depends(get_current_admin)):
    row = await db.fetchrow(
        "SELECT chat_url, chat_url_max, chat_title, updated_at "
        "FROM collab_hub_settings WHERE id = 1")
    return {
        "chat_url": (row["chat_url"] if row else None) or "",
        "chat_url_max": (row["chat_url_max"] if row else None) or "",
        "chat_title": (row["chat_title"] if row else None) or "",
        "updated_at": row["updated_at"] if row else None,
    }


@admin_router.patch("/collab-hub-settings", summary="Изменить ссылку на закрытый чат")
async def admin_update_collab_hub_settings(
    data: CollabHubSettingsUpdate,
    db=Depends(get_db),
    admin=Depends(get_current_admin),
):
    """Ссылки на закрытый чат участников Коллабораторной: Telegram и MAX.

    ⚠️ Пустая строка — осмысленное значение (чата на этой площадке нет): кнопка
    тогда просто не показывается, а если пусты обе — нет и пункта меню. Поэтому
    смотрим на `model_fields_set`, а не на «не None»: иначе очистить поле было
    бы нельзя.
    """
    fields, args = [], []
    sent = data.model_fields_set

    def _url_or_none(raw: Optional[str]) -> Optional[str]:
        url = (raw or "").strip()
        if url and not url.startswith("http"):
            raise HTTPException(400, "Ссылка должна начинаться с http:// или https://")
        return url or None

    if "chat_url" in sent:
        args.append(_url_or_none(data.chat_url))
        fields.append(f"chat_url = ${len(args)}")
    if "chat_url_max" in sent:
        args.append(_url_or_none(data.chat_url_max))
        fields.append(f"chat_url_max = ${len(args)}")
    if "chat_title" in sent:
        args.append((data.chat_title or "").strip() or None)
        fields.append(f"chat_title = ${len(args)}")
    if not fields:
        raise HTTPException(400, "Нечего менять")
    fields.append("updated_at = now()")
    await db.execute(
        f"INSERT INTO collab_hub_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING")
    await db.execute(
        f"UPDATE collab_hub_settings SET {', '.join(fields)} WHERE id = 1", *args)
    return await admin_get_collab_hub_settings(db=db, admin=admin)
