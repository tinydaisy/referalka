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
