"""Кабинет партнёра клиента: оферта, регистрация, материалы, продажи, люди.

⚠️⚠️ КАБИНЕТ ОДИН (решение № 30). Партнёрка и доступы к купленным материалам —
разделы ОДНОГО кабинета человека в границах клиента, с одним входом. Поэтому
здесь переиспользуется сессия кабинета покупателя (`product-cabinet`), а не
заводится своя: два входа с разными паролями в один кабинет — это гарантия
второго контакта и потерянных начислений.

⚠️ Вход в кабинет покупателя требует ПОКУПКИ (`product_access`). Партнёр может
не купить ничего — он продаёт, а не покупает. Поэтому здесь своя выдача кода:
человек пускается, если он партнёр ЛИБО что-то купил.

⚠️ Регистрация партнёра — осознанный вход (№ 14): акцепт оферты + налоговый
статус. Деньги платим только тем, кто может их легально принять.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Header, Request, Response
from pydantic import BaseModel

from app.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/partner", tags=["Кабинет партнёра"])

# ⚠️ `individual` («Физическое лицо») убран из ВЫБОРА по решению владельца, но
# ОСТАЁТСЯ в списке допустимых: у уже зарегистрированных партнёров этот статус
# мог быть записан, и запрет сломал бы им сохранение профиля.
_TAX_STATUSES = ("self_employed", "ip", "individual", "company")


# ─── Сессия: берём готовую из кабинета покупателя ─────────────────────────────

def _session(authorization: Optional[str] = Header(None)) -> dict:
    """Сессия кабинета покупателя — она же сессия партнёра (№ 30)."""
    from app.api.products_public import _decode

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Требуется вход")
    return _decode(authorization[7:])


async def _client_by_host(db, request: Request) -> Optional[int]:
    from app.api.products_public import _client_by_host as resolve
    return await resolve(db, request)


async def _client_by_email(db, email: str) -> Optional[int]:
    """Кабинет по почте — та же функция, что у кабинета покупателя.

    ⚠️ Партнёр чаще всех входит «голым» адресом `/my`: ссылку ему дают в боте
    и в переписке, а номер кабинета несёт только кнопка из письма. Без этого
    он упирался в «Не удалось определить кабинет» на ровном месте.
    """
    from app.api.products_public import _client_by_email as resolve
    return await resolve(db, email)


def _cors(response: Response) -> None:
    from app.api.products_public import _cors as apply
    apply(response)


async def _assert_partner_program(db, client_id: int) -> None:
    """У этого кабинета вообще есть партнёрская программа?

    ⚠️ Нужна именно здесь, в ПУБЛИЧНОМ роутере: `client_id` приходит от
    браузера, и без проверки посторонний записался бы партнёром в чужой
    кабинет, где раздела нет вовсе.
    """
    from app.services.features import client_has_feature

    if not await client_has_feature(db, client_id, "partner_program"):
        raise HTTPException(status_code=404,
                            detail="Партнёрская программа недоступна.")


async def _partner_row(db, client_id: int, contact_id: int) -> Optional[dict]:
    row = await db.fetchrow(
        """SELECT p.id, p.payout_mode, p.is_active, p.tax_status, p.accepted_at,
                  c.ref_code, c.name
             FROM client_partners p
             JOIN contacts c ON c.id = p.contact_id
            WHERE p.client_id = $1 AND p.contact_id = $2""",
        client_id, contact_id,
    )
    return dict(row) if row else None


async def _issue_login_code(db, client_id: int, contact_id: int) -> bool:
    """Одноразовый код входа в кабинет — сразу, без просьбы человека.

    ⚠️⚠️ Зовётся ПРИ РЕГИСТРАЦИИ партнёра, а не только из формы входа. Экран
    после регистрации обещает «вход по коду, который придёт на почту» — а
    отправляла его лишь отдельная ручка `/request-code`, то есть письмо
    приходило, только если человек сам догадается нажать «Открыть кабинет» и
    запросить код. Первый живой партнёр (клиент 1, 07.09.2026) прождал письмо,
    которого система не слала вовсе: кода в `product_cabinet_codes` не было
    создано ни одного.

    ⚠️ Почту берём ИЗ БАЗЫ (идентичность `email`), а не из формы: человек мог
    прийти из бота и не вводить её — там она уже есть. Нет почты вовсе →
    молча выходим: код уйдёт в бот из `send_cabinet_code`, если бот есть.

    ⚠️ Сбой отправки НЕ ломает регистрацию — партнёр уже создан, и падать
    из-за письма нельзя: человек увидел бы ошибку на успешном шаге.
    """
    email = await db.fetchval(
        """SELECT pu.platform_user_id FROM platform_users pu
            WHERE pu.contact_id = $1 AND pu.platform_slug = 'email'
            ORDER BY pu.id LIMIT 1""",
        contact_id,
    )
    if not email:
        return False

    code = f"{secrets.randbelow(1000000):06d}"
    try:
        await db.execute(
            """INSERT INTO product_cabinet_codes (client_id, contact_id, code_hash, expires_at)
               VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')""",
            client_id, contact_id, hashlib.sha256(code.encode()).hexdigest(),
        )
        from app.services.product_notify import send_cabinet_code
        await send_cabinet_code(db, client_id=client_id, contact_id=contact_id,
                                email=email, code=code)
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрка: код входа не отправлен контакту %s: %s",
                       contact_id, e)
        return False


async def _effective_mode(db, client_id: int, partner: dict) -> str:
    """Режим выплат, который реально действует для этого партнёра.

    ⚠️ Режим ОБЯЗАН быть виден партнёру в кабинете (4.7б). Иначе он считает по
    одним правилам, система по другим, и приходят жалобы «почему не начислили».
    """
    client_mode = await db.fetchval(
        "SELECT COALESCE(partner_payout_mode, 'passive') FROM clients WHERE id = $1",
        client_id) or "passive"
    return partner.get("payout_mode") or client_mode


# ─── Оферта и регистрация ─────────────────────────────────────────────────────

@router.get("/offer", summary="Текст партнёрской оферты")
async def partner_offer(request: Request, response: Response,
                        client_id: Optional[int] = None,
                        db: asyncpg.Connection = Depends(get_db)):
    """Оферта партнёра КЛИЕНТА.

    ⚠️ Берём текст платформенной партнёрской оферты как образец и подставляем
    в него имя клиента: свой текст на каждого клиента не пишем, а обещать
    партнёру условия платформы нельзя — платит-то клиент (№ 1).
    """
    _cors(response)
    cid = await _client_by_host(db, request) or client_id
    if not cid:
        raise HTTPException(status_code=400, detail="Не удалось определить кабинет")

    doc = await db.fetchrow(
        "SELECT title, body FROM platform_legal_docs WHERE slug = 'partner_offer'")
    client = await db.fetchrow(
        "SELECT COALESCE(NULLIF(brand_name, ''), name) AS brand FROM clients WHERE id = $1",
        cid)

    return {
        "title": (doc["title"] if doc else "Оферта об участии в партнёрской программе"),
        "body": (doc["body"] if doc else ""),
        "brand": client["brand"] if client else "",
        # ⚠️ «Физическое лицо» из выбора УБРАНО (решение владельца): выплата
        # физлицу требует от клиента удержать НДФЛ и сдать отчётность, а платит
        # партнёрам он сам — предлагать этот путь в форме нельзя.
        "tax_statuses": [
            {"value": "self_employed", "label": "Самозанятый"},
            {"value": "ip", "label": "ИП"},
            {"value": "company", "label": "Юридическое лицо"},
        ],
    }


@router.get("/prefill", summary="Что мы уже знаем о человеке")
async def partner_prefill(response: Response, request: Request,
                          client_id: Optional[int] = None, c: Optional[int] = None,
                          t: Optional[str] = None,
                          db: asyncpg.Connection = Depends(get_db)):
    """Данные для предзаполнения формы регистрации.

    ⚠️⚠️ ПОЛНУЮ ПОЧТУ ПОКАЗЫВАЕМ ТОЛЬКО ПО ПОДПИСИ (`?t=`), которую выдал наш
    бот. Причина простая: человек не помнит, под какой почтой он у клиента
    зарегистрирован, — и маска `p***a@mail.ru` ему не помогает, она отвечает
    «не скажу». В боте он уже опознан аккаунтом площадки, значит показать его
    собственную почту безопасно.

    ⚠️ БЕЗ подписи — только маска: номер контакта виден в адресе и подбирается
    перебором, так что по чужому номеру утекли бы чужие данные.

    Зачем вообще: из бота человек попадает сюда уже опознанным. Заставь его
    вводить почту заново — он впишет другую, и родится ВТОРОЙ контакт, из-за
    которого теряются приведённые и начисления (правило № 25).
    """
    _cors(response)
    cid = await _client_by_host(db, request) or client_id
    if not cid or not c:
        return {"known": False}

    from app.services.contact_merge import mask_email, mask_phone

    row = await db.fetchrow(
        """SELECT c.id, c.name, c.phone,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                    ORDER BY pu.id LIMIT 1) AS email
             FROM contacts c
            WHERE c.id = $1 AND c.client_id = $2 AND c.merged_into IS NULL""",
        c, cid,
    )
    if not row:
        return {"known": False}

    # Подпись от бота → человек опознан площадкой, можно показать его почту.
    from app.services.partner_invite import invite_contact_id
    verified = invite_contact_id(t, cid) == int(c)

    return {
        "known": True,
        "verified": verified,
        "name": row["name"] or "",
        # Полная почта — только по подписи; иначе маска.
        "email": row["email"] if verified else None,
        "phone": row["phone"] if verified else None,
        "email_masked": mask_email(row["email"]),
        "phone_masked": mask_phone(row["phone"]),
        "has_email": bool(row["email"]),
    }


class RegisterIn(BaseModel):
    client_id: Optional[int] = None
    # Номер контакта из ссылки бота (`?c=`) — человек уже опознан площадкой.
    contact_id: Optional[int] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    name: Optional[str] = None
    tax_status: str
    accept: bool = False


@router.post("/register", summary="Стать партнёром")
async def register_partner(data: RegisterIn, request: Request, response: Response,
                           authorization: Optional[str] = Header(None),
                           db: asyncpg.Connection = Depends(get_db)):
    """Акцепт оферты + налоговый статус → партнёр (правила 4.9).

    Как опознаём человека:
      • пришёл с сессией кабинета — берём контакт оттуда (надёжнее всего);
      • иначе ищем по почте и телефону среди контактов клиента;
      • не нашли — создаём контакт.

    ⚠️⚠️ ПОЧТУ НА ЭТАПЕ РЕГИСТРАЦИИ МЕНЯТЬ НЕЛЬЗЯ (№ 25). Именно подмена
    рождает второй контакт: человек известен как petya@mail.ru, вписывает
    petya2@gmail.com, система его не узнаёт и заводит нового — прошлые
    приведённые остаются за старым контактом, ссылки идут с новым кодом,
    начисления по третьему. Разобрать это потом невозможно. Поэтому при
    входе с сессией почта берётся из контакта, а присланная игнорируется.

    ⚠️ Уже партнёр → отвечаем «вы уже есть», а не создаём вторую запись:
    UNIQUE (client_id, contact_id) этого и не позволит.
    """
    _cors(response)

    # ⚠️⚠️ ВОШЕДШИЙ ЧЕЛОВЕК — КАБИНЕТ ИЗ ЕГО ТОКЕНА, и это ПЕРВЫЙ источник.
    # Раньше кабинет искали только по домену и по `client_id` из тела, а кабинет
    # партнёра (`/my`) его не присылал — человек, УЖЕ вошедший в свой кабинет,
    # жал «Стать партнёром» и получал «Не удалось определить кабинет» (прод,
    # 08.09.2026). Токен надёжнее любого параметра: он выдан этому кабинету.
    session_cid: Optional[int] = None
    if authorization and authorization.startswith("Bearer "):
        try:
            session_cid = _session(authorization).get("client_id")
        except HTTPException:
            session_cid = None

    cid = session_cid or await _client_by_host(db, request) or data.client_id
    if not cid:
        raise HTTPException(status_code=400, detail="Не удалось определить кабинет")

    # ⚠️⚠️ ГЕЙТ ОБЯЗАТЕЛЕН, хотя эндпоинт публичный. `client_id` приходит телом
    # запроса, и без проверки любой мог бы стать партнёром ЛЮБОГО кабинета —
    # включая те, у которых партнёрской программы нет и владелец о ней не
    # знает. Побочно это ещё и засорение чужой базы: регистрация создаёт
    # контакт.
    await _assert_partner_program(db, cid)

    if not data.accept:
        raise HTTPException(status_code=400,
                            detail="Чтобы стать партнёром, примите условия оферты.")
    if data.tax_status not in _TAX_STATUSES:
        raise HTTPException(status_code=400, detail="Укажите налоговый статус.")

    # 1) Опознаём человека
    contact_id: Optional[int] = None
    if authorization and authorization.startswith("Bearer "):
        try:
            sess = _session(authorization)
            if sess["client_id"] == cid:
                contact_id = sess["contact_id"]
        except HTTPException:
            contact_id = None

    # Пришёл из бота: номер контакта в ссылке. ⚠️ Обязательно сверяем
    # принадлежность кабинету — номер виден в адресе и подбирается перебором.
    if not contact_id and data.contact_id:
        contact_id = await db.fetchval(
            "SELECT id FROM contacts WHERE id = $1 AND client_id = $2 "
            "AND merged_into IS NULL",
            data.contact_id, cid)

    if not contact_id:
        from app.services.contact_merge import find_or_create_contact
        email = (data.email or "").strip().lower() or None
        phone = (data.phone or "").strip() or None
        if not email and not phone:
            raise HTTPException(status_code=400,
                                detail="Укажите почту или телефон — по ним мы вас узнаём.")
        contact_id, _is_new = await find_or_create_contact(
            db, client_id=cid, name=(data.name or "").strip() or None,
            email=email, phone=phone,
        )

    if not contact_id:
        raise HTTPException(status_code=400, detail="Не удалось определить контакт")

    # ⚠️⚠️ БЕЗ СПОСОБА СВЯЗИ ПАРТНЁРА НЕ СОЗДАЁМ — даже если человек опознан.
    # Раньше проверка стояла только в ветке «контакт не найден»: пришедший из
    # бота регистрировался с ПУСТЫМИ почтой и телефоном, а потом не мог войти
    # в кабинет (вход по коду на почту) и получить выплату. Ровно так и вышло
    # у первого живого партнёра.
    have_email = bool((data.email or "").strip())
    have_phone = bool((data.phone or "").strip())
    if not have_email and not have_phone:
        known = await db.fetchrow(
            """SELECT c.phone,
                      (SELECT pu.platform_user_id FROM platform_users pu
                        WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                        ORDER BY pu.id LIMIT 1) AS email
                 FROM contacts c WHERE c.id = $1""",
            contact_id,
        )
        if not (known and (known["email"] or known["phone"])):
            raise HTTPException(
                status_code=400,
                detail="У вас ещё нет почты и телефона — укажите хотя бы одно: "
                       "на почту приходит код входа в кабинет.")

    # ⚠️⚠️ ДОПИСЫВАЕМ ПОЧТУ И ТЕЛЕФОН ОПОЗНАННОМУ ЧЕЛОВЕКУ. У пришедшего из
    # бота почты в базе часто НЕТ вовсе (он known только по нику площадки) —
    # без этой записи он останется без неё и не сможет войти в кабинет: вход
    # идёт по коду на почту. Именно этот тупик и ловится жалобой «у аккаунта
    # почты нет, а вы просите ввести почту от заказа».
    #
    # ⚠️ Только В ПУСТОЕ: заменять уже известную почту нельзя (правило № 25) —
    # подмена рождает расхождение между тем, что знает клиент, и тем, под чем
    # человек входит.
    new_email = (data.email or "").strip().lower() or None
    new_phone = (data.phone or "").strip() or None

    # ⚠️ Почта уже принадлежит ДРУГОМУ человеку — говорим это прямо. Молча
    # привязать нельзя (у почты уникальность в пределах кабинета: вставка
    # упадёт непонятной ошибкой базы), а промолчать — значит оставить человека
    # гадать, почему «не получилось».
    if new_email:
        busy_by = await db.fetchval(
            """SELECT pu.contact_id FROM platform_users pu
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE c.client_id = $1 AND pu.platform_slug = 'email'
                  AND lower(pu.platform_user_id) = $2 AND c.merged_into IS NULL
                LIMIT 1""",
            cid, new_email,
        )
        if busy_by and int(busy_by) != int(contact_id):
            raise HTTPException(
                status_code=409,
                detail="Эта почта уже занята другим аккаунтом. Укажите другую "
                       "или войдите под ней в кабинет.")

    if new_email:
        try:
            from app.services.contact_merge import sync_email_identity_and_subscription
            await sync_email_identity_and_subscription(
                db, client_id=cid, contact_id=contact_id, email=new_email)
        except Exception as e:  # noqa: BLE001
            logger.warning("Партнёрка: почта не записана контакту %s: %s", contact_id, e)

    if new_phone:
        try:
            # ⚠️ Телефон пишем ТОЛЬКО через set_contact_phone: рядом обязан
            # обновляться phone_normalized, по нему ищутся дубли.
            from app.services.contact_merge import set_contact_phone
            await set_contact_phone(db, contact_id=contact_id, phone=new_phone,
                                    only_if_empty=True)
        except Exception as e:  # noqa: BLE001
            logger.warning("Партнёрка: телефон не записан контакту %s: %s", contact_id, e)

    existing = await _partner_row(db, cid, contact_id)
    if existing:
        # ⚠️ Код шлём и тут: человек нажал «стать партнёром» повторно, увидит
        # «Вы уже партнёр» и то же обещание про письмо. Промолчать — оставить
        # его ровно в том тупике, из-за которого правка и делается.
        sent = await _issue_login_code(db, cid, contact_id)
        return {"ok": True, "already": True, "partner_id": existing["id"],
                "ref_code": existing["ref_code"], "code_sent": sent}

    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() \
        or (request.client.host if request.client else None)

    partner_id = await db.fetchval(
        """INSERT INTO client_partners (client_id, contact_id, accepted_ip, tax_status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (client_id, contact_id) DO NOTHING
           RETURNING id""",
        cid, contact_id, ip, data.tax_status,
    )
    if not partner_id:
        row = await _partner_row(db, cid, contact_id)
        sent = await _issue_login_code(db, cid, contact_id)
        return {"ok": True, "already": True, "partner_id": row["id"] if row else None,
                "ref_code": row["ref_code"] if row else None, "code_sent": sent}

    # ⚠️ РЕТРОАКТИВНОГО ЗАКРЕПЛЕНИЯ НЕТ (№ 28). Здесь сознательно нет прохода
    # по истории: прошлые заслуги не засчитываются. Отсутствие такого кода —
    # и есть реализация правила.

    ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", contact_id)
    sent = await _issue_login_code(db, cid, contact_id)
    logger.info("Партнёрка: клиент %s, новый партнёр %s (контакт %s), код входа: %s",
                cid, partner_id, contact_id, "отправлен" if sent else "не отправлен")
    return {"ok": True, "partner_id": partner_id, "ref_code": ref_code,
            "code_sent": sent}


# ─── Вход в кабинет партнёра ──────────────────────────────────────────────────

class CodeIn(BaseModel):
    client_id: Optional[int] = None
    email: str


@router.post("/request-code", summary="Код входа партнёру на почту")
async def partner_request_code(data: CodeIn, request: Request, response: Response,
                               db: asyncpg.Connection = Depends(get_db)):
    """Одноразовый код входа.

    ⚠️ Отдельно от `/product-cabinet/request-code`, потому что там код уходит
    только тому, кто ЧТО-ТО КУПИЛ. Партнёр может не купить ничего — он продаёт.

    ⚠️ Ответ ОДИНАКОВЫЙ независимо от того, есть такая почта или нет: иначе по
    форме входа перебором вычисляется база клиента.
    """
    _cors(response)
    email = (data.email or "").strip().lower()
    cid = (await _client_by_host(db, request) or data.client_id
           or await _client_by_email(db, email))
    ok = {"ok": True, "sent": True}
    # ⚠️⚠️ ЧЕЛОВЕКУ ГОВОРИМ ПРАВДУ: письма не будет. Раньше здесь во всех
    # ветках возвращалось `sent: True`, экран писал «Код отправлен», и человек
    # ждал письмо, которого система не слала вовсе. Так на проде 07.09.2026
    # владелец не мог войти в свой же кабинет: почта в базе была записана без
    # точки (`имя2017@`), а вводил он свою настоящую — с точкой (`имя.2017@`).
    # Для Gmail это один ящик, для базы — разные люди.
    #
    # ⚠️ Перебор базы этим НЕ открывается: ответ один и тот же и когда почты
    # нет вовсе, и когда она есть, но доступа нет. Отличить «чужой клиент» от
    # «свой без доступа» по нему нельзя — а человек понимает, что делать.
    no_access = {
        "ok": True, "sent": False,
        "message": ("На этой почте нет доступа в кабинет. Проверьте написание "
                    "адреса — важны точки и раскладка. Если ошибки нет, "
                    "напишите тому, у кого вы покупали: доступ откроют."),
    }
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Проверьте адрес почты")
    # Кабинет не определился (чужая почта либо покупки у двух разных
    # экспертов) — отвечаем как «доступа нет», а не технической ошибкой.
    if not cid:
        return no_access

    contact_id = await db.fetchval(
        """SELECT c.id FROM contacts c
             JOIN platform_users pu ON pu.contact_id = c.id
                  AND pu.platform_slug = 'email' AND pu.platform_user_id = $2
            WHERE c.client_id = $1 AND c.merged_into IS NULL LIMIT 1""",
        cid, email,
    )
    if not contact_id:
        return no_access

    is_partner = await db.fetchval(
        "SELECT 1 FROM client_partners WHERE client_id = $1 AND contact_id = $2",
        cid, contact_id)
    has_access = await db.fetchval(
        """SELECT 1 FROM product_access pa
             JOIN products p ON p.id = pa.product_id
            WHERE pa.contact_id = $1 AND p.client_id = $2 LIMIT 1""",
        contact_id, cid)
    if not is_partner and not has_access:
        return no_access

    code = f"{secrets.randbelow(1000000):06d}"
    await db.execute(
        """INSERT INTO product_cabinet_codes (client_id, contact_id, code_hash, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')""",
        cid, contact_id, hashlib.sha256(code.encode()).hexdigest(),
    )
    try:
        from app.services.product_notify import send_cabinet_code
        await send_cabinet_code(db, client_id=cid, contact_id=contact_id,
                                email=email, code=code)
    except Exception as e:  # noqa: BLE001
        logger.warning("Код входа партнёру не отправлен: %s", e)
    return ok


# ─── Кабинет ──────────────────────────────────────────────────────────────────

@router.get("/miniapp", summary="Витрина партнёра в Mini App")
async def partner_miniapp(
    response: Response,
    client_id: int,
    platform: str = "telegram",
    platform_user_id: str = "",
    db: asyncpg.Connection = Depends(get_db),
):
    """Данные вкладки «Партнёру» внутри Mini App (решение № 2).

    ⚠️ Входа по коду здесь НЕТ и он не нужен: человек опознан площадкой —
    Mini App открывается из его аккаунта. Требовать код на почту в мессенджере
    значило бы выгнать человека из приложения ради того, что мы и так знаем.

    ⚠️ Отдаём ТОЛЬКО ссылки и суммы. Регистрация партнёром (оферта + налоговый
    статус) остаётся в вебе: это осознанный юридический шаг, и собирать его
    во всплывающем окне мессенджера неправильно.
    """
    _cors(response)
    if not platform_user_id:
        return {"is_partner": False}

    from app.services.client_domains import client_public_link, public_url_for

    contact_id = await db.fetchval(
        """SELECT pu.contact_id FROM platform_users pu
             JOIN contacts c ON c.id = pu.contact_id
            WHERE c.client_id = $1 AND pu.platform_slug = $2
              AND pu.platform_user_id = $3
            LIMIT 1""",
        client_id, platform, str(platform_user_id),
    )

    cabinet_url = await client_public_link(db, client_id, "/my")

    if not contact_id:
        return {"is_partner": False, "cabinet_url": cabinet_url}

    partner = await _partner_row(db, client_id, contact_id)
    if not partner or not partner["is_active"]:
        return {"is_partner": False, "cabinet_url": cabinet_url}

    mode = await _effective_mode(db, client_id, partner)

    # ⚠️⚠️ ДЕНЕЖНЫЕ СУММЫ ЗДЕСЬ НЕ ОТДАЁМ. Этот эндпоинт опознаёт человека по
    # `platform_user_id` из адреса, а подпись `initData` в проекте пока не
    # проверяется нигде (тот же зазор описан в event_raffle_public). Значит,
    # зная id партнёра, посторонний прочитал бы его заработок. Ссылки в этом
    # смысле безобидны — они и так предназначены для распространения, а суммы
    # видны в кабинете `/my`, где вход по коду на почту.
    ref = partner["ref_code"]
    base = await client_public_link(db, client_id, "")

    events = await db.fetch(
        """SELECT e.id, e.title, e.slug
             FROM events e
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
            WHERE eo.client_id = $1 AND e.partner_enabled = TRUE
              AND e.status IN ('published', 'ended')
            ORDER BY e.start_at DESC NULLS LAST LIMIT 50""",
        client_id,
    )
    products = await db.fetch(
        """SELECT id, title, slug FROM products
            WHERE client_id = $1 AND partner_enabled = TRUE AND status <> 'archived'
            ORDER BY title LIMIT 50""",
        client_id,
    )

    items = (
        [{"kind": "event", "id": e["id"], "title": e["title"],
          "link": public_url_for(base, f"/l/{e['slug']}?pid={ref}")} for e in events]
        + [{"kind": "product", "id": p["id"], "title": p["title"],
            "link": public_url_for(base, f"/pr/{p['slug']}?pid={ref}")} for p in products]
    )

    return {
        "is_partner": True,
        "ref_code": ref,
        "payout_mode": mode,
        "items": items,
        "cabinet_url": cabinet_url,
    }


@router.get("/me", summary="Партнёр: сводка")
async def partner_me(response: Response, sess: dict = Depends(_session),
                     db: asyncpg.Connection = Depends(get_db)):
    """Баланс, режим и число уровней.

    ⚠️ Ноль не объясняем (№ 31): пустой кабинет в первый день — просто нули,
    без оправдательных подписей.
    """
    _cors(response)
    cid, contact_id = sess["client_id"], sess["contact_id"]

    partner = await _partner_row(db, cid, contact_id)
    if not partner:
        return {"is_partner": False}

    mode = await _effective_mode(db, cid, partner)
    totals = await db.fetchrow(
        """SELECT COALESCE(SUM(amount) FILTER (WHERE payout_id IS NULL), 0) AS due,
                  COALESCE(SUM(amount) FILTER (WHERE payout_id IS NOT NULL), 0) AS paid,
                  COALESCE(SUM(amount), 0) AS total,
                  COUNT(*) AS sales
             FROM partner_accruals WHERE partner_id = $1""",
        partner["id"],
    )
    levels = await db.fetchval(
        "SELECT COALESCE(partner_levels, 1) FROM clients WHERE id = $1", cid) or 1

    # «Мои люди» показываем не всегда (№ 40): в активном режиме закреплённые,
    # не ставшие партнёрами, дохода не приносят — показ породил бы ложное
    # ожидание. Ставших партнёрами показываем в обоих режимах: с их продаж
    # реально идёт второй уровень, и не видя их, партнёр не поймёт, откуда
    # пришли деньги.
    #
    # ⚠️ Считаем ПО ТЕМ ЖЕ ТРЁМ ИСТОЧНИКАМ, что и сам список: закрепление,
    # переход на событие по реф-коду и заход за подарком. Раньше здесь были
    # только закреплённые — и у партнёра, к которому люди приходили по ссылкам,
    # но не закреплялись, раздел не показывался вовсе, хотя показать было что.
    people_count = await db.fetchval(
        """SELECT COUNT(DISTINCT id) FROM (
               SELECT c.id FROM contacts c WHERE c.partner_id = $1
               UNION
               SELECT ep.contact_id FROM event_participants ep
                 JOIN contacts rc ON rc.id = $3
                WHERE ep.referrer_ref_code IS NOT NULL
                  AND (ep.referrer_ref_code = rc.ref_code
                       OR rc.merged_ref_codes ? ep.referrer_ref_code)
               UNION
               SELECT fr.contact_id FROM funnel_runs fr
                WHERE fr.referrer_contact_id = $3 AND fr.contact_id IS NOT NULL
           ) x
           WHERE id <> $3
             AND EXISTS (SELECT 1 FROM contacts c2
                          WHERE c2.id = x.id AND c2.client_id = $2
                            AND c2.merged_into IS NULL)""",
        partner["id"], cid, partner["contact_id"]) or 0

    return {
        "is_partner": True,
        "partner_id": partner["id"],
        "ref_code": partner["ref_code"],
        "name": partner["name"],
        "payout_mode": mode,
        "levels": int(levels),
        "due": float(totals["due"]),
        "paid": float(totals["paid"]),
        "total": float(totals["total"]),
        "sales_count": int(totals["sales"]),
        "people_count": int(people_count),
        # ⚠️ Показываем, КОГДА ЕСТЬ КОГО показать. Прежнее «или пассивный
        # режим» открывало пустой раздел, а в активном прятало его при живых
        # людях, пришедших по ссылке.
        "show_people": bool(people_count),
    }


@router.get("/me/materials", summary="Что можно рекомендовать")
async def partner_materials(response: Response, sess: dict = Depends(_session),
                            db: asyncpg.Connection = Depends(get_db)):
    """События, продукты и лид-магниты с ЕГО ссылками.

    ⚠️ Галочек «разрешить рекомендовать» в кабинете партнёра нет (№ 12) — всё,
    что клиент отметил участвующим, ложится сюда само.
    """
    _cors(response)
    cid, contact_id = sess["client_id"], sess["contact_id"]
    partner = await _partner_row(db, cid, contact_id)
    if not partner:
        raise HTTPException(status_code=403, detail="Вы ещё не партнёр")

    from app.services.client_domains import client_public_url, public_url_for
    base = await client_public_url(db, cid)
    ref = partner["ref_code"]

    events = await db.fetch(
        """SELECT e.id, e.title, e.slug, e.start_at,
                  (SELECT url FROM event_posters ep
                    WHERE ep.event_id = e.id AND ep.day IS NULL
                    ORDER BY CASE ep.orientation WHEN 'square' THEN 1
                                                 WHEN 'horizontal' THEN 2
                                                 ELSE 3 END, ep.sort, ep.id
                    LIMIT 1) AS poster_url
             FROM events e
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
            WHERE eo.client_id = $1 AND e.partner_enabled = TRUE
              AND e.status IN ('published', 'ended')
            ORDER BY e.start_at DESC NULLS LAST
            LIMIT 100""",
        cid,
    )
    products = await db.fetch(
        """SELECT id, title, slug, cover_url FROM products
            WHERE client_id = $1 AND partner_enabled = TRUE AND status <> 'archived'
            ORDER BY title
            LIMIT 100""",
        cid,
    )
    magnets = await db.fetch(
        "SELECT id, name, slug FROM lead_magnets WHERE client_id = $1 ORDER BY name LIMIT 100",
        cid,
    )

    def _link(path: str) -> str:
        return public_url_for(base, f"{path}?pid={ref}")

    # Площадочные ссылки — в бота клиента с меткой и реф-кодом партнёра.
    # ⚠️ Показываем ТОЛЬКО те площадки, где у клиента есть свой бот и где
    # написан разбор метки: ссылка без разбора хуже её отсутствия — реф-код
    # молча теряется, и человек ни за кем не закрепляется.
    from app.services.share_links import build_funnel_landing_links

    async def _platform_links(kind: str, slug: str) -> dict:
        try:
            return await build_funnel_landing_links(
                db, client_id=cid, slug=slug, kind=kind, pid=ref)
        except Exception:  # noqa: BLE001
            return {}

    return {
        "ref_code": ref,
        "events": [{**dict(e), "link": _link(f"/l/{e['slug']}"),
                    "start_at": e["start_at"]} for e in events],
        "products": [
            {**dict(p), "link": _link(f"/pr/{p['slug']}"),
             "platform_links": await _platform_links("pr", p["slug"])}
            for p in products
        ],
        "lead_magnets": [
            {**dict(m), "link": _link(f"/m/{m['slug']}"),
             "platform_links": await _platform_links("m", m["slug"])}
            for m in magnets
        ],
    }


@router.get("/me/sales", summary="Мои продажи")
async def partner_sales(response: Response, sess: dict = Depends(_session),
                        db: asyncpg.Connection = Depends(get_db)):
    """Список продаж — есть ВСЕГДА, в обоих режимах (№ 40)."""
    _cors(response)
    cid, contact_id = sess["client_id"], sess["contact_id"]
    partner = await _partner_row(db, cid, contact_id)
    if not partner:
        raise HTTPException(status_code=403, detail="Вы ещё не партнёр")

    rows = await db.fetch(
        """SELECT a.id, a.level, a.source_kind, a.base_amount, a.amount,
                  a.created_at, a.payout_id IS NOT NULL AS is_paid,
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
             LEFT JOIN contacts bc ON bc.id = a.buyer_contact_id
            WHERE a.partner_id = $1
            ORDER BY a.created_at DESC
            LIMIT 300""",
        partner["id"],
    )
    from app.api.partner_program import _row
    return {"sales": [_row(r) for r in rows]}


@router.get("/me/network", summary="Моя сеть по уровням")
async def partner_network(response: Response, sess: dict = Depends(_session),
                          db: asyncpg.Connection = Depends(get_db)):
    """Партнёры ПОД партнёром, разложенные по уровням.

    ⚠️ Это НЕ «мои люди». «Люди» — те, кого партнёр привёл сам (покупатели и
    просто интересовавшиеся). «Сеть» — партнёры, которые пришли по его ссылке
    и сами продают: с их продаж идёт вознаграждение второго уровня. Смешивать
    нельзя, это разные списки и разные деньги.

    ⚠️ Дерево строится рекурсией по ОДНОМУ полю `contacts.partner_id` — партнёр
    это тоже контакт (решение № 44). Отдельной таблицы связей нет.

    ⚠️ Глубина ограничена настройкой кабинета (`clients.partner_levels`): дальше
    вознаграждение всё равно не начисляется, и показывать эти уровни значило бы
    обещать доход, которого не будет.
    """
    _cors(response)
    cid, contact_id = sess["client_id"], sess["contact_id"]
    partner = await _partner_row(db, cid, contact_id)
    if not partner:
        raise HTTPException(status_code=403, detail="Вы ещё не партнёр")

    max_levels = await db.fetchval(
        "SELECT COALESCE(partner_levels, 1) FROM clients WHERE id = $1", cid) or 1
    mode = await _effective_mode(db, cid, partner)

    rows = await db.fetch(
        """
        WITH RECURSIVE tree AS (
            -- 1-й уровень: партнёры, закреплённые лично за мной
            SELECT p.id, p.contact_id, 1 AS level
              FROM client_partners p
              JOIN contacts c ON c.id = p.contact_id
             WHERE p.client_id = $2 AND c.partner_id = $1
            UNION ALL
            -- Дальше вверх по тому же полю: партнёры моих партнёров
            SELECT p2.id, p2.contact_id, t.level + 1
              FROM tree t
              JOIN contacts c2 ON c2.partner_id = t.id
              JOIN client_partners p2 ON p2.contact_id = c2.id AND p2.client_id = $2
             WHERE t.level < $3
        )
        SELECT t.level, t.id AS partner_id, c.name, c.phone,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                 ORDER BY pu.id LIMIT 1) AS email,
               p.accepted_at, p.is_active,
               -- Сколько принёс ЭТОТ партнёр (оборот его продаж).
               COALESCE((SELECT SUM(a.base_amount) FROM partner_accruals a
                          WHERE a.partner_id = t.id AND a.level = 1), 0) AS turnover,
               -- Сколько с него получил Я — начисления моего уровня по его продажам.
               COALESCE((SELECT SUM(a2.amount) FROM partner_accruals a2
                          WHERE a2.partner_id = $1 AND a2.level = t.level + 1), 0)
                   AS my_income
          FROM tree t
          JOIN client_partners p ON p.id = t.id
          JOIN contacts c ON c.id = t.contact_id
         ORDER BY t.level, p.accepted_at DESC
         LIMIT 500""",
        partner["id"], cid, int(max_levels),
    )

    from app.api.partner_program import _row
    people = [_row(r) for r in rows]
    return {
        "levels": int(max_levels),
        "payout_mode": mode,
        "network": people,
    }


@router.get("/me/people", summary="Мои люди")
async def partner_people(response: Response, sess: dict = Depends(_session),
                         db: asyncpg.Connection = Depends(get_db)):
    """Закреплённые за партнёром.

    ⚠️ Партнёр видит про своих людей ВСЁ (№ 10) — имя, контакты, покупки: он их
    привёл, посторонним не является.

    ⚠️ В АКТИВНОМ режиме показываем только тех, кто СТАЛ ПАРТНЁРОМ (№ 40).
    Остальные дохода не приносят, и показать их — значит пообещать
    несуществующее. Ставших партнёрами не прячем ни в каком режиме: по ним
    считается второй уровень, и без них партнёр не поймёт, откуда деньги.
    """
    _cors(response)
    cid, contact_id = sess["client_id"], sess["contact_id"]
    partner = await _partner_row(db, cid, contact_id)
    if not partner:
        raise HTTPException(status_code=403, detail="Вы ещё не партнёр")

    mode = await _effective_mode(db, cid, partner)

    # ⚠️⚠️ ПОКАЗЫВАЕМ И ТЕХ, КТО ЕЩЁ НИЧЕГО НЕ КУПИЛ (решение владельца).
    # Раньше здесь были только закреплённые с покупками — то есть партнёр видел
    # лишь состоявшиеся продажи и не знал, кто интересовался. А именно эти люди
    # и есть его работа: с ними можно связаться и довести до покупки.
    #
    # Три источника «человек пришёл по моей ссылке» (у каждого свой смысл, и ни
    # один не покрывает остальные):
    #   • contacts.partner_id            — закреплён за партнёром;
    #   • event_participants             — открыл событие по его реф-коду;
    #   • funnel_runs                    — пришёл за подарком по его ссылке.
    #
    # ⚠️ Реф-код учитываем вместе с `merged_ref_codes`: после объединения
    # контактов старый код продолжает ходить по чужим постам, и терять из-за
    # этого приведённых нельзя.
    rows = await db.fetch(
        """
        WITH mine AS (
            -- Закреплённые за партнёром
            SELECT c.id, c.partner_bound_at AS came_at, TRUE AS bound
              FROM contacts c
             WHERE c.partner_id = $1
            UNION
            -- Пришли на событие по его реф-коду
            -- ⚠️ `created_at` у участника НЕТ; берём самую раннюю известную
            -- отметку. Все могут быть пустыми — человек просто открыл событие
            -- и не зарегистрировался, а это и есть «интересовался».
            SELECT ep.contact_id,
                   MIN(LEAST(ep.registered_at, ep.activated_at,
                             ep.link_clicked_at)), FALSE
              FROM event_participants ep
              JOIN contacts rc ON rc.id = $3
             WHERE ep.referrer_ref_code IS NOT NULL
               AND (ep.referrer_ref_code = rc.ref_code
                    OR rc.merged_ref_codes ? ep.referrer_ref_code)
             GROUP BY ep.contact_id
            UNION
            -- Пришли за подарком по его ссылке
            SELECT fr.contact_id, MIN(fr.landed_at), FALSE
              FROM funnel_runs fr
             WHERE fr.referrer_contact_id = $3 AND fr.contact_id IS NOT NULL
             GROUP BY fr.contact_id
        )
        SELECT c.id, c.name, c.phone,
               MIN(m.came_at) AS came_at,
               bool_or(m.bound) AS is_bound,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                 ORDER BY pu.id LIMIT 1) AS email,
               EXISTS (SELECT 1 FROM client_partners p2
                        WHERE p2.contact_id = c.id AND p2.client_id = $2) AS is_partner,
               -- Сколько человек ЗАПЛАТИЛ по продажам этого партнёра.
               -- 0 = интересовался, но не купил.
               COALESCE((SELECT SUM(a.base_amount) FROM partner_accruals a
                          WHERE a.buyer_contact_id = c.id AND a.partner_id = $1), 0) AS spent,
               -- Контакты на площадках — чтобы партнёр мог написать человеку.
               (SELECT json_agg(json_build_object(
                          'platform', pu2.platform_slug,
                          'user_id', pu2.platform_user_id,
                          'username', pu2.username))
                  FROM platform_users pu2
                 WHERE pu2.contact_id = c.id
                   AND pu2.platform_slug IN ('telegram', 'vk', 'max')) AS identities
          FROM mine m
          JOIN contacts c ON c.id = m.id
         WHERE c.client_id = $2 AND c.merged_into IS NULL
           AND c.id <> $3
         GROUP BY c.id, c.name, c.phone
         ORDER BY MIN(m.came_at) DESC NULLS LAST
         LIMIT 500""",
        partner["id"], cid, partner["contact_id"],
    )

    from app.api.partner_program import _row
    from app.services.profile_links import profile_url

    people = []
    for r in rows:
        item = _row(r)
        # Готовые ссылки «написать человеку» — партнёр не должен собирать их
        # руками из ника. Строим общим хелпером, свой формат не выдумываем.
        links = {}
        for ident in (item.pop("identities", None) or []):
            url = profile_url(ident.get("platform"),
                              user_id=ident.get("user_id"),
                              username=ident.get("username"))
            if url:
                links[ident["platform"]] = url
        item["links"] = links
        item["bought"] = float(item.get("spent") or 0) > 0
        people.append(item)

    return {"people": people, "payout_mode": mode}
