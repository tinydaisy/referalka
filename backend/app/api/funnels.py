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
from app.services.share_links import get_client_bot_handles, TG_DOMAIN
from app.config import settings
import asyncpg
import json

# ----------- Шаблоны (авторизованные) -----------

template_router = APIRouter(prefix="/funnel-templates", tags=["Воронки"])


# Дефолтные тексты воронки лид-магнита.
# Плейсхолдеры (подставляются на бэке перед отправкой):
#   {materials_list}     — список названий «1. <b>...</b>» жирным, без ссылок (text_1)
#   {materials_list_description}       — «1. <b>Название</b> — описание» (без ссылок)
#   {materials_list_description_links} — то же + ссылка отдельной строкой (без эмодзи)
#                          описание пакета (если есть) идёт СВЕРХУ списка
#   {materials_with_links} — список «1. Название — <ссылка>» (text_2)
#   {client_brand_name}  — название бренда (или имя клиента)
#   {client_owner_name}  — имя основателя
#   {client_owner_bio}   — биография основателя
#   {client_owner_achievements} — регалии основателя (факты в цифрах)
#   {subscription_channel} — @username TG-канала клиента
#   {owner_telegram}     — @username основателя для связи (text_3)
DEFAULT_TEXT_1 = (
    # ⚠️ Нейтральное «Здравствуйте», а не разговорное приветствие: это
    # заготовка ДЛЯ ВСЕХ новых клиентов, и она уходит их аудитории от их
    # имени. Чужая манера речи в своей рассылке читается как чужой текст,
    # который забыли переписать.
    # ⚠️ Уже настроенные воронки не трогаем: текст лежит в базе у каждого
    # клиента, здесь только умолчание для новых.
    "Здравствуйте! Благодарю за интерес!\n\n"
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
    # Шаг «сначала анкета» — показывается только тем, у кого есть фича surveys.
    text_survey: Optional[str] = None
    # Медиа (фото или видео). Передавать обе колонки парой. NULL = убрать медиа.
    text_1_media_url:  Optional[str] = None
    text_1_media_type: Optional[Literal['photo', 'video']] = None
    text_2_media_url:  Optional[str] = None
    text_2_media_type: Optional[Literal['photo', 'video']] = None


_TEMPLATE_COLUMNS = """id, type, text_1, button_label, text_2, text_3_delivered, text_3_stuck,
                      text_survey,
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
    tpl = await _get_or_create_template(int(client["sub"]), type, db)
    # Дефолтные тексты — чтобы фронт мог показать кнопку «Заполнить из шаблона»
    # (клиент случайно очистил поле и хочет вернуть заводской текст).
    tpl["defaults"] = {
        "text_1": DEFAULT_TEXT_1,
        "button_label": DEFAULT_BUTTON_LABEL,
        "text_2": DEFAULT_TEXT_2,
        "text_3_delivered": DEFAULT_TEXT_3_DELIVERED,
        "text_3_stuck": DEFAULT_TEXT_3_STUCK,
    }
    return tpl


"""Плейсхолдеры, которые воронка умеет раскрывать.

⚠️ Держать в синхроне с `_format_text` в services/funnel_service.py — там
единственное место, где они подставляются. Разъедется список — проверка
начнёт ругаться на рабочие имена.
"""
KNOWN_PLACEHOLDERS: frozenset[str] = frozenset({
    "materials_list", "materials_list_description",
    "materials_list_description_links", "materials_with_links",
    "client_brand_name", "client_owner_name", "client_owner_bio",
    "client_owner_positioning", "client_owner_achievements",
    "subscription_channel", "owner_telegram",
    "support_platform", "support_links",
    # Раскрываются в ссылках лид-магнитов (реф-коды), не в самом тексте.
    "plsn_ref", "ext_ref",
})


def _unknown_placeholders(text: str) -> list[str]:
    """Имена в фигурных скобках, которых воронка не знает."""
    import re
    found = re.findall(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", text or "")
    return sorted({f for f in found if f not in KNOWN_PLACEHOLDERS})


def _placeholder_error(bad: list[str]) -> str:
    """Понятный текст ошибки + подсказка похожего имени.

    Опечатка обычно в одну букву («material_list_description» вместо
    «materials_…»), поэтому просто перечислить допустимые имена мало — человек
    не увидит разницы. Подбираем ближайшее и называем его прямо.
    """
    import difflib
    parts = []
    for name in bad:
        near = difflib.get_close_matches(name, sorted(KNOWN_PLACEHOLDERS), n=1, cutoff=0.6)
        if near:
            parts.append(f"«{{{name}}}» — такого нет. Вы имели в виду «{{{near[0]}}}»?")
        else:
            parts.append(f"«{{{name}}}» — такого плейсхолдера нет.")
    return (" ".join(parts) +
            " Проверьте написание — иначе получатель увидит эту строку как есть.")


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

    for k in ('text_1', 'button_label', 'text_2', 'text_3_delivered', 'text_3_stuck',
              'text_survey'):
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

    # ⚠️ Ловим опечатку в плейсхолдере ДО сохранения. Неизвестное имя молча
    # уходило получателю сырым текстом: у клиента в подарочном сообщении вместо
    # списка материалов стояло «{material_list_description}» (не хватало «s»),
    # и заметили это только по жалобе. Проверка на бэкенде, а не во фронте, —
    # чтобы срабатывала и при сохранении мимо интерфейса.
    for k in ('text_1', 'text_2', 'text_3_delivered', 'text_3_stuck', 'text_survey'):
        v = getattr(data, k, None)
        if not v:
            continue
        bad = _unknown_placeholders(v)
        if bad:
            raise HTTPException(status_code=400, detail=_placeholder_error(bad))

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


class FunnelPreviewRequest(BaseModel):
    # Какой из текстов воронки рендерим.
    step: Literal['text_1', 'text_2', 'text_3_delivered', 'text_3_stuck']
    # Что выдаётся: один лид-магнит ИЛИ пакет (для {materials_*}).
    lead_magnet_id: Optional[int] = None
    package_id: Optional[int] = None
    # Площадка — от неё зависит {support_platform} и {subscription_channel}.
    platform: Literal['telegram', 'vk', 'max'] = 'telegram'
    # Текст можно прислать «как в форме» (несохранённый), иначе берём из шаблона.
    text: Optional[str] = None


@template_router.post("/{type}/preview", summary="Превью текста воронки")
async def preview_template(
    type: Literal['lead_magnet'],
    data: FunnelPreviewRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Рендерит текст воронки ровно так, как его увидит человек: с подставленными
    материалами выбранного лид-магнита/пакета, брендом, каналом подписки и
    контактами ({owner_telegram}, {support_platform}, {support_links})."""
    from app.services.funnel_service import (
        _get_brand_context, _materials_for_run, _package_description_for_run, _format_text,
    )
    cid = int(client["sub"])
    tpl = await _get_or_create_template(cid, type, db)
    raw = data.text if data.text is not None else (tpl.get(data.step) or "")

    # Материалы: собираем «как для забега» — тот же код, что и в реальной выдаче.
    fake_run = {
        "lead_magnet_id": data.lead_magnet_id,
        "package_id": data.package_id,
        "referrer_contact_id": None,   # реф-коды {plsn_ref}/{ext_ref} в превью пустые
    }
    materials = []
    pkg_desc = ""
    if data.lead_magnet_id or data.package_id:
        materials = await _materials_for_run(fake_run, db)
        pkg_desc = await _package_description_for_run(fake_run, db)

    ctx = await _get_brand_context(cid, db, platform=data.platform)
    text = _format_text(raw, ctx, materials, pkg_desc)
    return {
        "text": text,
        "button_label": tpl.get("button_label") or "ГОТОВО",
        "materials_count": len(materials),
    }


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
    """Возвращает @username СВОЕГО Telegram-бота клиента, в который надо
    переадресовывать landing. Если у клиента нет своего бота — пустая строка
    (системный @pluson_bot больше не используется как fallback)."""
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
        return row["handle"].lstrip('@')
    return ""


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
    """Формирует deeplink в чат с ботом/сообществом нужной платформы.
    Воронка лид-магнита — это «открыли чат → бот пишет приветствие со списком подарков».

    Правила выбора канала (только СВОИ каналы клиента, системные не используются):
    - TG: подключённый бот клиента. Нет своего бота → 404.
    - VK: ТОЛЬКО собственное VK-сообщество клиента. Системное сообщество не
      используется — оно принадлежит ПЛЮСОНу и не имеет права писать в личку
      подписчикам клиента (нарушает приватность и юридический контроль контента).
    - MAX: аналогично VK — только собственный MAX-бот клиента.
    """
    if platform == 'telegram':
        bot_username = await _client_bot_username(client_id, db)
        if not bot_username:
            raise HTTPException(status_code=404, detail="У клиента не подключён Telegram-бот для воронки")
        return f"https://{TG_DOMAIN}/{bot_username}?start=fnl_{run_id}"
    if platform == 'vk':
        # Берём собственный Mini App клиента (vk_app_id из platform_meta его VK-канала).
        # vk.me/{handle}?ref=... в VK НЕ работает для уже подписанных пользователей
        # (VK передаёт ref только при первом контакте с сообществом, когда есть
        # кнопка «Начать»). Mini App-посредник решает это: открывается на 1 сек,
        # вытаскивает vk_user_id через VK Bridge, регистрирует воронку на бэке,
        # сообщество шлёт Текст 1 в личку и Mini App закрывается.
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
            raise HTTPException(status_code=404, detail="У клиента не подключено VK Mini App для воронки")
        return f"https://vk.com/app{int(row['vk_app_id'])}#fnl_{run_id}"
    if platform == 'max':
        handles = await get_client_bot_handles(db, client_id)
        handle = (handles.get('max') or '').lstrip('@')
        if not handle:
            raise HTTPException(status_code=404, detail="У клиента не подключён MAX-бот для воронки")
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

        # Проверяем что у клиента подключён СВОЙ канал на выбранной платформе
        # (channels.is_system=FALSE). Системные каналы ПЛЮСОНа не используются —
        # ни для TG, ни для VK/MAX.
        own_channel = await db.fetchval(
            """SELECT 1
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1
                  AND cc.is_active = TRUE
                  AND ch.platform_slug = $2
                  AND ch.is_system = FALSE
                LIMIT 1""",
            client_id, platform,
        )
        if not own_channel:
            raise HTTPException(status_code=404, detail=f"Платформа {platform} не подключена клиентом")

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
