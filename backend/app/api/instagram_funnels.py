"""
Воронки Instagram — CRUD для кабинета клиента.

План — documentation/INSTAGRAM-FUNNEL-PLAN.md

⚠️ Гейт — фича `instagram_funnel` (пока только admin), и стоит он на ЗАПИСИ.
Читать свои воронки можно всегда: это данные клиента, отбирать их при
отключении фичи неправильно (то же правило, что у платных модулей).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.features import client_has_feature

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/instagram-funnels", tags=["instagram-funnels"])

REPLY_KINDS = (
    "public_comment", "dm_intro", "dm_not_subscribed",
    "dm_delivered", "dm_repeat", "dm_reminder",
)


async def _assert_write(db, client_id: int):
    if not await client_has_feature(db, client_id, "instagram_funnel"):
        raise HTTPException(status_code=403, detail="Воронки Instagram доступны не на вашем тарифе.")


class FunnelIn(BaseModel):
    channel_id: int
    name: str
    trigger_kind: str = "comment"
    media_scope: str = "any"
    media_ids: list[str] = []
    keyword_mode: str = "any"
    keywords: list[str] = []
    match_mode: str = "contains"
    lead_magnet_id: Optional[int] = None
    package_id: Optional[int] = None
    delivery_mode: str = "direct"
    require_subscription: bool = True
    public_reply_enabled: bool = True
    reminder_enabled: bool = True
    reminder_delay_min: int = 10
    is_active: bool = True
    replies: dict[str, list[str]] = {}


def _validate(data: FunnelIn) -> None:
    """Проверки, которые нельзя доверить браузеру.

    ⚠️ Форму обходят обычным запросом, а часть правил не выражается CHECK-ом
    в базе (например, срок напоминания), поэтому проверяем здесь.
    """
    if data.trigger_kind not in ("comment", "story_reply"):
        raise HTTPException(400, "Неизвестный триггер")
    if data.delivery_mode not in ("direct", "telegram"):
        raise HTTPException(400, "Неизвестный способ выдачи")
    if data.match_mode not in ("contains", "exact"):
        raise HTTPException(400, "Неизвестный режим сравнения слова")
    if (data.lead_magnet_id is None) == (data.package_id is None):
        raise HTTPException(400, "Выберите ровно одно: лид-магнит или пакет")

    # ⚠️ У СТОРИС конкретную публикацию выбрать нельзя: она живёт 24 часа, и
    # привязку пришлось бы переназначать каждый день. Кодовое слово при этом
    # обязательно — на сторис отвечают чем угодно, включая стикеры.
    if data.trigger_kind == "story_reply":
        if data.media_scope != "any":
            raise HTTPException(400, "У ответов на сторис нельзя выбрать конкретную публикацию")
        if data.keyword_mode != "specific" or not [k for k in data.keywords if k.strip()]:
            raise HTTPException(400, "Для ответов на сторис задайте кодовое слово")

    if data.media_scope == "specific" and not data.media_ids:
        raise HTTPException(400, "Выберите публикации")
    if data.keyword_mode == "specific" and not [k for k in data.keywords if k.strip()]:
        raise HTTPException(400, "Добавьте кодовые слова")

    # ⚠️ Больше суток бессмысленно: Meta разрешает писать только 24 часа с
    # последнего сообщения человека, и напоминание за пределами окна просто
    # не уйдёт. Клиент поставил бы 48 и решил, что функция сломана.
    if not (5 <= data.reminder_delay_min <= 23 * 60):
        raise HTTPException(400, "Напоминание — от 5 минут до 23 часов (Instagram разрешает писать сутки)")


async def _assert_owns(db, client_id: int, data: FunnelIn) -> None:
    """Канал и подарок должны принадлежать этому кабинету.

    ⚠️ Иначе, зная чужой id, можно поставить себе воронку на чужой аккаунт
    или раздавать чужой материал.
    """
    ch = await db.fetchrow(
        """SELECT 1 FROM channels ch JOIN client_channels cc ON cc.channel_id=ch.id
            WHERE ch.id=$1 AND cc.client_id=$2 AND ch.platform_slug='instagram'""",
        data.channel_id, client_id,
    )
    if not ch:
        raise HTTPException(404, "Аккаунт Instagram не найден")

    if data.lead_magnet_id:
        ok = await db.fetchval("SELECT 1 FROM lead_magnets WHERE id=$1 AND client_id=$2",
                               data.lead_magnet_id, client_id)
        if not ok:
            raise HTTPException(404, "Лид-магнит не найден")
    if data.package_id:
        ok = await db.fetchval("SELECT 1 FROM lead_magnet_packages WHERE id=$1 AND client_id=$2",
                               data.package_id, client_id)
        if not ok:
            raise HTTPException(404, "Пакет не найден")


async def _save_replies(db, funnel_id: int, replies: dict[str, list[str]]) -> None:
    """Переписать наборы фраз. Пустые строки отбрасываем."""
    await db.execute("DELETE FROM instagram_funnel_replies WHERE funnel_id=$1", funnel_id)
    for kind, texts in (replies or {}).items():
        if kind not in REPLY_KINDS:
            continue
        for i, t in enumerate([x for x in texts if (x or "").strip()]):
            await db.execute(
                "INSERT INTO instagram_funnel_replies (funnel_id, kind, text, sort_order) "
                "VALUES ($1,$2,$3,$4)",
                funnel_id, kind, t.strip(), i,
            )


async def _load_replies(db, funnel_id: int) -> dict[str, list[str]]:
    rows = await db.fetch(
        "SELECT kind, text FROM instagram_funnel_replies WHERE funnel_id=$1 ORDER BY kind, sort_order",
        funnel_id,
    )
    out: dict[str, list[str]] = {k: [] for k in REPLY_KINDS}
    for r in rows:
        out.setdefault(r["kind"], []).append(r["text"])
    return out


@router.get("", summary="Список воронок Instagram")
async def list_funnels(client=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT f.*, lm.name AS lead_magnet_name, p.name AS package_name,
                  ch.handle AS account_handle
             FROM instagram_funnels f
             LEFT JOIN lead_magnets lm ON lm.id = f.lead_magnet_id
             LEFT JOIN lead_magnet_packages p ON p.id = f.package_id
             LEFT JOIN channels ch ON ch.id = f.channel_id
            WHERE f.client_id = $1
         ORDER BY f.sort_order, f.id""",
        client_id,
    )
    items = []
    for r in rows:
        d = dict(r)
        # Сколько людей прошло — цифра из общей funnel_runs, отдельного учёта нет.
        d["runs"] = await db.fetchval(
            "SELECT COUNT(*) FROM funnel_runs WHERE instagram_funnel_id=$1", r["id"]
        )
        d["delivered"] = await db.fetchval(
            "SELECT COUNT(*) FROM funnel_runs WHERE instagram_funnel_id=$1 AND stage='delivered'",
            r["id"],
        )
        items.append(d)
    return {"items": items}


@router.get("/{funnel_id}", summary="Одна воронка")
async def get_funnel(funnel_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT * FROM instagram_funnels WHERE id=$1 AND client_id=$2", funnel_id, client_id
    )
    if not row:
        raise HTTPException(404, "Воронка не найдена")
    d = dict(row)
    d["replies"] = await _load_replies(db, funnel_id)
    return d


@router.post("", summary="Создать воронку")
async def create_funnel(data: FunnelIn, client=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(client["sub"])
    await _assert_write(db, client_id)
    _validate(data)
    await _assert_owns(db, client_id, data)

    async with db.transaction():
        fid = await db.fetchval(
            """INSERT INTO instagram_funnels
                 (client_id, channel_id, name, trigger_kind, media_scope, media_ids,
                  keyword_mode, keywords, lead_magnet_id, package_id, delivery_mode,
                  require_subscription, public_reply_enabled, reminder_enabled,
                  reminder_delay_min, is_active, match_mode)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
               RETURNING id""",
            client_id, data.channel_id, data.name.strip() or "Воронка",
            data.trigger_kind, data.media_scope, data.media_ids,
            data.keyword_mode, [k.strip() for k in data.keywords if k.strip()],
            data.lead_magnet_id, data.package_id, data.delivery_mode,
            data.require_subscription, data.public_reply_enabled,
            data.reminder_enabled, data.reminder_delay_min, data.is_active,
            data.match_mode,
        )
        await _save_replies(db, fid, data.replies)
    return {"id": fid}


@router.put("/{funnel_id}", summary="Изменить воронку")
async def update_funnel(funnel_id: int, data: FunnelIn,
                        client=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(client["sub"])
    await _assert_write(db, client_id)
    _validate(data)
    await _assert_owns(db, client_id, data)

    owned = await db.fetchval(
        "SELECT 1 FROM instagram_funnels WHERE id=$1 AND client_id=$2", funnel_id, client_id
    )
    if not owned:
        raise HTTPException(404, "Воронка не найдена")

    async with db.transaction():
        await db.execute(
            """UPDATE instagram_funnels SET
                 channel_id=$2, name=$3, trigger_kind=$4, media_scope=$5, media_ids=$6,
                 keyword_mode=$7, keywords=$8, lead_magnet_id=$9, package_id=$10,
                 delivery_mode=$11, require_subscription=$12, public_reply_enabled=$13,
                 reminder_enabled=$14, reminder_delay_min=$15, is_active=$16,
                 match_mode=$17, updated_at=now()
               WHERE id=$1""",
            funnel_id, data.channel_id, data.name.strip() or "Воронка",
            data.trigger_kind, data.media_scope, data.media_ids,
            data.keyword_mode, [k.strip() for k in data.keywords if k.strip()],
            data.lead_magnet_id, data.package_id, data.delivery_mode,
            data.require_subscription, data.public_reply_enabled,
            data.reminder_enabled, data.reminder_delay_min, data.is_active,
            data.match_mode,
        )
        await _save_replies(db, funnel_id, data.replies)
    return {"ok": True}


@router.delete("/{funnel_id}", summary="Удалить воронку")
async def delete_funnel(funnel_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(client["sub"])
    await _assert_write(db, client_id)
    await db.execute("DELETE FROM instagram_funnels WHERE id=$1 AND client_id=$2",
                     funnel_id, client_id)
    return {"ok": True}


@router.get("/media/{channel_id}", summary="Публикации аккаунта — для выбора рилса")
async def account_media(channel_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    """Список публикаций с обложками.

    ⚠️ Отдаём с картинкой и подписью: выбирать рилс по «id 178451…» человек не
    может, ему нужно узнать свою публикацию глазами.
    """
    import json as _json
    from app.services import instagram_api as ig

    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT ch.bot_token, ch.platform_meta FROM channels ch
             JOIN client_channels cc ON cc.channel_id=ch.id
            WHERE ch.id=$1 AND cc.client_id=$2 AND ch.platform_slug='instagram'""",
        channel_id, client_id,
    )
    if not row:
        raise HTTPException(404, "Аккаунт Instagram не найден")
    meta = row["platform_meta"] or {}
    if isinstance(meta, str):
        meta = _json.loads(meta)
    try:
        items = await ig.list_media(str(meta.get("ig_user_id") or ""), row["bot_token"] or "")
    except ig.InstagramApiError as e:
        raise HTTPException(400, e.user_message)
    return {"items": items}
