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
import re
import logging
import asyncpg
import jwt

from app.config import settings

logger = logging.getLogger(__name__)
from app.database import get_db
from app.services import r2_storage
from app.services.image_processor import process_image, is_image
from app.services.support_message import support_block_for_event
# ⚠️ На уровне модуля: хелпер _resolve_landing_link зовётся из нескольких
# функций, локальный импорт внутри одной из них ему недоступен.
from app.services.client_domains import public_url_for, client_public_link
from app.services.speaker_lead_magnet_stats import speaker_lead_magnet_stats
# Порядок слов в имени: список выбора себя и занятые слоты — «Фамилия Имя»
# (там ИЩУТ), профиль спикера — «Имя Фамилия» (там ПОКАЗЫВАЮТ).
from app.services.person_name import (
    display_name, search_name, SEARCH_NAME_ORDER_SQL, SEARCH_NAME_SQL,
)
from app.services.share_links import TG_DOMAIN

# Лимиты длины полей, которые заполняет сам спикер. Держать в синхроне с
# фронтом ([event_slug]/page.tsx) — иначе счётчик покажет одно, а сохранение
# откажет по другому правилу.
TOPIC_LIMIT = 190
TOPIC_DESC_LIMIT = 400
GIFT_TITLE_LIMIT = 380
GIFT_URL_LIMIT = 140
# Позиционирование и регалии — по реальным данным (замер 22.08.2026):
# медиана позиционирования 50 символов, регалий 465. В поля писали офферы и
# целые лендинги (у одного клиента 5922 символа с кейсами и призывами).
POSITIONING_LIMIT = 140
# ⚠️ Лимит регалий — НАСТРОЙКА КЛИЕНТА (миграция 420), а не константа: читаем
# его через общий хелпер. Прежнее число осталось умолчанием платформы.
from app.services.field_limits import (  # noqa: E402
    ACHIEVEMENTS_LIMIT_DEFAULT, achievements_limit,
)
# ⚠️ Единая точка правды про выбор афиши спикера (event_photo.py).
from app.services.event_photo import poster_subquery  # noqa: E402

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


# ⚠️ Угадывание «имя = первое слово» УДАЛЕНО (миграция 302).
# Оно врало на записях «Фамилия Имя» и противоречило турниру, который тем же
# приёмом считал первое слово ФАМИЛИЕЙ. Теперь имя и фамилия — отдельные поля.


@router.get("/{event_slug}/speakers", summary="Список фамилий спикеров события (публично)")
async def list_speakers_for_login(event_slug: str, db: asyncpg.Connection = Depends(get_db)):
    """Отдаёт только id+фамилия+имя — достаточно для выбора в выпадающем списке.
    Без access_code в ответе — это публичный endpoint."""
    # person_wording нужен ДО входа: заголовок экрана — «Кабинет номинанта»
    # в премии, «Кабинет спикера» на конференции.
    ev = await db.fetchrow(
        "SELECT id, title, person_wording FROM events WHERE slug = $1", event_slug
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    # ⚠️ Тема и логотип нужны ДО входа: экран авторизации открывается по ссылке
    # от организатора и на ЕГО домене, а красился фирменными цветами ПЛЮСОНа —
    # человек попадал на чужой по виду сайт и не понимал, туда ли пришёл.
    # Поля те же, что кабинет берёт после входа (`/me`), чтобы вид не менялся
    # на глазах при входе.
    #
    # ⚠️ Владелец события — через `event_owners` (у `events` своего client_id
    # нет). Сбой чтения темы не должен ронять сам вход: список фамилий важнее
    # оформления, поэтому всё в try.
    brand: dict = {}
    try:
        own = await db.fetchrow(
            """SELECT cl.brand_logo_url, cl.brand_logo_light_url,
                      COALESCE(NULLIF(cl.brand_name,''), cl.name) AS brand_name,
                      cl.lp_bg_color, cl.lp_bg_color_2, cl.lp_bg_angle,
                      cl.lp_color_heading, cl.lp_color_body
                 FROM event_owners eo JOIN clients cl ON cl.id = eo.client_id
                WHERE eo.event_id = $1 AND eo.status = 'accepted'
                ORDER BY eo.id LIMIT 1""",
            ev["id"],
        )
        if own:
            brand = dict(own)
    except Exception:  # noqa: BLE001
        brand = {}
    rows = await db.fetch(
        f"""SELECT cse.id AS speaker_event_id, c.id AS collaborator_id,
                  c.name, c.last_name
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
            WHERE cse.event_id = $1
            ORDER BY {SEARCH_NAME_ORDER_SQL('c')}""",
        ev["id"]
    )
    # Спикер ищет СЕБЯ в списке — значит «Фамилия Имя» (список поиска).
    items = []
    for r in rows:
        items.append({
            "speaker_event_id": r["speaker_event_id"],
            "collaborator_id": r["collaborator_id"],
            "first_name": r["name"] or "",
            "last_name": r["last_name"] or "",
            "full_name": search_name(r["name"], r["last_name"]),
        })
    return {
        "event_id": ev["id"],
        "event_slug": event_slug,
        "event_title": ev["title"],
        "person_wording": ev["person_wording"] or "speaker",
        "speakers": items,
        **brand,
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


def _card_link_for_self(link: Optional[str], contact_id) -> Optional[str]:
    """Личная ссылка спикера на СВОЮ карточку — с `c={contact_id}`.

    ⚠️ Витрина события в браузере опознаёт пришедшего ТОЛЬКО по `?c=`
    (`platform=contact`): без него человек для неё посторонний, и открывший
    свою же карточку номинант упирался в форму регистрации.

    ⚠️ В РАССЫЛКАХ этот параметр ставить нельзя — там та же ссылка уходит
    многим, и каждый получатель открыл бы витрину под личностью спикера.
    Поэтому правка живёт здесь, в кабинете, а не в `speaker_card_link`.

    Ссылку на Mini App не трогаем: там человек опознаётся по своему аккаунту.
    """
    if not link or not contact_id:
        return link
    if "t.me/" in link or "telegram.me/" in link:
        return link
    sep = "&" if "?" in link else "?"
    return f"{link}{sep}c={contact_id}"


def _auth_session(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Нет токена сессии")
    token = authorization.split(" ", 1)[1].strip()
    return _decode(token)


async def _auth_session_write(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
) -> dict:
    """Сессия спикера для действий, которые СОХРАНЯЮТ данные.

    Если у организатора не подключён модуль события — сохранение блокируется
    (module_access.BLOCKED_EXTERNAL_MSG). Просмотр кабинета при этом остаётся:
    спикер видит свою карточку и материалы, просто не может их менять.

    ⚠️ Вход в кабинет (`/auth`) НЕ блокируем — иначе человек упрётся в отказ
    на логине и не увидит объяснения, что происходит.
    """
    from app.services.module_access import assert_module_write_by_event
    await assert_module_write_by_event(db, event_id=int(session["e_id"]))
    return session


async def _sync_gift_magnet_list_from_legacy(db: asyncpg.Connection, ec_id: int):
    """Синхронизировать список event_collaborator_lead_magnets с одиночной legacy-
    привязкой event_collaborators.gift_lead_magnet_id/gift_package_id. Нужен когда
    старый клиент шлёт только legacy-поля (без gift_lead_magnets) — чтобы список
    (который читают критерий/рассылка/страница) не рассинхронился с одиночным полем."""
    link = await db.fetchrow(
        "SELECT gift_lead_magnet_id, gift_package_id FROM event_collaborators WHERE id = $1", ec_id
    )
    # ⚠️ Стираем ТОЛЬКО плюсоновские записи. Ручные подарки (manual_title) —
    # это подарки, заведённые организатором/спикером вручную; они больше нигде
    # не дублируются (колонки gift_after_speech_* удалены 2026-07-30), снести их
    # тут значило бы потерять подарок совсем.
    await db.execute(
        "DELETE FROM event_collaborator_lead_magnets "
        " WHERE ec_id = $1 AND manual_title IS NULL", ec_id)
    if not link:
        return
    if link["gift_lead_magnet_id"]:
        await db.execute(
            "INSERT INTO event_collaborator_lead_magnets (ec_id, lead_magnet_id, sort_order) VALUES ($1, $2, 0)",
            ec_id, link["gift_lead_magnet_id"],
        )
    elif link["gift_package_id"]:
        await db.execute(
            "INSERT INTO event_collaborator_lead_magnets (ec_id, package_id, sort_order) VALUES ($1, $2, 0)",
            ec_id, link["gift_package_id"],
        )


@router.get("/me", summary="Профиль спикера (после авторизации)")
async def get_me(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    se_id = int(session["se_id"])
    row = await db.fetchrow(
        """SELECT cse.id AS speaker_event_id, cse.event_id, cse.role,
                  cse.speaker_topic, (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.gift_lead_magnet_id, cse.gift_package_id,
                  c.linked_client_id,
                  (SELECT lc.email FROM clients lc WHERE lc.id = c.linked_client_id) AS linked_client_email,
                  cse.knowledge_base_title, cse.knowledge_base_url,
                  cse.notes,
                  cse.show_topic_field, cse.show_gift_after_speech_field,
                  cse.show_knowledge_base_field, cse.show_notes_field,
                  c.ask_topics, c.show_ask_topics_field,
                  cse.bot_in_channel,
                  (SELECT person_wording FROM events WHERE id = cse.event_id) AS person_wording,
                  c.id AS collaborator_id, c.name, c.last_name, c.title, c.achievements,
                  c.photo_url,
                  -- Кадрирование фото (мигр. 434, 451): спикер правит его сам.
                  c.photo_focal, c.crop_zoom_circle, c.crop_zoom_square,
                  c.crop_zoom_portrait, c.crop_dx_circle, c.crop_dy_circle,
                  c.crop_dx_square, c.crop_dy_square, c.crop_dx_portrait,
                  c.crop_dy_portrait, c.is_company, c.logo_on_light_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  -- Заодно уважаем per-event выбор афиши (cse.poster_id).
                  %(poster_sql_cse)s AS poster_url,
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
                  ctc.phone, ctc.ref_code, ctc.id AS my_contact_id,
                  e.title AS event_title, e.slug AS event_slug,
                  -- Логотип и бренд организатора: спикер открывает кабинет по
                  -- ссылке из письма и должен сразу видеть, чьё это событие.
                  own.brand_logo_url AS client_logo,
                  own.brand_logo_light_url AS client_logo_light,
                  COALESCE(NULLIF(own.brand_name,''), own.name) AS client_brand,
                  own.lp_bg_color, own.lp_bg_color_2, own.lp_bg_angle,
                  own.lp_color_heading, own.lp_color_body,
                  -- Для ссылок «посмотреть себя» в шапке профиля (см. ниже).
                  e.landing_url,
                  -- ⚠️ Режим ДЛЯ TELEGRAM: карточка спикера открывается
                  -- телеграм-ссылкой. «Общего режима» больше нет (мигр. 477–478).
                  own.tg_link_mode,
                  -- Сколько символов клиент разрешил в регалиях (миграция 420).
                  -- ⚠️ Отдаём спикеру, чтобы счётчик в поле показывал ровно то,
                  -- по чему потом откажет сохранение.
                  own.speaker_achievements_limit,
                  (SELECT ch.handle FROM client_channels ccx
                     JOIN channels ch ON ch.id = ccx.channel_id
                    WHERE ccx.client_id = own.id AND ch.platform_slug = 'telegram'
                      AND COALESCE(ch.bot_token,'') <> ''
                    ORDER BY ccx.is_active DESC, ccx.id LIMIT 1) AS bot_handle,
                  ers.is_enabled AS raffle_enabled,
                  cc.subscription_mode
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             JOIN events e ON e.id = cse.event_id
             -- Владелец события: у events своего client_id нет (event_owners).
             LEFT JOIN LATERAL (
               -- ⚠️ Поля перечислены ЯВНО: снаружи own.* не работает, колонку
               -- надо добавлять и сюда, иначе «column own.X does not exist».
               SELECT cl.id, COALESCE(cl.link_mode_telegram, 'bot') AS tg_link_mode,
                      cl.brand_logo_url, cl.brand_logo_light_url,
                      cl.brand_name, cl.name, cl.speaker_achievements_limit,
                      -- Тема кабинета: те же цвета, что клиент задал в
                      -- «Стилях лендингов». Без них кабинет у всех выглядел
                      -- одинаково — в фирменных цветах ПЛЮСОНа, а не клиента.
                      cl.lp_bg_color, cl.lp_bg_color_2, cl.lp_bg_angle,
                      cl.lp_color_heading, cl.lp_color_body
                 FROM event_owners eo JOIN clients cl ON cl.id = eo.client_id
                WHERE eo.event_id = e.id AND eo.status = 'accepted'
                ORDER BY eo.id LIMIT 1
             ) own ON TRUE
             LEFT JOIN contacts ctc ON ctc.id = c.contact_id
             LEFT JOIN platform_users pu_tg
               ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
             LEFT JOIN platform_users pu_vk
               ON pu_vk.contact_id = c.contact_id AND pu_vk.platform_slug = 'vk'
             LEFT JOIN platform_users pu_max
               ON pu_max.contact_id = c.contact_id AND pu_max.platform_slug = 'max'
             LEFT JOIN event_raffle_settings ers ON ers.event_id = cse.event_id
             LEFT JOIN conf_conferences cc ON cc.event_id = cse.event_id
            WHERE cse.id = $1""" % {"poster_sql_cse": poster_subquery("cse", "c")},
        se_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден (возможно, удалён)")
    topics = await db.fetch(
        "SELECT id, topic, description FROM conf_speaker_topics WHERE cse_id = $1 ORDER BY sort_order, id",
        se_id
    )
    d = dict(row)
    # ⚠️ NUMERIC из asyncpg приходит Decimal и уезжает в JSON СТРОКОЙ, а фронт
    # на приближение УМНОЖАЕТ размер фото — на строке вышел бы NaN и фото в
    # маске пропало бы. Та же ловушка уже ловила нас в афишах.
    from decimal import Decimal as _D
    for _z in ("crop_zoom_circle", "crop_zoom_square", "crop_zoom_portrait",
               "crop_dx_circle", "crop_dy_circle", "crop_dx_square",
               "crop_dy_square", "crop_dx_portrait", "crop_dy_portrait"):
        if isinstance(d.get(_z), _D):
            d[_z] = float(d[_z])
    # Пусто в настройке клиента = умолчание платформы. Подставляем ЗДЕСЬ, чтобы
    # фронт всегда получал число и не держал свою копию дефолта: разъедутся —
    # счётчик покажет одно, а сохранение откажет по другому правилу.
    d["achievements_limit"] = (
        int(d.pop("speaker_achievements_limit", None) or 0) or ACHIEVEMENTS_LIMIT_DEFAULT
    )
    # В кабинете темы — плоский список строк (индекс = позиция). Пустые заглушки
    # не показываем, поэтому индекс привязанной темы считаем ПО ЭТОМУ ЖЕ списку.
    visible = [t for t in topics if t["topic"]]
    d["topics"] = [t["topic"] for t in visible]
    # Описание темы («что будет на выступлении») — отдельным параллельным списком.
    # В программу идёт только НАЗВАНИЕ, описание — в тело рассылки и на карточку.
    d["topic_descriptions"] = [(t["description"] or "") for t in visible]
    # Какие темы реально стоят в слотах программы (conf_sessions.topic_id) —
    # их текст уходит в программу и рассылки. У спикера может быть НЕСКОЛЬКО
    # слотов (разные туры/дни), каждый со своей темой. Поэтому отдаём для
    # КАЖДОЙ темы список её слотов (дата дня + время) — чтобы в кабинете было
    # видно, какая тема к какому слоту привязана, а не одну «зелёную».
    slot_rows = await db.fetch(
        """SELECT s.topic_id,
                  s.start_time, s.end_time,
                  cd.day_number, cd.title AS day_title, cd.day_date
             FROM conf_sessions s
             LEFT JOIN conf_days cd
               ON cd.event_id = s.event_id AND cd.day_number = s.day
            WHERE s.speaker_id = $1 AND s.topic_id IS NOT NULL
            ORDER BY cd.day_date NULLS LAST, s.start_time""",
        se_id,
    )
    # topic_id -> [{day_number, day_date, start_time, end_time, day_title}]
    slots_by_topic: dict[int, list] = {}
    for sr in slot_rows:
        slots_by_topic.setdefault(sr["topic_id"], []).append({
            "day_number": sr["day_number"],
            "day_title": sr["day_title"],
            "day_date": sr["day_date"].isoformat() if sr["day_date"] else None,
            "start_time": (str(sr["start_time"])[:5] if sr["start_time"] else None),
            "end_time": (str(sr["end_time"])[:5] if sr["end_time"] else None),
        })
    # Список параллельный d["topics"]: для каждой видимой темы — её слоты (может быть []).
    d["topic_slots"] = [slots_by_topic.get(t["id"], []) for t in visible]
    # Обратная совместимость: индекс ПЕРВОЙ привязанной темы (старый фронт).
    d["bound_topic_index"] = next(
        (i for i, t in enumerate(visible) if slots_by_topic.get(t["id"])), None
    )
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
            _lm = await resolve_event_link_mode(db, client_id=int(coll_client_id))
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

    # Подарки-лид-магниты после эфира — СПИСОК до 4 (миграция 200), с порядком.
    lm_rows = await db.fetch(
        """SELECT eclm.id, eclm.lead_magnet_id, eclm.package_id, eclm.sort_order,
                  lm.name AS lm_name, lm.slug AS lm_slug,
                  lp.name AS lp_name, lp.slug AS lp_slug
             FROM event_collaborator_lead_magnets eclm
             LEFT JOIN lead_magnets lm ON lm.id = eclm.lead_magnet_id
             LEFT JOIN lead_magnet_packages lp ON lp.id = eclm.package_id
            WHERE eclm.ec_id = $1
            ORDER BY eclm.sort_order, eclm.id""",
        se_id,
    )
    gift_list = []
    for r in lm_rows:
        if r["lead_magnet_id"] and r["lm_name"]:
            gift_list.append({"kind": "magnet", "id": r["lead_magnet_id"], "name": r["lm_name"]})
        elif r["package_id"] and r["lp_name"]:
            gift_list.append({"kind": "package", "id": r["package_id"], "name": r["lp_name"]})
    d["gift_lead_magnets"] = gift_list
    # Первый — для обратной совместимости старого одиночного поля gift_lead_magnet.
    d["gift_lead_magnet"] = gift_list[0] if gift_list else None

    # Может ли спикер сохранять правки: зависит от того, подключён ли модуль
    # у организатора. Флаг нужен интерфейсу, чтобы показать плашку сразу, а не
    # после того, как человек заполнит форму и упрётся в отказ при сохранении.
    from app.services.module_access import module_write_allowed_by_event
    d["can_edit"] = await module_write_allowed_by_event(db, event_id=int(session["e_id"]))

    # Номинации, которые человек выбирает себе сам (миграция 328). Отдаём
    # всегда, когда организатор это разрешил для его роли: список номинаций
    # события, уже отмеченные и сколько всего можно.
    # ⚠️ Лимит считает СЕРВЕР (nominations_limit.effective_limit) — правило
    # «минимум из личного числа, потолка роли и общего числа номинаций»
    # повторять на фронте нельзя, разъедется.
    from app.services.nominations_limit import effective_limit, self_pick_allowed
    _ev_id = int(session["e_id"])
    d["self_pick_stages"] = await self_pick_allowed(db, _ev_id, row["role"])
    if d["self_pick_stages"]:
        d["stages"] = [dict(s) for s in await db.fetch(
            """SELECT s.id, s.title, s.subtitle,
                      (SELECT c.title FROM conf_stage_categories c
                        WHERE c.id = s.category_id) AS category_title
                 FROM conf_stages s WHERE s.event_id = $1
                ORDER BY s.sort_order, s.id""", _ev_id)]
        d["my_stage_ids"] = [r2["stage_id"] for r2 in await db.fetch(
            "SELECT stage_id FROM event_collaborator_stages WHERE ec_id = $1", se_id)]
        d["stages_limit"] = await effective_limit(
            db, event_id=_ev_id, ec_id=se_id, role=row["role"])

    # ⚠️ Ссылки «посмотреть, как я выгляжу» — прямо в шапке профиля, а не
    # только во вкладке «Материалы»: спикер заполняет карточку вслепую и не
    # понимает, что из неё увидит зритель. Считаем ТЕ ЖЕ функции, что в
    # /me/materials, — иначе адреса разъедутся между двумя экранами.
    from app.services.message_builder import event_public_base, speaker_card_link
    from app.services.client_domains import public_url_for
    # ⚠️ id события здесь — session["e_id"] (как строкой выше у can_edit),
    # переменной event_id в этой функции нет.
    _base = await event_public_base(db, int(session["e_id"]))
    d["card_link"] = _card_link_for_self(
        speaker_card_link(
            row["event_slug"], se_id, row["tg_link_mode"], row["bot_handle"],
            base_url=_base,
        ),
        row["my_contact_id"],
    ) or None
    # Пусто (не наш лендинг или он не опубликован) → отдаём None, чтобы
    # кабинет не рисовал кнопку «Как вы выглядите на лендинге».
    d["landing_link"] = await _resolve_landing_link(
        db, int(session["e_id"]), row["event_slug"], row["landing_url"], _base) or None
    return d


class CabinetUpdate(BaseModel):
    # Профиль (collaborators)
    name: Optional[str] = None
    # ⚠️ Фамилия — ОТДЕЛЬНОЕ поле (миграция 302), а не хвост в `name`.
    # Её не было в модели, хотя `profile_fields` ниже её уже перечисляет —
    # из-за этого КАЖДОЕ сохранение профиля падало 500 (AttributeError), и
    # спикер не мог поправить ни регалии, ни что-либо ещё.
    last_name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    # ⚠️ Точка лица (мигр. 434) и приближение кадра по формам (мигр. 451).
    # Спикер настраивает СЕБЯ САМ тем же компонентом, что организатор в
    # кабинете: разные экраны, один код и одни поля.
    photo_focal: Optional[str] = None
    crop_zoom_circle: Optional[float] = None
    crop_zoom_square: Optional[float] = None
    crop_zoom_portrait: Optional[float] = None
    crop_dx_circle: Optional[float] = None
    crop_dy_circle: Optional[float] = None
    crop_dx_square: Optional[float] = None
    crop_dy_square: Optional[float] = None
    crop_dx_portrait: Optional[float] = None
    crop_dy_portrait: Optional[float] = None
    # Компания и её логотип для светлого фона (мигр. 425, 450).
    is_company: Optional[bool] = None
    logo_on_light_url: Optional[str] = None
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
    # Описания тем — параллельный списку topics массив (индекс в индекс).
    topic_descriptions: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    knowledge_base_title: Optional[str] = None
    knowledge_base_url: Optional[str] = None
    # Заметки спикера (event_collaborators.notes) — если организатор включил
    # тоггл show_notes_field, спикер может редактировать своё поле «Заметки».
    notes: Optional[str] = None
    # «С какими вопросами можно обращаться?» (collaborators.ask_topics, глобально).
    # Спикер редактирует, если организатор включил show_ask_topics_field.
    ask_topics: Optional[str] = None
    # Подарок-лид-магнит из ПЛЮСОН-аккаунта спикера (миграция 167).
    # Передаётся {gift_lead_magnet_id} ИЛИ {gift_package_id}; чтобы снять —
    # передать gift_lead_magnet_id=0 (обнуляет обе привязки). Legacy-одиночный.
    gift_lead_magnet_id: Optional[int] = None
    gift_package_id: Optional[int] = None
    # Список до 4 подарков-лид-магнитов (миграция 200). Массив в нужном ПОРЯДКЕ:
    # [{"kind": "magnet"|"package", "id": N}, ...]. Пустой список [] — снять все.
    # Приоритетнее legacy-полей gift_lead_magnet_id/gift_package_id.
    gift_lead_magnets: Optional[List[dict]] = None


@router.patch("/me", summary="Сохранить правки спикера")
async def patch_me(
    data: CabinetUpdate,
    session: dict = Depends(_auth_session_write),
    db: asyncpg.Connection = Depends(get_db),
):
    from app.api.collaborators import (
        _upsert_personal_identities, _normalize_media_assets, _validate_social_links,
    )
    import json as _json

    # ⚠️ Лимиты длины дублируются на бэкенде: фронтовую проверку обходит любой,
    # кто шлёт запрос напрямую, а полотно на 400 символов ломает вёрстку
    # программы, лендинга и рассылок — там место рассчитано на название.
    # Цифры подобраны по реальным данным (замер 2026-08-21), см. фронт.
    _too_long: list[str] = []
    if data.topics is not None:
        for t in data.topics:
            if t and len(t) > TOPIC_LIMIT:
                _too_long.append(f"тема (не больше {TOPIC_LIMIT} символов)")
                break
    if data.topic_descriptions is not None:
        for d in data.topic_descriptions:
            if d and len(d) > TOPIC_DESC_LIMIT:
                _too_long.append(f"описание темы (не больше {TOPIC_DESC_LIMIT})")
                break
    if data.gift_after_speech_title and len(data.gift_after_speech_title) > GIFT_TITLE_LIMIT:
        _too_long.append(f"название подарка (не больше {GIFT_TITLE_LIMIT})")
    if data.gift_after_speech_url and len(data.gift_after_speech_url) > GIFT_URL_LIMIT:
        _too_long.append(f"ссылка на подарок (не больше {GIFT_URL_LIMIT})")
    if data.title and len(data.title) > POSITIONING_LIMIT:
        _too_long.append(f"позиционирование (не больше {POSITIONING_LIMIT})")
    if data.achievements is not None:
        # ⚠️ Лимит регалий берём У ВЛАДЕЛЬЦА карточки — это его настройка, и
        # она обязана совпадать со счётчиком, который спикер видит в поле.
        _ach_limit = await achievements_limit(db, await db.fetchval(
            "SELECT created_by_client_id FROM collaborators WHERE id = $1",
            int(session["c_id"]),
        ))
        _ach_len = len("\n".join(a for a in data.achievements if a))
        if _ach_len > _ach_limit:
            _too_long.append(f"регалии (не больше {_ach_limit} символов)")
    if _too_long:
        raise HTTPException(422, "Слишком длинно: " + ", ".join(_too_long))

    # Соцсети — только полной ссылкой (https://…), не ником (дубль фронт-проверки).
    _validate_social_links(data)

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
    profile_fields = ["name", "last_name", "title", "achievements", "photo_url",
                      # Кадрирование фото: точка лица и приближение по формам.
                      "photo_focal", "crop_zoom_circle", "crop_zoom_square",
                      "crop_zoom_portrait", "crop_dx_circle", "crop_dy_circle",
                      "crop_dx_square", "crop_dy_square", "crop_dx_portrait",
                      "crop_dy_portrait", "is_company", "logo_on_light_url",
                      "photo_folder_url", "video_folder_url",
                      "tg_channel_url", "vk_url", "max_url",
                      "instagram_url", "website_url", "tg_channel_id"]
    # getattr с дефолтом: если список выше разъедется с моделью, поле просто
    # не запишется — вместо 500 у спикера на ровном месте.
    upd = {f: getattr(data, f, None) for f in profile_fields
           if getattr(data, f, None) is not None}
    # photo_url можно ОБНУЛИТЬ (спикер нажал «Удалить»): если поле явно
    # передано как null — пишем NULL, иначе фильтр выше его пропускает.
    if "photo_url" in data.model_fields_set and data.photo_url is None:
        upd["photo_url"] = None
    # ask_topics (глобально на коллабе) — через model_fields_set, чтобы можно было
    # очистить (передать null/пусто). Спикер видит поле только если организатор
    # включил show_ask_topics_field (гейт на фронте, как у notes).
    if "ask_topics" in data.model_fields_set:
        upd["ask_topics"] = (data.ask_topics or None)
    # Ник ассистента — нормализуем (срезаем @ и пробелы); пустая строка → NULL.
    if data.assistant_tg_username is not None:
        from app.api.collaborators import normalize_tg_username
        upd["assistant_tg_username"] = normalize_tg_username(data.assistant_tg_username)
    # Понятные ограничения длины (вместо падения БД varchar(N)).
    _LIMITS = {"name": (255, "Имя"), "last_name": (255, "Фамилия"),
               "title": (500, "Регалии / должность"),
               "tg_channel_url": (500, "Ссылка Telegram"), "vk_url": (500, "Ссылка ВКонтакте"),
               "max_url": (500, "Ссылка MAX"), "instagram_url": (500, "Ссылка Instagram"),
               "website_url": (500, "Ссылка на сайт")}
    for f, (limit, label) in _LIMITS.items():
        v = upd.get(f)
        if isinstance(v, str) and len(v) > limit:
            raise HTTPException(status_code=400,
                detail=f"Поле «{label}» слишком длинное ({len(v)} символов, максимум {limit}). Сократите текст.")

    # Медийные активы: _normalize_media_assets сам кинет 400 на пустое число.
    media_assets_in = _normalize_media_assets(data.media_assets)
    if upd or media_assets_in is not None:
        parts = [f"{k} = ${i+2}" for i, k in enumerate(upd.keys())]
        vals = list(upd.values())
        if media_assets_in is not None:
            parts.append(f"media_assets = ${len(vals)+2}::jsonb")
            vals.append(_json.dumps(media_assets_in))
        parts.append("updated_at = NOW()")
        try:
            await db.execute(
                f"UPDATE collaborators SET {', '.join(parts)} WHERE id = $1",
                c_id, *vals
            )
        except asyncpg.exceptions.StringDataRightTruncationError:
            raise HTTPException(status_code=400, detail="Одно из полей слишком длинное. Сократите текст и сохраните снова.")

    # 2. Контакт (contacts) — только phone. Email живёт как идентичность
    #    (platform_users), синхронизируется ниже, в contacts.email НЕ пишем.
    if contact_id:
        if data.phone is not None:
            # ⚠️ Своя копия нормализации была проще общей (не понимала «7…»
            # без плюса и ведущие нули) — телефоны расходились по формату и
            # дубли не склеивались. Только через set_contact_phone.
            from app.services.contact_merge import set_contact_phone
            # only_if_empty=False: человек правит СВОЙ телефон в кабинете —
            # его ввод главнее того, что было записано раньше.
            await set_contact_phone(db, contact_id, data.phone, only_if_empty=False)
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

    # 4. Темы выступления — единый хелпер: тема №1 живёт по постоянному id
    # (её текст правим, а не пересоздаём), поэтому привязка слота не слетает.
    # Хелпер САМ привязывает первую тему к слоту, если слот занят без темы
    # («занял слот раньше, чем вписал тему») — из всех точек правки одинаково.
    if data.topics is not None:
        from app.api.modules.conference import _rewrite_speaker_topics
        # Описания приходят параллельным массивом (индекс в индекс) — склеиваем
        # в {topic, description}. Не прислали — описания не трогаем (пустые).
        _descs = data.topic_descriptions or []
        await _rewrite_speaker_topics(db, se_id, [
            {"topic": t, "description": (_descs[i] if i < len(_descs) else "")}
            for i, t in enumerate(data.topics)
        ])

    # 5. Подарки и материал. Различаем «не передано» (не трогаем) и «передано null»
    # (обнуляем) через model_fields_set — иначе нельзя стереть ручной подарок при
    # переключении на ПЛЮСОН-магнит (раньше null игнорировался, оставался старый текст).
    sent_fields = data.model_fields_set
    ev_upd = {}
    # ⚠️ Одиночный подарок → В СПИСОК (колонок gift_after_speech_* больше нет).
    if "gift_after_speech_title" in sent_fields or "gift_after_speech_url" in sent_fields:
        from app.api.modules.conference import _save_single_gift_to_list
        await _save_single_gift_to_list(
            db, se_id, data.gift_after_speech_title, data.gift_after_speech_url)
    for f in ("gift_raffle_title", "gift_raffle_url",
              "knowledge_base_title", "knowledge_base_url", "notes"):
        if f in sent_fields:
            ev_upd[f] = getattr(data, f, None)  # может быть и None → SET NULL
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
        # После legacy-обновления синхронизируем список-таблицу с одиночной привязкой,
        # чтобы старые клиенты (шлющие gift_lead_magnet_id) не рассинхронили список.
        if "gift_lead_magnets" not in sent_fields:
            await _sync_gift_magnet_list_from_legacy(db, se_id)

    # 5c. Список до 4 подарков (миграция 200 + 219: magnet/package/manual).
    # Приоритетнее legacy. Единый хелпер — тот же, что использует дашборд.
    if "gift_lead_magnets" in sent_fields:
        # ⚠️⚠️ ПУСТОЙ СПИСОК НЕ СТИРАЕТ РУЧНОЙ ПОДАРОК, записанный шагом выше.
        # `save_ec_gifts` переписывает список ЦЕЛИКОМ. Фронт при ручном подарке
        # шлёт `gift_lead_magnets: []` («снять плюсоновские») — и затирал только
        # что вставленный ручной: спикер видел «сохранено», а поле оставалось
        # пустым и после обновления страницы (жалоба 16.09.2026).
        #
        # ⚠️ Ручной подарок и плюсоновские могут жить ВМЕСТЕ — таблица это
        # позволяет, и спикеру так и нужно. Поэтому при пустом списке чистим
        # только ПЛЮСОН-строки, ручные не трогаем.
        linked = await db.fetchval("SELECT linked_client_id FROM collaborators WHERE id = $1", c_id)
        if data.gift_lead_magnets:
            from app.api.modules.conference import save_ec_gifts
            await save_ec_gifts(db, se_id, data.gift_lead_magnets, linked)
        else:
            await db.execute(
                "DELETE FROM event_collaborator_lead_magnets "
                " WHERE ec_id = $1 AND manual_title IS NULL", se_id)
            await db.execute(
                "UPDATE event_collaborators "
                "   SET gift_lead_magnet_id = NULL, gift_package_id = NULL "
                " WHERE id = $1", se_id)

    return await get_me(session, db)


@router.post("/me/verify-channel", summary="Проверить, что бот в канале спикера + резолвить tg_channel_id")
async def verify_channel(
    session: dict = Depends(_auth_session_write),
    db: asyncpg.Connection = Depends(get_db),
):
    """Проверить, что бот в канале спикера, и резолвить tg_channel_id.

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
    token = await get_client_telegram_token(client_id, db)  # только свой бот клиента
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
        m = channel_url.replace("https://t.me/", "").replace("http://t.me/", "").replace("https://t.me/", "").replace("http://t.me/", "").lstrip("@/").split("/")[0].split("?")[0]
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
    session: dict = Depends(_auth_session_write),
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
                  e.video_url AS event_video_url,
                  COALESCE(NULLIF(cl.brand_name, ''), cl.name) AS client_brand,
                  cl.partner_landing_url, cl.partner_dashboard_url,
                  cl.partner_visible_roles,
                  ec.role AS ec_role,
                  c.contact_id,
                  c.photo_url AS speaker_photo_url,
                  ec.announcement_poster_ids,
                  ec.show_partner_registration_link,
                  ec.use_photo_instead_of_poster,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу»
                  -- → афиша не отдаётся, спикер видит только своё фото.
                  %(poster_sql_ec)s AS speaker_poster_url,
                  c.video_url AS speaker_video_url,
                  ctc.ref_code AS speaker_ref_code,
                  ctc.first_referrer_contact_id,
                  ctc.external_ref_param AS speaker_external_ref_param
             FROM event_collaborators ec
             JOIN collaborators c    ON c.id = ec.speaker_id
             JOIN events e           ON e.id = ec.event_id
             JOIN clients cl         ON cl.id = (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
        LEFT JOIN contacts ctc       ON ctc.id = c.contact_id
            WHERE ec.id = $1 AND ec.event_id = $2 AND c.id = $3""" % {"poster_sql_ec": poster_subquery("ec", "c")},
        se_id, e_id, c_id,
    )
    if not base:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    # Афиши «для анонсов» в этом событии (миграция 122) — те, что клиент
    # отметил на странице спикера конференции. Спикер увидит их в своём
    # кабинете в секции «Афиши для анонсов» и скачает для распространения.
    # Миграция 237: если у спикера в этом событии отключены индивидуальные
    # афиши — не показываем и «для анонсов» (они из той же библиотеки).
    announcement_ids = ([] if base.get("use_photo_instead_of_poster")
                        else list(base.get("announcement_poster_ids") or []))
    # ⚠️ Индивидуальные афиши — тоже только после публикации (миграция 469).
    # Собранные генератором афиши спикеров сразу попадают в их карточки; без
    # этой проверки они показывались бы людям ещё до того, как клиент решил,
    # что вариант окончательный.
    ind_published = await db.fetchval(
        "SELECT EXISTS (SELECT 1 FROM event_poster_layouts"
        "  WHERE event_id = $1 AND kind = 'individual' AND published_to_cabinet)",
        e_id,
    )
    # ⚠️ Афиши, загруженные клиентом ВРУЧНУЮ в карточку, галочкой генератора не
    # управляются: они лежали там и до него. Гасим только автособранные — их
    # видно по метке вида «Название события (vertical)», которую ставит
    # render-all. Не различишь — спикер потеряет свои старые афиши.
    if announcement_ids and not ind_published:
        auto_ids = [r["id"] for r in await db.fetch(
            "SELECT id FROM collaborator_posters"
            # ⚠️ Скобки обязательны: без них AND связывает сильнее OR, и
            # условие по владельцу применилось бы только к первой ветке —
            # в выборку попали бы чужие афиши.
            " WHERE id = ANY($1::int[]) AND collaborator_id = $2"
            "   AND (label LIKE '%(horizontal)' OR label LIKE '%(vertical)'"
            "        OR label LIKE '%(square)')",
            announcement_ids, c_id,
        )]
        announcement_ids = [i for i in announcement_ids if i not in auto_ids]
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

    # ⚠️⚠️ НОВЫЕ СЛОТЫ АФИШ (миграция 492, 22.09.2026). У спикера на событие
    # три афиши — горизонтальная, квадратная, вертикальная. Показываем их в
    # кабинете ПЕРВЫМИ: это актуальные афиши именно этого события, тогда как
    # старая библиотека общая на все конференции.
    #
    # ⚠️ Тумблер «фото вместо афиши» гасит и их: клиент явно сказал, что
    # афиши этого спикера использовать не надо.
    slot_posters = []
    if not base.get("use_photo_instead_of_poster"):
        slot_posters = [dict(r) for r in await db.fetch(
            """SELECT orientation, url FROM event_speaker_posters
                WHERE ec_id = $1
                ORDER BY CASE orientation
                           WHEN 'horizontal' THEN 1
                           WHEN 'square'     THEN 2
                           WHEN 'vertical'   THEN 3
                           ELSE 4 END""",
            se_id,
        )]

    # ⚠️⚠️ ТОЛЬКО ОПУБЛИКОВАННОЕ (миграция 469). Раньше кабинет показывал всё
    # подряд: клиент собирает афишу в несколько заходов, подбирая раскладку, — и
    # каждая проба немедленно уезжала спикерам. Теперь показываем лишь те виды
    # и ориентации, по которым клиент нажал «Опубликовать».
    #
    # ⚠️ Галочка живёт на МАКЕТЕ и решается отдельно для каждой ориентации:
    # вертикальную можно выпустить, а горизонтальную ещё дорисовывать.
    pub_common = [r["orientation"] for r in await db.fetch(
        "SELECT orientation FROM event_poster_layouts"
        " WHERE event_id = $1 AND kind = 'common' AND published_to_cabinet",
        e_id,
    )]
    pub_day = [r["orientation"] for r in await db.fetch(
        "SELECT orientation FROM event_poster_layouts"
        " WHERE event_id = $1 AND kind = 'day' AND published_to_cabinet",
        e_id,
    )]

    # Общие афиши события (упорядочены: horizontal → vertical → square)
    posters = await db.fetch(
        """SELECT id, url, orientation, sort
             FROM event_posters
            WHERE event_id = $1 AND day IS NULL
              AND orientation = ANY($2::text[])
            ORDER BY CASE orientation
                       WHEN 'horizontal' THEN 1
                       WHEN 'vertical'   THEN 2
                       WHEN 'square'     THEN 3
                       ELSE 4
                     END, sort, id""",
        e_id, pub_common,
    )

    # Афиши ДНЕЙ события (миграция 215) — спикер скачивает афишу нужного дня
    # под свой анонс. Отдаём с названием дня из программы (conf_days.title),
    # чтобы в кабинете было понятно, какой день на афише.
    #
    # ⚠️⚠️ ТОЛЬКО ТЕ ДНИ, ГДЕ ЧЕЛОВЕК ВЫСТУПАЕТ (требование владельца).
    # Раньше отдавались афиши ВСЕХ дней: спикер первого дня получал в кабинете
    # ещё и афиши второго и третьего, анонсировал не тот день и путал свою
    # аудиторию. Дни берём из программы (`conf_sessions`), а не из галочек:
    # программа — единственное место, где записано, когда человек выступает.
    #
    # ⚠️ Нет сессий вовсе (программу ещё не заполнили) — отдаём ВСЕ дни, как
    # было. Пустой список здесь хуже лишнего: спикер остался бы без афиш
    # совсем и решил, что материалов нет.
    # ⚠️⚠️ `conf_sessions.speaker_id` — это `event_collaborators.id` (миграции
    # 003/004 + переименование 075), то есть строка «человек на этом событии»,
    # а НЕ `collaborators.id`. Подставишь сюда `c_id` — совпадений не будет
    # вовсе, и спикер молча останется без афиш дней.
    my_days = [r["day"] for r in await db.fetch(
        "SELECT DISTINCT day FROM conf_sessions"
        " WHERE event_id = $1 AND speaker_id = $2 AND day IS NOT NULL",
        e_id, se_id,
    )]
    day_posters = await db.fetch(
        """SELECT ep.id, ep.url, ep.orientation, ep.sort, ep.day,
                  cd.day_date,
                  COALESCE(NULLIF(cd.title, ''), 'День ' || ep.day::text) AS day_title
             FROM event_posters ep
             LEFT JOIN conf_days cd ON cd.event_id = ep.event_id AND cd.day_number = ep.day
            WHERE ep.event_id = $1 AND ep.day IS NOT NULL
              AND ($2::int[] = '{}'::int[] OR ep.day = ANY($2::int[]))
              AND ep.orientation = ANY($3::text[])
            ORDER BY ep.day,
                     CASE ep.orientation
                       WHEN 'horizontal' THEN 1
                       WHEN 'vertical'   THEN 2
                       WHEN 'square'     THEN 3
                       ELSE 4
                     END, ep.sort, ep.id""",
        e_id, my_days, pub_day,
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
    _base_lm = await resolve_event_link_mode(db, client_id=int(base["client_id"]))
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
        # Площадки, выключенные у события (миграция 263), спикеру не показываем
        # и в выгрузку материалов не отдаём — сам бот при этом работает.
        from app.services.share_links import get_event_disabled_platforms
        platforms -= await get_event_disabled_platforms(db, event_id=e_id)
        handles   = await get_client_bot_handles(db, client_id_int)
        vk_app_id = await get_client_vk_app_id(db, client_id_int)
        # Системный @pluson_bot — fallback для TG, если у клиента нет своего
        if await _has_system_channel(db, "telegram", allow_test=False):
            platforms.add("telegram")

        if "telegram" in platforms:
            # Системный @pluson_bot (PLUSON_TG_HANDLE) как fallback убран: если у
            # клиента нет своего TG-бота — TG invite-ссылку спикеру не показываем.
            tg_handle = (handles.get("telegram") or "").lstrip("@")
            if tg_handle:
                partner_link["telegram"] = f"https://{TG_DOMAIN}/{tg_handle}?start={payload}"
        if "vk" in platforms and vk_app_id:
            partner_link["vk"] = f"https://vk.com/app{vk_app_id}#{payload}"
        if "max" in platforms and handles.get("max"):
            partner_link["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?start={payload}"

    # Записи ЕГО выступлений (миграция 349) — куски, нарезанные организатором
    # из записи эфира. ⚠️ Отбор по speaker_ec_id: спикер видит СВОИ выступления,
    # а не весь эфир. Только status='ready' — недорезанный кусок отдавать нечего.
    my_recordings = await db.fetch(
        """SELECT cut.id, cut.title, cut.url, cut.duration_sec, cut.size_bytes,
                  cd.day_number, COALESCE(NULLIF(cd.title,''), 'День ' || cd.day_number::text) AS day_title
             FROM webinar_recording_cuts cut
             JOIN webinar_recordings rec ON rec.id = cut.recording_id
             JOIN webinar_rooms wr       ON wr.id = rec.room_id
        LEFT JOIN conf_days cd           ON cd.event_id = wr.event_id AND cd.day_number = wr.day_number
            WHERE cut.speaker_ec_id = $1 AND wr.event_id = $2
              AND cut.status = 'ready' AND cut.url IS NOT NULL
            ORDER BY wr.day_number, cut.start_sec""",
        se_id, e_id,
    )

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
        # Афиши дней события (миграция 215): у каждой day + day_title + day_date.
        "day_posters":  [dict(r) for r in day_posters],
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
        # Афиши-слоты этого события (миграция 492): фронт кабинета показывает
        # их отдельным блоком с подписями форматов.
        "speaker_posters": slot_posters,
        "event_video_url":    base.get("event_video_url"),
        "speaker_video_url":  base.get("speaker_video_url"),
        # Записи ЕГО выступлений из эфира — смотреть и скачивать.
        "my_recordings":      [dict(r) for r in my_recordings],
        "announcement_texts": [dict(r) for r in texts],
        "ref_links":    ref_links,
        # ⚠️ ВЕБ-ССЫЛКА БЕЗ МЕССЕНДЖЕРА (2026-08-28). Часть аудитории спикера не
        # сидит в ботах, а у части клиентов ботов нет вовсе — тогда остальные
        # ссылки пустые и раздавать нечего. Форма на сайте работает всегда,
        # реф-код в ней теперь засчитывается (раньше `pid` она игнорировала).
        "web_reg_link": (
            await client_public_link(
                db, int(base["client_id"]),
                f"/event/{base['event_slug']}/register?pid={base['speaker_ref_code']}")
            if base.get("speaker_ref_code") else ""
        ),
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


async def _resolve_landing_link(db, event_id: int, event_slug: str,
                                landing_url: str | None, base_url: str) -> str:
    """Адрес, по которому человек увидит СЕБЯ НА ЛЕНДИНГЕ события.

    ⚠️ Ссылка выдаётся ТОЛЬКО когда событие показывает НАШ лендинг
    (`events.registration_mode='landing'`) и он опубликован. Пусто → кабинет
    не рисует кнопку «Как вы выглядите на лендинге» вовсе.

    Почему так (2026-08-27). Раньше ссылка была всегда: при `external` вела на
    сторонний сайт клиента, а при простой форме — на `/event/{slug}`, то есть
    в веб-версию Mini App. И там, и там карточки спикера в нашем виде нет:
    человек жал «посмотреть, как я выгляжу» и не находил себя. Обещать показ
    там, где показывать нечего, хуже, чем не показывать кнопку.

    ⚠️ Неопубликованный лендинг тоже не годится — он отдаёт «Страница не
    найдена». Параметр `landing_url` больше не участвует (он про сторонний
    сайт) и оставлен только ради совместимости вызовов.
    """
    row = await db.fetchrow(
        """SELECT COALESCE(e.registration_mode, 'form') AS mode,
                  (SELECT p.is_published FROM event_landing_pages p
                    WHERE p.event_id = e.id AND p.kind = 'main'
                    LIMIT 1) AS published
             FROM events e WHERE e.id = $1""",
        event_id,
    )
    if not row or row["mode"] != 'landing' or not row["published"]:
        return ""
    return public_url_for(base_url, f"e/{event_slug}")


@router.get("/me/gift-stats", summary="Статистика переходов по подаркам спикера")
async def get_me_gift_stats(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Сколько людей перешло по подаркам спикера и сколько из них новых.

    Считается за два периода — «+3 дня» и «+7 дней» после окончания программы,
    оба от дня первого выступления. Логика и оговорки — в сервисе.
    """
    return await speaker_lead_magnet_stats(db, int(session["se_id"]))


@router.get("/me/recordings/{cut_id}/download",
            summary="Ссылка на скачивание своей нарезки")
async def download_my_recording(
    cut_id: int,
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Ссылка, по которой браузер СОХРАНЯЕТ файл, а не открывает проигрыватель.

    ⚠️ Прямая ссылка на хранилище отдаёт `Content-Type: video/mp4` без
    `Content-Disposition`, и браузер обязан показать видео. Атрибут `download`
    у ссылки не помогает — он действует только на своём домене. Поэтому
    подписываем ссылку с пометкой «это вложение».

    ⚠️ Нарезка сверяется со СПИКЕРОМ сессии (`speaker_ec_id`): иначе по чужому
    номеру можно было бы скачать выступление другого человека.
    """
    row = await db.fetchrow(
        """SELECT cut.r2_key, cut.title, wr.event_id
             FROM webinar_recording_cuts cut
             JOIN webinar_recordings rec ON rec.id = cut.recording_id
             JOIN webinar_rooms wr       ON wr.id = rec.room_id
            WHERE cut.id = $1 AND cut.speaker_ec_id = $2
              AND cut.status = 'ready' AND cut.r2_key IS NOT NULL""",
        cut_id, int(session["se_id"]))
    if not row:
        raise HTTPException(404, "Запись не найдена")

    from app.services.client_storage import storage_for
    client_id = await db.fetchval(
        "SELECT eo.client_id FROM event_owners eo "
        " WHERE eo.event_id=$1 AND eo.status='accepted' "
        " ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1", row["event_id"])
    cl, bucket, _ = await storage_for(db, client_id)
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', ' ', row["title"] or "").strip()[:120] or "Выступление"
    return {"url": r2_storage.download_url(row["r2_key"], f"{name}.mp4",
                                           client=cl, bucket=bucket)}


@router.get("/me/my-broadcasts", summary="Рассылки, где фигурирует этот спикер (в этом событии)")
async def get_me_broadcasts(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    """Список рассылок «со мной» — те, что привязаны к этому спикеру (session_id =
    его event_collaborators.id) в этом событии: speaker_intro, 5min_before, gift,
    expert_day. Черновики (status='draft') не показываем — только «в очереди»
    (pending) и «отправлено» (done). У каждой — превью (текст+фото+кнопка)."""
    from zoneinfo import ZoneInfo
    from app.services.message_builder import (
        build_message_content, event_public_base, speaker_card_link)
    from app.services.client_domains import public_url_for

    se_id = int(session["se_id"])
    me = await db.fetchrow(
        """SELECT cse.event_id, e.slug AS event_slug, e.landing_url,
                  col.contact_id AS my_contact_id,
                  COALESCE(cl.link_mode_telegram, 'bot') AS tg_link_mode,
                  (SELECT ch.handle FROM client_channels cc JOIN channels ch ON ch.id=cc.channel_id
                     WHERE cc.client_id=cl.id AND cc.is_active AND ch.platform_slug='telegram'
                       AND ch.is_system=FALSE AND ch.handle IS NOT NULL LIMIT 1) AS bot_handle
             FROM event_collaborators cse
             JOIN events e ON e.id = cse.event_id
             JOIN collaborators col ON col.id = cse.speaker_id
             JOIN clients cl ON cl.id = (
                 SELECT eo.client_id FROM event_owners eo
                  WHERE eo.event_id = e.id AND eo.status='accepted'
                  ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
            WHERE cse.id=$1""",
        se_id
    )
    if not me:
        raise HTTPException(status_code=404, detail="Спикер не найден")
    event_id = me["event_id"]

    # Спикер шлёт эти ссылки СВОЕЙ аудитории → домен клиента, не платформы.
    _base = await event_public_base(db, event_id)
    # Ссылка на карточку спикера в кабинете участника (Mini App или веб —
    # по настройке клиента ДЛЯ TELEGRAM).
    card_link = _card_link_for_self(
        speaker_card_link(me["event_slug"], se_id,
                          me["tg_link_mode"], me["bot_handle"],
                          base_url=_base),
        me["my_contact_id"],
    )
    landing_link = await _resolve_landing_link(
        db, event_id, me["event_slug"], me["landing_url"], _base)

    rows = await db.fetch(
        """
        SELECT bs.id, bs.type, bs.status, bs.fire_at, bs.template_id, bs.session_id,
               bs.snapshot_text, bs.snapshot_photo, bs.snapshot_video, bs.snapshot_media_type,
               bs.snapshot_btn_text, bs.snapshot_btn_url, bs.snapshot_buttons,
               bt.name AS tmpl_name, bt.text AS tmpl_text, bt.photo_url AS tmpl_photo,
               bt.video_url AS tmpl_video, bt.media_type AS tmpl_media_type,
               bt.button_text AS tmpl_btn_text, bt.button_url AS tmpl_btn_url,
               bt.speaker_photo_mode AS tmpl_speaker_photo_mode,
               -- Сколько людей реально получило. Спикер видел только «отправлено»
               -- без цифры — по такой пометке непонятно, дошло до десяти человек
               -- или до трёх тысяч.
               (SELECT count(*) FROM broadcast_log bl WHERE bl.schedule_id = bs.id) AS sent_total,
               (SELECT count(*) FROM broadcast_log bl WHERE bl.schedule_id = bs.id AND bl.status='sent') AS sent_ok
          FROM broadcast_schedules bs
          LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
         WHERE bs.event_id = $1
           AND (
                 -- speaker_intro / expert_day привязаны к КАРТОЧКЕ спикера
                 bs.session_id = $2
                 -- 5min_before / gift привязаны к его СЛОТУ в программе
                 OR bs.session_id IN (SELECT id FROM conf_sessions
                                       WHERE event_id = $1 AND speaker_id = $2)
               )
           AND bs.status IN ('pending', 'done')
         ORDER BY bs.fire_at NULLS LAST, bs.id
        """,
        event_id, se_id,
    )

    tz = ZoneInfo("Europe/Moscow")
    # {support_link} в превью: все каналы поддержки блоком (площадка неизвестна).
    _sup_link = await support_block_for_event(db, event_id)
    out = []
    for r in rows:
        try:
            content = await build_message_content(
                conn=db,
                tpl_type=r["type"],
                tmpl_text=r["tmpl_text"] or "",
                photo_url=r["tmpl_photo"],
                btn_text=r["tmpl_btn_text"],
                btn_url=r["tmpl_btn_url"] or "",
                event_id=event_id,
                session_id=r["session_id"],
                fire_at=r["fire_at"],
                tz=tz,
                template_id=r["template_id"],
                video_url=r["tmpl_video"],
                media_type=r["tmpl_media_type"],
                speaker_photo_mode=r["tmpl_speaker_photo_mode"] or "poster",
                support_link=_sup_link,
            )
        except Exception:
            content = {"text": r["tmpl_text"] or "", "photo": r["tmpl_photo"],
                       "video": None, "media_type": r["tmpl_media_type"],
                       "button_text": r["tmpl_btn_text"], "button_url": r["tmpl_btn_url"],
                       "buttons": []}
        fire_msk = r["fire_at"].astimezone(tz).strftime("%d.%m.%Y %H:%M") if r["fire_at"] else None
        out.append({
            "id": r["id"],
            "type": r["type"],
            "name": r["tmpl_name"] or r["type"],
            "status": r["status"],  # 'pending' | 'done'
            "fire_at_msk": fire_msk,
            # Доставка: сколько людей получило. У ещё не отправленных — нули.
            "sent_ok": r["sent_ok"],
            "sent_total": r["sent_total"],
            "text": content.get("text") or "",
            "photo": content.get("photo") if content.get("media_type") != "video" else None,
            "video": content.get("video") if content.get("media_type") == "video" else None,
            "media_type": content.get("media_type"),
            "button_text": content.get("button_text"),
            "button_url": content.get("button_url"),
            "buttons": content.get("buttons") or [],
        })
    return {
        "broadcasts": out,
        "card_link": card_link or None,
        "landing_link": landing_link or None,
    }


async def _speaker_test_targets(db, se_id: int):
    """Куда уйдёт тест: аккаунты САМОГО спикера на площадках + боты события,
    которыми будем слать. Возвращает (targets_for_ui, send_plan).

    targets_for_ui — список для предупреждения человеку: платформа, его ник,
    имя бота события. send_plan — то же + токены/ids для реальной отправки.
    """
    # Контакт спикера + владелец события (его боты).
    info = await db.fetchrow(
        """SELECT co.contact_id,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = ec.event_id AND eo.status='accepted'
                    ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id
             FROM event_collaborators ec
             JOIN collaborators co ON co.id = ec.speaker_id
            WHERE ec.id = $1""",
        se_id,
    )
    if not info or not info["contact_id"]:
        return [], []
    contact_id, client_id = info["contact_id"], info["client_id"]

    # Личные идентичности спикера на площадках.
    idents = await db.fetch(
        """SELECT platform_slug, platform_user_id, username
             FROM platform_users
            WHERE contact_id = $1 AND platform_slug IN ('telegram','vk','max')""",
        contact_id,
    )
    id_by_platform = {r["platform_slug"]: r for r in idents}

    # Боты события (клиента) на каждой площадке + их публичные имена.
    from app.services.channels import (
        get_client_telegram_token, get_client_max_token, get_client_vk_token,
    )
    ui, plan = [], []

    async def _bot_handle(platform):
        return await db.fetchval(
            """SELECT COALESCE(ch.handle, ch.display_name)
                 FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1 AND cc.is_active
                  AND ch.platform_slug = $2 AND ch.is_system = FALSE
                LIMIT 1""",
            client_id, platform,
        )

    # Telegram
    tg = id_by_platform.get("telegram")
    tg_token = await get_client_telegram_token(client_id, db)
    if tg and str(tg["platform_user_id"]).lstrip("@").isdigit() and tg_token:
        handle = await _bot_handle("telegram")
        nick = ("@" + tg["username"]) if tg["username"] else f"id {tg['platform_user_id']}"
        ui.append({"platform": "telegram", "nick": nick, "bot": ("@" + handle) if handle else "бот события"})
        plan.append({"platform": "telegram", "chat_id": str(tg["platform_user_id"]), "token": tg_token})

    # VK
    vk = id_by_platform.get("vk")
    vk_token = await get_client_vk_token(client_id, db)
    if vk and str(vk["platform_user_id"]).isdigit() and vk_token:
        handle = await _bot_handle("vk")
        nick = ("@" + vk["username"]) if vk["username"] else f"id {vk['platform_user_id']}"
        ui.append({"platform": "vk", "nick": nick, "bot": handle or "сообщество события"})
        plan.append({"platform": "vk", "chat_id": str(vk["platform_user_id"]), "token": vk_token})

    # MAX
    mx = id_by_platform.get("max")
    max_token = await get_client_max_token(client_id, db)
    if mx and str(mx["platform_user_id"]).isdigit() and max_token:
        handle = await _bot_handle("max")
        nick = ("@" + mx["username"]) if mx["username"] else f"id {mx['platform_user_id']}"
        ui.append({"platform": "max", "nick": nick, "bot": handle or "бот события"})
        plan.append({"platform": "max", "chat_id": str(mx["platform_user_id"]), "token": max_token})

    return ui, plan


@router.get("/me/my-broadcasts/{schedule_id}/test-targets",
            summary="Куда уйдёт тест рассылки (аккаунты самого спикера)")
async def get_broadcast_test_targets(
    schedule_id: int,
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    se_id = int(session["se_id"])
    ui, _ = await _speaker_test_targets(db, se_id)
    return {"targets": ui}


@router.post("/me/my-broadcasts/{schedule_id}/test",
             summary="Отправить тест рассылки самому спикеру в его аккаунты")
async def send_broadcast_test(
    schedule_id: int,
    session: dict = Depends(_auth_session_write),
    db: asyncpg.Connection = Depends(get_db),
):
    """Собирает сообщение рассылки ТОЧНО как оно уйдёт (тот же build_message_content,
    что и превью) и шлёт его САМОМУ спикеру — в его личные TG/VK/MAX через боты
    события. Никому больше не уходит."""
    import httpx
    from zoneinfo import ZoneInfo
    from app.services.message_builder import build_message_content, send_telegram_message

    se_id = int(session["se_id"])

    # Рассылка должна быть «с этим спикером» (та же логика, что в my-broadcasts).
    row = await db.fetchrow(
        """SELECT bs.id, bs.type, bs.event_id, bs.session_id, bs.template_id, bs.fire_at,
                  bt.text AS tmpl_text, bt.photo_url AS tmpl_photo, bt.video_url AS tmpl_video,
                  bt.media_type AS tmpl_media_type, bt.button_text AS tmpl_btn_text,
                  bt.button_url AS tmpl_btn_url, bt.speaker_photo_mode AS tmpl_speaker_photo_mode
             FROM broadcast_schedules bs
             LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
            WHERE bs.id = $1
              AND (bs.session_id = $2
                   OR bs.session_id IN (SELECT id FROM conf_sessions
                                         WHERE event_id = bs.event_id AND speaker_id = $2))""",
        schedule_id, se_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Рассылка не найдена")

    ui, plan = await _speaker_test_targets(db, se_id)
    if not plan:
        raise HTTPException(
            status_code=400,
            detail="Не нашли ваш аккаунт ни на одной площадке события. Напишите боту события — тогда тест сможет прийти.",
        )

    tz = ZoneInfo("Europe/Moscow")
    try:
        content = await build_message_content(
            conn=db, tpl_type=row["type"], tmpl_text=row["tmpl_text"] or "",
            photo_url=row["tmpl_photo"], btn_text=row["tmpl_btn_text"],
            btn_url=row["tmpl_btn_url"] or "", event_id=row["event_id"],
            session_id=row["session_id"], fire_at=row["fire_at"], tz=tz,
            template_id=row["template_id"], video_url=row["tmpl_video"],
            media_type=row["tmpl_media_type"],
            speaker_photo_mode=row["tmpl_speaker_photo_mode"] or "poster",
            support_link=await support_block_for_event(db, row["event_id"]),
        )
    except Exception:
        content = {"text": row["tmpl_text"] or "", "photo": row["tmpl_photo"], "video": None,
                   "media_type": row["tmpl_media_type"], "button_text": row["tmpl_btn_text"],
                   "button_url": row["tmpl_btn_url"], "buttons": []}

    text = content.get("text") or ""
    photo = content.get("photo")
    video = content.get("video")
    m_type = content.get("media_type")
    buttons = content.get("buttons") or []
    btn_text = content.get("button_text") or (buttons[0]["text"] if buttons else None)
    btn_url = content.get("button_url") or (buttons[0]["url"] if buttons else None)

    sent = 0
    async with httpx.AsyncClient(timeout=20) as http:
        for t in plan:
            try:
                if t["platform"] == "telegram":
                    ok, _err = await send_telegram_message(
                        http, t["token"], t["chat_id"], text, photo, btn_text, btn_url,
                        buttons=buttons or None,
                        video_url=video if m_type == "video" else None)
                    if ok:
                        sent += 1
                elif t["platform"] == "vk":
                    from app.services.vk_api import send_message as vk_send, tg_inline_to_vk_keyboard
                    kb = tg_inline_to_vk_keyboard([[{"text": btn_text, "url": btn_url}]]) if (btn_text and btn_url) else None
                    vk_text = f"{photo}\n\n{text}".strip() if photo else text
                    if m_type == "video" and video:
                        vk_text = f"{vk_text}\n\n🎬 Видео: {video}".strip()
                    if await vk_send(int(t["chat_id"]), vk_text, keyboard=kb, token=t["token"]):
                        sent += 1
                elif t["platform"] == "max":
                    from app.services.max_api import send_message as max_send, tg_inline_to_max_keyboard
                    mb = tg_inline_to_max_keyboard([[{"text": btn_text, "url": btn_url}]]) if (btn_text and btn_url) else None
                    max_text = f"{photo}\n\n{text}".strip() if photo else text
                    if m_type == "video" and video:
                        max_text = f"{max_text}\n\n🎬 Видео: {video}".strip()
                    if await max_send(int(t["chat_id"]), max_text, token=t["token"],
                                      buttons=mb, recipient_kind="user"):
                        sent += 1
            except Exception:
                pass

    return {"ok": sent > 0, "sent": sent, "targets": ui}


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
            return f"https://{TG_DOMAIN}/{u}" if u else None
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
    session: dict = Depends(_auth_session_write),
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
    session: dict = Depends(_auth_session_write),
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

    # ⚠️ asyncpg.Record не поддерживает .get() — фамилию берём явным полем SELECT.
    coll = await db.fetchrow("SELECT name, last_name FROM collaborators WHERE id = $1", c_id)
    name = (display_name(coll["name"], coll["last_name"]) if coll else "") or "Спикер"

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
    session: dict = Depends(_auth_session_write),
    db: asyncpg.Connection = Depends(get_db),
):
    c_id = int(session["c_id"])
    await db.execute(
        "UPDATE collaborators SET linked_client_id = NULL, updated_at = NOW() WHERE id = $1",
        c_id,
    )
    # снимаем и выбранный подарок-магнит на этом событии (одиночный + список)
    se_id = int(session["se_id"])
    await db.execute(
        "UPDATE event_collaborators SET gift_lead_magnet_id = NULL, gift_package_id = NULL WHERE id = $1",
        se_id,
    )
    # ⚠️ Снимаем только ПЛЮСОНОВСКИЕ подарки: ручные — единственный носитель
    # такого подарка (колонки gift_after_speech_* удалены), стереть их нельзя.
    await db.execute(
        "DELETE FROM event_collaborator_lead_magnets "
        " WHERE ec_id = $1 AND manual_title IS NULL", se_id)
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

    # known — уникальные идентифицированные контакты (первая цифра плашки),
    # delivered — уникальные, дошедшие до выдачи (вторая цифра). Ровно как счётчик
    # «N/M» на странице /dashboard/lead-magnets (lead_magnets.py).
    magnets = await db.fetch(
        """SELECT lm.id, lm.name, lm.slug,
                  COALESCE(COUNT(DISTINCT fr.contact_id) FILTER (WHERE fr.contact_id IS NOT NULL), 0) AS known,
                  COALESCE(COUNT(DISTINCT fr.contact_id) FILTER (WHERE fr.stage='delivered' AND fr.contact_id IS NOT NULL), 0) AS delivered
             FROM lead_magnets lm
             LEFT JOIN funnel_runs fr ON fr.lead_magnet_id = lm.id
            WHERE lm.client_id = $1
            GROUP BY lm.id ORDER BY lm.id DESC""",
        linked,
    )
    packages = await db.fetch(
        """SELECT lp.id, lp.name, lp.slug,
                  COALESCE(COUNT(DISTINCT fr.contact_id) FILTER (WHERE fr.contact_id IS NOT NULL), 0) AS known,
                  COALESCE(COUNT(DISTINCT fr.contact_id) FILTER (WHERE fr.stage='delivered' AND fr.contact_id IS NOT NULL), 0) AS delivered
             FROM lead_magnet_packages lp
             LEFT JOIN funnel_runs fr ON fr.package_id = lp.id
            WHERE lp.client_id = $1
            GROUP BY lp.id ORDER BY lp.id DESC""",
        linked,
    )
    return {
        "linked": True,
        "magnets": [{"id": m["id"], "name": m["name"], "slug": m["slug"],
                     "known": int(m["known"]), "delivered": int(m["delivered"])} for m in magnets],
        "packages": [{"id": p["id"], "name": p["name"], "slug": p["slug"],
                      "known": int(p["known"]), "delivered": int(p["delivered"])} for p in packages],
    }


# ─── Самозапись в слот программы ──────────────────────────────────────────────
#
# Спикер видит программу события по дням, занимает свободный слот кнопкой.
# Защита: один слот на спикера; чужой занятый слот трогать нельзя;
# перезапись на другой свободный слот разрешена (старый освобождается).
# Тема в программе живёт по карточке спикера (conf_speaker_topics) — здесь
# слот хранит только speaker_id; topic_id проставляется автоматически, если
# у спикера ровно одна тема.

@router.get("/me/program", summary="Программа события для спикера (слоты по дням)")
async def speaker_program(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    se_id = int(session["se_id"])
    e_id = int(session["e_id"])

    # Этапы участия спикера. Есть привязки (event_collaborator_stages) → только они.
    # Нет привязок → все этапы события (организатор ещё не настроил — не прячем всё).
    my_stage_ids = [r["stage_id"] for r in await db.fetch(
        "SELECT stage_id FROM event_collaborator_stages WHERE ec_id=$1", se_id)]
    if my_stage_ids:
        stages = await db.fetch(
            "SELECT id, sort_order, title, subtitle, start_date, end_date "
            "FROM conf_stages WHERE event_id = $1 AND id = ANY($2::int[]) ORDER BY sort_order, id",
            e_id, my_stage_ids,
        )
    else:
        stages = await db.fetch(
            "SELECT id, sort_order, title, subtitle, start_date, end_date "
            "FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id",
            e_id,
        )
    visible_stage_ids = {s["id"] for s in stages}
    # дни только видимых этапов (дни без этапа показываем всегда).
    # Галочка show_for_speakers у дня (миграция 204): FALSE → день скрыт от спикера.
    all_days = await db.fetch(
        "SELECT id, day_number, day_date, stage_id, title, show_for_speakers, "
        "       COALESCE(has_webinar, TRUE) AS has_webinar "
        "FROM conf_days WHERE event_id = $1 AND show_for_speakers = TRUE ORDER BY day_date NULLS LAST, day_number",
        e_id,
    )
    days = [d for d in all_days if d["stage_id"] is None or d["stage_id"] in visible_stage_ids]
    visible_day_nums = {d["day_number"] for d in days}
    # слот: имя занявшего + его актуальная тема (live по topic_id, fallback title)
    # Тема слота — live: выбранная topic_id, иначе ПЕРВАЯ тема занявшего спикера
    # (conf_speaker_topics), иначе замороженный title. Так тема подтягивается,
    # даже если спикер добавил её уже после занятия слота.
    sessions = await db.fetch(
        """
        SELECT s.id, s.day, s.start_time, s.end_time, s.sort_order,
               s.speaker_id AS occupant_ec_id, s.topic_id,
               btrim(CASE WHEN COALESCE(btrim(col.last_name),'')='' THEN COALESCE(col.name,'')
                          ELSE COALESCE(col.last_name,'')||' '||COALESCE(col.name,'') END) AS occupant_name,
               COALESCE(NULLIF(cst.topic,''),
                 (SELECT NULLIF(t.topic,'') FROM conf_speaker_topics t
                    WHERE t.cse_id = s.speaker_id ORDER BY t.sort_order, t.id LIMIT 1),
                 s.title
               ) AS topic
        FROM conf_sessions s
        LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
        LEFT JOIN collaborators col ON col.id = cse.speaker_id
        LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id
        WHERE s.event_id = $1
        ORDER BY s.day, NULLIF(s.start_time,'') NULLS LAST, s.sort_order
        """,
        e_id,
    )

    def _ser(s):
        d = dict(s)
        d["is_mine"] = (d.get("occupant_ec_id") == se_id)
        d["is_free"] = (d.get("occupant_ec_id") is None)
        return d

    # слоты только видимых дней
    vis_sessions = [_ser(s) for s in sessions if s["day"] in visible_day_nums]

    # темы спикера — чтобы при занятии слота он выбрал, с какой выступает
    my_topics = await db.fetch(
        "SELECT id, topic FROM conf_speaker_topics WHERE cse_id = $1 ORDER BY sort_order, id",
        se_id,
    )

    # реф-код спикера + slug — для личной реф-ссылки на вебинар дня
    ref = await db.fetchrow(
        "SELECT e.slug, c.ref_code "
        "FROM event_collaborators ec JOIN collaborators col ON col.id=ec.speaker_id "
        "LEFT JOIN contacts c ON c.id=col.contact_id JOIN events e ON e.id=ec.event_id "
        "WHERE ec.id=$1", se_id)

    # Флаг «эфир дня завершён»: дата дня прошла И прошло 2 часа после конца
    # последнего слота дня (МСК). Тогда реф-ссылку в кабинете замыливаем.
    from datetime import datetime, timezone, timedelta, time as _time
    MSK = timezone(timedelta(hours=3))
    now_msk = datetime.now(MSK)
    # последнее время окончания слота по дню (строки "HH:MM")
    last_end: dict = {}
    for s in vis_sessions:
        t = s.get("end_time") or s.get("start_time")
        if not t:
            continue
        cur = last_end.get(s["day"])
        if cur is None or str(t) > cur:
            last_end[s["day"]] = str(t)
    days_out = []
    for d in days:
        dd = dict(d)
        ended = False
        dt = d["day_date"]
        if dt:
            hhmm = last_end.get(d["day_number"], "23:59")
            try:
                hh, mm = int(hhmm[:2]), int(hhmm[3:5])
            except Exception:
                hh, mm = 23, 59
            end_dt = datetime.combine(dt, _time(hh, mm), tzinfo=MSK) + timedelta(hours=2)
            ended = now_msk > end_dt
        dd["webinar_ended"] = ended
        days_out.append(dd)

    return {
        "my_ec_id": se_id,
        "event_slug": ref["slug"] if ref else None,
        "my_ref_code": ref["ref_code"] if ref else None,
        "stages": [dict(s) for s in stages],
        "days": days_out,
        "sessions": vis_sessions,
        "my_topics": [dict(t) for t in my_topics],
    }


class ClaimSlotIn(BaseModel):
    session_id: int
    topic_id: Optional[int] = None  # какую из своих тем привязать к слоту


@router.post("/me/claim-slot", summary="Занять слот программы (один на спикера, с пересадкой)")
async def claim_slot(
    data: ClaimSlotIn,
    session: dict = Depends(_auth_session_write),
    db: asyncpg.Connection = Depends(get_db),
):
    se_id = int(session["se_id"])
    c_id = int(session["c_id"])
    e_id = int(session["e_id"])

    async with db.transaction():
        # целевой слот должен принадлежать этому событию
        target = await db.fetchrow(
            "SELECT id, day, speaker_id FROM conf_sessions WHERE id = $1 AND event_id = $2 FOR UPDATE",
            data.session_id, e_id,
        )
        if not target:
            raise HTTPException(status_code=404, detail="Слот не найден")

        if target["speaker_id"] == se_id:
            # уже мой слот — обновляем только тему (спикер сменил тему выступления)
            topic_rows = await db.fetch(
                "SELECT id FROM conf_speaker_topics WHERE cse_id = $1 ORDER BY sort_order, id", se_id)
            my_topic_ids = [r["id"] for r in topic_rows]
            new_topic = data.topic_id if (data.topic_id and data.topic_id in my_topic_ids) else (
                my_topic_ids[0] if len(my_topic_ids) == 1 else None)
            await db.execute(
                "UPDATE conf_sessions SET topic_id = $1 WHERE id = $2 AND event_id = $3",
                new_topic, data.session_id, e_id)
            try:
                from app.api.modules.conference import regenerate_landing_data
                await regenerate_landing_data(e_id, db)
            except Exception:
                pass
            return {"ok": True, "session_id": data.session_id, "topic_updated": True}

        if target["speaker_id"] is not None:
            raise HTTPException(status_code=409, detail="Этот слот уже занят другим спикером")

        # тема: спикер мог выбрать конкретную (topic_id) — проверяем что она его.
        # Привязка темы при занятии слота:
        #  • спикер явно выбрал одну из нескольких — берём её;
        #  • тема РОВНО ОДНА (или её ещё нет — заглушку создаём) — привязываем к
        #    теме №1 по постоянному id. Спикер впишет текст позже, привязка не
        #    слетит (мы правим текст темы, а не пересоздаём её);
        #  • тем НЕСКОЛЬКО и не выбрал — оставляем без привязки (topic_id NULL),
        #    пусть выберет; в программе покажется «Тема будет уточнена позже».
        from app.api.modules.conference import ensure_speaker_topic_placeholder
        topic_rows = await db.fetch(
            "SELECT id, NULLIF(topic,'') AS topic FROM conf_speaker_topics WHERE cse_id = $1 ORDER BY sort_order, id",
            se_id,
        )
        my_topic_ids = [r["id"] for r in topic_rows]
        # Спикер явно выбрал тему — берём её. Иначе привязываем к ПЕРВОЙ теме
        # (у спикера она есть всегда — заглушку создаём). Слот никогда не
        # остаётся без topic_id; при 2+ темах спикер сменит тему в кабинете,
        # а рассылки/программа всегда покажут привязанную (не пустую).
        if data.topic_id and data.topic_id in my_topic_ids:
            topic_id = data.topic_id
        else:
            topic_id = await ensure_speaker_topic_placeholder(db, se_id)
        title_default = "Тема будет уточнена позже"

        # освобождаем мой прежний слот в этом событии (пересадка)
        await db.execute(
            "UPDATE conf_sessions SET speaker_id = NULL, topic_id = NULL, title = $1 "
            "WHERE event_id = $2 AND speaker_id = $3",
            title_default, e_id, se_id,
        )

        # занимаем целевой слот атомарно (на случай гонки — проверяем что он всё ещё свободен)
        claimed = await db.fetchrow(
            "UPDATE conf_sessions SET speaker_id = $1, topic_id = $2 "
            "WHERE id = $3 AND event_id = $4 AND speaker_id IS NULL RETURNING id",
            se_id, topic_id, data.session_id, e_id,
        )
        if not claimed:
            raise HTTPException(status_code=409, detail="Слот только что заняли — обновите страницу")

    # пересчёт JSON лендинга вне транзакции
    try:
        from app.api.modules.conference import regenerate_landing_data
        await regenerate_landing_data(e_id, db)
    except Exception:
        pass

    return {"ok": True, "session_id": data.session_id}


@router.post("/me/release-slot", summary="Освободить свой слот")
async def release_slot(
    session: dict = Depends(_auth_session_write),
    db: asyncpg.Connection = Depends(get_db),
):
    se_id = int(session["se_id"])
    e_id = int(session["e_id"])
    await db.execute(
        "UPDATE conf_sessions SET speaker_id = NULL, topic_id = NULL, title = $1 "
        "WHERE event_id = $2 AND speaker_id = $3",
        "Тема будет уточнена позже", e_id, se_id,
    )
    try:
        from app.api.modules.conference import regenerate_landing_data
        await regenerate_landing_data(e_id, db)
    except Exception:
        pass
    return {"ok": True}


class MyStagesIn(BaseModel):
    stage_ids: List[int] = []


@router.post("/me/stages", summary="Сохранить свои номинации (самовыбор в кабинете)")
async def save_my_stages(
    data: MyStagesIn,
    session: dict = Depends(_auth_session_write),
    db: asyncpg.Connection = Depends(get_db),
):
    """Человек сам отмечает номинации, в которых участвует (миграция 328).

    ⚠️ Всё проверяет СЕРВЕР: разрешение по роли, лимит и принадлежность
    номинаций этому событию. Фронтовой проверки недостаточно — ограничение
    обходится обычным запросом мимо интерфейса.

    ⚠️ Отметки СВЕРХ лимита, проставленные организатором, не режем: он
    отмечал осознанно, и отбирать его настройку задним числом нельзя.
    Поэтому лимит сверяется с тем, сколько человек ДОБАВЛЯЕТ сам.
    """
    from app.services.nominations_limit import effective_limit, self_pick_allowed

    se_id = int(session["se_id"])
    e_id = int(session["e_id"])

    role = await db.fetchval("SELECT role FROM event_collaborators WHERE id = $1", se_id)
    if not await self_pick_allowed(db, e_id, role):
        raise HTTPException(
            status_code=403,
            detail="Организатор не открыл самостоятельный выбор номинаций",
        )

    async with db.transaction():
        # Только номинации ЭТОГО события: по чужому id иначе можно было бы
        # записаться в номинацию посторонней премии.
        wanted = [int(x) for x in (data.stage_ids or [])]
        valid = {r["id"] for r in await db.fetch(
            "SELECT id FROM conf_stages WHERE event_id = $1 AND id = ANY($2::int[])",
            e_id, wanted)} if wanted else set()

        old = {r["stage_id"] for r in await db.fetch(
            "SELECT stage_id FROM event_collaborator_stages WHERE ec_id = $1", se_id)}

        limit = await effective_limit(db, event_id=e_id, ec_id=se_id, role=role)
        if limit is not None and len(valid) > limit and len(valid) > len(old):
            raise HTTPException(status_code=400, detail={
                "code": "nominations_limit",
                "message": f"Вам доступно номинаций: {limit}. Снимите лишние и попробуйте снова.",
                "limit": limit,
            })

        # ⚠️ Снятые номинации с уже выставленными оценками не трогаем: они
        # принадлежат турнирной таблице, и человек не должен стирать чужую
        # работу жюри, просто сняв галочку.
        removed = old - valid
        locked: set[int] = set()
        if removed:
            locked = {r["stage_id"] for r in await db.fetch(
                """SELECT DISTINCT COALESCE(tp.stage_id, -1) AS stage_id
                     FROM tournament_scores ts
                     JOIN tournament_criteria tc ON tc.id = ts.criterion_id
                     JOIN tournament_packages tp ON tp.id = tc.package_id
                    WHERE ts.event_id = $1
                      AND COALESCE(tp.stage_id, -1) = ANY($2::int[])
                      AND ((ts.subject_kind = 'ec' AND ts.subject_id = $3)
                           OR ts.juror_ec_id = $3)""",
                e_id, list(removed), se_id)}

        # Итог = что человек выбрал + заблокированные оценками (они уже были
        # у него, поэтому это не обход лимита, а запрет на потерю данных).
        final = valid | locked
        await db.execute(
            "DELETE FROM event_collaborator_stages WHERE ec_id = $1 AND NOT (stage_id = ANY($2::int[]))",
            se_id, list(final) or [-1])
        if final:
            await db.execute(
                """INSERT INTO event_collaborator_stages (ec_id, stage_id)
                   SELECT $1, s.id FROM conf_stages s
                    WHERE s.id = ANY($2::int[]) AND s.event_id = $3
                   ON CONFLICT DO NOTHING""",
                se_id, list(final), e_id)

    return {
        "ok": True,
        "stage_ids": sorted(final),
        "kept_locked": sorted(locked),
        "limit": limit,
    }
