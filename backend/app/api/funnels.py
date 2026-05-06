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
#   {client_owner_achievements} — регалии основателя
#   {subscription_channel} — @username TG-канала клиента
#   {owner_telegram}     — @username основателя для связи (text_3)
DEFAULT_TEXT_1 = (
    "Добрейшего-богатейшего! Благодарю за интерес!\n\n"
    "🎁 Вот мои подарки для тебя\n\n"
    "👇👇👇\n"
    "{materials_list}\n\n"
    "{client_brand_name}\n"
    "{client_owner_achievements}\n\n"
    "Чтобы получить материалы — подпишись на канал {subscription_channel} и жми «ГОТОВО»."
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
    "Подпишитесь на {subscription_channel} и нажмите «ГОТОВО» — я отправлю материалы."
)


class TemplateUpdate(BaseModel):
    text_1: Optional[str] = None
    button_label: Optional[str] = None
    text_2: Optional[str] = None
    text_3_delivered: Optional[str] = None
    text_3_stuck: Optional[str] = None


async def _get_or_create_template(client_id: int, type_: str, db: asyncpg.Connection) -> dict:
    row = await db.fetchrow(
        """SELECT id, type, text_1, button_label, text_2, text_3_delivered, text_3_stuck,
                  created_at, updated_at
             FROM funnel_templates WHERE client_id = $1 AND type = $2""",
        client_id, type_
    )
    if row:
        return dict(row)
    row = await db.fetchrow(
        """INSERT INTO funnel_templates
              (client_id, type, text_1, button_label, text_2, text_3_delivered, text_3_stuck)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, type, text_1, button_label, text_2, text_3_delivered, text_3_stuck,
                     created_at, updated_at""",
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

    fields = []
    args = []
    idx = 1
    for k in ('text_1', 'button_label', 'text_2', 'text_3_delivered', 'text_3_stuck'):
        v = getattr(data, k)
        if v is not None:
            fields.append(f"{k} = ${idx}")
            args.append(v)
            idx += 1
    if not fields:
        return await _get_or_create_template(cid, type, db)
    args.extend([cid, type])
    row = await db.fetchrow(
        f"""UPDATE funnel_templates SET {', '.join(fields)}, updated_at = NOW()
            WHERE client_id = ${idx} AND type = ${idx + 1}
            RETURNING id, type, text_1, button_label, text_2, text_3_delivered, text_3_stuck,
                      created_at, updated_at""",
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
    VIP-клиент → его собственный бот. Иначе → @pluson_bot (PLUSON_BOT_USERNAME из настроек)."""
    row = await db.fetchrow(
        """SELECT t.allow_custom_bot, ch.handle, ch.bot_token
             FROM clients c
        LEFT JOIN tariffs t ON t.slug = c.tariff_slug
        LEFT JOIN channels ch ON ch.client_id = c.id
                              AND ch.platform_slug = 'telegram'
                              AND ch.is_active = TRUE
            WHERE c.id = $1
            ORDER BY ch.id ASC
            LIMIT 1""",
        client_id
    )
    if row and row["allow_custom_bot"] and row["handle"]:
        # handle хранится как '@username' — убираем @
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


async def _landing(slug: str, kind: str, request: Request) -> RedirectResponse:
    from app.services.contact_merge import _generate_unique_ref_code
    pool = await get_pool()
    async with pool.acquire() as db:
        resolved = await _resolve_slug(slug, kind, db)
        if not resolved:
            raise HTTPException(status_code=404, detail="Воронка не найдена")
        client_id, lm_id, pkg_id, _name = resolved

        # Параметры запроса
        qp = dict(request.query_params)
        utm = {k: v for k, v in qp.items() if k.startswith('utm_')}
        pid = qp.get('pid') or qp.get('new_partner_id')
        referrer_id = await _resolve_referrer(client_id, pid, db)

        # Сразу создаём «скелет» контакта на этого клиента — без идентификатора
        # платформы (его узнаем когда человек дойдёт до бота). UTM и реферер
        # пишем в contact, чтобы они были видны в карточке контакта сразу.
        # Если человек дойдёт до бота и его tg_id уже есть в platform_users —
        # funnel_runs.contact_id переключится на существующий контакт, а скелет
        # станет «orphan» (без идентификаций).
        ref_code = await _generate_unique_ref_code(db)
        skeleton_contact_id = await db.fetchval(
            """INSERT INTO contacts
                  (client_id, name, ref_code, utm_source, first_referrer_contact_id)
               VALUES ($1, NULL, $2, $3, $4)
               RETURNING id""",
            client_id, ref_code, utm.get("utm_source"), referrer_id
        )

        run_id = await db.fetchval(
            """INSERT INTO funnel_runs
                  (client_id, type, lead_magnet_id, package_id,
                   contact_id, referrer_contact_id, utm, stage, landed_at)
               VALUES ($1, 'lead_magnet', $2, $3, $4, $5, $6::jsonb, 'landed', NOW())
               RETURNING id""",
            client_id, lm_id, pkg_id, skeleton_contact_id, referrer_id, json.dumps(utm)
        )

        bot_username = await _client_bot_username(client_id, db)

    # Деплинк в бот: payload `fnl_<run_id>`
    return RedirectResponse(
        url=f"https://t.me/{bot_username}?start=fnl_{run_id}",
        status_code=302
    )
