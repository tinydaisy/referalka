"""
Заказ тарифа события: оформление, оплата, страница благодарности (мигр. 257).

Схема связывания (заменяет старую с GET-параметрами в GetCourse):
  1. Форма заказа на нашем лендинге сама опознаёт человека — по email/телефону
     находит контакт или заводит новый. Скрытые поля и параметры в адресе
     больше не нужны.
  2. Создаём заказ в `event_participant_tariffs` (status='unpaid').
  3. У платёжной системы КЛИЕНТА просим ссылку, передавая ТОЛЬКО номер заказа.
     Ни контакт, ни событие наружу не уходят.
  4. После оплаты система дёргает вебхук с этим номером → ставим 'paid',
     регистрируем участника.

⚠️ Бесплатный тариф (цена 0 или пусто) заказа НЕ создаёт — сразу регистрация.
Иначе в «Заказах» копился бы мусор из нулевых оплат.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from typing import Optional
import logging
import asyncpg

from app.database import get_db
from app.services import client_payments
from app.services.contact_merge import find_or_create_contact, resolve_ref_code
from app.services.participant_registration import finalize_participant_registration

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/public/event-orders", tags=["Заказы тарифов"])
webhook_router = APIRouter(prefix="/api/v1/integrations/client-pay",
                           tags=["Вебхук оплаты тарифа"])

_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _cors(response: Response) -> None:
    for k, v in _CORS.items():
        response.headers[k] = v


class OrderIn(BaseModel):
    tariff_id: int
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None
    contact_id: Optional[int] = None
    # Человек выбрал себя на экране «Это вы?» (несколько совпадений).
    chosen_contact_id: Optional[int] = None
    # Ничего из найденного не подошло — создаём новый контакт.
    force_new: bool = False
    # Реф-код того, кто привёл (?pid= в адресе лендинга). Позволяет вести
    # рекламу прямо на лендинг, без прохода через бота.
    ref_code: Optional[str] = None
    utm_source: Optional[str] = None
    consent_pd: bool = False
    consent_marketing: bool = False


async def _load_tariff(db, tariff_id: int):
    """Тариф + событие + владелец с ключами платёжной системы."""
    return await db.fetchrow(
        """SELECT t.id, t.code, t.title, t.price, t.pay_url, t.pay_product_id,
                  t.is_active,
                  e.id AS event_id, e.slug AS event_slug, e.title AS event_title,
                  e.skip_contact_form,
                  cl.id AS client_id, cl.name AS client_name,
                  cl.pay_provider, cl.pay_leadpay_login, cl.pay_leadpay_token
             FROM event_tariffs t
             JOIN events e ON e.id = t.event_id
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
             JOIN clients cl ON cl.id = eo.client_id
            WHERE t.id = $1
            ORDER BY eo.id LIMIT 1""",
        tariff_id,
    )


@router.options("/create", include_in_schema=False)
async def _opts(response: Response):
    _cors(response)
    return {}


@router.post("/create", summary="Оформить заказ тарифа")
async def create_order(
    data: OrderIn,
    request: Request,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    _cors(response)

    t = await _load_tariff(db, data.tariff_id)
    if not t or not t["is_active"]:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    # Согласия обязательны — это форма сбора контактных данных (152-ФЗ).
    if not data.consent_pd:
        raise HTTPException(
            status_code=400,
            detail="Без согласия на обработку персональных данных оформить заказ нельзя",
        )

    name = (data.name or "").strip()
    email = (data.email or "").strip() or None
    phone = (data.phone or "").strip() or None
    tg = (data.telegram_username or "").strip().lstrip("@") or None

    if not email and not phone:
        raise HTTPException(status_code=400, detail="Укажите email или телефон")

    # ── Кто заказывает ────────────────────────────────────────────────────
    # ⚠️ Тот же резолв, что у регистрации на событие из вебинарной комнаты
    # (register_event_from_deeplink): known_contact_id из ссылки цепляет
    # данные к ЭТОМУ контакту, не плодя дубль; без него идёт автомердж по
    # email/телефону/нику. Внутри есть защита от гонок (advisory-lock), так
    # что двойная отправка формы не создаст второй контакт.
    known_cid = None
    if data.contact_id:
        known_cid = await db.fetchval(
            """SELECT id FROM contacts
                WHERE id = $1 AND client_id = $2 AND merged_into IS NULL""",
            data.contact_id, t["client_id"],
        )

    # ⚠️ Идентичность из НИКА не создаём (как в вебинарной авторизации):
    # реального id мы не знаем, а псевдо-запись '@ник' конфликтует с уже
    # существующим числовым id того же человека — форма отказывала людям в
    # регистрации под их собственным ником. Ник используем только для ПОИСКА;
    # настоящая идентичность появится, когда человек зайдёт в бота.
    contact_id = known_cid

    # Человек уже выбрал себя на экране «Это вы?».
    if not contact_id and data.chosen_contact_id:
        contact_id = await db.fetchval(
            """SELECT id FROM contacts
                WHERE id = $1 AND client_id = $2 AND is_active = TRUE
                  AND merged_into IS NULL""",
            data.chosen_contact_id, t["client_id"],
        )

    # ⚠️ Email одного контакта, телефон другого — обычная ситуация: у человека
    # два аккаунта в базе. Молча брать первый нельзя (заказ уйдёт не тому),
    # сливать их автоматически — тем более. Показываем найденных и просим
    # выбрать, ровно как вебинарная авторизация.
    if not contact_id and not data.force_new:
        from app.services.contact_merge import resolve_or_ask
        found, cands, can_new = await resolve_or_ask(
            db, t["client_id"], email, phone, tg)
        if found:
            contact_id = found
        elif cands:
            return {"ok": False, "need_choice": True,
                    "candidates": cands, "can_create_new": can_new}

    if not contact_id:
        if data.force_new:
            # «Я здесь впервые» — создаём новый контакт, минуя автомердж.
            from app.services.contact_merge import create_new_contact
            contact_id = await create_new_contact(
                db, client_id=t["client_id"], name=name or None,
                email=email, phone=phone, utm_source=data.utm_source or None,
            )
        else:
            contact_id, _is_new = await find_or_create_contact(
                db,
                client_id=t["client_id"],
                name=name or None,
                email=email,
                phone=phone,
                lookup_telegram_username=tg,
            )

    # Кто привёл. Код может быть старым (merged_ref_codes) — резолвер это
    # учитывает. Свой собственный код игнорируем: сам себя не приводил.
    resolved_ref, referrer_contact_id = await resolve_ref_code(
        db, (data.ref_code or "").strip() or None, t["client_id"])
    if referrer_contact_id and referrer_contact_id == contact_id:
        resolved_ref, referrer_contact_id = None, None

    price = int(t["price"] or 0)

    # ── Бесплатный тариф: заказа нет, сразу регистрируем ─────────────────
    if price <= 0:
        # ⚠️ Рефовода записываем только если его ещё нет: первый, кто привёл,
        # и остаётся — иначе повторный заход по чужой ссылке перепишет.
        await db.execute(
            """INSERT INTO event_participants
                   (event_id, contact_id, is_registered, referrer_ref_code)
               VALUES ($1, $2, TRUE, $3)
               ON CONFLICT (event_id, contact_id)
               DO UPDATE SET is_registered = TRUE,
                             referrer_ref_code =
                               COALESCE(event_participants.referrer_ref_code, $3)""",
            t["event_id"], contact_id, resolved_ref,
        )
        await finalize_participant_registration(
            db, event_id=t["event_id"], contact_id=contact_id)
        return {
            "ok": True,
            "free": True,
            "redirect": f"/event/{t['event_slug']}?c={contact_id}",
        }

    # ── Платный тариф: заказ + ссылка на оплату ──────────────────────────
    participant_id = await db.fetchval(
        """INSERT INTO event_participants (event_id, contact_id, referrer_ref_code)
           VALUES ($1, $2, $3)
           ON CONFLICT (event_id, contact_id)
           DO UPDATE SET referrer_ref_code =
                           COALESCE(event_participants.referrer_ref_code, $3)
           RETURNING id""",
        t["event_id"], contact_id, resolved_ref,
    )

    order_id = await db.fetchval(
        """INSERT INTO event_participant_tariffs
               (event_id, participant_id, tariff_id, contact_id, amount,
                status, source, ordered_at)
           VALUES ($1, $2, $3, $4, $5, 'unpaid', 'landing', NOW())
           ON CONFLICT (participant_id, tariff_id)
           DO UPDATE SET amount = EXCLUDED.amount, ordered_at = NOW()
           RETURNING id""",
        t["event_id"], participant_id, t["id"], contact_id, price,
    )

    client = {
        "id": t["client_id"],
        "pay_provider": t["pay_provider"],
        "pay_leadpay_login": t["pay_leadpay_login"],
        "pay_leadpay_token": t["pay_leadpay_token"],
    }

    # Платёжная система не подключена → ведём на внешнюю ссылку тарифа.
    # Оплату в этом случае клиент отмечает вручную в разделе «Заказы».
    if not client_payments.is_configured(client):
        if t["pay_url"]:
            return {"ok": True, "order_id": order_id, "payment_url": t["pay_url"],
                    "manual": True}
        raise HTTPException(
            status_code=400,
            detail="У этого тарифа не настроена оплата. Напишите организатору.",
        )

    base = str(request.base_url).rstrip("/")
    try:
        pay_url = await client_payments.create_payment_link(
            client=client,
            order_id=order_id,
            product_id=t["pay_product_id"],
            notification_url=f"{base}/api/v1/integrations/client-pay/leadpay",
            # ⚠️ Номер ЗАКАЗА в самом ПУТИ, а не параметром: параметр
            # терялся по дороге. По заказу видно и событие, и конкретного
            # человека — имя, сумму, статус оплаты.
            redirect_url_ok=f"{base}/thanks/order/{order_id}",
            redirect_url_error=f"{base}/thanks/order/{order_id}?fail=1",
            email=email,
            phone=phone,
            fio=name or None,
        )
    except RuntimeError as e:
        logger.error("Заказ %s: не удалось создать ссылку оплаты: %s", order_id, e)
        raise HTTPException(status_code=502, detail=str(e))

    await db.execute(
        "UPDATE event_participant_tariffs SET payment_url = $1, payment_provider = 'leadpay' "
        "WHERE id = $2",
        pay_url, order_id,
    )

    # Письмо со ссылкой на оплату: человек часто уходит подумать и теряет
    # вкладку. Ошибка отправки не должна ронять заказ — ссылка уже готова.
    try:
        from app.services.order_email import (
            send_order_created_email, notify_organizer_new_order,
        )
        await send_order_created_email(db, order_id)
        await notify_organizer_new_order(db, order_id)
    except Exception as e:
        logger.warning("Письмо о заказе %s не отправлено: %s", order_id, e)

    return {"ok": True, "order_id": order_id, "payment_url": pay_url}


@router.post("/quick/{tariff_id}/{contact_id}", summary="Регистрация без формы")
async def quick_register(
    tariff_id: int,
    contact_id: int,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Бесплатный тариф + галочка «Регистрировать без ввода контактных
    данных» + известный контакт → регистрируем сразу, форму не показываем.

    ⚠️ Работает только для БЕСПЛАТНОГО тарифа: для платного контакты нужны
    в любом случае — по ним человек получит доступ и чек.
    """
    _cors(response)
    t = await _load_tariff(db, tariff_id)
    if not t or not t["is_active"]:
        raise HTTPException(status_code=404, detail="Тариф не найден")
    if int(t["price"] or 0) > 0 or not t["skip_contact_form"]:
        raise HTTPException(status_code=400, detail="Нужна форма")

    own = await db.fetchval(
        """SELECT id FROM contacts
            WHERE id = $1 AND client_id = $2 AND merged_into IS NULL""",
        contact_id, t["client_id"],
    )
    if not own:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    await db.execute(
        """INSERT INTO event_participants (event_id, contact_id, is_registered)
           VALUES ($1, $2, TRUE)
           ON CONFLICT (event_id, contact_id) DO UPDATE SET is_registered = TRUE""",
        t["event_id"], contact_id,
    )
    await finalize_participant_registration(
        db, event_id=t["event_id"], contact_id=contact_id)
    return {"ok": True, "redirect": f"/event/{t['event_slug']}?c={contact_id}"}


@router.get("/prefill/{tariff_id}/{contact_id}", summary="Данные контакта для формы")
async def prefill(
    tariff_id: int,
    contact_id: int,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Человек пришёл из бота по ссылке с ?c= — подставляем его контакты в
    форму, чтобы не вводил заново. Поля остаются редактируемыми: телефон
    в базе может быть старый.

    Контакт обязан принадлежать клиенту события — иначе по чужому номеру в
    адресе можно было бы вытащить контакты из другой базы."""
    _cors(response)
    t = await _load_tariff(db, tariff_id)
    if not t:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    row = await db.fetchrow(
        """SELECT c.name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    LIMIT 1) AS email,
                  (SELECT pt.username FROM platform_users pt
                    WHERE pt.contact_id = c.id AND pt.platform_slug = 'telegram'
                      AND pt.username IS NOT NULL
                    LIMIT 1) AS tg_username
             FROM contacts c
            WHERE c.id = $1 AND c.client_id = $2 AND c.merged_into IS NULL""",
        contact_id, t["client_id"],
    )
    if not row:
        return {}
    return dict(row)


@router.get("/tariff/{tariff_id}", summary="Данные для страницы после оплаты")
async def thanks_by_tariff(
    tariff_id: int,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Событие, чаты, боты и поддержка — по номеру ТАРИФА.

    ⚠️ Номер тарифа стоит прямо в адресе страницы, поэтому не теряется по
    дороге, в отличие от номера заказа в параметре. Различать покупателей
    между собой здесь не нужно: чаты и боты у всех одинаковые, а
    одновременные покупки друг другу не мешают.
    """
    _cors(response)
    t = await _load_tariff(db, tariff_id)
    if not t:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    ev = await db.fetchrow(
        """SELECT e.slug, e.title,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS tg_chat_url,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS vk_chat_url,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS max_chat_url,
                  (SELECT url FROM event_posters
                    WHERE event_id = e.id AND day IS NULL
                    ORDER BY CASE orientation
                               WHEN 'horizontal' THEN 1
                               WHEN 'square' THEN 2 ELSE 3 END, sort, id
                    LIMIT 1) AS poster_url
             FROM events e WHERE e.id = $1""",
        t["event_id"],
    )

    chans = await db.fetch(
        """SELECT ch.platform_slug, ch.handle
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.handle IS NOT NULL AND ch.handle <> ''
              AND ch.platform_slug IN ('telegram', 'vk', 'max')""",
        t["client_id"],
    )
    bots = []
    for c in chans:
        h = c["handle"].lstrip("@")
        url = {
            "telegram": f"https://telegram.me/{h}?start=ref_pg{ev['slug']}",
            "vk": f"https://vk.me/{h}",
            "max": f"https://max.ru/{h}?start=ref_pg{ev['slug']}",
        }.get(c["platform_slug"])
        if url:
            bots.append({"platform": c["platform_slug"], "url": url})

    cl = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1",
        t["client_id"],
    )
    support = []
    if cl and cl["work_tg_username"]:
        support.append({"platform": "telegram",
                        "url": f"https://t.me/{str(cl['work_tg_username']).lstrip('@')}"})
    if cl and cl["work_vk"]:
        support.append({"platform": "vk", "url": cl["work_vk"]})
    if cl and cl["work_max"]:
        support.append({"platform": "max", "url": cl["work_max"]})

    return {
        "tariff_title": t["title"],
        "event_slug": ev["slug"],
        "event_title": ev["title"],
        "poster_url": ev["poster_url"],
        "chats": [
            {"platform": p, "url": u}
            for p, u in (("telegram", ev["tg_chat_url"]),
                         ("vk", ev["vk_chat_url"]),
                         ("max", ev["max_chat_url"]))
            if u
        ],
        "bots": bots,
        "support": support,
    }


@router.get("/{order_id}", summary="Заказ для страницы благодарности")
async def get_order(
    order_id: int,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Одна страница благодарности на все события: по номеру заказа находим
    событие и отдаём его чаты. Ничего настраивать не нужно."""
    _cors(response)
    row = await db.fetchrow(
        """SELECT o.id, o.status, o.amount, o.contact_id, o.event_id,
                  t.title AS tariff_title,
                  e.slug AS event_slug, e.title AS event_title,
                  e.thanks_destination,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS tg_chat_url,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS vk_chat_url,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS max_chat_url,
                  (SELECT url FROM event_posters
                    WHERE event_id = e.id AND day IS NULL
                    ORDER BY CASE orientation
                               WHEN 'horizontal' THEN 1
                               WHEN 'square' THEN 2 ELSE 3 END, sort, id
                    LIMIT 1) AS poster_url
             FROM event_participant_tariffs o
             JOIN event_tariffs t ON t.id = o.tariff_id
             JOIN events e ON e.id = o.event_id
            WHERE o.id = $1""",
        order_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Заказ не найден")
    d = dict(row)
    d["chats"] = [
        {"platform": p, "url": u}
        for p, u in (("telegram", d.pop("tg_chat_url", None)),
                     ("vk", d.pop("vk_chat_url", None)),
                     ("max", d.pop("max_chat_url", None)))
        if u
    ]

    # Боты клиента: через них придут напоминания, подарки и ссылка на эфир.
    chans = await db.fetch(
        """SELECT ch.platform_slug, ch.handle
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
             JOIN event_owners eo ON eo.client_id = cc.client_id
                                 AND eo.status = 'accepted'
            WHERE eo.event_id = $1 AND cc.is_active = TRUE
              AND ch.handle IS NOT NULL AND ch.handle <> ''
              AND ch.platform_slug IN ('telegram', 'vk', 'max')""",
        row["event_id"] if "event_id" in row else d.get("event_id"),
    )
    bots = []
    for c in chans:
        h = c["handle"].lstrip("@")
        url = {
            "telegram": f"https://telegram.me/{h}?start=ref_pg{d['event_slug']}",
            "vk": f"https://vk.me/{h}",
            "max": f"https://max.ru/{h}?start=ref_pg{d['event_slug']}",
        }.get(c["platform_slug"])
        if url:
            bots.append({"platform": c["platform_slug"], "url": url})
    d["bots"] = bots

    cl = await db.fetchrow(
        """SELECT cl.work_tg_username, cl.work_vk, cl.work_max
             FROM event_owners eo JOIN clients cl ON cl.id = eo.client_id
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY eo.id LIMIT 1""",
        row["event_id"] if "event_id" in row else d.get("event_id"),
    )
    support = []
    if cl:
        if cl["work_tg_username"]:
            support.append({"platform": "telegram",
                            "url": f"https://t.me/{str(cl['work_tg_username']).lstrip('@')}"})
        if cl["work_vk"]:
            support.append({"platform": "vk", "url": cl["work_vk"]})
        if cl["work_max"]:
            support.append({"platform": "max", "url": cl["work_max"]})
    d["support"] = support
    return d


# ─────────────────────────────────────────────────────────────────────────────
# Вебхук оплаты
# ─────────────────────────────────────────────────────────────────────────────
@webhook_router.post("/leadpay", summary="Оплата тарифа события (LeadPay)")
async def leadpay_order_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """LeadPay возвращает наш `order_id` в виде `evt-<id>` — по нему находим
    заказ. Ключи для проверки подписи берём у ВЛАДЕЛЬЦА события, а не из
    переменных окружения: у каждого клиента своя платёжная система."""
    form = await request.form()
    data = {k: str(v) for k, v in form.items()}
    if not data:
        try:
            data = await request.json()
        except Exception:
            data = {}

    raw_id = str(data.get("order_id") or "").strip()
    if not raw_id.startswith("evt-"):
        # Не наш заказ (подписка платформы обрабатывается другим роутером).
        return {"ok": True, "skipped": True}

    try:
        order_id = int(raw_id[4:])
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверный номер заказа")

    order = await db.fetchrow(
        """SELECT o.id, o.status, o.event_id, o.contact_id, o.participant_id,
                  cl.pay_leadpay_token
             FROM event_participant_tariffs o
             JOIN events e ON e.id = o.event_id
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
             JOIN clients cl ON cl.id = eo.client_id
            WHERE o.id = $1
            ORDER BY eo.id LIMIT 1""",
        order_id,
    )
    if not order:
        raise HTTPException(status_code=404, detail="Заказ не найден")

    if not client_payments.verify_leadpay_webhook(data, order["pay_leadpay_token"] or ""):
        logger.error("Вебхук заказа %s: подпись не сошлась", order_id)
        raise HTTPException(status_code=403, detail="Подпись неверна")

    if str(data.get("status") or "").lower() != "success":
        logger.info("Заказ %s: оплата не прошла (%s)", order_id, data.get("status"))
        return {"ok": True, "paid": False}

    # Идемпотентность: повторный вебхук не должен ничего ломать.
    if order["status"] == "paid":
        return {"ok": True, "paid": True, "already": True}

    await db.execute(
        """UPDATE event_participant_tariffs
              SET status = 'paid', paid_at = NOW(), source = 'leadpay',
                  external_payment_id = $2
            WHERE id = $1""",
        order_id, str(data.get("payment_id") or data.get("id") or "") or None,
    )

    # Оплата = регистрация на событие.
    if order["contact_id"]:
        await db.execute(
            """INSERT INTO event_participants (event_id, contact_id, is_registered)
               VALUES ($1, $2, TRUE)
               ON CONFLICT (event_id, contact_id)
               DO UPDATE SET is_registered = TRUE""",
            order["event_id"], order["contact_id"],
        )
        await finalize_participant_registration(
            db, event_id=order["event_id"], contact_id=order["contact_id"])

    try:
        from app.services.order_email import (
            send_order_paid_email, notify_organizer_new_order,
        )
        await send_order_paid_email(db, order_id)
        await notify_organizer_new_order(db, order_id, paid=True)
    except Exception as e:
        logger.warning("Письмо об оплате заказа %s не отправлено: %s", order_id, e)

    logger.info("Заказ %s оплачен", order_id)
    return {"ok": True, "paid": True}
