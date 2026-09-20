"""Каналы тех.поддержки ПЛЮСОНа — для кабинета и публичной страницы /support.

⚠️⚠️ СПИСОК ПЛОЩАДОК ЖИВЁТ В БАЗЕ, А НЕ ВО ФРОНТЕ. Раньше он был захардкожен в
`web/src/lib/support.ts`: выключить площадку значило править код и пересобирать
сайт, а когда в подарке ПЛЮСОНа ВК показывался, в поддержке его не было —
никто и не знал, что это два разных списка. Теперь площадки отмечаются в
админке и берутся общей функцией (`services/plusson_platforms.py`), одной на
подарок, поддержку и партнёрку.

Эндпоинт ПУБЛИЧНЫЙ: страница `/support` открыта всем, в том числе тем, у кого
ещё нет кабинета.
"""
from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends

from app.database import get_db
from app.services.plusson_platforms import (
    PLATFORM_LABEL, bot_link, platform_channels,
)

router = APIRouter(prefix="/support-channels", tags=["Поддержка"])

# Payload обращения в поддержку. Бот по нему понимает, что человек пришёл с
# вопросом, и заводит диалог, а не гонит его по воронке.
SUPPORT_PAYLOAD = "question"


@router.get("", summary="Мессенджеры, где работает тех.поддержка")
async def list_support_channels(db: asyncpg.Connection = Depends(get_db)):
    """`{items: [{key, label, hint, url}]}` — уже в порядке показа.

    Пустой список — валидный ответ (все площадки выключены). Фронт в этом
    случае показывает почту поддержки: пустой экран хуже.
    """
    items = []
    for ch in await platform_channels(db):
        slug = ch["slug"]
        items.append({
            "key": slug,
            "label": PLATFORM_LABEL.get(slug, slug),
            # Подпись под названием: в Телеграме ник узнаваем, у MAX и ВК ник
            # выглядит как набор цифр — там показываем название канала.
            "hint": f"@{ch['handle']}" if slug == "telegram" else ch["title"],
            "url": bot_link(slug, ch["handle"], SUPPORT_PAYLOAD),
        })
    return {"items": items}
