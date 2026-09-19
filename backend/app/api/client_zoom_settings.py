"""Интеграция с Zoom — подключение своего зум-аккаунта (миграция 444).

Живёт во вкладке «Интеграция» настроек кабинета, рядом с автообзвонами.

⚠️⚠️ ЗУМ У КАЖДОГО КЛИЕНТА СВОЙ. Клиент проходит OAuth, и его токены ложатся в
`client_zoom_accounts`. Конференции создаются в ЕГО аккаунте: у Zoom лимит
одновременных конференций на лицензию, и эфиры разных клиентов в одном
аккаунте мешали бы друг другу. В окружении сервера — только ключи ПРИЛОЖЕНИЯ
ПЛЮСОНа, одно на всех (как `vk_oauth_*`, `ig_app_*`).

Гейт — фича `zoom_integration` (никогда по tariff_slug), пока только admin.
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse

from app.auth import get_current_client
from app.database import get_db
from app.config import settings
from app.services import zoom_api
from app.services.features import client_has_feature

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/clients/me/zoom", tags=["Zoom"])


async def _assert_feature(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "zoom_integration"):
        raise HTTPException(
            status_code=403,
            detail="Интеграция с Zoom недоступна на вашем тарифе.",
        )


def _cid(client) -> int:
    return int(client["sub"])


@router.get("", summary="Состояние интеграции с Zoom")
async def get_status(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Подключён ли зум клиента, чей он и где уже созданы конференции.

    ⚠️ 403 без фичи — блок на фронте по нему сам прячется, как блок
    автообзвонов. Замок на пол-экрана посреди вкладки с другими интеграциями
    был бы шумом.
    """
    cid = _cid(client)
    await _assert_feature(db, cid)

    acc = await db.fetchrow(
        "SELECT zoom_email, zoom_account_name, zoom_plan_type, access_token, "
        "       connected_at, refresh_failed_at, refresh_error "
        "FROM client_zoom_accounts WHERE client_id=$1", cid)

    # Где кнопкой уже заведены конференции — чтобы человек видел, что
    # интеграция не абстрактная, а работает вот в этих эфирах.
    rows = await db.fetch(
        """SELECT e.id AS event_id, e.title, wr.day_number, wr.zoom_meeting_id,
                  wr.zoom_livestream_ok, wr.zoom_created_at
             FROM webinar_rooms wr
             JOIN events e ON e.id = wr.event_id
             JOIN event_owners eo ON eo.event_id = e.id
                  AND eo.status = 'accepted' AND eo.client_id = $1
            WHERE wr.zoom_meeting_id IS NOT NULL
            ORDER BY wr.zoom_created_at DESC NULLS LAST
            LIMIT 20""",
        cid,
    )

    plan = int(acc["zoom_plan_type"] or 0) if acc else 0
    return {
        # Настроено ли приложение на сервере. Нет — подключать нечего, и кнопку
        # показывать не надо.
        "app_configured": zoom_api.is_configured(),
        "connected": bool(acc and acc["access_token"]),
        "email": (acc["zoom_email"] if acc else None) or "",
        "account_name": (acc["zoom_account_name"] if acc else None) or "",
        "plan_type": plan or None,
        # ⚠️ Тип 1 — базовый (бесплатный). Ниже Pro нет Custom Live Streaming:
        # конференция создастся, а вещать в нашу комнату не сможет. Говорим об
        # этом в кабинете, а не в момент старта эфира.
        "can_livestream": plan >= 2,
        "connected_at": acc["connected_at"].isoformat() if acc and acc["connected_at"] else None,
        # Доступ отозван/приложение удалено — кабинет скажет «подключите заново».
        "needs_reconnect": bool(acc and acc["refresh_failed_at"]),
        "error": (acc["refresh_error"] if acc else None) or "",
        "meetings": [
            {
                "event_id": r["event_id"],
                "event_title": r["title"],
                "day_number": r["day_number"],
                "meeting_id": r["zoom_meeting_id"],
                "livestream_ok": r["zoom_livestream_ok"],
                "created_at": r["zoom_created_at"].isoformat() if r["zoom_created_at"] else None,
            }
            for r in rows
        ],
    }


@router.get("/oauth-url", summary="Ссылка на окно подключения Zoom")
async def oauth_url(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Готовит подключение и отдаёт ссылку на согласие Zoom.

    ⚠️ `state` — короткая случайная строка с TTL 10 минут. По ней callback
    опознаёт клиента: Zoom возвращается на наш адрес БЕЗ куки кабинета, и
    другого способа понять, кто подключался, нет.
    """
    cid = _cid(client)
    await _assert_feature(db, cid)
    if not zoom_api.is_configured():
        raise HTTPException(
            status_code=400,
            detail="Zoom не настроен на сервере: нет ключей приложения. Напишите в поддержку.",
        )

    state = secrets.token_urlsafe(24)
    exp = datetime.now(timezone.utc) + timedelta(minutes=10)
    # Строка на клиента одна: заводим её при первом подключении, дальше обновляем.
    await db.execute(
        "INSERT INTO client_zoom_accounts (client_id, pending_state, pending_state_exp) "
        "VALUES ($1,$2,$3) "
        "ON CONFLICT (client_id) DO UPDATE SET pending_state=EXCLUDED.pending_state, "
        "  pending_state_exp=EXCLUDED.pending_state_exp, updated_at=NOW()",
        cid, state, exp,
    )
    return {"oauth_url": zoom_api.oauth_url(state)}


def _html(title: str, message: str, ok: bool = True) -> HTMLResponse:
    color = "#16a34a" if ok else "#dc2626"
    return HTMLResponse(
        f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>{title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:60px auto;
padding:24px;text-align:center}}h1{{color:{color};font-size:20px;margin-bottom:12px}}
p{{color:#475569;line-height:1.5}}</style></head>
<body><h1>{title}</h1><p>{message}</p><p style="margin-top:32px;color:#94a3b8;font-size:13px">
Эту вкладку можно закрыть и вернуться в кабинет ПЛЮСОНа.</p></body></html>""",
        status_code=200 if ok else 400,
    )


@router.get("/oauth-callback", include_in_schema=False)
async def oauth_callback(
    code: str = "", state: str = "", error: str = "",
    error_description: str = "",
    db: asyncpg.Connection = Depends(get_db),
):
    """Возврат из Zoom после согласия.

    ⚠️ БЕЗ авторизации кабинета: Zoom не пересылает наши куки. Клиент
    опознаётся по `state`, выданному в `/oauth-url` и живущему 10 минут.
    """
    if error:
        return _html("Не получилось", f"Zoom вернул: {error_description or error}", ok=False)

    # ⚠️⚠️ КОД ЕСТЬ, А МЕТКИ `state` НЕТ — это НЕ ошибка и не сбой. Так
    # приходит кнопка **Add app now** со страницы Local Test в настройках
    # приложения Zoom: она ставит приложение аккаунту и отправляет человека на
    # наш адрес возврата, ничего не зная про кабинет ПЛЮСОНа и про то, какому
    # клиенту записывать токен. Без `state` мы клиента опознать не можем —
    # Zoom сюда куки кабинета не пересылает.
    #
    # Раньше тут было общее «Zoom не вернул код подтверждения»: человек видел
    # слово «Не получилось» после успешной, вообще говоря, установки и решал,
    # что интеграция сломана (прод, 19.09.2026). Теперь объясняем, что
    # произошло и куда идти дальше.
    if code and not state:
        return _html(
            "Приложение добавлено",
            "Это была установка приложения из настроек Zoom — она прошла. "
            "Осталось связать его с вашим кабинетом: вернитесь в ПЛЮСОН, "
            "«Настройки → Интеграция → Zoom», и нажмите «Подключить Zoom». "
            "Только так мы поймём, чей это аккаунт.",
        )
    if not code or not state:
        return _html("Не получилось",
                     "Zoom не вернул код подтверждения. Начните подключение "
                     "из кабинета: «Настройки → Интеграция → Zoom».", ok=False)

    acc = await db.fetchrow(
        "SELECT client_id, pending_state_exp FROM client_zoom_accounts WHERE pending_state=$1",
        state)
    if not acc:
        return _html("Не получилось",
                     "Подключение не найдено. Начните заново из кабинета.", ok=False)
    exp = acc["pending_state_exp"]
    if not exp or exp < datetime.now(timezone.utc):
        return _html("Время вышло",
                     "С момента нажатия прошло больше 10 минут. Начните подключение заново.",
                     ok=False)

    cid = acc["client_id"]
    try:
        tokens = await zoom_api.exchange_code(code)
        me = await zoom_api.get_me_with_token(tokens["access_token"])
    except zoom_api.ZoomError as e:
        logger.warning("Zoom OAuth: обмен кода не удался (клиент %s): %s", cid, e)
        return _html("Не получилось", f"Zoom: {e}", ok=False)

    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=int(tokens.get("expires_in") or 3600))
    await db.execute(
        "UPDATE client_zoom_accounts SET zoom_user_id=$1, zoom_email=$2, zoom_account_name=$3, "
        " zoom_plan_type=$4, access_token=$5, refresh_token=$6, token_expires_at=$7, "
        " pending_state=NULL, pending_state_exp=NULL, refresh_failed_at=NULL, refresh_error=NULL, "
        " connected_at=NOW(), updated_at=NOW() WHERE client_id=$8",
        str(me.get("id") or ""), me.get("email") or "",
        f"{me.get('first_name', '')} {me.get('last_name', '')}".strip(),
        int(me.get("type") or 1),
        tokens["access_token"], tokens.get("refresh_token") or "", expires_at,
        cid,
    )

    # ⚠️ Про тариф говорим сразу: ниже Pro конференция создастся, а вещать в
    # вебинарную комнату не будет. Узнать это в момент эфира — худший вариант.
    if int(me.get("type") or 1) < 2:
        return _html(
            "Zoom подключён",
            f"Аккаунт {me.get('email') or ''} подключён. Но у него базовый (бесплатный) тариф — "
            "трансляция в вебинарную комнату на нём недоступна: Zoom разрешает её с тарифа Pro.",
        )
    return _html("Zoom подключён", f"Аккаунт {me.get('email') or ''} готов к работе.")


@router.post("/check", summary="Проверить связь с Zoom")
async def check(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Спрашивает у Zoom, чей это аккаунт — проверка «доступ ещё действует».

    ⚠️ Именно запрос к Zoom, а не «токен в базе не пустой»: отозванный доступ
    выглядит в базе ровно так же, как рабочий, и выяснять это перед эфиром —
    худший момент. Заодно обновляет тариф: клиент мог перейти на Pro.
    """
    cid = _cid(client)
    await _assert_feature(db, cid)

    try:
        me = await zoom_api.get_me(db, cid)
    except zoom_api.ZoomNotConnected as e:
        return {"ok": False, "needs_reconnect": True, "error": str(e)}
    except zoom_api.ZoomError as e:
        return {"ok": False, "needs_reconnect": False, "error": str(e)}

    plan = int(me.get("type") or 1)
    await db.execute(
        "UPDATE client_zoom_accounts SET zoom_plan_type=$1, zoom_email=$2, updated_at=NOW() "
        "WHERE client_id=$3", plan, me.get("email") or "", cid)

    return {
        "ok": True,
        "email": me.get("email") or "",
        "account_name": f"{me.get('first_name', '')} {me.get('last_name', '')}".strip(),
        "plan_type": plan,
        "can_livestream": plan >= 2,
    }


@router.delete("", summary="Отключить Zoom")
async def disconnect(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Забывает зум-аккаунт клиента.

    ⚠️ Уже созданные конференции в Zoom НЕ удаляем: они назначены, ссылки на
    них могли уйти спикерам, и молча снести их значит сорвать эфир. Отключение
    здесь — про то, что мы больше не создаём новые.
    """
    cid = _cid(client)
    await _assert_feature(db, cid)
    await db.execute("DELETE FROM client_zoom_accounts WHERE client_id=$1", cid)
    return {"ok": True}
