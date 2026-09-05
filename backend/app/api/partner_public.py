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


def _cors(response: Response) -> None:
    from app.api.products_public import _cors as apply
    apply(response)


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
        "tax_statuses": [
            {"value": "self_employed", "label": "Самозанятый"},
            {"value": "ip", "label": "ИП"},
            {"value": "company", "label": "Юридическое лицо"},
            {"value": "individual", "label": "Физическое лицо"},
        ],
    }


class RegisterIn(BaseModel):
    client_id: Optional[int] = None
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
    cid = await _client_by_host(db, request) or data.client_id
    if not cid:
        raise HTTPException(status_code=400, detail="Не удалось определить кабинет")

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

    existing = await _partner_row(db, cid, contact_id)
    if existing:
        return {"ok": True, "already": True, "partner_id": existing["id"],
                "ref_code": existing["ref_code"]}

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
        return {"ok": True, "already": True, "partner_id": row["id"] if row else None,
                "ref_code": row["ref_code"] if row else None}

    # ⚠️ РЕТРОАКТИВНОГО ЗАКРЕПЛЕНИЯ НЕТ (№ 28). Здесь сознательно нет прохода
    # по истории: прошлые заслуги не засчитываются. Отсутствие такого кода —
    # и есть реализация правила.

    ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", contact_id)
    logger.info("Партнёрка: клиент %s, новый партнёр %s (контакт %s)",
                cid, partner_id, contact_id)
    return {"ok": True, "partner_id": partner_id, "ref_code": ref_code}


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
    cid = await _client_by_host(db, request) or data.client_id
    if not cid:
        raise HTTPException(status_code=400, detail="Не удалось определить кабинет")

    email = (data.email or "").strip().lower()
    ok = {"ok": True, "sent": True}
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Проверьте адрес почты")

    contact_id = await db.fetchval(
        """SELECT c.id FROM contacts c
             JOIN platform_users pu ON pu.contact_id = c.id
                  AND pu.platform_slug = 'email' AND pu.platform_user_id = $2
            WHERE c.client_id = $1 AND c.merged_into IS NULL LIMIT 1""",
        cid, email,
    )
    if not contact_id:
        return ok

    is_partner = await db.fetchval(
        "SELECT 1 FROM client_partners WHERE client_id = $1 AND contact_id = $2",
        cid, contact_id)
    has_access = await db.fetchval(
        """SELECT 1 FROM product_access pa
             JOIN products p ON p.id = pa.product_id
            WHERE pa.contact_id = $1 AND p.client_id = $2 LIMIT 1""",
        contact_id, cid)
    if not is_partner and not has_access:
        return ok

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
    people_count = await db.fetchval(
        """SELECT COUNT(*) FROM contacts c
            WHERE c.partner_id = $1
              AND ($2 = 'passive' OR EXISTS (
                    SELECT 1 FROM client_partners p2
                     WHERE p2.contact_id = c.id AND p2.client_id = $3))""",
        partner["id"], mode, cid) or 0

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
        "show_people": bool(people_count) or mode == "passive",
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
    rows = await db.fetch(
        """SELECT c.id, c.name, c.phone, c.partner_bound_at,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                    ORDER BY pu.id LIMIT 1) AS email,
                  EXISTS (SELECT 1 FROM client_partners p2
                           WHERE p2.contact_id = c.id AND p2.client_id = $2) AS is_partner,
                  COALESCE((SELECT SUM(a.base_amount) FROM partner_accruals a
                             WHERE a.buyer_contact_id = c.id AND a.partner_id = $1), 0) AS spent
             FROM contacts c
            WHERE c.partner_id = $1
              AND ($3 = 'passive' OR EXISTS (
                    SELECT 1 FROM client_partners p3
                     WHERE p3.contact_id = c.id AND p3.client_id = $2))
            ORDER BY c.partner_bound_at DESC NULLS LAST
            LIMIT 500""",
        partner["id"], cid, mode,
    )
    from app.api.partner_program import _row
    return {"people": [_row(r) for r in rows], "payout_mode": mode}
