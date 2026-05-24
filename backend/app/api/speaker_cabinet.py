"""
Мини-кабинет спикера на pluson.ru/speaker/<event_slug> — самообслуживание.

Не Mini App, отдельный веб-лендинг. Спикер открывает ссылку, выбирает свою
фамилию из списка, вводит код доступа (`collaborators.access_code`) — получает
сессионный токен (JWT 24ч) — правит свои данные.

Endpoints:
- GET  /api/v1/public/speaker-cabinet/{event_slug}/speakers — список фамилий
- POST /api/v1/public/speaker-cabinet/{event_slug}/auth     — выдача JWT
- GET  /api/v1/public/speaker-cabinet/me                    — данные после auth
- PATCH /api/v1/public/speaker-cabinet/me                   — правка профиля и события
- POST /api/v1/public/speaker-cabinet/me/photo              — заглушка для upload (через основной /uploads)
"""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Header, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional, List
import asyncpg
import jwt

from app.config import settings
from app.database import get_db
from app.services import r2_storage
from app.services.image_processor import process_image, is_image

router = APIRouter(prefix="/api/v1/public/speaker-cabinet", tags=["Кабинет спикера"])

_CAB_AUD = "speaker-cabinet"
_CAB_TTL_HOURS = 24


def _sign(speaker_event_id: int, collaborator_id: int, event_id: int) -> str:
    payload = {
        "aud": _CAB_AUD,
        "se_id": speaker_event_id,
        "c_id": collaborator_id,
        "e_id": event_id,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_CAB_TTL_HOURS),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def _decode(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"], audience=_CAB_AUD)
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"Сессия истекла или невалидна ({e})")


def _split_full_name(name: str) -> tuple[str, str]:
    s = (name or "").strip()
    if not s:
        return "", ""
    parts = s.split(maxsplit=1)
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[1]


@router.get("/{event_slug}/speakers", summary="Список фамилий спикеров события (публично)")
async def list_speakers_for_login(event_slug: str, db: asyncpg.Connection = Depends(get_db)):
    """Отдаёт только id+фамилия+имя — достаточно для выбора в выпадающем списке.
    Без access_code в ответе — это публичный endpoint."""
    ev = await db.fetchrow(
        "SELECT id, title FROM events WHERE slug = $1", event_slug
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    rows = await db.fetch(
        """SELECT cse.id AS speaker_event_id, c.id AS collaborator_id, c.name
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
            WHERE cse.event_id = $1
            ORDER BY c.name""",
        ev["id"]
    )
    items = []
    for r in rows:
        first, last = _split_full_name(r["name"])
        items.append({
            "speaker_event_id": r["speaker_event_id"],
            "collaborator_id": r["collaborator_id"],
            "first_name": first,
            "last_name": last,
            "full_name": r["name"],
        })
    return {
        "event_id": ev["id"],
        "event_slug": event_slug,
        "event_title": ev["title"],
        "speakers": items,
    }


class CabinetAuthIn(BaseModel):
    speaker_event_id: int
    access_code: str


@router.post("/{event_slug}/auth", summary="Авторизация: фамилия + код доступа → JWT")
async def auth(event_slug: str, data: CabinetAuthIn, db: asyncpg.Connection = Depends(get_db)):
    code = (data.access_code or "").strip()
    if not code:
        raise HTTPException(status_code=422, detail="Введите код доступа")
    row = await db.fetchrow(
        """SELECT cse.id AS se_id, cse.event_id, c.id AS c_id, c.access_code
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             JOIN events e ON e.id = cse.event_id
            WHERE cse.id = $1 AND e.slug = $2""",
        data.speaker_event_id, event_slug
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден в этом событии")
    if (row["access_code"] or "").strip().lower() != code.lower():
        raise HTTPException(status_code=403, detail="Неверный код доступа")
    token = _sign(row["se_id"], row["c_id"], row["event_id"])
    return {"token": token, "expires_in_hours": _CAB_TTL_HOURS}


def _auth_session(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Нет токена сессии")
    token = authorization.split(" ", 1)[1].strip()
    return _decode(token)


@router.get("/me", summary="Профиль спикера (после авторизации)")
async def get_me(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    se_id = int(session["se_id"])
    row = await db.fetchrow(
        """SELECT cse.id AS speaker_event_id, cse.event_id, cse.role,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.knowledge_base_title, cse.knowledge_base_url,
                  cse.show_topic_field, cse.show_gift_after_speech_field,
                  cse.show_knowledge_base_field,
                  cse.bot_in_channel,
                  c.id AS collaborator_id, c.name, c.title, c.achievements,
                  c.photo_url, c.poster_url, c.photo_folder_url, c.video_folder_url,
                  c.tg_channel_url, c.vk_url, c.max_url, c.instagram_url, c.website_url,
                  c.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username AS personal_tg_username,
                  pu_vk.platform_user_id AS personal_vk_id,
                  pu_vk.username AS personal_vk_username,
                  pu_max.platform_user_id AS personal_max_id,
                  pu_max.username AS personal_max_username,
                  (pu_tg.id IS NOT NULL)  AS tg_locked,
                  (pu_vk.id IS NOT NULL)  AS vk_locked,
                  (pu_max.id IS NOT NULL) AS max_locked,
                  ctc.email, ctc.phone, ctc.ref_code,
                  e.title AS event_title, e.slug AS event_slug,
                  ers.is_enabled AS raffle_enabled,
                  cc.subscription_mode
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             JOIN events e ON e.id = cse.event_id
             LEFT JOIN contacts ctc ON ctc.id = c.contact_id
             LEFT JOIN platform_users pu_tg
               ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
             LEFT JOIN platform_users pu_vk
               ON pu_vk.contact_id = c.contact_id AND pu_vk.platform_slug = 'vk'
             LEFT JOIN platform_users pu_max
               ON pu_max.contact_id = c.contact_id AND pu_max.platform_slug = 'max'
             LEFT JOIN event_raffle_settings ers ON ers.event_id = cse.event_id
             LEFT JOIN conf_conferences cc ON cc.event_id = cse.event_id
            WHERE cse.id = $1""",
        se_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден (возможно, удалён)")
    topics = await db.fetch(
        "SELECT topic FROM conf_speaker_topics WHERE cse_id = $1 ORDER BY sort_order, id",
        se_id
    )
    d = dict(row)
    d["topics"] = [t["topic"] for t in topics if t["topic"]]
    # Нужна ли проверка подписки на канал этого спикера в Mini App.
    # all_speakers — у всех; organizer — только организаторам; none — никому.
    mode = (d.get("subscription_mode") or "none").lower()
    role = (d.get("role") or "").lower()
    d["needs_channel_check"] = (
        mode == "all_speakers"
        or (mode == "organizer" and role == "organizer")
    )
    return d


class CabinetUpdate(BaseModel):
    # Профиль (collaborators)
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    # Контакт (contacts)
    email: Optional[str] = None
    phone: Optional[str] = None
    # Личные идентичности
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    # Выступление (event_collaborators)
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    knowledge_base_title: Optional[str] = None
    knowledge_base_url: Optional[str] = None


@router.patch("/me", summary="Сохранить правки спикера")
async def patch_me(
    data: CabinetUpdate,
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    from app.api.collaborators import _upsert_personal_identities

    se_id = int(session["se_id"])
    c_id = int(session["c_id"])

    coll = await db.fetchrow(
        "SELECT created_by_client_id, contact_id FROM collaborators WHERE id = $1",
        c_id
    )
    if not coll:
        raise HTTPException(status_code=404, detail="Профиль не найден")
    client_id = coll["created_by_client_id"]
    contact_id = coll["contact_id"]

    # 1. Профиль (collaborators)
    profile_fields = ["name", "title", "achievements", "photo_url", "poster_url",
                      "photo_folder_url", "video_folder_url",
                      "tg_channel_url", "vk_url", "max_url",
                      "instagram_url", "website_url", "tg_channel_id"]
    upd = {f: getattr(data, f) for f in profile_fields if getattr(data, f) is not None}
    if upd:
        parts = [f"{k} = ${i+2}" for i, k in enumerate(upd.keys())]
        parts.append("updated_at = NOW()")
        await db.execute(
            f"UPDATE collaborators SET {', '.join(parts)} WHERE id = $1",
            c_id, *upd.values()
        )

    # 2. Контакт (contacts) — email / phone
    if contact_id:
        ct_upd = {}
        if data.email is not None:
            ct_upd["email"] = data.email.strip() or None
            ct_upd["email_normalized"] = (data.email or "").strip().lower() or None
        if data.phone is not None:
            phone_raw = (data.phone or "").strip()
            phone_norm = "".join(ch for ch in phone_raw if ch.isdigit()) or None
            if phone_norm and phone_norm.startswith("8") and len(phone_norm) == 11:
                phone_norm = "+7" + phone_norm[1:]
            ct_upd["phone"] = phone_raw or None
            ct_upd["phone_normalized"] = phone_norm
        if ct_upd:
            parts = [f"{k} = ${i+2}" for i, k in enumerate(ct_upd.keys())]
            await db.execute(
                f"UPDATE contacts SET {', '.join(parts)} WHERE id = $1",
                contact_id, *ct_upd.values()
            )

    # 3. Личные идентичности → platform_users.
    # ВАЖНО: если у contact_id уже есть запись на платформе (привязана через
    # бота при первом клике spkinv_) — НЕ перезаписываем её, спикер не имеет
    # права менять свой ID. Только при первом заполнении (если platform_users
    # ещё нет) разрешаем ввод.
    if contact_id:
        locks = await db.fetchrow(
            """SELECT
                 EXISTS(SELECT 1 FROM platform_users WHERE contact_id=$1 AND platform_slug='telegram') AS tg_locked,
                 EXISTS(SELECT 1 FROM platform_users WHERE contact_id=$1 AND platform_slug='vk')       AS vk_locked,
                 EXISTS(SELECT 1 FROM platform_users WHERE contact_id=$1 AND platform_slug='max')      AS max_locked""",
            contact_id,
        )
        # Создаём отфильтрованный dataclass-like объект для _upsert_personal_identities.
        # Если платформа залочена — обнуляем эти поля чтобы хелпер их пропустил.
        class _Filtered:
            personal_tg_id = data.personal_tg_id if not locks["tg_locked"] else None
            personal_tg_username = data.personal_tg_username if not locks["tg_locked"] else None
            personal_vk_id = data.personal_vk_id if not locks["vk_locked"] else None
            personal_vk_username = data.personal_vk_username if not locks["vk_locked"] else None
            personal_max_id = data.personal_max_id if not locks["max_locked"] else None
            personal_max_username = data.personal_max_username if not locks["max_locked"] else None
        await _upsert_personal_identities(db, client_id, contact_id, _Filtered())

    # 4. Темы выступления — переписываем целиком из массива
    if data.topics is not None:
        clean = [t.strip() for t in data.topics if (t or "").strip()]
        await db.execute("DELETE FROM conf_speaker_topics WHERE cse_id = $1", se_id)
        if clean:
            for i, topic in enumerate(clean):
                await db.execute(
                    "INSERT INTO conf_speaker_topics (cse_id, topic, sort_order) VALUES ($1,$2,$3)",
                    se_id, topic, i
                )
            await db.execute(
                "UPDATE event_collaborators SET speaker_topic = $1 WHERE id = $2",
                clean[0], se_id
            )
        else:
            await db.execute(
                "UPDATE event_collaborators SET speaker_topic = NULL WHERE id = $1", se_id
            )

    # 5. Подарки и материал
    ev_upd = {}
    for f in ("gift_after_speech_title", "gift_after_speech_url",
              "gift_raffle_title", "gift_raffle_url",
              "knowledge_base_title", "knowledge_base_url"):
        v = getattr(data, f, None)
        if v is not None:
            ev_upd[f] = v
    if ev_upd:
        parts = [f"{k} = ${i+2}" for i, k in enumerate(ev_upd.keys())]
        await db.execute(
            f"UPDATE event_collaborators SET {', '.join(parts)} WHERE id = $1",
            se_id, *ev_upd.values()
        )

    return await get_me(session, db)


@router.post("/me/verify-channel", summary="Проверить, что бот в канале спикера + резолвить tg_channel_id")
async def verify_channel(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """
    Используется на форме спикера для самопроверки канала. Если у коллаба
    заполнен tg_channel_url, но tg_channel_id пуст — резолвит через getChat.
    Затем getChatMember(channel, личный_tg_id) — если бот в канале админом
    и видит спикера, ставит event_collaborators.bot_in_channel = TRUE и
    возвращает {ok: true}. Иначе — разъяснение что не так.
    """
    import httpx
    from app.services.channels import get_client_telegram_token

    se_id = int(session["se_id"])
    row = await db.fetchrow(
        """SELECT cse.id AS se_id, cse.event_id, c.id AS c_id,
                  c.tg_channel_url, c.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  c.created_by_client_id, c.name AS speaker_name
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             LEFT JOIN platform_users pu_tg
               ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
            WHERE cse.id = $1""",
        se_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Профиль не найден")

    channel_url = (row["tg_channel_url"] or "").strip()
    channel_id = (row["tg_channel_id"] or "").strip()
    if not channel_url and not channel_id:
        raise HTTPException(status_code=400, detail="Сначала укажите ссылку на ваш Telegram-канал и сохраните")
    speaker_tg_id = row["personal_tg_id"]
    if not speaker_tg_id:
        raise HTTPException(status_code=400, detail="Ваш Telegram-аккаунт ещё не привязан. Откройте invite-ссылку через бота и попробуйте ещё раз")

    client_id = int(row["created_by_client_id"])
    token = (await get_client_telegram_token(client_id, db)) or settings.telegram_bot_token
    if not token:
        raise HTTPException(status_code=400, detail="У клиента не подключён бот для проверки канала")

    bot_handle = ""
    try:
        async with httpx.AsyncClient(timeout=5) as http:
            br = await http.get(f"https://api.telegram.org/bot{token}/getMe")
        bot_handle = ((br.json() or {}).get("result") or {}).get("username", "") or ""
    except Exception:
        pass
    bot_ref = f"@{bot_handle}" if bot_handle else "бот клиента"

    # Если ID канала ещё не сохранён — резолвим через getChat по @username из url
    if not channel_id and channel_url:
        m = channel_url.replace("https://t.me/", "").replace("http://t.me/", "").lstrip("@/").split("/")[0].split("?")[0]
        if m and not m.startswith("+"):
            try:
                async with httpx.AsyncClient(timeout=6) as http:
                    cr = await http.get(
                        f"https://api.telegram.org/bot{token}/getChat",
                        params={"chat_id": f"@{m}"},
                    )
                cd = cr.json()
                if cd.get("ok") and cd.get("result", {}).get("id"):
                    channel_id = str(cd["result"]["id"])
                    await db.execute(
                        "UPDATE collaborators SET tg_channel_id = $1, updated_at = NOW() WHERE id = $2",
                        channel_id, row["c_id"],
                    )
            except Exception:
                pass

    if not channel_id:
        raise HTTPException(
            status_code=400,
            detail=f"Не удалось определить ID канала по ссылке. Добавьте {bot_ref} администратором в канал и попробуйте снова."
        )

    try:
        async with httpx.AsyncClient(timeout=8) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChatMember",
                params={"chat_id": channel_id, "user_id": speaker_tg_id},
            )
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ошибка Telegram API: {e}")

    if not data.get("ok"):
        desc = (data.get("description") or "").lower()
        if "member list is inaccessible" in desc or "not enough rights" in desc or "no rights" in desc:
            detail = f"Бот не админ канала. Добавьте {bot_ref} в администраторы вашего канала (без прав публикации) и нажмите «Проверить» ещё раз."
        elif "chat not found" in desc:
            detail = f"Канал не найден. Возможно {bot_ref} ещё не добавлен в ваш канал. Добавьте и нажмите «Проверить»."
        elif "user not found" in desc:
            detail = "Telegram не видит вас в канале. Зайдите в свой канал и попробуйте ещё раз."
        elif "bot was kicked" in desc or "kicked" in desc:
            detail = f"Бот удалён из канала. Добавьте {bot_ref} обратно в администраторы."
        else:
            detail = f"Не удалось проверить. Telegram ответил: {data.get('description') or 'неизвестная ошибка'}"
        return {"ok": False, "detail": detail, "bot_handle": bot_handle, "channel_id": channel_id}

    # Успех — ставим bot_in_channel
    await db.execute(
        "UPDATE event_collaborators SET bot_in_channel = TRUE WHERE id = $1",
        se_id,
    )
    return {"ok": True, "channel_id": channel_id, "bot_handle": bot_handle}


@router.post("/me/upload", summary="Загрузить фото/афишу спикера (cabinet-сессия)")
async def upload_me(
    file: UploadFile = File(...),
    kind: str = Form(...),  # 'speaker_photo' | 'speaker_poster'
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Загрузка фото профиля и афиши через cabinet-JWT (без client-JWT).
    Файл проходит через тот же image_processor (ресайз) и пишется в R2 по
    путь `clients/{client_id}/speakers/{collaborator_id}/{photo|poster}/`.
    """
    if kind not in ("speaker_photo", "speaker_poster"):
        raise HTTPException(400, detail="kind must be 'speaker_photo' or 'speaker_poster'")
    c_id = int(session["c_id"])
    coll = await db.fetchrow(
        "SELECT created_by_client_id FROM collaborators WHERE id = $1",
        c_id,
    )
    if not coll or not coll["created_by_client_id"]:
        raise HTTPException(404, detail="Профиль спикера не найден")
    client_id = int(coll["created_by_client_id"])

    raw = await file.read()
    if not raw:
        raise HTTPException(400, detail="Пустой файл")
    MAX = 50 * 1024 * 1024
    if len(raw) > MAX:
        raise HTTPException(413, detail="Файл больше 50 МБ")

    content_type = file.content_type or "application/octet-stream"
    if not is_image(content_type):
        raise HTTPException(400, detail="Можно загружать только картинки (jpg/png/webp)")
    processed, new_ct, new_ext = process_image(raw, kind, content_type)
    size = len(processed)

    key = r2_storage.build_key(
        client_id, kind, new_ext,
        event_id=None, collaborator_id=c_id, poster_type=None,
    )
    url = await r2_storage.upload_bytes(key, processed, new_ct)

    async with db.transaction():
        await db.fetchrow(
            """INSERT INTO client_files
                 (client_id, kind, r2_key, url, size_bytes, content_type, collaborator_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
            client_id, kind, key, url, size, new_ct, c_id,
        )
        await db.execute(
            "UPDATE clients SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2",
            size, client_id,
        )

    # Сразу проставляем url в collaborators.photo_url / poster_url
    if kind == "speaker_photo":
        await db.execute("UPDATE collaborators SET photo_url = $1, updated_at = NOW() WHERE id = $2", url, c_id)
    else:
        await db.execute("UPDATE collaborators SET poster_url = $1, updated_at = NOW() WHERE id = $2", url, c_id)

    return {"url": url, "kind": kind}
