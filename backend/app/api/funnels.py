"""
Воронки (funnels) — выдача лид-магнитов и пакетов через бот.

Endpoints:
  GET    /api/v1/funnel-templates/{type}      — текущий шаблон клиента (auto-create при первом GET)
  PATCH  /api/v1/funnel-templates/{type}      — обновить тексты

  Публичные (без авторизации):
  GET    /m/{slug}                             — landing для одиночного лид-магнита
  GET    /p/{slug}                             — landing для пакета

  Landing-флоу:
    1. Регистрируем funnel_run со stage=landed (resolved через slug → magnet|package).
    2. Пишем UTM-метки и referrer_contact_id (по pid).
    3. Возвращаем 302 на t.me/<bot>?start=fnl_<run_id>.
       run_id (а не slug) — чтобы бот мог сразу найти забег и не плодить дубликаты.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from typing import Optional, Literal
from urllib.parse import quote_plus
from app.auth import get_current_client
from app.database import get_db, get_pool
from app.services.channels import get_client_telegram_token
from app.services.share_links import (
    get_client_bot_handles,
    PLUSON_VK_HANDLE,
    PLUSON_MAX_HANDLE,
    _has_system_channel,
)
from app.config import settings
import asyncpg
import json

# ----------- Шаблоны (авторизованные) -----------

template_router = APIRouter(prefix="/funnel-templates", tags=["Воронки"])


# Дефолтные тексты воронки лид-магнита.
# Плейсхолдеры (подставляются на бэке перед отправкой):
#   {materials_list}     — список названий «1. ...» «2. ...» (text_1)
#   {materials_with_links} — список «1. Название — <ссылка>» (text_2)
#   {client_brand_name}  — название бренда (или имя клиента)
#   {client_owner_name}  — имя основателя
#   {client_owner_bio}   — биография основателя
#   {client_owner_achievements} — регалии основателя (факты в цифрах)
#   {subscription_channel} — @username TG-канала клиента
#   {owner_telegram}     — @username основателя для связи (text_3)
DEFAULT_TEXT_1 = (
    "Добрейшего-богатейшего! Благодарю за интерес!\n\n"
    "🎁 Вот мои подарки для тебя\n\n"
    "👇👇👇\n"
    "{materials_list}\n\n"
    "{client_owner_name}\n"
    "{client_owner_bio}\n\n"
    "<b>Чтобы получить материалы — подпишись на канал\n"
    "👇👇👇\n"
    "{subscription_channel}\n"
    "И жми «ГОТОВО»</b>"
)

DEFAULT_BUTTON_LABEL = "ГОТОВО"

DEFAULT_TEXT_2 = (
    "Отлично! 🎁 Жми на соответствующие ссылки и забирай подарки:\n\n"
    "{materials_with_links}"
)

DEFAULT_TEXT_3_DELIVERED = (
    "Все ли открылось? 🤔\n\n"
    "Если что-то не работает — напиши мне в {owner_telegram}, я помогу."
)

DEFAULT_TEXT_3_STUCK = (
    "Заметил, что вы остановились на шаге подписки на канал.\n\n"
    "Подпишитесь на\n"
    "{subscription_channel}\n"
    "и нажмите «ГОТОВО» — я отправлю материалы."
)


class TemplateUpdate(BaseModel):
    text_1: Optional[str] = None
    button_label: Optional[str] = None
    text_2: Optional[str] = None
    text_3_delivered: Optional[str] = None
    text_3_stuck: Optional[str] = None
    # Медиа (фото или видео). Передавать обе колонки парой. NULL = убрать медиа.
    text_1_media_url:  Optional[str] = None
    text_1_media_type: Optional[Literal['photo', 'video']] = None
    text_2_media_url:  Optional[str] = None
    text_2_media_type: Optional[Literal['photo', 'video']] = None


_TEMPLATE_COLUMNS = """id, type, text_1, button_label, text_2, text_3_delivered, text_3_stuck,
                      text_1_media_url, text_1_media_type,
                      text_2_media_url, text_2_media_type,
                      created_at, updated_at"""


async def _get_or_create_template(client_id: int, type_: str, db: asyncpg.Connection) -> dict:
    row = await db.fetchrow(
        f"""SELECT {_TEMPLATE_COLUMNS}
              FROM funnel_templates WHERE client_id = $1 AND type = $2""",
        client_id, type_
    )
    if row:
        return dict(row)
    row = await db.fetchrow(
        f"""INSERT INTO funnel_templates
              (client_id, type, text_1, button_label, text_2, text_3_delivered, text_3_stuck)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING {_TEMPLATE_COLUMNS}""",
        client_id, type_,
        DEFAULT_TEXT_1, DEFAULT_BUTTON_LABEL, DEFAULT_TEXT_2,
        DEFAULT_TEXT_3_DELIVERED, DEFAULT_TEXT_3_STUCK
    )
    return dict(row)


@template_router.get("/{type}", summary="Получить шаблон воронки клиента")
async def get_template(
    type: Literal['lead_magnet'],
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    return await _get_or_create_template(int(client["sub"]), type, db)


@template_router.patch("/{type}", summary="Обновить шаблон воронки")
async def update_template(
    type: Literal['lead_magnet'],
    data: TemplateUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    cid = int(client["sub"])
    # Гарантируем что шаблон существует
    await _get_or_create_template(cid, type, db)

    # Поля с обычной семантикой "обновлять только если передано".
    # Для media-полей принимаем явный None как "убрать медиа", поэтому используем
    # model_fields_set для определения "поле было передано в запросе".
    sent = data.model_fields_set if hasattr(data, "model_fields_set") else set(data.__fields_set__)

    fields = []
    args = []
    idx = 1

    for k in ('text_1', 'button_label', 'text_2', 'text_3_delivered', 'text_3_stuck'):
        v = getattr(data, k)
        if v is not None:
            fields.append(f"{k} = ${idx}")
            args.append(v)
            idx += 1

    for k in ('text_1_media_url', 'text_1_media_type', 'text_2_media_url', 'text_2_media_type'):
        if k in sent:
            v = getattr(data, k)
            fields.append(f"{k} = ${idx}")
            args.append(v if v else None)
            idx += 1
            # Смена URL → сбрасываем кеш file_id, чтобы при следующей отправке
            # Telegram перекачал новый файл и отдал свежий file_id.
            if k.endswith('_media_url'):
                cache_field = k.replace('_url', '_file_id')
                fields.append(f"{cache_field} = NULL")

    if not fields:
        return await _get_or_create_template(cid, type, db)
    args.extend([cid, type])
    row = await db.fetchrow(
        f"""UPDATE funnel_templates SET {', '.join(fields)}, updated_at = NOW()
            WHERE client_id = ${idx} AND type = ${idx + 1}
            RETURNING {_TEMPLATE_COLUMNS}""",
        *args
    )
    return dict(row)


# ----------- Публичный landing -----------

public_router = APIRouter(tags=["Воронки (публичные)"])


async def _resolve_slug(slug: str, kind: str, db: asyncpg.Connection):
    """kind = 'm' (лид-магнит) или 'p' (пакет). Возвращает (client_id, lead_magnet_id, package_id, name)."""
    if kind == 'm':
        row = await db.fetchrow(
            "SELECT id, client_id, name FROM lead_magnets WHERE slug = $1",
            slug
        )
        if not row:
            return None
        return row["client_id"], row["id"], None, row["name"]
    else:
        row = await db.fetchrow(
            "SELECT id, client_id, name FROM lead_magnet_packages WHERE slug = $1",
            slug
        )
        if not row:
            return None
        return row["client_id"], None, row["id"], row["name"]


async def _resolve_referrer(client_id: int, pid: Optional[str], db: asyncpg.Connection) -> Optional[int]:
    """pid — реф-код контакта клиента. Возвращает contact_id или None."""
    if not pid:
        return None
    return await db.fetchval(
        "SELECT id FROM contacts WHERE client_id = $1 AND ref_code = $2",
        client_id, pid
    )


async def _client_bot_username(client_id: int, db: asyncpg.Connection) -> str:
    """Возвращает @username бота, в который надо переадресовывать landing.
    Если у клиента активна фича 'channels' и есть подключённый бот → его. Иначе → @pluson_bot."""
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
                ORDER BY ch.id ASC
                LIMIT 1""",
            client_id,
        )
        if row and row["handle"]:
            h = row["handle"].lstrip('@')
            if h:
                return h
    return getattr(settings, 'plusson_bot_username', None) or 'pluson_bot'


@public_router.get("/m/{slug}", summary="Landing воронки (одиночный лид-магнит)")
async def landing_lead_magnet(slug: str, request: Request):
    return await _landing(slug, 'm', request)


@public_router.get("/p/{slug}", summary="Landing воронки (пакет)")
async def landing_package(slug: str, request: Request):
    return await _landing(slug, 'p', request)


_PLATFORM_ALIASES = {
    'tg': 'telegram',
    'telegram': 'telegram',
    'vk': 'vk',
    'max': 'max',
}


async def _platform_redirect_url(client_id: int, platform: str, run_id: int, db: asyncpg.Connection) -> str:
    """Формирует deeplink в нужный мессенджер на основании платформы.
    Воронка лид-магнита — это «открыли чат → бот пишет приветствие со списком подарков».
    Соответственно, для каждой платформы deeplink в чат с ботом/сообществом (НЕ в Mini App).
    Для VIP-клиента берём его бот/сообщество, иначе — системный канал ПЛЮСОН.
    """
    if platform == 'telegram':
        bot_username = await _client_bot_username(client_id, db)
        return f"https://t.me/{bot_username}?start=fnl_{run_id}"
    if platform == 'vk':
        # vk.me/{handle}?ref=fnl_xxx — открывает чат с сообществом, ref доходит
        # в Long Poll бота через message_new.message.ref / message.payload.ref.
        handles = await get_client_bot_handles(db, client_id)
        handle = (handles.get('vk') or PLUSON_VK_HANDLE).lstrip('@')
        return f"https://vk.me/{handle}?ref=fnl_{run_id}"
    if platform == 'max':
        handles = await get_client_bot_handles(db, client_id)
        handle = (handles.get('max') or PLUSON_MAX_HANDLE).lstrip('@')
        return f"https://max.ru/{handle}?start=fnl_{run_id}"
    raise HTTPException(status_code=400, detail=f"Неизвестная платформа: {platform}")


async def _landing(slug: str, kind: str, request: Request) -> RedirectResponse:
    qp = dict(request.query_params)
    to_raw = (qp.get('to') or 'tg').lower()
    platform = _PLATFORM_ALIASES.get(to_raw)
    if not platform:
        raise HTTPException(status_code=400, detail=f"Параметр to должен быть одним из: tg, vk, max")

    pool = await get_pool()
    async with pool.acquire() as db:
        resolved = await _resolve_slug(slug, kind, db)
        if not resolved:
            raise HTTPException(status_code=404, detail="Воронка не найдена")
        client_id, lm_id, pkg_id, _name = resolved

        # Проверяем что выбранная платформа доступна клиенту
        # (есть свой канал ИЛИ есть системный канал не в test-режиме).
        own_channel = await db.fetchval(
            """SELECT 1
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1
                  AND cc.is_active = TRUE
                  AND ch.platform_slug = $2
                LIMIT 1""",
            client_id, platform,
        )
        if not own_channel and not await _has_system_channel(db, platform, allow_test=False):
            raise HTTPException(status_code=404, detail=f"Платформа {platform} не подключена")

        # Параметры запроса
        utm = {k: v for k, v in qp.items() if k.startswith('utm_')}
        pid = qp.get('pid') or qp.get('new_partner_id')
        referrer_id = await _resolve_referrer(client_id, pid, db)

        # Контакт НЕ создаём — UTM и реферер хранятся прямо в funnel_runs.
        # Контакт материализуется только когда человек дойдёт до бота
        # (в funnel_service.run_started), копируя utm/referrer из этого забега.
        # Превью-боты Telegram/Open Graph и ушедшие посетители скелетов больше не плодят.
        run_id = await db.fetchval(
            """INSERT INTO funnel_runs
                  (client_id, type, lead_magnet_id, package_id,
                   contact_id, referrer_contact_id, utm, stage, landed_at,
                   platform_slug)
               VALUES ($1, 'lead_magnet', $2, $3, NULL, $4, $5::jsonb, 'landed', NOW(), $6)
               RETURNING id""",
            client_id, lm_id, pkg_id, referrer_id, json.dumps(utm), platform
        )

        redirect_url = await _platform_redirect_url(client_id, platform, run_id, db)

    return RedirectResponse(url=redirect_url, status_code=302)
