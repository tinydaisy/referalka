"""
Регистрация партнёров — клиент через сторонний партнёрский сервис.

Не привязано к событию/лид-магниту. Самостоятельная фича.

Поток:
  1. Клиент в Настройках → Технические вписывает URL стороннего лендинга
     партнёрской системы (Tilda/GetCourse/Bizon360) → clients.partner_landing_url.
  2. У каждого контакта в карточке появляется блок «Партнёрская ссылка»:
     pluson.ru/partner/{client_id}?to=tg&pluson_cid={contact.id}&{external_ref_param}
     (хвост `&gcpc=fdd97` приклеивается если у контакта есть external_ref_param).
  3. Другой человек открывает ссылку → бэк создаёт partner_runs (запоминает
     рефовода + хвост query-строки) → 302 в бот платформы со start=prt_<run_id>.
  4. /start prt_<id> в боте:
     · если у контакта НЕТ external_ref_param → «Регистрируетесь Партнёром у
       {owner} ({brand})» + web_app кнопка → Mini App → авто-редирект на
       лендинг с pluson_cid={new_id} + {referrer_query}.
     · если контакт УЖЕ зарегистрирован партнёром → «Вы уже партнёр.
       Ваш код: XXX. По вопросам — @work_tg».
  5. Человек заполняет форму → клиент в редирект ставит /r/partner/{run_id}
     → возврат в Mini App, экран успеха (poll на external_ref_param).
  6. GetCourse/Bizon360 шлёт webhook /integrations/salebot/register с
     pluson_cid+external_ref_param → contacts.external_ref_param обновляется.

Публичные endpoints (без авторизации, под `/`):
  GET  /partner/{client_id}                           — landing-redirect в бот
  GET  /r/partner/{run_id}                            — возврат с лендинга (Mini App)

API endpoints (авторизованные, под `/api/v1`):
  GET  /api/v1/partner/runs/{run_id}                  — данные забега для Mini App
  GET  /api/v1/partner/runs/{run_id}/contact-status   — poll: внешний код пришёл?
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from typing import Optional
from app.database import get_pool
from app.services.share_links import get_client_bot_handles, _has_system_channel
from app.config import settings
import asyncpg
import logging
import re

log = logging.getLogger(__name__)

public_router = APIRouter(tags=["Регистрация партнёров (публичные)"])
api_router    = APIRouter(prefix="/partner", tags=["Регистрация партнёров"])


_PLATFORM_ALIASES = {
    'tg': 'telegram',
    'telegram': 'telegram',
    'vk': 'vk',
    'max': 'max',
}

# Ключи query-параметров, которые НЕ являются частью внешнего партнёрского кода
# и не должны попадать в referrer_query при склейке URL лендинга.
_RESERVED_QUERY_KEYS = {'to', 'pluson_cid'}


async def _client_bot_username(client_id: int, db: asyncpg.Connection) -> str:
    """@username TG-бота: свой бот клиента (если фича channels) или @pluson_bot."""
    from app.services.features import client_has_feature
    has_channels = await client_has_feature(db, client_id, "channels")
    if has_channels:
        row = await db.fetchrow(
            """SELECT ch.handle
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1
                  AND cc.is_active = TRUE
                  AND ch.platform_slug = 'telegram'
                  AND ch.is_system = FALSE
                  AND ch.bot_token IS NOT NULL
                ORDER BY ch.id ASC LIMIT 1""",
            client_id,
        )
        if row and row["handle"]:
            h = row["handle"].lstrip('@')
            if h:
                return h
    return getattr(settings, 'plusson_bot_username', None) or 'pluson_bot'


async def _platform_redirect_url(client_id: int, platform: str, run_id: int,
                                 db: asyncpg.Connection) -> str:
    """Deeplink в чат бота / VK Mini App / MAX-бота, чтобы там попасть в /start prt_<id>."""
    if platform == 'telegram':
        bot_username = await _client_bot_username(client_id, db)
        return f"https://t.me/{bot_username}?start=prt_{run_id}"
    if platform == 'vk':
        # Только собственный VK Mini App клиента (см. funnels._platform_redirect_url
        # для деталей — системное VK-сообщество ПЛЮСОНа не используется для
        # чужих клиентов, нарушает приватность).
        row = await db.fetchrow(
            """SELECT (ch.platform_meta->>'vk_app_id')::int AS vk_app_id
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1
                  AND cc.is_active = TRUE
                  AND ch.platform_slug = 'vk'
                  AND ch.is_system = FALSE
                  AND ch.platform_meta->>'vk_app_id' IS NOT NULL
                LIMIT 1""",
            client_id,
        )
        if not row or not row["vk_app_id"]:
            raise HTTPException(status_code=404, detail="У клиента не подключено VK Mini App")
        return f"https://vk.com/app{int(row['vk_app_id'])}#prt_{run_id}"
    if platform == 'max':
        handles = await get_client_bot_handles(db, client_id)
        handle = (handles.get('max') or '').lstrip('@')
        if not handle:
            raise HTTPException(status_code=404, detail="У клиента не подключён MAX-бот")
        return f"https://max.ru/{handle}?start=prt_{run_id}"
    raise HTTPException(status_code=400, detail=f"Неизвестная платформа: {platform}")


def _build_referrer_query(qp: dict) -> str:
    """Из query-параметров строит «хвост» для URL лендинга.

    Исключаем служебные параметры (to, pluson_cid) — всё остальное считаем
    партнёрским кодом во внешней системе клиента (например `gcpc=fdd97` —
    может быть несколько пар через &).
    """
    parts: list[str] = []
    for k, v in qp.items():
        if k in _RESERVED_QUERY_KEYS:
            continue
        if not k:
            continue
        # Без перекодирования — клиент кладёт строку как есть, в неё включён
        # ровно тот формат, который ждёт его партнёрская система.
        parts.append(f"{k}={v}")
    return "&".join(parts)


@public_router.get("/partner/{client_id}",
                   summary="Landing регистрации партнёра — редирект в бот")
async def partner_landing(client_id: int, request: Request) -> RedirectResponse:
    qp = dict(request.query_params)
    to_raw = (qp.get('to') or 'tg').lower()
    platform = _PLATFORM_ALIASES.get(to_raw)
    if not platform:
        raise HTTPException(status_code=400, detail="Параметр to должен быть tg, vk или max")

    pool = await get_pool()
    async with pool.acquire() as db:
        client = await db.fetchrow(
            "SELECT id, partner_landing_url FROM clients WHERE id = $1 AND is_active = TRUE",
            client_id,
        )
        if not client:
            raise HTTPException(status_code=404, detail="Клиент не найден")
        if not (client["partner_landing_url"] or "").strip():
            raise HTTPException(status_code=404,
                                detail="У клиента не настроена партнёрская ссылка")

        # Проверяем доступность платформы клиенту (как в funnels._landing)
        own_channel = await db.fetchval(
            """SELECT 1 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1 AND cc.is_active = TRUE
                  AND ch.platform_slug = $2 LIMIT 1""",
            client_id, platform,
        )
        if not own_channel:
            if platform == 'telegram':
                if not await _has_system_channel(db, 'telegram', allow_test=False):
                    raise HTTPException(status_code=404, detail="Платформа telegram не подключена")
            else:
                raise HTTPException(status_code=404,
                                    detail=f"Платформа {platform} не подключена клиентом")

        # Резолвим referrer: если в URL есть pluson_cid и он валидный contact
        # ЭТОГО клиента — это рефовод.
        referrer_contact_id: Optional[int] = None
        pluson_cid_raw = qp.get('pluson_cid')
        if pluson_cid_raw and pluson_cid_raw.isdigit():
            referrer_contact_id = await db.fetchval(
                "SELECT id FROM contacts WHERE id = $1 AND client_id = $2 AND is_active = TRUE",
                int(pluson_cid_raw), client_id,
            )

        referrer_query = _build_referrer_query(qp)

        run_id = await db.fetchval(
            """INSERT INTO partner_runs
                  (client_id, platform_slug, referrer_contact_id, referrer_query, stage)
               VALUES ($1, $2, $3, $4, 'landed')
               RETURNING id""",
            client_id, platform, referrer_contact_id, referrer_query,
        )

        redirect_url = await _platform_redirect_url(client_id, platform, run_id, db)

    return RedirectResponse(url=redirect_url, status_code=302)


@public_router.get("/r/partner/{run_id}",
                   summary="Возврат с лендинга партнёра — открыть Mini App с экраном успеха")
async def partner_return(run_id: int) -> RedirectResponse:
    """После сабмита формы клиент в редирект ставит pluson.ru/r/partner/{run_id}.
    Мы тут редиректим в Mini App (TG/VK/MAX) — он покажет экран успеха.

    Mini App открывается через web_app только из бота, прямой URL вне Telegram
    редиректит на t.me-ссылку, тогда юзер в Telegram нажимает Mini App вручную.
    Поэтому работаем как /r/{slug} для events: отдаём HTML, который пытается
    открыть webview через Telegram.WebApp.openLink fallback.
    """
    pool = await get_pool()
    async with pool.acquire() as db:
        run = await db.fetchrow(
            "SELECT client_id, platform_slug FROM partner_runs WHERE id = $1",
            run_id,
        )
        if not run:
            raise HTTPException(status_code=404, detail="Партнёрский забег не найден")

        # Базовый хост Mini App (dev/прод определяется через settings.frontend_url)
        host = (settings.frontend_url or "https://pluson.ru").rstrip("/")

        # Для TG: в том же webview грузим Mini App страницу `/c/{N}/tg/partner/{run_id}?done=1`
        # — Telegram.WebApp уже инжектирован в webview лендинга.
        if run["platform_slug"] == 'telegram':
            url = f"{host}/c/{run['client_id']}/tg/partner/{run_id}?done=1"
            return RedirectResponse(url=url, status_code=302)
        if run["platform_slug"] == 'vk':
            # VK Mini App открывается из чата сообщества — для возврата мы
            # перекидываем на тот же URL, что и при старте, но с хешем `_done`.
            row = await db.fetchrow(
                """SELECT (ch.platform_meta->>'vk_app_id')::int AS vk_app_id
                     FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id = $1 AND cc.is_active = TRUE
                      AND ch.platform_slug = 'vk'
                      AND ch.is_system = FALSE LIMIT 1""",
                run["client_id"],
            )
            if row and row["vk_app_id"]:
                return RedirectResponse(
                    url=f"https://vk.com/app{int(row['vk_app_id'])}#prt_{run_id}_done",
                    status_code=302,
                )
        # MAX: пока fallback — на сайт ПЛЮСОНа (отдельный Mini App для MAX
        # будет добавлен после деплоя MAX-фронта).
        return RedirectResponse(url="https://pluson.ru/", status_code=302)


# ─── API эндпоинты (для Mini App) ──────────────────────────────────────────

@api_router.get("/runs/{run_id}",
                summary="Данные забега для Mini App (URL лендинга + контекст)")
async def get_partner_run(run_id: int):
    """Mini App при открытии страницы /tg/partner/{run_id} вызывает этот
    endpoint, чтобы получить URL стороннего лендинга + хвост для редиректа."""
    pool = await get_pool()
    async with pool.acquire() as db:
        row = await db.fetchrow(
            """SELECT pr.id, pr.client_id, pr.platform_slug, pr.referrer_query,
                      pr.contact_id, pr.stage,
                      c.partner_landing_url,
                      c.brand_name, c.name as client_name,
                      c.work_tg_username
                 FROM partner_runs pr
                 JOIN clients c ON c.id = pr.client_id
                WHERE pr.id = $1""",
            run_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Забег не найден")

        brand = (row["brand_name"] or row["client_name"] or "").strip()
        landing_url = (row["partner_landing_url"] or "").strip() or None
        work_tg = (row["work_tg_username"] or "").lstrip("@").strip() or None

        return {
            "run_id": run_id,
            "client_id": row["client_id"],
            "platform": row["platform_slug"],
            "landing_url": landing_url,
            "referrer_query": row["referrer_query"] or "",
            "contact_id": row["contact_id"],
            "stage": row["stage"],
            "brand_name": brand,
            "work_tg_username": work_tg,
        }


@api_router.get("/runs/{run_id}/contact-status",
                summary="Poll: пришёл ли внешний партнёрский код контакту")
async def get_partner_run_contact_status(run_id: int):
    """Mini App после редиректа на лендинг → возврат через /r/partner/{run_id}
    → экран успеха → poll-ит этот endpoint раз в секунду пока:
    · external_ref_param появится → показываем «✅ Вы зарегистрированы»
    · таймаут 15 сек → показываем «😕 Упс, что-то пошло не так»
    """
    pool = await get_pool()
    async with pool.acquire() as db:
        row = await db.fetchrow(
            """SELECT pr.contact_id, pr.stage,
                      c.external_ref_param
                 FROM partner_runs pr
            LEFT JOIN contacts c ON c.id = pr.contact_id
                WHERE pr.id = $1""",
            run_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Забег не найден")
        erp = (row["external_ref_param"] or "").strip()
        # Если код пришёл, а run ещё не помечен completed — отметим
        if erp and row["stage"] != 'completed':
            await db.execute(
                "UPDATE partner_runs SET stage='completed', completed_at=NOW() WHERE id=$1",
                run_id,
            )
        return {
            "contact_id": row["contact_id"],
            "external_ref_param": erp or None,
            "has_code": bool(erp),
        }


@api_router.post("/runs/{run_id}/mark-landing-opened",
                 summary="Отметить что Mini App открыл сторонний лендинг (для аналитики)")
async def mark_landing_opened(run_id: int):
    pool = await get_pool()
    async with pool.acquire() as db:
        await db.execute(
            """UPDATE partner_runs
                  SET stage = 'opened_landing', opened_landing_at = COALESCE(opened_landing_at, NOW())
                WHERE id = $1 AND stage <> 'completed'""",
            run_id,
        )
    return {"ok": True}
