"""
Публичная часть продуктов (миграция 290): витрина `/pr/{slug}` и кабинет
купившего `/my`.

Две разные вещи:
  • ВИТРИНА — что человек видит ДО покупки: описание, тарифы, состав
    (названия и описания, БЕЗ ссылок на файлы), оферта.
  • КАБИНЕТ — что он видит ПОСЛЕ: те же материалы, но со ссылками, и только
    те, что открыты его тарифом.

⚠️ На витрине ссылок на материалы нет ни в каком виде — иначе лендинг раздаёт
содержимое бесплатно. Ссылка появляется только в кабинете и только у того, у
кого есть запись в `product_access`.

⚠️ Кабинет — в границах КЛИЕНТА (как аккаунт GetCourse): человек видит
продукты, купленные у этого клиента, чужих брендов там нет.

Роуты:
  GET  /api/v1/public/products/{slug}                — витрина
  POST /api/v1/public/product-cabinet/request-code   — код входа на почту
  POST /api/v1/public/product-cabinet/auth           — код → сессия
  GET  /api/v1/public/product-cabinet/me             — что куплено
  GET  /api/v1/public/product-cabinet/me/{slug}      — материалы продукта
"""
import hashlib
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg
import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel

from app.config import settings
from app.database import get_db
from app.services.client_domains import client_id_by_domain
from app.services.preview_token import is_preview_owner
from app.services.tariff_discount import with_discount

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/public", tags=["Продукты — публичное"])

_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}


def _cors(response: Response) -> None:
    for k, v in _CORS.items():
        response.headers[k] = v


# ── Сессия кабинета ───────────────────────────────────────────────────────
# По образцу кабинета спикера: подписанный токен на 24 часа, без cookies —
# кабинет открывается и с домена клиента, и с pluson.ru.

_CAB_AUD = "product-cabinet"
_CAB_TTL_HOURS = 24


def _sign(client_id: int, contact_id: int) -> str:
    """JWT той же схемы, что в кабинете спикера — свой формат не плодим.

    ⚠️ `aud` обязателен: без него токеном кабинета спикера можно было бы
    войти в кабинет покупателя и наоборот.
    """
    return jwt.encode(
        {
            "aud": _CAB_AUD,
            "cl_id": client_id,
            "ct_id": contact_id,
            "exp": datetime.now(timezone.utc) + timedelta(hours=_CAB_TTL_HOURS),
        },
        settings.jwt_secret, algorithm="HS256",
    )


def _decode(token: str) -> dict:
    try:
        data = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"],
                          audience=_CAB_AUD)
        return {"client_id": int(data["cl_id"]), "contact_id": int(data["ct_id"])}
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Сессия истекла — войдите заново")


def _session(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Требуется вход")
    return _decode(authorization[7:])


async def _client_by_host(db, request: Request) -> Optional[int]:
    """Чей это домен. На pluson.ru вернёт None — там кабинет открывается по
    номеру кабинета в адресе."""
    host = (request.headers.get("host") or "").split(":")[0].lower()
    if not host:
        return None
    try:
        return await client_id_by_domain(db, host)
    except Exception:
        return None


# ── Витрина продукта ──────────────────────────────────────────────────────

@router.get("/products/{slug}", summary="Витрина продукта")
async def product_public(
    slug: str, request: Request, response: Response,
    client_id: Optional[int] = None,
    preview: Optional[str] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    """Всё для страницы продукта одним запросом.

    ⚠️ slug уникален в пределах КАБИНЕТА, не глобально: у разных клиентов
    может быть свой `/pr/mentoring`. Клиента определяем по домену, а на
    общем pluson.ru — по параметру.
    """
    _cors(response)

    cid = await _client_by_host(db, request) or client_id
    if cid:
        row = await db.fetchrow(
            "SELECT * FROM products WHERE slug = $1 AND client_id = $2", slug, cid)
    else:
        # На общем домене без указания кабинета: slug должен быть однозначным.
        rows = await db.fetch("SELECT * FROM products WHERE slug = $1 LIMIT 2", slug)
        if len(rows) > 1:
            raise HTTPException(status_code=404, detail="Уточните адрес кабинета")
        row = rows[0] if rows else None

    # ⚠️ ЧЕРНОВИК ПРОДУКТА ОТКРЫТ ПО ССЫЛКЕ (2026-08-14). У продукта нет
    # внешнего каталога (в отличие от событий, которые попадают в календарь):
    # публикация ничего наружу не открывает, а страница нужна сразу — её
    # рассылают ссылкой. Раньше черновик отдавал 404, и клиент видел
    # «Страница не найдена» на собственном продукте.
    #
    # Статус оставлен на будущее — появится внешний каталог продуктов, там он
    # и будет решать, показывать ли карточку. Доступ по прямой ссылке к этому
    # отношения не имеет.
    #
    # `archived` закрыт: архив — это осознанное «убрать», и ссылка на него
    # должна перестать работать.
    if not row:
        raise HTTPException(status_code=404, detail="Страница не найдена")
    if row["status"] == "archived" and not is_preview_owner(preview, row["client_id"]):
        raise HTTPException(status_code=404, detail="Страница не найдена")

    product_id = row["id"]

    tariffs = await db.fetch(
        """SELECT id, code, title, description, excluded_description, price,
                  discount_kind, discount_value,
                  order_hint, is_featured, sort_order
             FROM product_tariffs
            WHERE product_id = $1 AND is_active
            ORDER BY sort_order, id""",
        product_id,
    )

    sections = await db.fetch(
        "SELECT id, parent_id, title, description, sort_order "
        "FROM product_sections WHERE product_id = $1 ORDER BY sort_order, id",
        product_id,
    )

    # ⚠️ Состав для витрины: название, описание, тип и с какого тарифа открыт.
    # Ссылок (`url`, `body`) здесь НЕТ и быть не должно.
    items = await db.fetch(
        """SELECT pm.id AS link_id, pm.section_id, pm.sort_order,
                  pm.min_tariff_id,
                  COALESCE(pm.title_override, m.title) AS title,
                  m.description
             FROM product_materials pm
             JOIN materials m ON m.id = pm.material_id
            WHERE pm.product_id = $1 AND pm.show_on_landing
            ORDER BY pm.sort_order, pm.id""",
        product_id,
    )

    client = await db.fetchrow(
        "SELECT id, name, brand_name, brand_logo_url FROM clients WHERE id = $1",
        row["client_id"],
    )

    return {
        "product": {
            "id": product_id,
            "slug": row["slug"],
            "title": row["title"],
            "subtitle": row["subtitle"],
            "description": row["description"],
            "cover_url": row["cover_url"],
            "offer_url": row["offer_url"],
            "wording_preset": row["wording_preset"],
            "wording": _jsonb(row["wording"]),
        },
        "client": dict(client) if client else None,
        "tariffs": [with_discount(t) for t in tariffs],
        "sections": [dict(s) for s in sections],
        "content": [dict(i) for i in items],
    }


def _jsonb(value):
    """asyncpg отдаёт JSONB строкой — разворачиваем, иначе фронт получит текст.

    ⚠️ Та же грабля, что была с вариантами ответов в анкетах: при новой точке
    отдачи JSONB не забыть развернуть.
    """
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return {}
    return value or {}


# ── Вход в кабинет ────────────────────────────────────────────────────────

class CodeRequest(BaseModel):
    email: str
    client_id: Optional[int] = None


class AuthRequest(BaseModel):
    email: str
    code: str
    client_id: Optional[int] = None


@router.post("/product-cabinet/request-code", summary="Код входа на почту")
async def request_code(
    data: CodeRequest, request: Request, response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Отправляет одноразовый код на почту.

    ⚠️ Ответ ОДИНАКОВЫЙ, есть такая почта у клиента или нет: иначе по форме
    входа можно было бы перебором узнать, кто у него покупал.
    """
    _cors(response)
    cid = await _client_by_host(db, request) or data.client_id
    if not cid:
        raise HTTPException(status_code=400, detail="Не удалось определить кабинет")

    email = (data.email or "").strip().lower()
    ok = {"ok": True, "sent": True}
    # ⚠️⚠️ Говорим правду, когда письма не будет — см. тот же приём в
    # partner_public.request_code. Молчаливое «Код отправлен» заставляло
    # человека ждать письмо, которого никто не слал.
    no_access = {
        "ok": True, "sent": False,
        "message": ("На этой почте нет доступа в кабинет. Проверьте написание "
                    "адреса — важны точки и раскладка. Если ошибки нет, "
                    "напишите тому, у кого вы покупали: доступ откроют."),
    }
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
        return no_access

    has_access = await db.fetchval(
        """SELECT 1 FROM product_access pa
            JOIN products p ON p.id = pa.product_id
           WHERE pa.contact_id = $1 AND p.client_id = $2 LIMIT 1""",
        contact_id, cid,
    )
    if not has_access:
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
    except Exception as e:
        logger.warning("Код входа в кабинет не отправлен: %s", e)
    return ok


@router.post("/product-cabinet/auth", summary="Код → сессия")
async def cabinet_auth(
    data: AuthRequest, request: Request, response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    _cors(response)
    cid = await _client_by_host(db, request) or data.client_id
    if not cid:
        raise HTTPException(status_code=400, detail="Не удалось определить кабинет")

    email = (data.email or "").strip().lower()
    code_hash = hashlib.sha256((data.code or "").strip().encode()).hexdigest()

    row = await db.fetchrow(
        """SELECT pc.id, pc.contact_id
             FROM product_cabinet_codes pc
             JOIN platform_users pu ON pu.contact_id = pc.contact_id
                  AND pu.platform_slug = 'email' AND pu.platform_user_id = $3
            WHERE pc.client_id = $1 AND pc.code_hash = $2
              AND pc.used_at IS NULL AND pc.expires_at > NOW()
            ORDER BY pc.id DESC LIMIT 1""",
        cid, code_hash, email,
    )
    if not row:
        raise HTTPException(status_code=400, detail="Код неверен или устарел")

    await db.execute("UPDATE product_cabinet_codes SET used_at = NOW() WHERE id = $1",
                     row["id"])
    return {"ok": True, "token": _sign(cid, row["contact_id"])}


# ── Кабинет купившего ─────────────────────────────────────────────────────

async def _brand(db, client_id: int) -> Optional[dict]:
    """Оформление кабинета купившего — логотип, имя и цвета клиента.

    ⚠️ Человек купил у КОНКРЕТНОГО эксперта: без логотипа и названия кабинет
    выглядит безымянным чужим сервисом. Цвета берём из темы лендингов
    (`clients.lp_*`) — одна настройка на всё, отдельно оформлять кабинет
    клиенту не нужно.
    """
    row = await db.fetchrow(
        """SELECT name, brand_name, brand_logo_url, brand_logo_light_url,
                  lp_bg_color, lp_bg_color_2, lp_color_heading, lp_btn_color,
                  lp_btn_text_color
             FROM clients WHERE id = $1""",
        client_id,
    )
    return dict(row) if row else None


@router.get("/product-cabinet/me", summary="Что мне открыто")
async def cabinet_me(
    response: Response,
    sess: dict = Depends(_session),
    db: asyncpg.Connection = Depends(get_db),
):
    _cors(response)
    rows = await db.fetch(
        """SELECT p.id, p.slug, p.title, p.subtitle, p.cover_url,
                  p.wording_preset, pa.granted_at,
                  t.title AS tariff_title,
                  (SELECT COUNT(*) FROM product_materials pm
                    WHERE pm.product_id = p.id) AS items_count
             FROM product_access pa
             JOIN products p ON p.id = pa.product_id
        LEFT JOIN product_tariffs t ON t.id = pa.tariff_id
            WHERE pa.contact_id = $1 AND p.client_id = $2
              AND p.status <> 'archived'
            ORDER BY pa.granted_at DESC""",
        sess["contact_id"], sess["client_id"],
    )
    return {"products": [dict(r) for r in rows],
            "brand": await _brand(db, sess["client_id"])}


@router.get("/product-cabinet/me/{slug}", summary="Материалы продукта")
async def cabinet_product(
    slug: str, response: Response,
    sess: dict = Depends(_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Материалы, открытые ЭТОМУ человеку по ЕГО тарифу.

    ⚠️ Фильтр по тарифу — на бэкенде, а не в интерфейсе: иначе ссылки на
    материалы старших тарифов уехали бы в браузер к тому, кто их не покупал.
    """
    _cors(response)

    access = await db.fetchrow(
        """SELECT pa.tariff_id, p.id AS product_id, p.title, p.slug,
                  p.wording_preset, t.sort_order AS tariff_rank
             FROM product_access pa
             JOIN products p ON p.id = pa.product_id
        LEFT JOIN product_tariffs t ON t.id = pa.tariff_id
            WHERE pa.contact_id = $1 AND p.client_id = $2 AND p.slug = $3""",
        sess["contact_id"], sess["client_id"], slug,
    )
    if not access:
        raise HTTPException(status_code=404, detail="У вас нет доступа к этому продукту")

    sections = await db.fetch(
        "SELECT id, parent_id, title, description, sort_order "
        "FROM product_sections WHERE product_id = $1 ORDER BY sort_order, id",
        access["product_id"],
    )

    # Материал виден, если он открыт всем (min_tariff_id IS NULL) либо тариф
    # человека не ниже требуемого. «Не ниже» = по порядку тарифов на странице:
    # клиент сам расставляет их от младшего к старшему.
    items = await db.fetch(
        """SELECT pm.id AS link_id, pm.section_id, pm.sort_order,
                  pm.material_id,
                  COALESCE(pm.title_override, m.title) AS title,
                  m.description
             FROM product_materials pm
             JOIN materials m ON m.id = pm.material_id
        LEFT JOIN product_tariffs mt ON mt.id = pm.min_tariff_id
            WHERE pm.product_id = $1
              AND (pm.min_tariff_id IS NULL
                   OR ($2::int IS NOT NULL AND mt.sort_order <= $2))
            ORDER BY pm.sort_order, pm.id""",
        access["product_id"], access["tariff_rank"],
    )

    # Содержимое каждого материала — блоками (миграция 294): текст, картинки,
    # видео по ссылке, файлы, аудио, кнопки.
    out_items = []
    for it in items:
        d = dict(it)
        blocks = await db.fetch(
            "SELECT id, kind, title, body, url, size_bytes, duration_sec, sort_order "
            "FROM material_blocks WHERE material_id = $1 ORDER BY sort_order, id",
            it["material_id"],
        )
        d["blocks"] = [dict(b) for b in blocks]
        out_items.append(d)

    # ⚠️ Бренд клиента — чтобы кабинет купившего был в ЕГО оформлении, а не в
    # безымянном сером. Человек купил у конкретного эксперта: логотип и
    # название должны быть его, иначе кабинет выглядит чужим сервисом.
    # Цвета берём из темы лендингов (`clients.lp_*`) — одна настройка на всё,
    # клиенту не надо оформлять кабинет отдельно.
    return {
        "product": {
            "id": access["product_id"],
            "slug": access["slug"],
            "title": access["title"],
            "wording_preset": access["wording_preset"],
        },
        "brand": await _brand(db, sess["client_id"]),
        "sections": [dict(s) for s in sections],
        "items": out_items,
    }


# ── Мой профиль ───────────────────────────────────────────────────────────

class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None


class EmailChangeRequest(BaseModel):
    email: str


class EmailChangeConfirm(BaseModel):
    email: str
    code: str


@router.get("/product-cabinet/me/profile/data", summary="Мои данные")
async def cabinet_profile(
    response: Response,
    sess: dict = Depends(_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Имя, почта и телефон человека — для раздела «Мой профиль».

    ⚠️ Путь с хвостом `/data`: ручка `/me/{slug}` ловит любой сегмент как slug
    продукта, и `/me/profile` ушёл бы в неё, а не сюда.
    """
    _cors(response)
    row = await db.fetchrow(
        """SELECT c.id, c.name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email
             FROM contacts c WHERE c.id = $1""",
        sess["contact_id"],
    )
    if not row:
        raise HTTPException(status_code=404, detail="Профиль не найден")
    return dict(row)


@router.patch("/product-cabinet/me/profile", summary="Правка имени и телефона")
async def cabinet_profile_save(
    data: ProfileUpdate, response: Response,
    sess: dict = Depends(_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Правка идёт В КОНТАКТ клиента — это одна и та же запись.

    ⚠️ Почта здесь НЕ меняется: она логин входа, и опечатка отрезала бы
    человека от купленного. Смена — отдельной парой ручек с подтверждением
    кодом на НОВЫЙ адрес (см. ниже).

    ⚠️ Телефон пишем только через `set_contact_phone`: рядом обязан
    обновляться `phone_normalized`, по нему ищутся дубли (правило проекта).
    """
    _cors(response)
    name = (data.name or "").strip()
    if name:
        await db.execute(
            "UPDATE contacts SET name = $2, updated_at = NOW() WHERE id = $1",
            sess["contact_id"], name[:200],
        )
    if data.phone is not None:
        from app.services.contact_merge import set_contact_phone
        await set_contact_phone(db, sess["contact_id"], data.phone,
                                only_if_empty=False)
    return {"ok": True}


@router.post("/product-cabinet/me/email/request", summary="Код на новую почту")
async def cabinet_email_request(
    data: EmailChangeRequest, response: Response,
    sess: dict = Depends(_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Код подтверждения уходит на НОВЫЙ адрес.

    ⚠️⚠️ Именно так почта защищена от опечатки: не подтвердил — не сменилась.
    Иначе описка в адресе (лишняя точка, чужая раскладка) навсегда отрезала бы
    человека от купленного, а чинить пришлось бы вручную в базе.
    """
    _cors(response)
    email = (data.email or "").strip().lower()
    if "@" not in email or len(email) < 5:
        raise HTTPException(status_code=400, detail="Проверьте адрес почты")

    busy = await db.fetchval(
        """SELECT c.id FROM contacts c
             JOIN platform_users pu ON pu.contact_id = c.id
                  AND pu.platform_slug = 'email' AND pu.platform_user_id = $2
            WHERE c.client_id = $1 AND c.merged_into IS NULL AND c.id <> $3
            LIMIT 1""",
        sess["client_id"], email, sess["contact_id"],
    )
    if busy:
        raise HTTPException(
            status_code=409,
            detail="Эта почта уже занята другим человеком в базе.")

    code = f"{secrets.randbelow(1000000):06d}"
    await db.execute(
        """INSERT INTO product_cabinet_codes
                (client_id, contact_id, code_hash, expires_at, new_email)
           VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes', $4)""",
        sess["client_id"], sess["contact_id"],
        hashlib.sha256(code.encode()).hexdigest(), email,
    )
    try:
        from app.services.product_notify import send_email_change_code
        await send_email_change_code(db, client_id=sess["client_id"],
                                     email=email, code=code)
    except Exception as e:
        logger.warning("Код смены почты не отправлен: %s", e)
        raise HTTPException(status_code=502,
                            detail="Не удалось отправить письмо. Попробуйте позже.")
    return {"ok": True}


@router.post("/product-cabinet/me/email/confirm", summary="Подтвердить новую почту")
async def cabinet_email_confirm(
    data: EmailChangeConfirm, response: Response,
    sess: dict = Depends(_session),
    db: asyncpg.Connection = Depends(get_db),
):
    _cors(response)
    email = (data.email or "").strip().lower()
    code_hash = hashlib.sha256((data.code or "").strip().encode()).hexdigest()

    row = await db.fetchrow(
        """SELECT id FROM product_cabinet_codes
            WHERE client_id = $1 AND contact_id = $2 AND code_hash = $3
              AND new_email = $4 AND used_at IS NULL AND expires_at > NOW()
            ORDER BY id DESC LIMIT 1""",
        sess["client_id"], sess["contact_id"], code_hash, email,
    )
    if not row:
        raise HTTPException(status_code=400, detail="Код неверен или устарел")

    async with db.transaction():
        await db.execute(
            "UPDATE product_cabinet_codes SET used_at = NOW() WHERE id = $1",
            row["id"])
        # ⚠️ Почта — идентичность, а не колонка контакта (правило проекта:
        # `contacts.email` дропнута миграцией 282).
        await db.execute(
            """INSERT INTO platform_users (contact_id, platform_slug, platform_user_id)
               VALUES ($1, 'email', $2)
               ON CONFLICT (contact_id, platform_slug)
               DO UPDATE SET platform_user_id = EXCLUDED.platform_user_id""",
            sess["contact_id"], email,
        )
    return {"ok": True, "email": email}


@router.get("/product-cabinet/me/support/list", summary="Каналы поддержки клиента")
async def cabinet_support(
    response: Response,
    sess: dict = Depends(_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Куда написать за помощью — площадки, где у клиента есть аккаунт.

    ⚠️ Отдаём только заполненные: пустая плитка «ВКонтакте», ведущая никуда,
    хуже её отсутствия.
    """
    _cors(response)
    row = await db.fetchrow(
        """SELECT work_tg_username, work_vk, work_max, phone,
                  COALESCE(NULLIF(brand_name, ''), name) AS brand
             FROM clients WHERE id = $1""",
        sess["client_id"],
    )
    if not row:
        return {"items": []}

    def _link(value: str, kind: str) -> Optional[str]:
        v = (value or "").strip()
        if not v:
            return None
        if v.startswith("http"):
            return v
        nick = v.lstrip("@")
        if kind == "telegram":
            return f"https://telegram.me/{nick}"
        if kind == "vk":
            return f"https://vk.com/{nick}"
        if kind == "max":
            return f"https://max.ru/{nick}"
        return v

    items = []
    for kind, label, value in (
        ("telegram", "Telegram", row["work_tg_username"]),
        ("max", "MAX", row["work_max"]),
        ("vk", "ВКонтакте", row["work_vk"]),
    ):
        url = _link(value, kind)
        if url:
            items.append({"kind": kind, "label": label, "url": url})
    return {"items": items, "brand": row["brand"]}
