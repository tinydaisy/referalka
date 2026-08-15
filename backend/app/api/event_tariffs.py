"""
Тарифы мероприятия — настройка платных тарифов события (VIP и др.) и
просмотр «кто оплатил».

Раздел доступен только клиентам тарифа `vip` (write-операции — 403 для
остальных). Само наличие тарифов у события — это то, что позволяет вебхуку
оплаты (`/integrations/payment/paid`) засчитать покупку.

API (требуют JWT владельца кабинета):
  GET    /api/v1/events/{event_id}/tariffs
  POST   /api/v1/events/{event_id}/tariffs
  PATCH  /api/v1/events/{event_id}/tariffs/{tariff_id}
  DELETE /api/v1/events/{event_id}/tariffs/{tariff_id}
  POST   /api/v1/events/{event_id}/tariffs/reorder
  GET    /api/v1/events/{event_id}/tariffs/{tariff_id}/buyers

Создано миграцией 157 (event_tariffs, event_participant_tariffs, events.offer_url).
Скидка тарифа — миграция 305.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import asyncpg

from app.database import get_db
from app.auth import get_current_client
from app.services.features import client_has_feature
from app.services.tariff_discount import with_discount

router = APIRouter(prefix="/events/{event_id}/tariffs", tags=["Тарифы мероприятия"])


async def _check_event_access(db, client_id: int, event_id: int):
    row = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND id IN "
        "(SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено или нет доступа")


async def _assert_vip(db, client_id: int):
    """Раздел тарифов мероприятия — только при включённой фиче event_tariffs.

    Фича включается через tariff_features (сейчас — у скрытого тарифа admin,
    в будущем можно добавить в любой публичный тариф). Никакого хардкода по
    tariff_slug или client_id.
    """
    if not await client_has_feature(db, client_id, "event_tariffs"):
        raise HTTPException(
            status_code=403,
            detail="Раздел «Тарифы мероприятия» недоступен на вашем тарифе.",
        )


class TariffIn(BaseModel):
    code: str
    title: str
    description: Optional[str] = None
    # Что в тариф НЕ входит — на лендинге показывается зачёркнутым с крестиком.
    excluded_description: Optional[str] = None
    price: Optional[int] = None
    pay_url: Optional[str] = None
    # Код товара в платёжной системе клиента (миграция 257). Задан → ссылку
    # оплаты создаём сами и ловим оплату вебхуком; иначе — внешний pay_url.
    pay_product_id: Optional[str] = None
    # Предупреждение над формой заказа (белым по красному).
    order_hint: Optional[str] = None
    # Скидка (миграция 305): 'percent' | 'amount' | None.
    # ⚠️ price — цена К ОПЛАТЕ (уже со скидкой); старая цена вычисляется.
    discount_kind: Optional[str] = None
    discount_value: Optional[int] = None
    sort_order: int = 0
    is_active: bool = True
    is_featured: bool = False


class TariffPatch(BaseModel):
    code: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    excluded_description: Optional[str] = None
    price: Optional[int] = None
    pay_url: Optional[str] = None
    pay_product_id: Optional[str] = None
    order_hint: Optional[str] = None
    discount_kind: Optional[str] = None
    discount_value: Optional[int] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None
    is_featured: Optional[bool] = None


class TariffsReorder(BaseModel):
    """Порядок тарифов — как клиент расставил в кабинете, так и на лендинге."""
    ids: List[int]


def _norm_discount(kind: Optional[str], value: Optional[int]) -> tuple:
    """Привести пару «вид + размер» к валидному состоянию.

    Пустой размер или нераспознанный вид = скидки нет: хранить половину пары
    нельзя (CHECK не пустит, да и непонятно, рубли это или проценты).
    """
    if not kind or value is None:
        return None, None
    kind = str(kind).strip().lower()
    if kind not in ("percent", "amount"):
        return None, None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None, None
    if value <= 0:
        return None, None
    if kind == "percent" and value >= 100:
        raise HTTPException(status_code=400, detail="Скидка в процентах должна быть меньше 100")
    return kind, value


def _norm_code(code: str) -> str:
    return (code or "").strip().lower()


@router.get("", summary="Тарифы мероприятия + счётчик оплативших")
async def list_tariffs(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    rows = await db.fetch(
        """SELECT t.id, t.code, t.title, t.description, t.excluded_description,
                  t.price, t.discount_kind, t.discount_value,
                  t.pay_url, t.pay_product_id, t.order_hint,
                  t.sort_order, t.is_active, t.is_featured,
                  (SELECT COUNT(*) FROM event_participant_tariffs ept
                     WHERE ept.tariff_id = t.id AND ept.status = 'paid') AS buyers_count,
                  (SELECT COUNT(*) FROM event_participant_tariffs ept
                     WHERE ept.tariff_id = t.id AND ept.status = 'unpaid') AS unpaid_count
             FROM event_tariffs t
            WHERE t.event_id = $1
            ORDER BY t.sort_order, t.id""",
        event_id,
    )
    return {"items": [with_discount(r) for r in rows]}


@router.get("-orders", summary="Все заказы события (по всем тарифам) — для сводной таблицы")
async def list_all_orders(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    rows = await db.fetch(
        """SELECT ept.id, ept.participant_id, ept.tariff_id, ept.status,
                  ept.paid_at, ept.ordered_at, ept.source, ept.amount, ept.note,
                  t.code AS tariff_code, t.title AS tariff_title, t.price AS tariff_price,
                  c.id AS contact_id, c.name AS contact_name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS max_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS max_username,
                  -- Партнёр = кто привёл (referrer) этого участника на событие
                  (SELECT rc.name FROM contacts rc WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1) AS referrer_name,
                  (SELECT rc.id FROM contacts rc WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1) AS referrer_contact_id
             FROM event_participant_tariffs ept
             JOIN event_tariffs t ON t.id = ept.tariff_id
             JOIN event_participants ep ON ep.id = ept.participant_id
             JOIN contacts c ON c.id = ep.contact_id
            WHERE ept.event_id = $1
            ORDER BY t.sort_order, t.id, COALESCE(ept.paid_at, ept.ordered_at) DESC, ept.id DESC""",
        event_id,
    )
    # справочник тарифов для фильтров
    tariffs = await db.fetch(
        "SELECT id, code, title, price FROM event_tariffs WHERE event_id = $1 ORDER BY sort_order, id",
        event_id,
    )
    return {
        "orders": [dict(r) for r in rows],
        "tariffs": [dict(t) for t in tariffs],
    }


@router.post("", summary="Создать тариф")
async def create_tariff(
    event_id: int,
    data: TariffIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)
    code = _norm_code(data.code)
    if not code:
        raise HTTPException(status_code=400, detail="Код тарифа обязателен")
    if not (data.title or "").strip():
        raise HTTPException(status_code=400, detail="Название тарифа обязательно")
    exists = await db.fetchval(
        "SELECT 1 FROM event_tariffs WHERE event_id = $1 AND code = $2", event_id, code
    )
    if exists:
        raise HTTPException(status_code=409, detail=f"Тариф с кодом «{code}» уже есть у события")
    d_kind, d_value = _norm_discount(data.discount_kind, data.discount_value)

    # Новый тариф встаёт В КОНЕЦ списка. С sort_order=0 он прыгал бы наверх
    # и ломал уже расставленный клиентом порядок.
    sort_order = data.sort_order
    if not sort_order:
        last = await db.fetchval(
            "SELECT COALESCE(MAX(sort_order), 0) FROM event_tariffs WHERE event_id = $1",
            event_id,
        )
        sort_order = int(last or 0) + 10

    row = await db.fetchrow(
        """INSERT INTO event_tariffs (event_id, code, title, description, excluded_description,
                                     price, discount_kind, discount_value,
                                     pay_url, pay_product_id, order_hint,
                                     sort_order, is_active, is_featured)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id, code, title, description, excluded_description, price,
                     discount_kind, discount_value, pay_url,
                     pay_product_id, order_hint, sort_order, is_active, is_featured""",
        event_id, code, data.title.strip(), data.description, data.excluded_description,
        data.price, d_kind, d_value,
        data.pay_url, data.pay_product_id, data.order_hint, sort_order,
        data.is_active, data.is_featured,
    )
    return with_discount(row)


@router.post("/reorder", summary="Порядок тарифов (перетаскивание)")
async def reorder_tariffs(
    event_id: int,
    data: TariffsReorder,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Как клиент расставил тарифы в кабинете, так они идут и на лендинге.

    ⚠️ Объявлен ДО `/{tariff_id}` — иначе тот перехватит «reorder» как id.
    Шаг 10 (как у блоков лендинга): между соседями можно вставить вручную.
    """
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)

    async with db.transaction():
        for i, tid in enumerate(data.ids):
            await db.execute(
                "UPDATE event_tariffs SET sort_order = $1, updated_at = NOW() "
                "WHERE id = $2 AND event_id = $3",
                (i + 1) * 10, int(tid), event_id,
            )
    return {"ok": True}


@router.patch("/{tariff_id}", summary="Изменить тариф")
async def update_tariff(
    event_id: int,
    tariff_id: int,
    data: TariffPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)
    cur = await db.fetchrow(
        "SELECT id FROM event_tariffs WHERE id = $1 AND event_id = $2", tariff_id, event_id
    )
    if not cur:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    fields = data.model_dump(exclude_unset=True)
    if "code" in fields:
        code = _norm_code(fields["code"])
        if not code:
            raise HTTPException(status_code=400, detail="Код тарифа не может быть пустым")
        clash = await db.fetchval(
            "SELECT 1 FROM event_tariffs WHERE event_id = $1 AND code = $2 AND id <> $3",
            event_id, code, tariff_id,
        )
        if clash:
            raise HTTPException(status_code=409, detail=f"Тариф с кодом «{code}» уже есть у события")
        fields["code"] = code
    if "title" in fields:
        fields["title"] = (fields["title"] or "").strip()
        if not fields["title"]:
            raise HTTPException(status_code=400, detail="Название тарифа не может быть пустым")

    # Скидка — ПАРА полей. Прислали хоть одно — нормализуем и пишем оба,
    # иначе в базе останется половина (вид без размера) и упрёмся в CHECK.
    if "discount_kind" in fields or "discount_value" in fields:
        cur_d = await db.fetchrow(
            "SELECT discount_kind, discount_value FROM event_tariffs WHERE id = $1", tariff_id
        )
        kind = fields.get("discount_kind", cur_d["discount_kind"])
        value = fields.get("discount_value", cur_d["discount_value"])
        fields["discount_kind"], fields["discount_value"] = _norm_discount(kind, value)

    if not fields:
        return {"ok": True}

    sets = ", ".join(f"{k} = ${i+3}" for i, k in enumerate(fields.keys()))
    row = await db.fetchrow(
        f"""UPDATE event_tariffs SET {sets}, updated_at = NOW()
             WHERE id = $1 AND event_id = $2
         RETURNING id, code, title, description, excluded_description, price,
                   discount_kind, discount_value, pay_url,
                   pay_product_id, order_hint, sort_order, is_active, is_featured""",
        tariff_id, event_id, *fields.values(),
    )
    return with_discount(row)


@router.delete("/{tariff_id}", summary="Удалить тариф")
async def delete_tariff(
    event_id: int,
    tariff_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)
    await db.execute(
        "DELETE FROM event_tariffs WHERE id = $1 AND event_id = $2", tariff_id, event_id
    )
    return {"ok": True}


@router.get("/{tariff_id}/buyers", summary="Кто оплатил тариф")
async def list_buyers(
    event_id: int,
    tariff_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    tariff = await db.fetchrow(
        "SELECT id, code, title FROM event_tariffs WHERE id = $1 AND event_id = $2",
        tariff_id, event_id,
    )
    if not tariff:
        raise HTTPException(status_code=404, detail="Тариф не найден")
    rows = await db.fetch(
        """SELECT ept.id, ept.participant_id, ept.status, ept.paid_at, ept.ordered_at,
                  ept.source, ept.amount, ept.external_payment_id, ept.note,
                  c.id AS contact_id, c.name AS contact_name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS max_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS max_username
             FROM event_participant_tariffs ept
             JOIN event_participants ep ON ep.id = ept.participant_id
             JOIN contacts c ON c.id = ep.contact_id
            WHERE ept.tariff_id = $1
            ORDER BY COALESCE(ept.paid_at, ept.ordered_at) DESC, ept.id DESC""",
        tariff_id,
    )
    all_rows = [dict(r) for r in rows]
    paid = [r for r in all_rows if r.get("status") == "paid"]
    unpaid = [r for r in all_rows if r.get("status") == "unpaid"]
    return {
        "tariff": dict(tariff),
        "count": len(paid),               # обратная совместимость: count = оплатившие
        "buyers": paid,                   # обратная совместимость: buyers = оплатившие
        "paid": paid,
        "unpaid": unpaid,
        "paid_count": len(paid),
        "unpaid_count": len(unpaid),
    }


class AddBuyerRequest(BaseModel):
    # Кого отметить: либо участника события, либо контакт
    # (контакт → создаём/находим участие в событии). Хотя бы одно обязательно.
    participant_id: Optional[int] = None
    contact_id: Optional[int] = None
    amount: Optional[int] = None
    status: str = "paid"   # 'paid' (оплатил) | 'unpaid' (имеет заказ, не оплатил)
    note: Optional[str] = None


@router.post("/{tariff_id}/buyers", summary="Вручную отметить оплатившего (участник или контакт)")
async def add_buyer(
    event_id: int,
    tariff_id: int,
    data: AddBuyerRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)

    tariff = await db.fetchval(
        "SELECT id FROM event_tariffs WHERE id = $1 AND event_id = $2", tariff_id, event_id
    )
    if not tariff:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    participant_id = data.participant_id
    # Если передан contact_id — создаём/находим участие этого контакта в событии.
    if participant_id is None:
        if data.contact_id is None:
            raise HTTPException(status_code=400, detail="Укажите участника или контакт")
        contact_ok = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
            data.contact_id, client_id,
        )
        if not contact_ok:
            raise HTTPException(status_code=404, detail="Контакт не найден")
        prow = await db.fetchrow(
            """INSERT INTO event_participants (event_id, contact_id, is_registered, registered_at)
               VALUES ($1, $2, TRUE, NOW())
               ON CONFLICT (event_id, contact_id)
               DO UPDATE SET is_registered = TRUE
               RETURNING id""",
            event_id, data.contact_id,
        )
        participant_id = prow["id"]
    else:
        # Проверяем что участник принадлежит этому событию.
        ok = await db.fetchval(
            "SELECT 1 FROM event_participants WHERE id = $1 AND event_id = $2",
            participant_id, event_id,
        )
        if not ok:
            raise HTTPException(status_code=404, detail="Участник не найден в этом событии")

    status = data.status if data.status in ("paid", "unpaid") else "paid"
    # Запись о тарифе (идемпотентно) + участник зарегистрирован.
    note = (data.note or "").strip() or None
    if status == "paid":
        await db.execute(
            """INSERT INTO event_participant_tariffs (event_id, participant_id, tariff_id, status, paid_at, ordered_at, source, amount, note)
               VALUES ($1, $2, $3, 'paid', NOW(), NOW(), 'manual', $4, $5)
               ON CONFLICT (participant_id, tariff_id) DO UPDATE SET
                 status = 'paid', paid_at = NOW(), source = 'manual',
                 amount = COALESCE(EXCLUDED.amount, event_participant_tariffs.amount),
                 note = COALESCE(EXCLUDED.note, event_participant_tariffs.note)""",
            event_id, participant_id, tariff_id, data.amount, note,
        )
    else:  # unpaid — не понижаем уже оплаченный
        await db.execute(
            """INSERT INTO event_participant_tariffs (event_id, participant_id, tariff_id, status, ordered_at, source, amount, note)
               VALUES ($1, $2, $3, 'unpaid', NOW(), 'manual', $4, $5)
               ON CONFLICT (participant_id, tariff_id) DO UPDATE SET
                 status = CASE WHEN event_participant_tariffs.status = 'paid' THEN 'paid' ELSE 'unpaid' END,
                 ordered_at = COALESCE(event_participant_tariffs.ordered_at, NOW()),
                 source = 'manual',
                 amount = COALESCE(EXCLUDED.amount, event_participant_tariffs.amount),
                 note = COALESCE(EXCLUDED.note, event_participant_tariffs.note)""",
            event_id, participant_id, tariff_id, data.amount, note,
        )
    await db.execute(
        "UPDATE event_participants SET is_registered = TRUE WHERE id = $1", participant_id
    )
    return {"ok": True, "participant_id": participant_id, "status": status}


@router.delete("/{tariff_id}/buyers/{participant_id}", summary="Снять отметку оплаты")
async def remove_buyer(
    event_id: int,
    tariff_id: int,
    participant_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)
    await db.execute(
        "DELETE FROM event_participant_tariffs WHERE tariff_id = $1 AND participant_id = $2 AND event_id = $3",
        tariff_id, participant_id, event_id,
    )
    return {"ok": True}


class BuyerPatchRequest(BaseModel):
    note: Optional[str] = None              # заметка организатора
    status: Optional[str] = None            # 'paid' | 'unpaid'
    move_to_tariff_id: Optional[int] = None # перенести запись на другой тариф
    amount: Optional[int] = None            # фактически внесённая сумма (для скидок)
    amount_set: bool = False                # явный флаг: пришёл amount (даже null → обнулить)


@router.patch("/{tariff_id}/buyers/{participant_id}", summary="Изменить запись: заметка / статус / перенос на другой тариф")
async def patch_buyer(
    event_id: int,
    tariff_id: int,
    participant_id: int,
    data: BuyerPatchRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)

    cur = await db.fetchrow(
        "SELECT id FROM event_participant_tariffs WHERE tariff_id = $1 AND participant_id = $2 AND event_id = $3",
        tariff_id, participant_id, event_id,
    )
    if not cur:
        raise HTTPException(status_code=404, detail="Запись не найдена")

    # Перенос на другой тариф — меняем tariff_id (с проверкой что целевой тариф этого события)
    if data.move_to_tariff_id is not None and data.move_to_tariff_id != tariff_id:
        target = await db.fetchval(
            "SELECT id FROM event_tariffs WHERE id = $1 AND event_id = $2",
            data.move_to_tariff_id, event_id,
        )
        if not target:
            raise HTTPException(status_code=404, detail="Целевой тариф не найден")
        # Если у участника уже есть запись на целевом тарифе — не плодим дубль:
        # удаляем текущую, целевую обновляем (заметку/статус перенесём ниже).
        dup = await db.fetchval(
            "SELECT id FROM event_participant_tariffs WHERE tariff_id = $1 AND participant_id = $2",
            data.move_to_tariff_id, participant_id,
        )
        if dup:
            await db.execute("DELETE FROM event_participant_tariffs WHERE id = $1", cur["id"])
        else:
            await db.execute(
                "UPDATE event_participant_tariffs SET tariff_id = $1 WHERE id = $2",
                data.move_to_tariff_id, cur["id"],
            )
        tariff_id = data.move_to_tariff_id  # дальнейшие правки — на новой записи

    # Точечные апдейты note/status
    sets = []
    vals: list = []
    if data.note is not None:
        sets.append(f"note = ${len(vals)+1}")
        vals.append(data.note.strip() or None)
    if data.status in ("paid", "unpaid"):
        sets.append(f"status = ${len(vals)+1}")
        vals.append(data.status)
        if data.status == "paid":
            sets.append("paid_at = NOW()")
    if data.amount_set:
        sets.append(f"amount = ${len(vals)+1}")
        vals.append(data.amount)
    if sets:
        vals.extend([tariff_id, participant_id])
        await db.execute(
            f"UPDATE event_participant_tariffs SET {', '.join(sets)} "
            f"WHERE tariff_id = ${len(vals)-1} AND participant_id = ${len(vals)}",
            *vals,
        )
    return {"ok": True}
