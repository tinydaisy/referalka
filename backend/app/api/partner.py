"""
Регистрация партнёров — клиент через сторонний партнёрский сервис.

Не привязано к событию/лид-магниту. Самостоятельная фича.

Поток (упрощённый, без Mini App):
  1. Клиент в Настройках → Технические вписывает URL стороннего лендинга
     партнёрской системы (Tilda/GetCourse/Bizon360) → clients.partner_landing_url.
  2. У каждого контакта в карточке появляется блок «Партнёрская ссылка»:
     pluson.ru/partner/{client_id}?to=tg&pluson_cid={contact.id}&{external_ref_param}
     (хвост `&gcpc=fdd97` приклеивается если у контакта есть external_ref_param).
  3. Другой человек открывает ссылку → бэк создаёт partner_runs (запоминает
     рефовода + хвост query-строки) → 302 в бот платформы со start=prt_<run_id>.
  4. /start prt_<id> в боте:
     · если у контакта НЕТ external_ref_param → «Регистрируетесь Партнёром у
       {owner} ({brand})» + url-кнопка → СРАЗУ на сторонний лендинг с готовыми
       параметрами (pluson_cid={new_id} + хвост рефовода).
     · если контакт УЖЕ зарегистрирован партнёром → «Вы уже партнёр.
       Ваш код: XXX. По вопросам — @work_tg».
  5. Человек заполнил форму → партнёрский сервис в редирект-после-формы
     ставит t.me/{bot}?start=partner_done_<client_id> (или vk.me/{group}?ref=
     partner_done_<cid>, max.ru/{handle}?start=partner_done_<cid>).
  6. Бот по своему tg_id (или vk_id) находит контакт у этого клиента →
     проверяет contacts.external_ref_param → шлёт «Вы зарегистрированы,
     ваш код XXX, по вопросам @work_tg» либо «Упс, что-то не так — @work_tg».

Параллельно GetCourse шлёт webhook /integrations/salebot/register с
pluson_cid+external_ref_param — он обновляет contacts.external_ref_param.

Публичные endpoints (без авторизации, под `/`):
  GET  /partner/{client_id}    — landing-redirect в бот
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from typing import Optional
from app.database import get_pool
from app.services.share_links import get_client_bot_handles, _has_system_channel
from app.config import settings
import asyncpg
import logging

log = logging.getLogger(__name__)

public_router = APIRouter(tags=["Регистрация партнёров"])


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
    """Deeplink в чат бота / VK-сообщества / MAX-бота, чтобы там попасть в /start prt_<id>."""
    if platform == 'telegram':
        bot_username = await _client_bot_username(client_id, db)
        return f"https://t.me/{bot_username}?start=prt_{run_id}"
    if platform == 'vk':
        # Только собственное VK-сообщество клиента. Открываем чат с сообществом
        # с ref-меткой — VK кладёт её в message.ref первого сообщения, наш
        # consumer ловит и запускает run_started_partner_vk.
        handles = await get_client_bot_handles(db, client_id)
        handle = (handles.get('vk') or '').lstrip('@')
        if not handle:
            raise HTTPException(status_code=404, detail="У клиента не подключено VK-сообщество")
        return f"https://vk.me/{handle}?ref=prt_{run_id}"
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
        if k in _RESERVED_QUERY_KEYS or not k:
            continue
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
