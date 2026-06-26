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
                  cse.gift_lead_magnet_id, cse.gift_package_id,
                  c.linked_client_id,
                  (SELECT lc.email FROM clients lc WHERE lc.id = c.linked_client_id) AS linked_client_email,
                  cse.knowledge_base_title, cse.knowledge_base_url,
                  cse.show_topic_field, cse.show_gift_after_speech_field,
                  cse.show_knowledge_base_field,
                  cse.bot_in_channel,
                  c.id AS collaborator_id, c.name, c.title, c.achievements,
                  c.photo_url,
                  (SELECT url FROM collaborator_posters cp
                     WHERE cp.collaborator_id = c.id
                     ORDER BY cp.sort_order, cp.id
                     LIMIT 1) AS poster_url,
                  c.photo_folder_url, c.video_folder_url,
                  c.video_url AS speaker_video_url,
                  c.tg_channel_url, c.vk_url, c.max_url, c.instagram_url, c.website_url,
                  c.tg_channel_id, c.media_assets, c.assistant_tg_username,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username AS personal_tg_username,
                  pu_vk.platform_user_id AS personal_vk_id,
                  pu_vk.username AS personal_vk_username,
                  pu_max.platform_user_id AS personal_max_id,
                  pu_max.username AS personal_max_username,
                  (pu_tg.id IS NOT NULL)  AS tg_locked,
                  (pu_vk.id IS NOT NULL)  AS vk_locked,
                  (pu_max.id IS NOT NULL) AS max_locked,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = ctc.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email,
                  ctc.phone, ctc.ref_code,
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
    # media_assets (JSONB) — asyncpg отдаёт строкой, парсим в list
    import json as _json
    ma = d.get("media_assets")
    if isinstance(ma, str):
        try:
            d["media_assets"] = _json.loads(ma)
        except (ValueError, TypeError):
            d["media_assets"] = []
    elif ma is None:
        d["media_assets"] = []
    # Нужна ли проверка подписки на канал этого спикера в Mini App.
    mode = (d.get("subscription_mode") or "none").lower()
    role = (d.get("role") or "").lower()
    d["needs_channel_check"] = (
        mode == "all_speakers"
        or (mode == "organizer" and role == "organizer")
    )
    # Партнёрские реф-ссылки на 3 платформы (если у клиента подключены) —
    # формат прямых ссылок per platform (как для лид-магнитов и шеринга события):
    # TG: t.me/{bot}?start=ref_pg{slug}_pid{ref_code}
    # VK: vk.com/app{vk_app_id}#ref_pg{slug}_pid{ref_code}  (через Mini App)
    # MAX: max.ru/{handle}?startapp=ref_pg{slug}_pid{ref_code}
    try:
        from app.services.share_links import build_share_links, resolve_event_link_mode
        # Узнаём client_id коллаба
        coll_client_id = await db.fetchval(
            "SELECT created_by_client_id FROM collaborators WHERE id = $1",
            d.get("collaborator_id"),
        )
        if coll_client_id and d.get("event_slug") and d.get("ref_code"):
            _ev_lm = await db.fetchval(
                "SELECT link_mode FROM events WHERE slug = $1", d["event_slug"]
            )
            _lm = await resolve_event_link_mode(db, client_id=int(coll_client_id), event_link_mode=_ev_lm)
            d["ref_links"] = await build_share_links(
                db,
                client_id=int(coll_client_id),
                event_slug=d["event_slug"],
                partner_id=d["ref_code"],
                link_mode=_lm,
            )
        else:
            d["ref_links"] = {}
    except Exception:
        d["ref_links"] = {}

    # Выбранный лид-магнит/пакет как «подарок после эфира» — название для UI.
    d["gift_lead_magnet"] = None
    if d.get("gift_lead_magnet_id"):
        nm = await db.fetchval("SELECT name FROM lead_magnets WHERE id = $1", d["gift_lead_magnet_id"])
        if nm:
            d["gift_lead_magnet"] = {"kind": "magnet", "id": d["gift_lead_magnet_id"], "name": nm}
    elif d.get("gift_package_id"):
        nm = await db.fetchval("SELECT name FROM lead_magnet_packages WHERE id = $1", d["gift_package_id"])
        if nm:
            d["gift_lead_magnet"] = {"kind": "package", "id": d["gift_package_id"], "name": nm}
    return d


class CabinetUpdate(BaseModel):
    # Профиль (collaborators)
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    # poster_url убран миграцией 121 — афиши теперь в библиотеке (collaborator_posters).
    # Спикер видит свою библиотеку в Материалах и может скачать любую афишу.
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    # TG-ник ассистента, который может редактировать профиль (по ссылке
    # саморедактирования / spkinv). Спикер вписывает сам в кабинете.
    assistant_tg_username: Optional[str] = None
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
    # Медийные активы — массив {platform, subscribers} (миграция 111)
    media_assets: Optional[List[dict]] = None
    # Выступление (event_collaborators)
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    knowledge_base_title: Optional[str] = None
    knowledge_base_url: Optional[str] = None
    # Подарок-лид-магнит из ПЛЮСОН-аккаунта спикера (миграция 167).
    # Передаётся {gift_lead_magnet_id} ИЛИ {gift_package_id}; чтобы снять —
    # передать gift_lead_magnet_id=0 (обнуляет обе привязки).
    gift_lead_magnet_id: Optional[int] = None
    gift_package_id: Optional[int] = None


@router.patch("/me", summary="Сохранить правки спикера")
async def patch_me(
    data: CabinetUpdate,
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    from app.api.collaborators import _upsert_personal_identities, _normalize_media_assets
    import json as _json

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
    profile_fields = ["name", "title", "achievements", "photo_url",
                      "photo_folder_url", "video_folder_url",
                      "tg_channel_url", "vk_url", "max_url",
                      "instagram_url", "website_url", "tg_channel_id"]
    upd = {f: getattr(data, f) for f in profile_fields if getattr(data, f) is not None}
    # photo_url можно ОБНУЛИТЬ (спикер нажал «Удалить»): если поле явно
    # передано как null — пишем NULL, иначе фильтр выше его пропускает.
    if "photo_url" in data.model_fields_set and data.photo_url is None:
        upd["photo_url"] = None
    # Ник ассистента — нормализуем (срезаем @ и пробелы); пустая строка → NULL.
    if data.assistant_tg_username is not None:
        upd["assistant_tg_username"] = (data.assistant_tg_username or "").lstrip("@").strip() or None
    media_assets_in = _normalize_media_assets(data.media_assets)
    if upd or media_assets_in is not None:
        parts = [f"{k} = ${i+2}" for i, k in enumerate(upd.keys())]
        vals = list(upd.values())
        if media_assets_in is not None:
            parts.append(f"media_assets = ${len(vals)+2}::jsonb")
            vals.append(_json.dumps(media_assets_in))
        parts.append("updated_at = NOW()")
        await db.execute(
            f"UPDATE collaborators SET {', '.join(parts)} WHERE id = $1",
            c_id, *vals
        )

    # 2. Контакт (contacts) — только phone. Email живёт как идентичность
    #    (platform_users), синхронизируется ниже, в contacts.email НЕ пишем.
    if contact_id:
        if data.phone is not None:
            phone_raw = (data.phone or "").strip()
            phone_norm = "".join(ch for ch in phone_raw if ch.isdigit()) or None
            if phone_norm and phone_norm.startswith("8") and len(phone_norm) == 11:
                phone_norm = "+7" + phone_norm[1:]
            await db.execute(
                "UPDATE contacts SET phone = $2, phone_normalized = $3, updated_at = NOW() WHERE id = $1",
                contact_id, phone_raw or None, phone_norm,
            )
        if data.email is not None:
            from app.services.contact_merge import (
                sync_email_identity_and_subscription, normalize_email as _ne,
            )
            em_norm = _ne(data.email)
            if em_norm:
                cl_id = await db.fetchval("SELECT client_id FROM contacts WHERE id = $1", contact_id)
                await sync_email_identity_and_subscription(
                    db, client_id=cl_id, contact_id=contact_id, email=em_norm, first_name=None,
                )
            else:
                await db.execute(
                    "DELETE FROM platform_users WHERE contact_id = $1 AND platform_slug = 'email'",
                    contact_id,
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

    # 5b. Подарок-лид-магнит из ПЛЮСОН (миграция 167). Привязка валидируется:
    # выбранный магнит/пакет должен принадлежать linked_client_id спикера.
    # gift_lead_magnet_id=0 (или package=0) → снять обе привязки.
    if data.gift_lead_magnet_id is not None or data.gift_package_id is not None:
        linked = await db.fetchval(
            "SELECT linked_client_id FROM collaborators WHERE id = $1", c_id
        )
        lm_id = data.gift_lead_magnet_id
        pkg_id = data.gift_package_id
        if (lm_id or 0) <= 0 and (pkg_id or 0) <= 0:
            # снять привязку
            await db.execute(
                "UPDATE event_collaborators SET gift_lead_magnet_id = NULL, gift_package_id = NULL WHERE id = $1",
                se_id,
            )
        elif lm_id and lm_id > 0:
            ok = await db.fetchval(
                "SELECT 1 FROM lead_magnets WHERE id = $1 AND client_id = $2", lm_id, linked
            )
            if not ok:
                raise HTTPException(status_code=400, detail="Лид-магнит не найден в вашем ПЛЮСОН-аккаунте")
            await db.execute(
                "UPDATE event_collaborators SET gift_lead_magnet_id = $2, gift_package_id = NULL WHERE id = $1",
                se_id, lm_id,
            )
        elif pkg_id and pkg_id > 0:
            ok = await db.fetchval(
                "SELECT 1 FROM lead_magnet_packages WHERE id = $1 AND client_id = $2", pkg_id, linked
            )
            if not ok:
                raise HTTPException(status_code=400, detail="Пакет не найден в вашем ПЛЮСОН-аккаунте")
            await db.execute(
                "UPDATE event_collaborators SET gift_package_id = $2, gift_lead_magnet_id = NULL WHERE id = $1",
                se_id, pkg_id,
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
    if kind != "speaker_photo":
        # speaker_poster через cabinet больше не загружается: афиши — это
        # библиотека (collaborator_posters), управляется клиентом из дашборда.
        raise HTTPException(400, detail="kind must be 'speaker_photo'")
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

    # Сразу проставляем url в collaborators.photo_url
    await db.execute(
        "UPDATE collaborators SET photo_url = $1, updated_at = NOW() WHERE id = $2",
        url, c_id,
    )

    return {"url": url, "kind": kind}


# ──────────────────────────────────────────────
# МАТЕРИАЛЫ ДЛЯ ВКЛАДКИ «МАТЕРИАЛЫ» В КАБИНЕТЕ СПИКЕРА
# (миграция 112 — event_announcement_texts)
#
# Возвращает:
#   - афиши события (event_posters, read-only)
#   - тексты-анонсы события (event_announcement_texts) + словарь подстановки
#     плейсхолдеров {link}/{event}/{date}/{brand}
#   - реф-ссылки спикера на 3 платформы (TG/VK/MAX) — дублируются из get_me,
#     но логически живут здесь
#   - партнёрская ссылка на регистрацию: prtp_<first_referrer_contact_id>
#     если у спикера есть рефовод; иначе корневая prtc_<client_id>.
#     Только если у клиента настроен partner_landing_url.
# ──────────────────────────────────────────────

PLUSON_TG_HANDLE = "pluson_bot"


def _format_event_date_msk(start_at) -> str:
    """`start_at` (asyncpg TIMESTAMPTZ) → строка «DD.MM.YYYY HH:MM МСК»."""
    if not start_at:
        return ""
    msk = start_at.astimezone(timezone(timedelta(hours=3)))
    return msk.strftime("%d.%m.%Y %H:%M") + " МСК"


@router.get("/me/materials", summary="Афиши + тексты-анонсы + ссылки для спикера")
async def get_me_materials(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    se_id = int(session["se_id"])
    c_id  = int(session["c_id"])
    e_id  = int(session["e_id"])

    # Базовые поля события + клиента + контакта-спикера + личная афиша
    # (per-event приоритетнее глобальной, как в Mini App / рассылках).
    base = await db.fetchrow(
        """SELECT e.id AS event_id, e.slug AS event_slug, e.title AS event_title,
                  e.start_at,
                  (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id,
                  e.link_mode,
                  e.video_url AS event_video_url,
                  COALESCE(NULLIF(cl.brand_name, ''), cl.name) AS client_brand,
                  cl.partner_landing_url, cl.partner_dashboard_url,
                  cl.partner_visible_roles,
                  ec.role AS ec_role,
                  c.contact_id,
                  c.photo_url AS speaker_photo_url,
                  ec.announcement_poster_ids,
                  ec.show_partner_registration_link,
                  (SELECT url FROM collaborator_posters cp
                     WHERE cp.id = ec.poster_id OR
                           (ec.poster_id IS NULL AND cp.collaborator_id = c.id)
                     ORDER BY (cp.id = ec.poster_id) DESC, cp.sort_order, cp.id
                     LIMIT 1) AS speaker_poster_url,
                  c.video_url AS speaker_video_url,
                  ctc.ref_code AS speaker_ref_code,
                  ctc.first_referrer_contact_id,
                  ctc.external_ref_param AS speaker_external_ref_param
             FROM event_collaborators ec
             JOIN collaborators c    ON c.id = ec.speaker_id
             JOIN events e           ON e.id = ec.event_id
             JOIN clients cl         ON cl.id = (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
        LEFT JOIN contacts ctc       ON ctc.id = c.contact_id
            WHERE ec.id = $1 AND ec.event_id = $2 AND c.id = $3""",
        se_id, e_id, c_id,
    )
    if not base:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    # Афиши «для анонсов» в этом событии (миграция 122) — те, что клиент
    # отметил на странице спикера конференции. Спикер увидит их в своём
    # кабинете в секции «Афиши для анонсов» и скачает для распространения.
    announcement_ids = list(base.get("announcement_poster_ids") or [])
    if announcement_ids:
        announcement_posters = await db.fetch(
            """SELECT id, url, label, sort_order
                 FROM collaborator_posters
                WHERE id = ANY($1::int[]) AND collaborator_id = $2
                ORDER BY sort_order, id""",
            announcement_ids, c_id,
        )
    else:
        announcement_posters = []

    # Афиши события (упорядочены: horizontal → vertical → square)
    posters = await db.fetch(
        """SELECT id, url, orientation, sort
             FROM event_posters
            WHERE event_id = $1
            ORDER BY CASE orientation
                       WHEN 'horizontal' THEN 1
                       WHEN 'vertical'   THEN 2
                       WHEN 'square'     THEN 3
                       ELSE 4
                     END, sort, id""",
        e_id,
    )

    # Тексты-анонсы
    texts = await db.fetch(
        """SELECT id, content, sort
             FROM event_announcement_texts
            WHERE event_id = $1
            ORDER BY sort, id""",
        e_id,
    )

    # Реф-ссылки спикера (та же логика, что в get_me)
    from app.services.share_links import build_share_links, resolve_event_link_mode
    _base_lm = await resolve_event_link_mode(db, client_id=int(base["client_id"]), event_link_mode=base["link_mode"])
    try:
        ref_links = await build_share_links(
            db,
            client_id=int(base["client_id"]),
            event_slug=base["event_slug"],
            partner_id=base["speaker_ref_code"],
            link_mode=_base_lm,
        ) if base.get("speaker_ref_code") else {}
    except Exception:
        ref_links = {}

    # Партнёрская ссылка спикера. Если у спикера есть first_referrer_contact_id
    # → prtp_<id рефовода>; иначе корневая prtc_<client_id>. Платформы — те,
    # где у клиента есть подключённый канал (TG fallback на @pluson_bot).
    # Тогл «Показывать ссылку на регистрацию партнёром» (миграция 123).
    # Если клиент выключил для этого спикера — партнёрский блок не
    # отдаём, как будто фича не настроена.
    show_partner_link = bool(base.get("show_partner_registration_link", True))

    # Роль спикера должна входить в partner_visible_roles клиента (кому показывать).
    # Раскрытие: headliner→speaker, general_partner→partner.
    _ec_role = (base.get("ec_role") or "").lower()
    _role_group = {
        "speaker": "speaker", "headliner": "speaker",
        "jury": "jury", "organizer": "organizer", "participant": "participant",
        "partner": "partner", "general_partner": "partner",
    }.get(_ec_role, _ec_role)
    _visible_roles = set(base.get("partner_visible_roles") or [])
    role_allows_partner = _role_group in _visible_roles

    partner_landing_configured = (
        show_partner_link and role_allows_partner
        and bool((base.get("partner_landing_url") or "").strip())
    )
    partner_link: dict = {}
    if partner_landing_configured:
        from app.services.share_links import (
            get_active_platforms, get_client_bot_handles, get_client_vk_app_id,
            _has_system_channel,
        )
        ref_cid = base.get("first_referrer_contact_id")
        client_id_int = int(base["client_id"])
        payload = f"prtp_{int(ref_cid)}" if ref_cid else f"prtc_{client_id_int}"

        platforms = set(await get_active_platforms(db, client_id_int))
        handles   = await get_client_bot_handles(db, client_id_int)
        vk_app_id = await get_client_vk_app_id(db, client_id_int)
        # Системный @pluson_bot — fallback для TG, если у клиента нет своего
        if await _has_system_channel(db, "telegram", allow_test=False):
            platforms.add("telegram")

        if "telegram" in platforms:
            tg_handle = (handles.get("telegram") or PLUSON_TG_HANDLE).lstrip("@")
            partner_link["telegram"] = f"https://t.me/{tg_handle}?start={payload}"
        if "vk" in platforms and vk_app_id:
            partner_link["vk"] = f"https://vk.com/app{vk_app_id}#{payload}"
        if "max" in platforms and handles.get("max"):
            partner_link["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?start={payload}"

    # Словарь подстановок для плейсхолдеров {link}/{event}/{date}/{brand}.
    # {link} = ref_links.telegram || .vk || .max (берём первый доступный).
    link_default = ref_links.get("telegram") or ref_links.get("vk") or ref_links.get("max") or ""
    placeholders = {
        "link":  link_default,
        "event": base["event_title"] or "",
        "date":  _format_event_date_msk(base.get("start_at")),
        "brand": base["client_brand"] or "",
    }

    return {
        "event_id":     base["event_id"],
        "event_slug":   base["event_slug"],
        "event_title":  base["event_title"],
        "posters":      [dict(r) for r in posters],
        # Фото профиля коллаба (collaborators.photo_url) — «Фото для сайта»
        # в кабинете спикера. На лендинге и в Mini App используется именно оно.
        "photo_url":         base.get("speaker_photo_url"),
        # Афиша помеченная «для рассылок» (radio) в этой конференции —
        # одна. NULL → fallback на первую из библиотеки.
        "broadcast_poster_url": base.get("speaker_poster_url"),
        "speaker_poster_url":   base.get("speaker_poster_url"),  # alias, обратная совместимость
        # Афиши помеченные «для анонсов» (чек-бокс) в этой конференции —
        # массив. Спикер скачивает любую для своих анонсов.
        "announcement_posters": [dict(r) for r in announcement_posters],
        "event_video_url":    base.get("event_video_url"),
        "speaker_video_url":  base.get("speaker_video_url"),
        "announcement_texts": [dict(r) for r in texts],
        "ref_links":    ref_links,
        "partner_link": partner_link,
        "partner_landing_configured": partner_landing_configured,
        # Партнёрский код самого спикера во внешней системе клиента
        # (contacts.external_ref_param). Если есть — кабинет спикера показывает
        # «Вы уже партнёр, ваш код X» вместо ссылок на регистрацию.
        # Скрываем целиком если клиент выключил show_partner_registration_link (миграция 123).
        # Весь партнёрский блок (и «вы уже партнёр», и регистрация, и кабинет/
        # оплаты) управляется роль-фильтром partner_visible_roles. Если роль
        # человека не отмечена галочкой — блок не показываем вообще.
        "speaker_external_ref_param": (
            (base.get("speaker_external_ref_param") or "").strip() or None
        ) if (show_partner_link and role_allows_partner) else None,
        "partner_dashboard_url": (
            (base.get("partner_dashboard_url") or "").strip() or None
        ) if (show_partner_link and role_allows_partner) else None,
        "placeholders": placeholders,
    }


@router.get("/me/invited", summary="Приглашённые спикером люди + его реф-статистика")
async def get_me_invited(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Личная реф-статистика спикера/жюри по этому событию: кого он привёл.

    Считаем по contacts.ref_code спикера → event_participants.referrer_ref_code.
    Возвращает счётчики (зашло/зарегано/в чате) + список людей с платформенной
    идентичностью для перехода в их аккаунт.
    """
    event_id = int(session["e_id"])
    collaborator_id = int(session["c_id"])
    # ref_code спикера (через его контакт).
    ref_code = await db.fetchval(
        """SELECT c.ref_code FROM collaborators co
             JOIN contacts c ON c.id = co.contact_id
            WHERE co.id = $1 LIMIT 1""",
        collaborator_id,
    )
    if not ref_code:
        return {"ref_code": None, "entered": 0, "registered": 0, "in_chat": 0, "people": []}

    entered = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE event_id = $1 AND referrer_ref_code = $2",
        event_id, ref_code,
    ) or 0
    registered = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE event_id = $1 AND referrer_ref_code = $2 AND is_registered = TRUE",
        event_id, ref_code,
    ) or 0
    in_chat = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE event_id = $1 AND referrer_ref_code = $2 AND is_in_chat = TRUE",
        event_id, ref_code,
    ) or 0

    rows = await db.fetch(
        """SELECT ct.name, ep.is_registered, ep.is_in_chat,
                  pu.platform_slug, pu.platform_user_id, pu.username
             FROM event_participants ep
             JOIN contacts ct ON ct.id = ep.contact_id
             LEFT JOIN LATERAL (
                 SELECT p.platform_slug, p.platform_user_id, p.username
                   FROM platform_users p
                  WHERE p.contact_id = ct.id
                  ORDER BY CASE p.platform_slug
                             WHEN 'telegram' THEN 1 WHEN 'vk' THEN 2
                             WHEN 'max' THEN 3 WHEN 'email' THEN 4 ELSE 5 END, p.id
                  LIMIT 1
             ) pu ON TRUE
            WHERE ep.event_id = $1 AND ep.referrer_ref_code = $2
            ORDER BY ep.is_registered DESC, ep.id DESC
            LIMIT 500""",
        event_id, ref_code,
    )

    def _account_url(slug, pid, uname):
        """Прямая ссылка на аккаунт человека в его площадке."""
        if not pid:
            return None
        u = (uname or "").lstrip("@")
        if slug == "telegram":
            return f"https://t.me/{u}" if u else None
        if slug == "vk":
            return f"https://vk.com/id{pid}" if str(pid).isdigit() else (f"https://vk.com/{u}" if u else None)
        if slug == "max":
            return f"https://max.ru/u/{pid}" if pid and not str(pid).startswith("@") else None
        return None

    people = [{
        "name": r["name"] or "Без имени",
        "is_registered": bool(r["is_registered"]),
        "is_in_chat": bool(r["is_in_chat"]),
        "platform_slug": r["platform_slug"],
        "username": r["username"],
        "account_url": _account_url(r["platform_slug"], r["platform_user_id"], r["username"]),
    } for r in rows]

    return {
        "ref_code": ref_code,
        "entered": entered,
        "registered": registered,
        "in_chat": in_chat,
        "people": people,
    }


# ════════════════ Привязка ПЛЮСОН-аккаунта спикера (миграция 167) ════════════════
# Спикеры чемпионата становятся клиентами ПЛЮСОН. Из своего кабинета спикер
# подключает свой ПЛЮСОН-аккаунт (вход или регистрация прямо здесь) — связка
# пишется в collaborators.linked_client_id. После этого он выбирает СВОЙ
# лид-магнит/пакет как «подарок после эфира», и турнирный критерий считает
# по нему переходы (funnel_runs).

class LinkPlusonIn(BaseModel):
    email: str
    password: str


@router.post("/me/link-pluson", summary="Подключить существующий ПЛЮСОН-аккаунт спикера")
async def link_pluson(
    data: LinkPlusonIn,
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    from app.auth import verify_password
    c_id = int(session["c_id"])
    email = (data.email or "").strip().lower()

    client = await db.fetchrow(
        "SELECT id, name, email, password_hash, is_active FROM clients WHERE LOWER(email) = $1",
        email,
    )
    if not client or not verify_password(data.password, client["password_hash"]):
        raise HTTPException(status_code=401, detail="Неверный email или пароль ПЛЮСОН")
    if not client["is_active"]:
        raise HTTPException(status_code=403, detail="Этот ПЛЮСОН-аккаунт заблокирован")

    await db.execute(
        "UPDATE collaborators SET linked_client_id = $2, updated_at = NOW() WHERE id = $1",
        c_id, client["id"],
    )
    return {"ok": True, "linked_client_id": client["id"], "linked_client_email": client["email"]}


@router.post("/me/register-pluson", summary="Зарегистрировать новый ПЛЮСОН-аккаунт и привязать")
async def register_pluson(
    data: LinkPlusonIn,
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Создаёт новый кабинет ПЛЮСОН (тариф trial) и сразу привязывает к спикеру.
    Имя берём из карточки коллаба."""
    from app.api.auth import register as auth_register, RegisterRequest
    c_id = int(session["c_id"])
    email = (data.email or "").strip().lower()

    exists = await db.fetchval("SELECT 1 FROM clients WHERE LOWER(email) = $1", email)
    if exists:
        raise HTTPException(status_code=409, detail="Этот email уже зарегистрирован — войдите вместо регистрации")

    coll = await db.fetchrow("SELECT name FROM collaborators WHERE id = $1", c_id)
    name = (coll["name"] if coll else None) or "Спикер"

    # Переиспользуем штатную регистрацию (trial, реф-код, подписка и т.п.)
    res = await auth_register(
        RegisterRequest(name=name, email=email, password=data.password),
        db,
    )
    new_client_id = res["client"]["id"] if isinstance(res, dict) and res.get("client") else None
    if not new_client_id:
        raise HTTPException(status_code=500, detail="Не удалось создать ПЛЮСОН-аккаунт")

    await db.execute(
        "UPDATE collaborators SET linked_client_id = $2, updated_at = NOW() WHERE id = $1",
        c_id, new_client_id,
    )
    return {"ok": True, "linked_client_id": new_client_id, "linked_client_email": email}


@router.post("/me/unlink-pluson", summary="Отвязать ПЛЮСОН-аккаунт")
async def unlink_pluson(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    c_id = int(session["c_id"])
    await db.execute(
        "UPDATE collaborators SET linked_client_id = NULL, updated_at = NOW() WHERE id = $1",
        c_id,
    )
    # снимаем и выбранный подарок-магнит на этом событии
    se_id = int(session["se_id"])
    await db.execute(
        "UPDATE event_collaborators SET gift_lead_magnet_id = NULL, gift_package_id = NULL WHERE id = $1",
        se_id,
    )
    return {"ok": True}


@router.get("/me/my-lead-magnets", summary="Лид-магниты и пакеты привязанного ПЛЮСОН-аккаунта")
async def my_lead_magnets(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    c_id = int(session["c_id"])
    linked = await db.fetchval("SELECT linked_client_id FROM collaborators WHERE id = $1", c_id)
    if not linked:
        return {"linked": False, "magnets": [], "packages": []}

    magnets = await db.fetch(
        "SELECT id, name, slug FROM lead_magnets WHERE client_id = $1 ORDER BY id DESC", linked
    )
    packages = await db.fetch(
        "SELECT id, name, slug FROM lead_magnet_packages WHERE client_id = $1 ORDER BY id DESC", linked
    )
    return {
        "linked": True,
        "magnets": [{"id": m["id"], "name": m["name"], "slug": m["slug"]} for m in magnets],
        "packages": [{"id": p["id"], "name": p["name"], "slug": p["slug"]} for p in packages],
    }
