"""API новостей платформы.

Три роутера — по трём разным аудиториям:
  client_router  — кабинет клиента: лента, счётчик колокольчика, отметки прочтения;
  manage_router  — ведение новостей: админ ИЛИ сервисный клиент (см. ниже);
  public_router  — отписка от писем по ссылке из письма (без авторизации).

⚠️⚠️ Ведение новостей открыто ДВУМ разным ролям, и это осознанно: админу
платформы (JWT role='admin') и владельцу сервисного кабинета
(`clients.is_system_service`). Второе — чтобы посадить на новости человека из
техподдержки, не выдавая ему всю админку с клиентами, тарифами и оплатами.
Поэтому у ручек ведения СВОЯ зависимость `require_news_editor`, а не
`get_current_admin`.
"""
import logging
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services import platform_news as svc

log = logging.getLogger(__name__)

client_router = APIRouter(prefix="/news", tags=["Новости платформы"])
manage_router = APIRouter(prefix="/platform-news", tags=["Новости платформы (ведение)"])
public_router = APIRouter(tags=["Новости платформы"])


# ─── Кто может вести новости ─────────────────────────────────────────────────

async def require_news_editor(
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
) -> dict:
    """Админ платформы либо владелец сервисного кабинета.

    ⚠️ Помощнику сервисного кабинета ведение НЕ открываем: новость видят все
    клиенты платформы разом, отозвать её нельзя. Такое право даётся человеку
    явно — сменой владельца кабинета, а не выдачей помощнического доступа.
    """
    if user.get("role") == "admin":
        return {"kind": "admin", "admin_id": int(user["sub"])}

    if user.get("role") == "assistant":
        raise HTTPException(status_code=403, detail="Новости ведёт только владелец кабинета")

    client_id = int(user["sub"])
    is_service = await db.fetchval(
        "SELECT is_system_service FROM clients WHERE id = $1", client_id)
    if not is_service:
        raise HTTPException(status_code=403, detail="Раздел доступен только команде ПЛЮСОНа")
    return {"kind": "client", "client_id": client_id}


# ─── Кабинет клиента ─────────────────────────────────────────────────────────

@client_router.get("", summary="Новости платформы для кабинета")
async def my_news(
    limit: Optional[int] = None,
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Лента новостей с отметкой «прочитана». `limit=5` — для колокольчика."""
    client_id = int(user["sub"])
    items = await svc.list_for_client(db, client_id, limit=limit)
    return {
        "news": items,
        "unread": await svc.unread_count(db, client_id),
    }


@client_router.get("/unread-count", summary="Сколько новостей не прочитано")
async def my_unread_count(
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Цифра на колокольчике. Отдельная лёгкая ручка — как unread-count у
    диалогов: дёргается по таймеру, тащить ради неё всю ленту незачем."""
    return {"unread": await svc.unread_count(db, int(user["sub"]))}


@client_router.post("/{news_id}/read", summary="Отметить новость прочитанной")
async def read_one(
    news_id: int,
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await svc.mark_read(db, client_id, news_id)
    return {"ok": True, "unread": await svc.unread_count(db, client_id)}


@client_router.post("/read-all", summary="Отметить все новости прочитанными")
async def read_all(
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """«Скрыть все» в плашке."""
    marked = await svc.mark_all_read(db, int(user["sub"]))
    return {"ok": True, "marked": marked, "unread": 0}


# ─── Настройка: отписка от писем из кабинета ─────────────────────────────────

class NewsEmailPref(BaseModel):
    enabled: bool


@client_router.get("/email-preference", summary="Получаю ли письма с новостями")
async def get_email_pref(
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    off = await db.fetchval(
        "SELECT news_unsubscribed_at FROM clients WHERE id = $1", int(user["sub"]))
    return {"enabled": off is None}


@client_router.put("/email-preference", summary="Включить/выключить письма с новостями")
async def set_email_pref(
    data: NewsEmailPref,
    user=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Влияет ТОЛЬКО на почту — в кабинете новости остаются."""
    await db.execute(
        """UPDATE clients
              SET news_unsubscribed_at = CASE WHEN $2 THEN NULL
                                              ELSE COALESCE(news_unsubscribed_at, NOW()) END
            WHERE id = $1""",
        int(user["sub"]), data.enabled,
    )
    return {"ok": True, "enabled": data.enabled}


# ─── Ведение новостей ────────────────────────────────────────────────────────

class NewsCreate(BaseModel):
    title: str
    body: str = ""
    image_url: Optional[str] = None
    mail_subject: Optional[str] = None
    mail_body: Optional[str] = None


class NewsUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    image_url: Optional[str] = None
    mail_subject: Optional[str] = None
    mail_body: Optional[str] = None
    status: Optional[str] = None


@manage_router.get("", summary="Список новостей (черновики + опубликованные)")
async def list_news(
    editor=Depends(require_news_editor),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        """SELECT n.*,
                  (SELECT COUNT(*) FROM platform_news_reads r WHERE r.news_id = n.id) AS read_count
             FROM platform_news n
            ORDER BY COALESCE(n.published_at, n.created_at) DESC, n.id DESC"""
    )
    return {
        "news": [dict(r) for r in rows],
        "recipients": await svc.recipients_preview(db),
    }


@manage_router.post("", summary="Создать новость (черновиком)")
async def create_news(
    data: NewsCreate,
    editor=Depends(require_news_editor),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Всегда рождается черновиком: публикация — отдельное осознанное
    действие, её видят все клиенты разом и отменить это нельзя."""
    title = (data.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Впишите заголовок новости")

    row = await db.fetchrow(
        """INSERT INTO platform_news
               (title, body, image_url, mail_subject, mail_body,
                created_by_admin_id, created_by_client_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
        title, data.body or "", data.image_url or None,
        (data.mail_subject or "").strip() or None,
        (data.mail_body or "").strip() or None,
        editor.get("admin_id"), editor.get("client_id"),
    )
    return {"news": dict(row)}


@manage_router.patch("/{news_id}", summary="Изменить новость")
async def update_news(
    news_id: int,
    data: NewsUpdate,
    editor=Depends(require_news_editor),
    db: asyncpg.Connection = Depends(get_db),
):
    fs = data.model_fields_set
    sets: list[str] = []
    args: list = []

    def add(col: str, val):
        args.append(val)
        sets.append(f"{col} = ${len(args)}")

    # ⚠️ model_fields_set, а не `is not None`: иначе нельзя стереть картинку
    # или свой текст рассылки — «прислали null» было бы неотличимо от «не
    # прислали» (та же ловушка, что в PATCH /clients/me/profile).
    if "title" in fs:
        title = (data.title or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Заголовок не может быть пустым")
        add("title", title)
    if "body" in fs:
        add("body", data.body or "")
    if "image_url" in fs:
        add("image_url", (data.image_url or "").strip() or None)
    if "mail_subject" in fs:
        add("mail_subject", (data.mail_subject or "").strip() or None)
    if "mail_body" in fs:
        add("mail_body", (data.mail_body or "").strip() or None)

    if "status" in fs and data.status:
        if data.status not in ("draft", "published", "archived"):
            raise HTTPException(status_code=400, detail="Неизвестный статус")
        add("status", data.status)
        # published_at ставим ОДИН раз — при первой публикации. Иначе снятие с
        # публикации и возврат обратно сделали бы старую новость «свежей» и
        # она всплыла бы плашкой у тех, кто её уже прочитал.
        if data.status == "published":
            sets.append("published_at = COALESCE(published_at, NOW())")

    if not sets:
        return {"ok": True, "message": "Нечего обновлять"}

    args.append(news_id)
    row = await db.fetchrow(
        f"UPDATE platform_news SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Новость не найдена")
    return {"news": dict(row)}


@manage_router.delete("/{news_id}", summary="Удалить новость")
async def delete_news(
    news_id: int,
    editor=Depends(require_news_editor),
    db: asyncpg.Connection = Depends(get_db),
):
    result = await db.execute("DELETE FROM platform_news WHERE id = $1", news_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Новость не найдена")
    return {"ok": True}


@manage_router.post("/{news_id}/send-email", summary="Разослать новость на почту клиентов")
async def send_email(
    news_id: int,
    editor=Depends(require_news_editor),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Отдельно от публикации: опубликованную с опечаткой новость можно
    снять, а разосланное письмо не отзывается."""
    from app.tasks.platform_news import send_news_email_task
    news = await db.fetchrow("SELECT status FROM platform_news WHERE id = $1", news_id)
    if not news:
        raise HTTPException(status_code=404, detail="Новость не найдена")
    if news["status"] != "published":
        raise HTTPException(status_code=400, detail="Сначала опубликуйте новость")

    # ⚠️ Через очередь, а не прямо здесь: писем сотни, HTTP-запрос из браузера
    # отвалится по таймауту, оставив рассылку наполовину отправленной.
    send_news_email_task.delay(news_id)
    return {"ok": True, "queued": True}


@manage_router.post("/{news_id}/send-bot", summary="Разослать новость в бот ПЛЮСОНа")
async def send_bot(
    news_id: int,
    editor=Depends(require_news_editor),
    db: asyncpg.Connection = Depends(get_db),
):
    from app.tasks.platform_news import send_news_bot_task
    news = await db.fetchrow("SELECT status FROM platform_news WHERE id = $1", news_id)
    if not news:
        raise HTTPException(status_code=404, detail="Новость не найдена")
    if news["status"] != "published":
        raise HTTPException(status_code=400, detail="Сначала опубликуйте новость")

    send_news_bot_task.delay(news_id)
    return {"ok": True, "queued": True}


# ─── Отписка по ссылке из письма ─────────────────────────────────────────────

_PAGE = """<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Новости ПЛЮСОНа</title></head>
<body style="margin:0;font-family:Roboto,Arial,sans-serif;background:#f8fafc;color:#25455D">
<div style="max-width:520px;margin:60px auto;padding:32px;background:#fff;border-radius:16px;
            box-shadow:0 1px 3px rgba(0,0,0,.08)">
  <h1 style="margin:0 0 12px;font-size:20px">{title}</h1>
  <p style="margin:0;line-height:1.55;color:#475569">{text}</p>
</div></body></html>"""


@public_router.get("/api/v1/news/unsubscribe", response_class=HTMLResponse,
                   summary="Отписка от писем с новостями ПЛЮСОНа")
async def news_unsubscribe(token: str, request: Request, db=Depends(get_db)):
    """⚠️ Отписывает СРАЗУ, без формы-подтверждения.

    У отписки контакта от рассылок клиента форма есть — там спрашивают причину
    для метрик доставляемости. Здесь получатель — сам клиент платформы, причина
    нам ничего не даёт, а лишний экран между «не хочу» и результатом читается
    как попытка удержать.
    """
    from app.services.news_unsubscribe_token import parse_news_unsubscribe_token

    client_id = parse_news_unsubscribe_token(token or "")
    if not client_id:
        return HTMLResponse(
            _PAGE.format(title="Ссылка не сработала",
                         text="Похоже, ссылка повреждена. Отписаться можно в кабинете: "
                              "Настройки → Новости."),
            status_code=400)

    await db.execute(
        """UPDATE clients
              SET news_unsubscribed_at = COALESCE(news_unsubscribed_at, NOW())
            WHERE id = $1""",
        client_id,
    )
    return HTMLResponse(
        _PAGE.format(
            title="Вы отписались от новостей",
            text="Больше не пришлём писем с новостями ПЛЮСОНа. В кабинете новости "
                 "останутся — вы увидите их, когда зайдёте. Вернуть письма можно "
                 "в настройках кабинета."),
        status_code=200)
