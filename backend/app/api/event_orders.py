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
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from typing import Optional
import logging
import asyncpg

from app.database import get_db
from app.services import client_payments
from app.services import promo_codes as promo_svc
from app.services.consents import save_consents, client_ip
from app.services.contact_merge import find_or_create_contact, resolve_ref_code
from app.services.event_participant import upsert_event_participant
from app.services.share_links import TG_DOMAIN

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
    # ⚠️⚠️ ПЛОЩАДКА ЗАКАЗЧИКА (22.09.2026). Человек приходит из бота, и его
    # tg_id/vk_id/max_id известны, но форма их не принимала — резолв шёл только
    # по `contact_id` из ссылки, а он по дороге «бот → лендинг → заказ»
    # терялся. Итог: ВТОРОЙ контакт с email и телефоном, но без мессенджера
    # (событие 89 — 20 человек). Площадочный id прислал сам мессенджер, он
    # врать не может, поэтому это признак СИЛЬНЕЕ `contact_id` из адреса.
    tg_id: Optional[str] = None
    vk_id: Optional[str] = None
    max_id: Optional[str] = None
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
    # Промокод ПЛЮСОНа (миграция 397). ⚠️ Проверяется и применяется ТОЛЬКО на
    # сервере: скидка, посчитанная в браузере, обходится запросом мимо формы.
    promo_code: Optional[str] = None


async def _load_tariff(db, tariff_id: int):
    """Тариф + событие + владелец с ключами платёжной системы."""
    return await db.fetchrow(
        """SELECT t.id, t.code, t.title, t.price, t.pay_url, t.pay_product_id,
                  t.is_active,
                  e.id AS event_id, e.slug AS event_slug, e.title AS event_title,
                  e.skip_contact_form,
                  cl.id AS client_id, cl.name AS client_name,
                  cl.pay_provider, cl.pay_leadpay_login, cl.pay_leadpay_token,
                  cl.pay_prodamus_url, cl.pay_prodamus_secret,
                  cl.pay_tbank_terminal_key, cl.pay_tbank_password,
                  cl.pay_tbank_test_terminal_key, cl.pay_tbank_test_password,
                  cl.pay_tbank_test_mode,
                  cl.pay_tbank_taxation, cl.pay_tbank_vat
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


@router.get("/known/{tariff_id}/{contact_id}", summary="Известные данные заказчика")
async def order_known(
    tariff_id: int, contact_id: int, response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Что мы уже знаем о пришедшем — чтобы подставить в форму заказа.

    Данные собирает общая `known_contact_fields` (contact_merge) — та же, что
    питает анкету и авторизацию вебинарной комнаты. Своего SELECT тут быть не
    должно: разъедется с остальными формами.
    """
    _cors(response)
    t = await _load_tariff(db, tariff_id)
    if not t:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    from app.services.contact_merge import known_contact_fields
    return {"ok": True,
            "known": await known_contact_fields(db, t["client_id"], contact_id)}


class PromoCheckIn(BaseModel):
    tariff_id: int
    promo_code: str
    contact_id: Optional[int] = None
    email: Optional[str] = None


@router.options("/check-promo", include_in_schema=False)
async def _opts_promo(response: Response):
    _cors(response)
    return {}


@router.post("/check-promo", summary="Проверить промокод до оформления заказа")
async def check_promo(
    data: PromoCheckIn,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Годится ли код и какая будет цена — ДО отправки формы.

    ⚠️ Зачем отдельная проверка: раньше промокод проверялся только при
    создании заказа, то есть В САМОМ КОНЦЕ. Между вводом кода и этой
    проверкой успевал вклиниться экран «Это вы?» — человек вводил неверный
    код, проходил выбор контакта и только потом узнавал, что код не годится
    (жалоба владельца 17.09.2026). Теперь код проверяется сразу при вводе.

    ⚠️ Это НЕ замена проверке в `create_order`: там она остаётся и остаётся
    главной. Ответ браузера подделывается, скидку считает только сервер при
    создании заказа. Здесь — лишь подсказка человеку.
    """
    _cors(response)
    t = await _load_tariff(db, data.tariff_id)
    if not t:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    price = int(t["price"] or 0)
    if price <= 0:
        raise HTTPException(status_code=400,
                            detail="Этот тариф бесплатный — промокод не нужен")
    if (t["pay_product_id"] or "").strip():
        raise HTTPException(status_code=400,
                            detail="На этом тарифе промокоды не действуют.")

    try:
        promo = await promo_svc.resolve(
            db, code=data.promo_code, client_id=t["client_id"], price=price,
            event_id=t["event_id"], tariff_id=t["id"], tariff_kind="event",
            contact_id=data.contact_id, email=data.email,
        )
    except promo_svc.PromoError as e:
        # Текст писался для покупателя — показываем как есть.
        raise HTTPException(status_code=400, detail=str(e))

    # ⚠️ Показываем ту же цену, что уйдёт в оплату: с поправкой на минимум
    # платёжной системы. Иначе человек увидит 50 ₽, а заплатит 100 ₽.
    price_after = promo_svc.clamp_to_provider_minimum(
        promo["price_after"], t["pay_provider"])
    return {
        "ok": True,
        "code": promo["code"],
        "price_before": price,
        "price_after": price_after,
        "is_free": price_after <= 0,
    }


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

    # ⚠️⚠️ ПЛОЩАДКА — ПРИЗНАК СИЛЬНЕЕ `contact_id` ИЗ ССЫЛКИ. Её прислал сам
    # мессенджер, а `?c=` едет через адресную строку и по дороге теряется.
    # В отличие от ника, здесь настоящий числовой id — его можно и нужно
    # привязывать: общая функция найдёт человека по существующей идентичности,
    # прицепит площадку к контакту из ссылки (`known_contact_id`) или склеит
    # по email/телефону.
    _plat = None
    for _v, _s in ((data.tg_id, "telegram"), (data.vk_id, "vk"),
                   (data.max_id, "max")):
        _v = str(_v or "").strip()
        # Только положительное целое: мусор из адреса создал бы призрака.
        if _v.isdigit() and int(_v) > 0:
            _plat = (_s, _v)
            break
    if _plat:
        try:
            from app.services.contact_merge import upsert_contact_with_identity
            contact_id, _pu, _new = await upsert_contact_with_identity(
                db, client_id=t["client_id"],
                platform_slug=_plat[0], platform_user_id=_plat[1],
                email=email or None, phone=phone,
                first_name=name,
                known_contact_id=known_cid,
            )
        except HTTPException:
            # 409: email уже за ДРУГИМ аккаунтом той же площадки. Человека не
            # выдумываем — пусть отработает обычный путь ниже (поиск по
            # email/телефону и, если данные расходятся, экран «Это вы?»).
            contact_id = known_cid
        except Exception:
            contact_id = known_cid

    # Человек уже выбрал себя на экране «Это вы?».
    if not contact_id and data.chosen_contact_id:
        contact_id = await db.fetchval(
            """SELECT id FROM contacts
                WHERE id = $1 AND client_id = $2 AND is_active = TRUE
                  AND merged_into IS NULL""",
            data.chosen_contact_id, t["client_id"],
        )
        # ⚠️ Человек выбрал контакт и тут же назвал свои email/телефон —
        # дописываем их ЕМУ, если у него этих полей не было. Иначе контакт
        # остаётся с одним ником, а письмо о заказе слать некуда.
        if contact_id:
            from app.services.contact_merge import (
                set_contact_phone, sync_email_identity_and_subscription,
            )
            if phone:
                # ⚠️ Только через set_contact_phone — рядом обязан писаться
                # phone_normalized, по нему ищутся дубли (см. contact_merge).
                await set_contact_phone(db, contact_id, phone)
            if name:
                await db.execute(
                    "UPDATE contacts SET name = COALESCE(NULLIF(name, ''), $2) WHERE id = $1",
                    contact_id, name,
                )
            if email:
                # Email уникален: если он уже занят ДРУГИМ контактом, тихо
                # пропускаем — иначе упрёмся в ограничение базы.
                busy = await db.fetchval(
                    """SELECT pu.contact_id FROM platform_users pu
                        JOIN contacts c_own ON c_own.id = pu.contact_id
                        WHERE c_own.client_id = $1 AND pu.platform_slug = 'email'
                          AND pu.platform_user_id = $2 LIMIT 1""",
                    t["client_id"], email.strip().lower(),
                )
                if not busy:
                    try:
                        await sync_email_identity_and_subscription(
                            db, client_id=t["client_id"], contact_id=contact_id,
                            email=email, first_name=name or None,
                        )
                    except Exception:
                        pass

    # ⚠️ Email одного контакта, телефон другого — обычная ситуация: у человека
    # два аккаунта в базе. Молча брать первый нельзя (заказ уйдёт не тому),
    # сливать их автоматически — тем более. Показываем найденных и просим
    # выбрать, ровно как вебинарная авторизация.
    # ⚠️ Резолв идёт и тогда, когда человек пришёл с известным контактом:
    # он мог вписать почту или ник ДРУГОГО своего аккаунта. Контакт входа
    # передаём как ещё одного кандидата — тогда на экране «Это вы?» человек
    # увидит и тот аккаунт, под которым сидит, а не только то, что набрал
    # руками. Совпало всё на него одного — вопроса не будет.
    if not data.force_new and not data.chosen_contact_id:
        from app.services.contact_merge import resolve_or_ask
        found, cands, can_new = await resolve_or_ask(
            db, t["client_id"], email, phone, tg, known_contact_id=known_cid)
        if cands:
            return {"ok": False, "need_choice": True,
                    "candidates": cands, "can_create_new": can_new}
        if found:
            contact_id = found

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

    # ⚠️ Согласия ЗАПИСЫВАЕМ (10.09.2026). Раньше форма их принимала и
    # выбрасывала: человек ставил галочку, а в базе не оставалось ничего —
    # и рассылать ему было юридически не на чем. Одна галочка «рассылки и
    # звонки» проставляет ОБА согласия (см. services/consents.py).
    await save_consents(
        db, contact_id=contact_id,
        consent_pd=data.consent_pd,
        consent_marketing=data.consent_marketing,
        ip=client_ip(request),
    )

    # Кто привёл. Код может быть старым (merged_ref_codes) — резолвер это
    # учитывает. Свой собственный код игнорируем: сам себя не приводил.
    resolved_ref, referrer_contact_id = await resolve_ref_code(
        db, (data.ref_code or "").strip() or None, t["client_id"])
    if referrer_contact_id and referrer_contact_id == contact_id:
        resolved_ref, referrer_contact_id = None, None

    # ЛОГ ССЫЛКИ ПЕРЕХОДА — оформление заказа тарифа.
    # ⚠️ Журнала на этом пути не было вовсе: кто и по чьей ссылке пришёл
    # покупать — не видно. Площадка берётся из `_plat` (tg_id/vk_id/max_id в
    # форме), значит запись одинаковая для всех трёх площадок — и из ботов, и
    # из Mini App, и с веб-лендинга.
    # ⚠️ Пишем СЫРОЙ `data.ref_code` (что реально пришло в `?pid=`) и рядом
    # `resolved_ref` — что из него вышло. Разойдутся — сразу видно, что код
    # не нашёлся, а не гадать потом.
    try:
        from app.services.entry_link_log import log_entry_link
        await log_entry_link(
            db,
            platform=f"{_plat[0] if _plat else 'web'}-order",
            platform_user_id=(_plat[1] if _plat else None),
            raw_param=f"order:{t['event_slug']}:{data.ref_code or ''}",
            parsed_slug=t["event_slug"],
            parsed_pid=(resolved_ref or (data.ref_code or "").strip() or None),
        )
    except Exception:
        pass

    # Партнёрка: закрепление за партнёром (миграция 346).
    #
    # ⚠️⚠️ Событийное `referrer_ref_code` мы НЕ ТРОГАЕМ — там «кто привёл на
    # это событие» (любой человек, на этом держатся подарки и зачёт). Партнёрка
    # живёт в своём поле `contacts.partner_id` и о рефералке события не знает.
    # Получателя вознаграждения по заказу события определяем в момент оплаты,
    # по правилам режима (см. _accrue_partner_reward).
    #
    # ⚠️ Закрепление пишется в ОБОИХ режимах: иначе переключение кабинета на
    # пассивный начиналось бы «с нуля».
    #
    # ⚠️ Дубль с `upsert_event_participant` (там закрепление стоит для ВСЕХ
    # путей регистрации) — намеренный: здесь человек оформляет заказ, но
    # участником ещё не стал, и до оплаты может не дойти. Функция
    # идемпотентна, второй вызов ничего не меняет.
    if contact_id and resolved_ref:
        from app.services.partner_binding import try_bind_by_ref_code
        await try_bind_by_ref_code(
            db, client_id=t["client_id"], contact_id=contact_id,
            ref_code=resolved_ref)

    price = int(t["price"] or 0)

    # ── Промокод (миграция 397) ──────────────────────────────────────────
    # ⚠️ Применяется К ЦЕНЕ ТАРИФА, которая уже содержит скидку тарифа:
    # `price` в базе — это цена к оплате (см. tariff_discount.py).
    # ⚠️⚠️ У тарифа с КОДОМ ТОВАРА промокод невозможен: LeadPay берёт цену из
    # своей карточки и нашу сумму игнорирует. Посчитать скидку и отправить её
    # в оплату означало бы показать человеку одну цену, а списать другую.
    # Поэтому отказываем явно (поле промокода у таких тарифов и не
    # показывается — см. promo_allowed).
    if data.promo_code and (t["pay_product_id"] or "").strip():
        raise HTTPException(
            status_code=400,
            detail="На этом тарифе промокоды не действуют.",
        )

    promo = None
    if data.promo_code and price > 0:
        try:
            promo = await promo_svc.resolve(
                db, code=data.promo_code, client_id=t["client_id"], price=price,
                event_id=t["event_id"], tariff_id=t["id"], tariff_kind="event",
                contact_id=contact_id, email=data.email,
            )
            # ⚠️ Скидка не может увести цену ниже минимума платёжной системы
            # (у LeadPay это 100 ₽) — иначе человек упрётся в отказ уже на ЕЁ
            # странице, где мы ничего объяснить не можем. Ноль не трогается:
            # там платёжка не нужна вовсе.
            price = promo_svc.clamp_to_provider_minimum(
                promo["price_after"], t["pay_provider"])
        except promo_svc.PromoError as e:
            # Текст писался для покупателя — показываем как есть.
            raise HTTPException(status_code=400, detail=str(e))

    # ── Цена стала нулевой: платёжка не нужна ────────────────────────────
    # ⚠️ Ноль по промокоду и изначально бесплатный тариф — РАЗНЫЕ случаи:
    # у первого заказ создаётся (сумма 0, статус paid), чтобы клиент видел,
    # скольким он раздал скидку; у второго заказа нет вовсе (решение
    # миграции 290). Поэтому ветки разведены.
    if price <= 0:
        # Единая точка записи в участники (см. services/event_participant.py):
        # реф-код пишется только если пуст, письмо уходит один раз.
        participant_id, _is_new, _became = await upsert_event_participant(
            db, event_id=t["event_id"], contact_id=contact_id,
            is_registered=True, referrer_ref_code=resolved_ref,
        )
        if promo:
            # ⚠️ Статус сразу `paid`, а не `unpaid`: платить нечего, вебхук не
            # придёт, и заказ висел бы в неоплаченных вечно.
            free_order_id = await db.fetchval(
                """INSERT INTO event_participant_tariffs
                       (event_id, participant_id, tariff_id, contact_id, amount,
                        status, source, ordered_at, paid_at, promo_code_id, promo_code)
                   VALUES ($1, $2, $3, $4, 0, 'paid', 'landing', NOW(), NOW(), $5, $6)
                   ON CONFLICT (participant_id, tariff_id)
                   DO UPDATE SET amount = 0, status = 'paid', ordered_at = NOW(),
                                 paid_at = COALESCE(event_participant_tariffs.paid_at, NOW()),
                                 promo_code_id = EXCLUDED.promo_code_id,
                                 promo_code = EXCLUDED.promo_code
                   RETURNING id""",
                t["event_id"], participant_id, t["id"], contact_id,
                promo["promo_id"], promo["code"],
            )
            # apply_now: оплаты не будет, ждать нечего — списываем сразу.
            await promo_svc.reserve(
                db, promo_id=promo["promo_id"],
                price_before=promo["price_before"], price_after=0,
                contact_id=contact_id, event_order_id=free_order_id,
                apply_now=True,
            )
        return {
            "ok": True,
            "free": True,
            "promo_code": promo["code"] if promo else None,
            "redirect": f"/event/{t['event_slug']}?c={contact_id}",
        }

    # ── Платный тариф: заказ + ссылка на оплату ──────────────────────────
    # Регистрации ещё нет — она случится после оплаты (_mark_order_paid).
    participant_id, _is_new, _became = await upsert_event_participant(
        db, event_id=t["event_id"], contact_id=contact_id,
        is_registered=False, referrer_ref_code=resolved_ref,
    )

    order_id = await db.fetchval(
        """INSERT INTO event_participant_tariffs
               (event_id, participant_id, tariff_id, contact_id, amount,
                status, source, ordered_at, promo_code_id, promo_code)
           VALUES ($1, $2, $3, $4, $5, 'unpaid', 'landing', NOW(), $6, $7)
           ON CONFLICT (participant_id, tariff_id)
           DO UPDATE SET amount = EXCLUDED.amount, ordered_at = NOW(),
                         promo_code_id = EXCLUDED.promo_code_id,
                         promo_code = EXCLUDED.promo_code
           RETURNING id""",
        t["event_id"], participant_id, t["id"], contact_id, price,
        promo["promo_id"] if promo else None,
        promo["code"] if promo else None,
    )

    # ⚠️ Резервируем применение СРАЗУ, а не после оплаты: иначе одноразовый
    # код, пока человек платит, успеет применить кто-то ещё. Списывается он
    # при подтверждении оплаты (mark_applied в вебхуке).
    if promo:
        try:
            await promo_svc.reserve(
                db, promo_id=promo["promo_id"],
                price_before=promo["price_before"], price_after=price,
                contact_id=contact_id, event_order_id=order_id,
            )
        except promo_svc.PromoError as e:
            raise HTTPException(status_code=400, detail=str(e))

    client = {
        "id": t["client_id"],
        "pay_provider": t["pay_provider"],
        "pay_leadpay_login": t["pay_leadpay_login"],
        "pay_leadpay_token": t["pay_leadpay_token"],
        "pay_prodamus_url": t["pay_prodamus_url"],
        "pay_prodamus_secret": t["pay_prodamus_secret"],
        "pay_tbank_terminal_key": t["pay_tbank_terminal_key"],
        "pay_tbank_password": t["pay_tbank_password"],
        "pay_tbank_test_terminal_key": t["pay_tbank_test_terminal_key"],
        "pay_tbank_test_password": t["pay_tbank_test_password"],
        "pay_tbank_test_mode": t["pay_tbank_test_mode"],
        "pay_tbank_taxation": t["pay_tbank_taxation"],
        "pay_tbank_vat": t["pay_tbank_vat"],
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
        # ⚠️ Адрес вебхука сервис подставляет сам — он у каждой системы свой.
        pay_url, provider = await client_payments.create_payment_link(
            client=client,
            order_id=order_id,
            product_id=t["pay_product_id"],
            base_url=base,
            # ⚠️ Номер ЗАКАЗА в самом ПУТИ, а не параметром: параметр
            # терялся по дороге. По заказу видно и событие, и конкретного
            # человека — имя, сумму, статус оплаты.
            redirect_url_ok=f"{base}/thanks/order/{order_id}",
            redirect_url_error=f"{base}/thanks/order/{order_id}?fail=1",
            # Продамусу товар заранее заводить не нужно — название и цену
            # он берёт прямо из ссылки.
            title=t["title"],
            price=price,
            email=email,
            phone=phone,
            fio=name or None,
        )
    except RuntimeError as e:
        logger.error("Заказ %s: не удалось создать ссылку оплаты: %s", order_id, e)
        raise HTTPException(status_code=502, detail=str(e))

    await db.execute(
        "UPDATE event_participant_tariffs SET payment_url = $1, payment_provider = $2 "
        "WHERE id = $3",
        pay_url, provider, order_id,
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
    # ⚠️ Галочка ОДНА на оба режима — skip_contact_form. Отдельного поля под
    # лендинг не заводим: смысл тот же, а два поля разъезжаются.
    if int(t["price"] or 0) > 0 or not t["skip_contact_form"]:
        raise HTTPException(status_code=400, detail="Нужна форма")

    own = await db.fetchval(
        """SELECT id FROM contacts
            WHERE id = $1 AND client_id = $2 AND merged_into IS NULL""",
        contact_id, t["client_id"],
    )
    if not own:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    await upsert_event_participant(
        db, event_id=t["event_id"], contact_id=contact_id, is_registered=True)
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
            "telegram": f"https://{TG_DOMAIN}/{h}?start=ref_pg{ev['slug']}",
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
            "telegram": f"https://{TG_DOMAIN}/{h}?start=ref_pg{d['event_slug']}",
            "vk": f"https://vk.me/{h}",
            "max": f"https://max.ru/{h}?start=ref_pg{d['event_slug']}",
        }.get(c["platform_slug"])
        if url:
            bots.append({"platform": c["platform_slug"], "url": url})
    d["bots"] = bots

    # ⚠️ Бренд и фирменные цвета берём ТЕМ ЖЕ запросом, что и каналы
    # поддержки: страница «спасибо» — лицо КЛИЕНТА, а не ПЛЮСОНа. Раньше она
    # была нарисована нашими цветами (#25455D + персиковые кнопки), и человек
    # после оплаты попадал будто на чужой сайт.
    cl = await db.fetchrow(
        """SELECT cl.work_tg_username, cl.work_vk, cl.work_max,
                  cl.brand_name, cl.name AS owner_name, cl.brand_logo_url,
                  cl.lp_bg_color, cl.lp_bg_color_2, cl.lp_bg_angle, cl.lp_bg_gradient,
                  cl.lp_color_heading, cl.lp_color_body,
                  cl.lp_btn_color, cl.lp_btn_text_color, cl.lp_btn_radius,
                  cl.lp_btn_color_2, cl.lp_btn_angle, cl.lp_btn_metallic,
                  cl.lp_btn_border_color, cl.lp_btn_border_width,
                  cl.lp_btn_border_metallic,
                  cl.lp_font_heading, cl.lp_font_body
             FROM event_owners eo JOIN clients cl ON cl.id = eo.client_id
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY eo.id LIMIT 1""",
        row["event_id"] if "event_id" in row else d.get("event_id"),
    )
    if cl:
        # ⚠️ Градиент и шрифты собираем ОБЩИМ хелпером лендинга, а не своей
        # формулой: вторая копия разъедется с лендингом, и страница оплаты
        # станет отличаться от страницы события.
        from app.services.landing_theme import apply_theme_fields
        theme = apply_theme_fields({
            "bg_color": cl["lp_bg_color"], "bg_color_2": cl["lp_bg_color_2"],
            "bg_angle": cl["lp_bg_angle"] if cl["lp_bg_angle"] is not None else 45,
            "bg_gradient": cl["lp_bg_gradient"],
            "font_heading": cl["lp_font_heading"], "font_body": cl["lp_font_body"],
        })
        d["brand"] = {
            "name": cl["brand_name"] or cl["owner_name"] or "",
            "logo_url": cl["brand_logo_url"] or None,
            # Пустые значения оставляем None — фронт подставит свои дефолты,
            # иначе у клиента без темы страница станет белой.
            "bg_css": theme["bg_css"],
            "color_heading": cl["lp_color_heading"] or None,
            "color_body": cl["lp_color_body"] or None,
            # ⚠️ Кнопка — это НЕ один цвет. У клиента она собирается из
            # градиента (два цвета + угол), металлического перелива и рамки со
            # своим цветом, толщиной и переливом. Отдать только `btn_color`
            # значило бы нарисовать плоскую заливку вместо его кнопки — именно
            # так и вышло в первой версии (16.09.2026).
            "btn_color": cl["lp_btn_color"] or None,
            "btn_text_color": cl["lp_btn_text_color"] or None,
            "btn_radius": cl["lp_btn_radius"],
            "btn_color_2": cl["lp_btn_color_2"] or None,
            "btn_angle": cl["lp_btn_angle"],
            "btn_metallic": cl["lp_btn_metallic"],
            "btn_border_color": cl["lp_btn_border_color"] or None,
            "btn_border_width": cl["lp_btn_border_width"],
            "btn_border_metallic": cl["lp_btn_border_metallic"],
            "font_heading_css": theme["font_heading_css"],
            "font_body_css": theme["font_body_css"],
        }
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
# Вебхуки оплаты
#
# ⚠️ У каждой платёжной системы свой роут: форматы оповещения и способы
# подписи разные. А вот всё, что происходит ПОСЛЕ подтверждения оплаты,
# одинаково — это `_mark_order_paid`. При добавлении третьей системы пишется
# только разбор её оповещения, дальше вызывается общая функция.
# ─────────────────────────────────────────────────────────────────────────────
async def _parse_order_data(request: Request) -> dict:
    """Тело вебхука — форма или JSON, у разных систем по-разному."""
    try:
        form = await request.form()
        data = {k: str(v) for k, v in form.items()}
    except Exception:
        data = {}
    if not data:
        try:
            data = await request.json()
        except Exception:
            data = {}
    return data


def _is_true(value) -> bool:
    """Признак успеха в вебхуке. Тело приходит и JSON-ом (там `true`), и
    формой (там строка «true») — сравнивать с `True` напрямую нельзя."""
    return str(value).strip().lower() in ("true", "1", "yes")


def _our_order_id(raw: str) -> Optional[int]:
    """Номер нашего заказа из `evt-<id>`. Чужой номер → None (это оплата
    подписки на платформу, её обрабатывает другой роутер).

    ⚠️ После номера может идти НАЗВАНИЕ ТАРИФА: `evt-188 · VIP-участие`.
    Продамус показывает `order_id` покупателю в шапке страницы оплаты
    («Оплата заказа №48861971 (evt-188 · VIP-участие)»), и это единственное
    место, где человек видит, за что платит. Поэтому берём только цифры
    сразу после префикса, а не всё до конца строки — иначе `int()` падает,
    заказ не находится и оплата не отмечается.
    """
    m = re.match(r"^evt-(\d+)", str(raw or "").strip())
    return int(m.group(1)) if m else None


def _product_order_id(raw: str) -> Optional[int]:
    """Номер заказа ПРОДУКТА из `prd-<id>` (миграция 290).

    ⚠️ Вебхуки продуктов приходят на ЭТИ ЖЕ роуты: `webhook_path` в
    client_payments один на всю платёжную систему, отдельного адреса завести
    нельзя. Поэтому обработчик сначала смотрит префикс и уводит заказ продукта
    в свою ветку.

    ⚠️ Как и у события, после номера может идти название тарифа
    (`prd-42 · Курс`) — берём только цифры сразу после префикса.
    """
    m = re.match(r"^prd-(\d+)", str(raw or "").strip())
    return int(m.group(1)) if m else None


async def _try_product_webhook(db, *, raw_order, provider: str, verify,
                               paid: bool, payment_id):
    """Продуктовая ветка вебхука. None → заказ не продуктовый, идём дальше.

    ⚠️ Подпись проверяется ЗДЕСЬ, ключами владельца ПРОДУКТА: у события и у
    продукта разные таблицы, и вызывающий к моменту разбора префикса ещё не
    знает, чьи секреты брать. `verify(order)` — замыкание вызывающего: оно
    знает, как проверять именно эту платёжную систему.
    """
    pid = _product_order_id(raw_order)
    if pid is None:
        return None

    from app.api.product_orders import (
        load_product_order_for_webhook, mark_product_order_paid,
    )
    order = await load_product_order_for_webhook(db, pid)
    if not order:
        raise HTTPException(status_code=404, detail="Заказ не найден")

    if not verify(order):
        logger.error("Вебхук заказа продукта %s: подпись не сошлась", pid)
        raise HTTPException(status_code=403, detail="Подпись неверна")

    if not paid:
        logger.info("Заказ продукта %s: оплата не прошла", pid)
        return {"ok": True, "paid": False}

    return await mark_product_order_paid(db, pid, provider, payment_id)


async def _load_order_for_webhook(db, order_id: int):
    return await db.fetchrow(
        """SELECT o.id, o.status, o.event_id, o.contact_id, o.participant_id,
                  cl.pay_leadpay_token, cl.pay_prodamus_secret,
                  cl.pay_tbank_password, cl.pay_tbank_test_password
             FROM event_participant_tariffs o
             JOIN events e ON e.id = o.event_id
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
             JOIN clients cl ON cl.id = eo.client_id
            WHERE o.id = $1
            ORDER BY eo.id LIMIT 1""",
        order_id,
    )


async def _mark_order_paid(db, order, provider: str, payment_id: Optional[str]) -> dict:
    """Отмечает заказ оплаченным и регистрирует участника.

    Идемпотентно: повторный вебхук ничего не ломает — платёжные системы
    присылают оповещение по нескольку раз, это норма.
    """
    order_id = order["id"]
    if order["status"] == "paid":
        return {"ok": True, "paid": True, "already": True}

    await db.execute(
        """UPDATE event_participant_tariffs
              SET status = 'paid', paid_at = NOW(), source = $2,
                  external_payment_id = $3
            WHERE id = $1""",
        order_id, provider, payment_id or None,
    )

    # Оплата = регистрация на событие.
    if order["contact_id"]:
        await upsert_event_participant(
            db, event_id=order["event_id"], contact_id=order["contact_id"],
            is_registered=True)

    # Промокод: резерв становится применением (миграция 397).
    # ⚠️ Сбой здесь не должен ронять вебхук — деньги уже приняты, а платёжка
    # сочтёт оповещение недоставленным и начнёт слать повторы.
    try:
        await promo_svc.mark_applied(db, event_order_id=order_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("Промокод по заказу %s не отмечен применённым: %s", order_id, e)

    try:
        from app.services.order_email import (
            send_order_paid_email, notify_organizer_new_order,
        )
        await send_order_paid_email(db, order_id)
        await notify_organizer_new_order(db, order_id, paid=True)
    except Exception as e:
        logger.warning("Письмо об оплате заказа %s не отправлено: %s", order_id, e)

    # Бонус в ПЛЮСОНе (миграция 307): тариф может выдавать покупателю кабинет
    # с модулем. Тариф без бонуса — функция сразу выходит. Своих исключений
    # не бросает: оплата уже принята, участник зарегистрирован, и сорвавшаяся
    # выдача бонуса не должна превращаться в ошибку вебхука (иначе платёжка
    # сочтёт оповещение недоставленным и начнёт слать повторы).
    # ⚠️ Доступ здесь НЕ включается — создаётся купон и уходит письмо со
    # ссылкой. Раньше кабинет заводился сразу по вебхуку, и дни горели, пока
    # письмо лежало непрочитанным: человек открывал его через две недели и
    # обнаруживал, что от 30 дней осталось 16 (миграция 308).
    try:
        from app.services.plusson_bonus import issue_bonus_coupon
        await issue_bonus_coupon(db, order_id)
    except Exception as e:
        logger.warning("Бонус ПЛЮСОНа по заказу %s не выдан: %s", order_id, e)

    # Номинации по тарифу (миграция 328): тариф премии может открывать
    # покупателю N номинаций, которые он потом отмечает сам в кабинете.
    # ⚠️ Карточки номинанта может ещё не быть — это норма, человек чаще
    # платит раньше, чем регистрируется. Тогда число не теряется: оно
    # дочитается из оплаты при создании карточки (pull_paid_nominations).
    # Своих исключений не бросаем по той же причине, что и у бонуса выше.
    try:
        from app.services.nominations_grant import apply_paid_nominations
        await apply_paid_nominations(db, order_id)
    except Exception as e:
        logger.warning("Номинации по заказу %s не выданы: %s", order_id, e)

    # Партнёрское вознаграждение (миграция 348).
    # ⚠️ Начисление рождается ИМЕННО ЗДЕСЬ, в момент подтверждения оплаты
    # (решение № 27) — и больше нигде. Кода, который ходит по истории заказов
    # и начисляет задним числом, не существует и существовать не должно.
    # ⚠️ Получатель уже записан в participant.referrer_ref_code при создании
    # заказа (там жила развилка по режиму выплат) — здесь только читаем.
    await _accrue_partner_reward(db, order_id)

    logger.info("Заказ %s оплачен (%s)", order_id, provider)
    return {"ok": True, "paid": True}


async def _accrue_partner_reward(db, order_id: int) -> None:
    """Начисление партнёру по оплаченному тарифу события.

    ⚠️⚠️ У события своего поля «кому платим» НЕТ — и заводить его не стали.
    `event_participants.referrer_ref_code` хранит «КТО ПРИВЁЛ» (любой человек,
    на этом держатся подарки и зачёт), а получателя вознаграждения решает
    режим выплат. Поэтому здесь мы отдаём приведшего в `resolve_reward_recipient`
    как ИСХОДНЫЕ ДАННЫЕ, а не как готового получателя:

        пассивный → платим ЗАКРЕПЛЁННОМУ партнёру покупателя;
        активный  → приведшему, и только если он партнёр.

    Взять поле напрямую было бы ошибкой: в пассивном режиме деньги ушли бы
    приведшему на это событие вместо закреплённого партнёра, а если в поле
    лежит не-партнёр — начисления не возникло бы вовсе.

    Своих исключений не бросаем: оплата принята, и сорвавшееся начисление не
    должно превращаться в ошибку вебхука.
    """
    try:
        from app.services.partner_accrual import (
            accrue_for_order, resolve_reward_recipient,
        )

        row = await db.fetchrow(
            """SELECT o.amount, o.tariff_id, o.contact_id, o.event_id,
                      ep.referrer_ref_code,
                      -- ⚠️ Владельца берём с учётом РОЛИ, а не «первого по id»:
                      -- у коллаб-события в event_owners несколько принятых
                      -- строк, и соорганизатор мог попасть туда раньше. Это
                      -- канонический паттерн проекта (events.py:477).
                      -- Ниже он всё равно уточняется по базе покупателя.
                      (SELECT eo.client_id FROM event_owners eo
                        WHERE eo.event_id = o.event_id AND eo.status = 'accepted'
                        ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id,
                      -- Чей это покупатель на самом деле.
                      (SELECT c.client_id FROM contacts c WHERE c.id = o.contact_id)
                          AS buyer_client_id
                 FROM event_participant_tariffs o
                 LEFT JOIN event_participants ep
                        ON ep.event_id = o.event_id AND ep.contact_id = o.contact_id
                WHERE o.id = $1""",
            order_id,
        )
        if not row or not row["client_id"] or not row["contact_id"]:
            return

        # ⚠️⚠️ В КОЛЛАБЕ платит ТОТ, В ЧЬЕЙ БАЗЕ ЛЕЖИТ ПОКУПАТЕЛЬ, а не «первый
        # владелец события». Суть коллаборации в том, что каждый организатор
        # ведёт свою базу и своих партнёров: начисление в чужом кабинете — это
        # чужие деньги и чужой партнёр, которого там может не быть вовсе.
        # Проверяем, что база покупателя действительно участвует в событии,
        # иначе остаёмся на владельце.
        client_id = row["client_id"]
        if row["buyer_client_id"] and row["buyer_client_id"] != client_id:
            owns = await db.fetchval(
                """SELECT 1 FROM event_owners
                    WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'""",
                row["event_id"], row["buyer_client_id"],
            )
            if owns:
                client_id = row["buyer_client_id"]

        recipient = await resolve_reward_recipient(
            db, client_id=client_id, buyer_contact_id=row["contact_id"],
            referrer_ref_code=row["referrer_ref_code"],
        )

        await accrue_for_order(
            db, client_id=client_id, source_kind="event",
            source_order_id=order_id, buyer_contact_id=row["contact_id"],
            amount=row["amount"], tariff_id=row["tariff_id"],
            recipient_ref_code=recipient,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрское начисление по заказу %s не создано: %s", order_id, e)


@webhook_router.post("/leadpay", summary="Оплата тарифа события (LeadPay)")
async def leadpay_order_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """LeadPay возвращает наш `order_id` в виде `evt-<id>` — по нему находим
    заказ. Ключи для проверки подписи берём у ВЛАДЕЛЬЦА события, а не из
    переменных окружения: у каждого клиента своя платёжная система."""
    data = await _parse_order_data(request)
    payment_id = str(data.get("payment_id") or data.get("id") or "") or None
    is_ok = str(data.get("status") or "").lower() == "success"

    # Заказ продукта (`prd-`) — своя ветка: другая таблица и свой постэффект.
    handled = await _try_product_webhook(
        db, raw_order=data.get("order_id"), provider="leadpay",
        verify=lambda o: client_payments.verify_leadpay_webhook(
            data, o["pay_leadpay_token"] or ""),
        paid=is_ok, payment_id=payment_id,
    )
    if handled is not None:
        return handled

    order_id = _our_order_id(data.get("order_id"))
    if order_id is None:
        return {"ok": True, "skipped": True}

    order = await _load_order_for_webhook(db, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Заказ не найден")

    if not client_payments.verify_leadpay_webhook(data, order["pay_leadpay_token"] or ""):
        logger.error("Вебхук заказа %s: подпись не сошлась", order_id)
        raise HTTPException(status_code=403, detail="Подпись неверна")

    if str(data.get("status") or "").lower() != "success":
        logger.info("Заказ %s: оплата не прошла (%s)", order_id, data.get("status"))
        return {"ok": True, "paid": False}

    return await _mark_order_paid(
        db, order, "leadpay",
        str(data.get("payment_id") or data.get("id") or "") or None,
    )


@webhook_router.post("/prodamus", summary="Оплата тарифа события (Продамус)")
async def prodamus_order_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """Продамус шлёт форму с полями `order_id`, `payment_status`, `payment_id`,
    подпись — в заголовке `Sign`.

    ⚠️ Ключ для проверки берём у ВЛАДЕЛЬЦА события, а не из переменных
    окружения: там лежит ключ самого ПЛЮСОНа, которым оплачивают подписку на
    платформу. Перепутать их — значит принять чужую оплату за свою.
    """
    data = await _parse_order_data(request)
    signature = (request.headers.get("Sign") or request.headers.get("sign")
                 or request.headers.get("Signature"))

    # ⚠️ Продамус шлёт оповещение и о незавершённой оплате — оплаченной
    # считается только `success`.
    prod_ok = str(data.get("payment_status") or "").strip().lower() == "success"

    handled = await _try_product_webhook(
        db, raw_order=data.get("order_id"), provider="prodamus",
        verify=lambda o: client_payments.verify_prodamus_webhook(
            data, signature, o["pay_prodamus_secret"] or ""),
        paid=prod_ok,
        payment_id=str(data.get("payment_id") or data.get("order_num") or "") or None,
    )
    if handled is not None:
        return handled

    order_id = _our_order_id(data.get("order_id"))
    if order_id is None:
        return {"ok": True, "skipped": True}

    order = await _load_order_for_webhook(db, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Заказ не найден")

    if not client_payments.verify_prodamus_webhook(
            data, signature, order["pay_prodamus_secret"] or ""):
        logger.error("Вебхук заказа %s (Продамус): подпись не сошлась", order_id)
        raise HTTPException(status_code=403, detail="Подпись неверна")

    # ⚠️ Продамус шлёт оповещение и о незавершённой оплате — оплаченной
    # считается только `success`.
    status = str(data.get("payment_status") or "").strip().lower()
    if status != "success":
        logger.info("Заказ %s: оплата не прошла (%s)", order_id, status or "нет статуса")
        return {"ok": True, "paid": False}

    return await _mark_order_paid(
        db, order, "prodamus",
        str(data.get("payment_id") or data.get("order_num") or "") or None,
    )


@webhook_router.post("/tbank", summary="Оплата тарифа события (Т-Банк)")
async def tbank_order_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """Т-Банк шлёт JSON с полями `OrderId`, `Status`, `Success`, `PaymentId`,
    подпись — в поле `Token` того же тела.

    ⚠️ В ответ надо вернуть РОВНО «OK» текстом (не JSON): иначе банк считает
    нотификацию недоставленной и будет слать её повторно сутки. Поэтому здесь
    `PlainTextResponse`, а не словарь, как у остальных систем.

    ⚠️ Пароль терминала берём у ВЛАДЕЛЬЦА события, а не из переменных
    окружения — там ключи самого ПЛЮСОНа, которыми оплачивают подписку на
    платформу.
    """
    data = await _parse_order_data(request)

    # ⚠️ Банк шлёт нотификации на каждый шаг оплаты (AUTHORIZED и др.).
    # Оплаченным считается только CONFIRMED — деньги списаны.
    tb_ok = (str(data.get("Status") or "").strip().upper() == "CONFIRMED"
             and _is_true(data.get("Success")))

    handled = await _try_product_webhook(
        db, raw_order=data.get("OrderId"), provider="tbank",
        verify=lambda o: client_payments.verify_tbank_webhook(
            data, o["pay_tbank_password"], o["pay_tbank_test_password"]),
        paid=tb_ok, payment_id=str(data.get("PaymentId") or "") or None,
    )
    # ⚠️ Банку отвечаем РОВНО «OK» текстом и в этой ветке тоже — иначе он
    # сочтёт нотификацию недоставленной и будет слать её сутки.
    if handled is not None:
        return PlainTextResponse("OK")

    order_id = _our_order_id(data.get("OrderId"))
    if order_id is None:
        return PlainTextResponse("OK")

    order = await _load_order_for_webhook(db, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Заказ не найден")

    # ⚠️ Сверяем с ОБОИМИ паролями — боевым и тестовым. Нотификация приходит с
    # того терминала, на котором прошла оплата, а клиент мог переключить режим
    # уже после того, как заказ ушёл в оплату.
    if not client_payments.verify_tbank_webhook(
            data, order["pay_tbank_password"], order["pay_tbank_test_password"]):
        logger.error("Вебхук заказа %s (Т-Банк): подпись не сошлась", order_id)
        raise HTTPException(status_code=403, detail="Подпись неверна")

    # ⚠️ Банк шлёт нотификации на каждый шаг оплаты (AUTHORIZED и др.).
    # Оплаченным считается только CONFIRMED — деньги списаны.
    status = str(data.get("Status") or "").strip().upper()
    if status != "CONFIRMED" or not _is_true(data.get("Success")):
        logger.info("Заказ %s: оплата не завершена (%s)", order_id, status or "нет статуса")
        return PlainTextResponse("OK")

    await _mark_order_paid(
        db, order, "tbank", str(data.get("PaymentId") or "") or None,
    )
    return PlainTextResponse("OK")
