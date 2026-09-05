"""Раздел клиента «Моя партнёрка» — настройки, партнёры, продажи, выплаты.

⚠️ Не путать с `/dashboard/partner-program` (реф-программа САМОГО ПЛЮСОНа), где
клиент выступает партнёром платформы и получает кэшбэк. Здесь наоборот: у
клиента свои партнёры, и деньги им платит ОН САМ (решение № 1) — платформа
только считает вознаграждение и показывает, кому сколько.

Три подраздела (№ 41):

    Настройки — умолчание вознаграждения, уровни, затухание, режим выплат
    Партнёры  — список с двумя суммами: сколько ПРИНЁС и сколько К ВЫПЛАТЕ
    Продажи   — все продажи партнёров с признаком выплаты

⚠️ Две суммы у партнёра — разные вещи, и подписывать их надо явно:
    «принёс»    — ОБОРОТ, сколько заплатили приведённые им покупатели;
    «к выплате» — ВОЗНАГРАЖДЕНИЕ партнёра, начисленное и ещё не выплаченное.

Гейт — фича `partner_program` (никогда по tariff_slug). ⚠️ На чтение раздел
открыт: это данные клиента, он за них заплатил. Гейт стоит на записи — тот же
принцип «смотреть можно, менять нельзя», что у платных модулей.
"""

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.assistant_access import assistant_is_restricted
from app.services.features import client_has_feature

router = APIRouter(prefix="/partner-program", tags=["Моя партнёрка"])


async def _assert_write(db, user) -> int:
    """Право на запись: фича + не ограниченный помощник."""
    client_id = int(user["sub"])
    if await assistant_is_restricted(user):
        raise HTTPException(status_code=403,
                            detail="Партнёрская программа доступна только владельцу кабинета.")
    if not await client_has_feature(db, client_id, "partner_program"):
        raise HTTPException(status_code=403,
                            detail="Партнёрская программа недоступна на вашем тарифе.")
    return client_id


# ─── Настройки ────────────────────────────────────────────────────────────────

class SettingsIn(BaseModel):
    partner_default_reward_kind: Optional[str] = None
    partner_default_reward_value: Optional[float] = None
    partner_levels: Optional[int] = None
    partner_level_decay: Optional[float] = None
    partner_payout_mode: Optional[str] = None
    tab_label_partner: Optional[str] = None


@router.get("/settings", summary="Настройки партнёрской программы")
async def get_settings(user=Depends(get_current_client),
                       db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """SELECT partner_default_reward_kind, partner_default_reward_value,
                  COALESCE(partner_levels, 1)               AS partner_levels,
                  partner_level_decay,
                  COALESCE(partner_payout_mode, 'passive')  AS partner_payout_mode,
                  tab_label_partner
             FROM clients WHERE id = $1""",
        int(user["sub"]),
    )
    data = dict(row) if row else {}
    data["has_feature"] = await client_has_feature(
        db, int(user["sub"]), "partner_program")
    return data


@router.patch("/settings", summary="Изменить настройки")
async def update_settings(data: SettingsIn, user=Depends(get_current_client),
                          db: asyncpg.Connection = Depends(get_db)):
    client_id = await _assert_write(db, user)
    fs = data.model_fields_set

    if "partner_payout_mode" in fs and data.partner_payout_mode not in ("active", "passive"):
        raise HTTPException(status_code=400, detail="Режим выплат: active или passive.")
    if "partner_default_reward_kind" in fs and data.partner_default_reward_kind:
        if data.partner_default_reward_kind not in ("percent", "fixed"):
            raise HTTPException(status_code=400,
                                detail="Вид вознаграждения: percent или fixed.")

    sets, args = [], []
    # ⚠️ Через model_fields_set, а не `is not None`: Pydantic не различает
    # «не прислали» и «прислали null», и без этого очистить поле было бы
    # нельзя — тот же приём, что в PATCH /clients/me/profile.
    for field in ("partner_default_reward_kind", "partner_default_reward_value",
                  "partner_levels", "partner_level_decay", "partner_payout_mode",
                  "tab_label_partner"):
        if field in fs:
            value = getattr(data, field)
            if field == "tab_label_partner" and isinstance(value, str):
                value = value.strip() or None
            args.append(value)
            sets.append(f"{field} = ${len(args) + 1}")

    if not sets:
        return {"ok": True}

    # Пара «вид + значение» пишется целиком: половина пары в базе — это
    # «непонятно, рубли или проценты» (CHECK такую строку не пропустит).
    if ("partner_default_reward_kind" in fs) != ("partner_default_reward_value" in fs):
        raise HTTPException(
            status_code=400,
            detail="Вид и размер вознаграждения задаются вместе.")

    await db.execute(
        f"UPDATE clients SET {', '.join(sets)} WHERE id = $1", client_id, *args)
    return {"ok": True}


# ─── Партнёры ─────────────────────────────────────────────────────────────────

@router.get("/partners", summary="Список партнёров")
async def list_partners(user=Depends(get_current_client),
                        db: asyncpg.Connection = Depends(get_db)):
    """Партнёры с двумя суммами: сколько принёс и сколько к выплате (№ 41).

    ⚠️ «Принёс» — оборот по НЕВЫПЛАЧЕННЫМ и выплаченным начислениям вместе:
    это заслуга партнёра целиком, она не обнуляется выплатой. «К выплате» —
    только то, за что ещё не платили (`payout_id IS NULL`).
    """
    rows = await db.fetch(
        """SELECT p.id, p.contact_id, p.tax_status, p.payout_mode, p.is_active,
                  p.accepted_at, p.created_at,
                  c.name, c.phone, c.ref_code,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                    ORDER BY pu.id LIMIT 1) AS email,
                  COALESCE((SELECT SUM(a.base_amount) FROM partner_accruals a
                             WHERE a.partner_id = p.id AND a.level = 1), 0) AS turnover,
                  COALESCE((SELECT SUM(a.amount) FROM partner_accruals a
                             WHERE a.partner_id = p.id AND a.payout_id IS NULL), 0) AS due,
                  COALESCE((SELECT SUM(a.amount) FROM partner_accruals a
                             WHERE a.partner_id = p.id AND a.payout_id IS NOT NULL), 0) AS paid,
                  (SELECT COUNT(*) FROM contacts b WHERE b.partner_id = p.id) AS people
             FROM client_partners p
             JOIN contacts c ON c.id = p.contact_id
            WHERE p.client_id = $1
            ORDER BY due DESC, p.created_at DESC""",
        int(user["sub"]),
    )
    return {"partners": [_row(r) for r in rows]}


class PartnerPatch(BaseModel):
    payout_mode: Optional[str] = None
    is_active: Optional[bool] = None


@router.patch("/partners/{partner_id}", summary="Личный режим / отключение партнёра")
async def update_partner(partner_id: int, data: PartnerPatch,
                         user=Depends(get_current_client),
                         db: asyncpg.Connection = Depends(get_db)):
    """⚠️ Менять здесь можно ТОЛЬКО личный режим и активность.

    Сменить самого партнёра у человека нельзя ни отсюда, ни откуда-либо ещё
    (№ 16): закрепление живёт в `contacts.partner_id` и не переписывается.
    """
    client_id = await _assert_write(db, user)
    fs = data.model_fields_set

    if "payout_mode" in fs and data.payout_mode not in (None, "active", "passive"):
        raise HTTPException(status_code=400, detail="Режим выплат: active, passive или пусто.")

    sets, args = [], []
    for field in ("payout_mode", "is_active"):
        if field in fs:
            args.append(getattr(data, field))
            sets.append(f"{field} = ${len(args) + 2}")
    if not sets:
        return {"ok": True}

    updated = await db.fetchval(
        f"UPDATE client_partners SET {', '.join(sets)} "
        f"WHERE id = $1 AND client_id = $2 RETURNING id",
        partner_id, client_id, *args)
    if not updated:
        raise HTTPException(status_code=404, detail="Партнёр не найден")
    return {"ok": True}


@router.post("/partners/{partner_id}/payout", summary="Отметить «Выплачено»")
async def mark_payout(partner_id: int, user=Depends(get_current_client),
                      db: asyncpg.Connection = Depends(get_db)):
    """Закрывает все начисления партнёра, накопленные НА МОМЕНТ НАЖАТИЯ (№ 42).

    ⚠️⚠️ Фиксируем СПИСОК начислений, а не «всё, что было у партнёра». Иначе
    продажа, пришедшая через минуту после нажатия, оказалась бы помечена
    выплаченной, хотя денег за неё не давали. Поэтому id собираются ДО вставки
    выплаты, и обновляются ровно они.

    ⚠️ Нужна ЗАПИСЬ о выплате, а не флаг у начисления: без неё нельзя ответить
    «когда и сколько я ему заплатил» — а это спрашивают и партнёры, и налоговая.

    ⚠️ Дважды за одну продажу не платим: начисление с проставленным payout_id
    в выборку `payout_id IS NULL` больше не попадёт никогда.
    """
    client_id = await _assert_write(db, user)

    # ⚠️ Партнёр обязан принадлежать ЭТОМУ кабинету. Без проверки запрос с
    # чужим id отвечал бы «ок, выплачивать нечего» — то есть подтверждал бы
    # существование чужих партнёров.
    own = await db.fetchval(
        "SELECT 1 FROM client_partners WHERE id = $1 AND client_id = $2",
        partner_id, client_id)
    if not own:
        raise HTTPException(status_code=404, detail="Партнёр не найден")

    async with db.transaction():
        rows = await db.fetch(
            """SELECT id, amount FROM partner_accruals
                WHERE partner_id = $1 AND client_id = $2 AND payout_id IS NULL
                ORDER BY id
                FOR UPDATE""",
            partner_id, client_id,
        )
        if not rows:
            return {"ok": True, "paid": 0, "amount": 0, "empty": True}

        ids = [r["id"] for r in rows]
        total = sum(r["amount"] for r in rows)

        payout_id = await db.fetchval(
            """INSERT INTO partner_payouts (client_id, partner_id, amount)
               VALUES ($1, $2, $3) RETURNING id""",
            client_id, partner_id, total,
        )
        await db.execute(
            "UPDATE partner_accruals SET payout_id = $1 WHERE id = ANY($2::int[])",
            payout_id, ids,
        )

    return {"ok": True, "paid": len(ids), "amount": float(total), "payout_id": payout_id}


@router.get("/partners/{partner_id}/people", summary="Кто закреплён за партнёром")
async def partner_people(partner_id: int, user=Depends(get_current_client),
                         db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT c.id, c.name, c.phone, c.partner_bound_at,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                    ORDER BY pu.id LIMIT 1) AS email,
                  EXISTS (SELECT 1 FROM client_partners p2
                           WHERE p2.contact_id = c.id AND p2.client_id = $2) AS is_partner
             FROM contacts c
             JOIN client_partners p ON p.id = c.partner_id
            WHERE c.partner_id = $1 AND p.client_id = $2
            ORDER BY c.partner_bound_at DESC NULLS LAST""",
        partner_id, int(user["sub"]),
    )
    return {"people": [_row(r) for r in rows]}


# ─── Продажи ──────────────────────────────────────────────────────────────────

@router.get("/sales", summary="Продажи партнёров")
async def list_sales(partner_id: Optional[int] = None,
                     user=Depends(get_current_client),
                     db: asyncpg.Connection = Depends(get_db)):
    """Все продажи, по которым начислено вознаграждение.

    Единица списка — НАЧИСЛЕНИЕ, а не заказ: у одного заказа их бывает
    несколько (уровни), и каждое выплачивается своему человеку.
    """
    rows = await db.fetch(
        """SELECT a.id, a.level, a.source_kind, a.source_order_id,
                  a.base_amount, a.amount, a.created_at,
                  a.payout_id IS NOT NULL AS is_paid,
                  po.paid_at AS payout_at,
                  pc.name AS partner_name, a.partner_id,
                  bc.name AS buyer_name,
                  CASE a.source_kind
                       WHEN 'event' THEN (SELECT e.title FROM event_participant_tariffs t
                                            JOIN events e ON e.id = t.event_id
                                           WHERE t.id = a.source_order_id)
                       WHEN 'product' THEN (SELECT p2.title FROM product_orders o
                                              JOIN products p2 ON p2.id = o.product_id
                                             WHERE o.id = a.source_order_id)
                  END AS source_title
             FROM partner_accruals a
             JOIN client_partners p ON p.id = a.partner_id
             JOIN contacts pc ON pc.id = p.contact_id
             LEFT JOIN contacts bc ON bc.id = a.buyer_contact_id
             LEFT JOIN partner_payouts po ON po.id = a.payout_id
            WHERE a.client_id = $1
              AND ($2::int IS NULL OR a.partner_id = $2)
            ORDER BY a.created_at DESC
            LIMIT 500""",
        int(user["sub"]), partner_id,
    )
    return {"sales": [_row(r) for r in rows]}


@router.get("/payouts", summary="История выплат")
async def list_payouts(user=Depends(get_current_client),
                       db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT po.id, po.amount, po.paid_at, po.note, po.partner_id,
                  c.name AS partner_name,
                  (SELECT COUNT(*) FROM partner_accruals a WHERE a.payout_id = po.id) AS items
             FROM partner_payouts po
             JOIN client_partners p ON p.id = po.partner_id
             JOIN contacts c ON c.id = p.contact_id
            WHERE po.client_id = $1
            ORDER BY po.paid_at DESC
            LIMIT 200""",
        int(user["sub"]),
    )
    return {"payouts": [_row(r) for r in rows]}


def _row(r) -> dict:
    """asyncpg Record → dict с числами вместо Decimal.

    ⚠️ Decimal уезжает наружу СТРОКОЙ («2.00»), и фронт не может её сложить
    или сравнить. Приводим к float здесь, а не в каждом компоненте.
    """
    from decimal import Decimal
    out = dict(r)
    for k, v in out.items():
        if isinstance(v, Decimal):
            out[k] = float(v)
    return out
