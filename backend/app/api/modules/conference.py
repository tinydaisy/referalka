from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List, Union
from app.auth import get_current_client
from app.database import get_db
from app.services.speaker_defaults import default_show_flags
from app.services import collaborator_sort
from app.services.webinar_service import day_stream_url
from app.services.client_domains import client_public_link
# ⚠️ Имя спикера собирать ТОЛЬКО этим хелпером: «Имя Фамилия» для показа.
# Голый col.name отдаёт одно имя — фамилия пропадает (миграция 302 вынесла её
# в отдельную колонку last_name).
from app.services.person_name import DISPLAY_NAME_SQL
from app.services.speaker_lead_magnet_stats import speaker_lead_magnet_stats
import asyncpg
import logging
import re
import json
import httpx
from datetime import datetime, date, time, timedelta

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/events/{event_id}/conference", tags=["Конференция"])


_TRANSLIT_MAP = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
}


def slugify(name: str) -> str:
    s = name.lower().strip()
    s = ''.join(_TRANSLIT_MAP.get(ch, ch) for ch in s)
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s_-]+", "-", s).strip('-')
    return s[:60] or 'item'


_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _normalize_hhmm(val):
    """Принимает ввод времени "HH:MM" (или ISO с временем), возвращает строку "HH:MM" либо None."""
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    # Если прилетел ISO datetime — берём час:минута часть напрямую (без TZ-математики).
    if "T" in s:
        s = s.split("T", 1)[1][:5]
    elif len(s) > 5 and s[2] == ":":
        s = s[:5]
    if not _HHMM_RE.match(s):
        raise HTTPException(status_code=422, detail=f"Время должно быть в формате HH:MM, получено: {val!r}")
    return s


async def check_conference_access(event_id: int, client_id: int, db: asyncpg.Connection,
                                  *, write: bool = False):
    """Доступ клиента к событию модуля «Конференции».

    `write=True` — действие МЕНЯЕТ данные (создание, правка, удаление,
    отправка). Такое разрешено только с подключённым модулем: без него
    клиент может смотреть свои данные, но не менять их (2026-08-10).
    Просмотр (`write=False`) не гейтим никогда — это его собственные данные.

    ⚠️ Три роута ниже формально GET, но реально ОТПРАВЛЯЮТ сообщения в
    Telegram (карточка спикера, расписание, подарки розыгрыша) — им тоже
    нужен `write=True`. Гейт «по HTTP-методу» их бы пропустил.
    """
    # Владелец — только через event_owners (events.client_id удалён миграцией 137).
    event = await db.fetchrow(
        "SELECT id, module_slug FROM events WHERE id = $1 AND EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id = events.id AND eo.client_id = $2 AND eo.status='accepted')",
        event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    if write:
        from app.services.module_access import assert_module_write
        await assert_module_write(db, client_id=client_id,
                                  module_slug=event["module_slug"])
    return event


async def _assert_send_allowed(db: asyncpg.Connection, *, client_id: int,
                               event_id: int, token: Optional[str]) -> None:
    """Проверка для эндпоинтов, которые ОТПРАВЛЯЮТ сообщения наружу.

    Два рубежа:
      1. токен интеграции клиента — иначе слать чужим ботом мог бы кто угодно,
         зная только номер события и чата;
      2. подключённый модуль — отправка это платное действие, как и рассылки.
    """
    if not token:
        raise HTTPException(status_code=401, detail="Нужен заголовок X-Integration-Token")
    ok = await db.fetchval(
        "SELECT 1 FROM clients WHERE id = $1 AND integration_token = $2 AND is_active = TRUE",
        client_id, token,
    )
    if not ok:
        raise HTTPException(status_code=403, detail="Токен не подходит к этому событию")

    module_slug = await db.fetchval("SELECT module_slug FROM events WHERE id = $1", event_id)
    from app.services.module_access import assert_module_write
    await assert_module_write(db, client_id=client_id, module_slug=module_slug)


async def ensure_collaborator_contact(collaborator_id: int, db: asyncpg.Connection) -> str:
    """
    Гарантирует что у коллаборатора есть связанный контакт в contacts
    с заполненным ref_code. Возвращает ref_code.

    Логика:
    - Если у collaborators.contact_id уже стоит FK → вернём contacts.ref_code
      (генерим если NULL — но в новой схеме ref_code обязателен при создании contacts).
    - Иначе создаём contact (с уникальным ref_code) и привязываем его к collaborator.

    Личный TG спикера живёт в platform_users (миграция 107) — апсертится отдельно
    через CollaboratorCreate/Update + _upsert_personal_tg в collaborators.py.
    """
    from app.services.contact_merge import _generate_unique_ref_code

    coll = await db.fetchrow(
        "SELECT id, created_by_client_id, contact_id, name FROM collaborators WHERE id = $1",
        collaborator_id
    )
    if not coll:
        raise HTTPException(status_code=404, detail="Коллаборатор не найден")

    contact_id = coll["contact_id"]

    if not contact_id:
        ref_code = await _generate_unique_ref_code(db)
        contact_id = await db.fetchval(
            """INSERT INTO contacts (client_id, name, ref_code, is_active, tags, merged_ref_codes)
               VALUES ($1, $2, $3, TRUE, '[]'::JSONB, '[]'::JSONB)
               RETURNING id""",
            coll["created_by_client_id"], coll["name"], ref_code
        )
        await db.execute(
            "UPDATE collaborators SET contact_id = $1 WHERE id = $2",
            contact_id, coll["id"]
        )
    else:
        ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", contact_id)
        if not ref_code:
            ref_code = await _generate_unique_ref_code(db)
            await db.execute("UPDATE contacts SET ref_code = $1 WHERE id = $2", ref_code, contact_id)

    return ref_code


async def regenerate_landing_data(event_id: int, db: asyncpg.Connection):
    """Собирает JSON-снимок конференции из БД и сохраняет в landing_data."""
    conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
    if not conf:
        return
    event = await db.fetchrow(
        """SELECT e.*,
                  (SELECT chat_url FROM client_broadcast_chats
                     WHERE id = CASE e.primary_chat_platform
                                  WHEN 'vk'  THEN e.vk_chat_ref
                                  WHEN 'max' THEN e.max_chat_ref
                                  ELSE e.tg_chat_ref END) AS chat_url
             FROM events e WHERE e.id = $1""",
        event_id,
    )
    # Спикеры: JOIN глобальной базы + данных участия в событии
    speakers = await db.fetch(
        """SELECT cse.*, btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.photo_url, sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1 AND cse.is_visible = TRUE
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    days = await db.fetch(
        "SELECT * FROM conf_days WHERE event_id = $1 ORDER BY day_number", event_id
    )
    sessions = await db.fetch(
        """SELECT s.*, COALESCE(NULLIF(cst.topic,''), (SELECT NULLIF(t.topic,'') FROM conf_speaker_topics t WHERE t.cse_id = s.speaker_id ORDER BY t.sort_order, t.id LIMIT 1), s.title) AS title,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS speaker_name, cse.role AS speaker_role,
                  sp.title AS speaker_title, sp.photo_url, (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url
           FROM conf_sessions s
           -- is_visible=FALSE («Исключать из Mini App и лендинга») → слот остаётся,
           -- данные скрытого спикера в публичную выдачу не идут.
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id AND cse.is_visible = TRUE
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id
           WHERE s.event_id = $1 ORDER BY s.day, NULLIF(s.start_time,'') NULLS LAST, s.sort_order""",
        event_id
    )
    # Афиши — единый источник истины event_posters
    posters_rows = await db.fetch(
        """SELECT url, orientation FROM event_posters
            WHERE event_id = $1 AND day IS NULL ORDER BY sort, id""",
        event_id
    )
    poster_horizontal = [p["url"] for p in posters_rows if p["orientation"] == "horizontal"]
    poster_vertical   = [p["url"] for p in posters_rows if p["orientation"] == "vertical"]
    poster_square     = [p["url"] for p in posters_rows if p["orientation"] == "square"]

    def dt_str(val):
        # Время теперь хранится как строка "HH:MM" — отдаём её прямо.
        if val is None or val == "":
            return None
        return str(val)[:5]

    def date_str(val):
        if val is None:
            return None
        if isinstance(val, date):
            return val.strftime("%-d %B %Y года")
        return str(val)

    # Ссылка эфира = вебинарная комната ДНЯ (events.stream_url удалён миграцией 233).
    # На каждый день считаем свою ссылку; корень — по первому дню.
    root_stream_url = ""

    schedule = []
    for d in days:
        day_sessions = [s for s in sessions if s["day"] == d["day_number"]]
        day_stream = await day_stream_url(db, event_id, d["day_number"]) or ""
        if not root_stream_url:
            root_stream_url = day_stream
        schedule.append({
            "day": f"День {d['day_number']}",
            "date": date_str(d["day_date"]),
            "stream_url": day_stream,
            "slots": [
                {
                    "time": dt_str(s["start_time"]),
                    "time_end": dt_str(s["end_time"]),
                    "title": s["title"],
                    "speaker": s["speaker_name"],
                    "speaker_role": s["speaker_role"],
                    "speaker_title": s["speaker_title"],
                    "photo_url": s["photo_url"],
                    "gift_title": s.get("gift_after_speech_title"),
                    "gift_url": s.get("gift_after_speech_url"),
                }
                for s in day_sessions
            ]
        })

    landing_data = {
        "id": event["slug"] if event else str(event_id),
        "name": event["title"] if event else "",
        "name_sub": conf["offer"] or "",
        "dates": f"{date_str(conf['start_date'])} — {date_str(conf['end_date'])}" if conf["start_date"] else "",
        "description": (event["description"] if event else "") or "",
        "registration_url": (event["landing_url"] if event else None) or conf["getcourse_form_url"] or "",
        "chat_url": (event["chat_url"] if event else None) or conf["chat_url"] or "",
        "stream_url": root_stream_url,
        "landing_template": conf["landing_template"] or "ivision",
        "speakers": [
            {
                "id": s["id"],
                "name": s["name"],
                "role": s["role"],
                "title": s["title"] or "",
                "photo_url": s["photo_url"] or "",
                "tg_channel_url": s["tg_channel_url"] or "",
                "speaker_topic": s["speaker_topic"] or "",
                "gift_after_speech_title": s.get("gift_after_speech_title") or "",
                "gift_after_speech_url": s.get("gift_after_speech_url") or "",
                "gift_raffle_title": s["gift_raffle_title"] or "",
                "gift_raffle_url": s["gift_raffle_url"] or "",
            }
            for s in speakers
        ],
        "schedule": schedule,
        "poster_horizontal": poster_horizontal,
        "poster_vertical": poster_vertical,
        "poster_square": poster_square,
    }

    await db.execute(
        "UPDATE conf_conferences SET landing_data = $1 WHERE event_id = $2",
        json.dumps(landing_data), event_id
    )
    return landing_data


# ─── Конференция (настройки) ───────────────────────────────────────────────────

class ConferenceUpdate(BaseModel):
    subtitle: Optional[str] = None
    offer: Optional[str] = None
    # description перенесён в events.description (миграция 092). Поле живёт
    # на уровне события, конференции/турниры используют то же поле.
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    landing_url: Optional[str] = None
    landing_template: Optional[str] = None
    # chat_url, stream_url, vip_url пишутся в events, не conf_conferences —
    # источник истины один. Оставлены здесь как поля, чтобы фронт мог
    # отправить их в одном PATCH со всеми остальными настройками.
    # Чаты события — ссылки на client_broadcast_chats (миграция 174)
    tg_chat_ref: Optional[int] = None
    vk_chat_ref: Optional[int] = None
    max_chat_ref: Optional[int] = None
    # Чат СПИКЕРОВ (миграция 437) — закрытый чат команды, отдельный от чата
    # участников: туда уходит «вы следующие» за 15 минут до выступления.
    # ID вводится вручную (/getmyid в чате), URL — только справочно.
    tg_speakers_chat_id: Optional[str] = None
    vk_speakers_chat_id: Optional[str] = None
    max_speakers_chat_id: Optional[str] = None
    tg_speakers_chat_url: Optional[str] = None
    vk_speakers_chat_url: Optional[str] = None
    max_speakers_chat_url: Optional[str] = None
    primary_chat_platform: Optional[str] = None   # 'telegram' | 'vk' | 'max'
    vip_url: Optional[str] = None
    vip_button_label: Optional[str] = None
    offer_url: Optional[str] = None                # оферта ссылкой на чужой сайт (миграция 157)
    offer_id: Optional[int] = None                 # оферта из раздела «Оферты» (миграция 249)
    chat_button_label: Optional[str] = None        # заголовок кнопки чата (миграция 117)
    # Галочка «Офлайн-событие» (миграция 394): показываем адрес и карту
    # вместо кнопки эфира. Явный выбор организатора, а не догадка по
    # заполненному адресу — туда кладут и ссылку на трансляцию.
    is_offline: Optional[bool] = None
    # ⚠️ САМ АДРЕС забыли, а подпись кнопки к нему добавили — и адрес у
    # конференции не сохранялся ВООБЩЕ: Pydantic выбрасывал поле, запрос
    # отвечал 200, в базе оставалось пусто, на лендинге адреса не было.
    # У мероприятия поле в модели есть, поэтому там всё работало, и разница
    # выглядела необъяснимой. Это ровно тот случай, о котором предупреждает
    # комментарий ниже.
    address: Optional[str] = None
    address_button_label: Optional[str] = None
    geo_lat: Optional[float] = None
    geo_lon: Optional[float] = None
    accent_button: Optional[str] = None            # 'vip' | 'chat' | 'none' (миграция 117)
    hide_stream_button: Optional[bool] = None      # скрыть кнопку стрима в Mini App (миграция 128)
    show_welcome_tab: Optional[bool] = None        # показывать вкладку «Интро» (миграция 406)
    # ⚠️ Поля обязаны быть ЗДЕСЬ, а не только в списке EVENT_FIELDS: Pydantic
    # выбрасывает всё, чего нет в модели, — запрос отвечал 200, а значение до
    # базы не доходило.
    thanks_destination: Optional[str] = None       # куда вести после оплаты (261)
    registration_mode: Optional[str] = None        # форма | наш лендинг | чужой сайт (262)
    end_action: Optional[str] = None               # 'next_event' | 'gift' (миграция 195)
    end_gift_lead_magnet_id: Optional[int] = None
    end_gift_package_id: Optional[int] = None
    getcourse_form_url: Optional[str] = None
    require_speakers_sub: Optional[bool] = None
    subscription_mode: Optional[str] = None   # none | organizer | all_speakers
    is_live: Optional[bool] = None
    status: Optional[str] = None
    test_telegram_ids: Optional[List[str]] = None
    raffle_url: Optional[str] = None
    chat_greeting_enabled: Optional[bool] = None  # приветствие в чатах (миграция 163)
    chat_greeting_keyword: Optional[str] = None   # кодовое слово приветствия
    chat_greeting_exact: Optional[bool] = None    # точное / любое вхождение
    # Этапы по умолчанию для новых спикеров турнира (миграция 184)
    default_speaker_stage_ids: Optional[List[int]] = None
    # Самовыбор номинаций в кабинете + потолок на человека (миграция 328).
    # Две отдельные галочки: номинант покупает участие, жюри приглашают —
    # правила у них разные. Потолок NULL = без ограничений.
    self_pick_stages_speakers: Optional[bool] = None
    self_pick_stages_jury: Optional[bool] = None
    max_nominations_speakers: Optional[int] = None
    max_nominations_jury: Optional[int] = None
    # Что человек видит в своей форме — значения по умолчанию для НОВЫХ
    # карточек (миграция 336). Уже заведённые не трогаются: заданное лично
    # главнее общей настройки.
    default_show_topic_field: Optional[bool] = None
    default_show_gift_after_speech_field: Optional[bool] = None
    default_show_knowledge_base_field: Optional[bool] = None
    default_show_notes_field: Optional[bool] = None
    default_show_partner_registration_link: Optional[bool] = None


@router.get("/", summary="Данные конференции")
async def get_conference(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    conf = await db.fetchrow(
        """
        SELECT cc.*, e.title as event_title,
               e.slug        AS event_slug,
               e.status      AS event_status,
               e.module_slug AS module_slug,
               (SELECT chat_url FROM client_broadcast_chats
                  WHERE id = CASE e.primary_chat_platform
                               WHEN 'vk'  THEN e.vk_chat_ref
                               WHEN 'max' THEN e.max_chat_ref
                               ELSE e.tg_chat_ref END) AS event_chat_url,
               (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS event_chat_url_tg,
               (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS event_chat_url_vk,
               (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS event_chat_url_max,
               e.primary_chat_platform AS event_primary_chat_platform,
               e.vip_url     AS event_vip_url,
               e.vip_button_label AS event_vip_button_label,
               e.offer_url   AS event_offer_url,
               e.offer_id    AS event_offer_id,
               e.chat_button_label AS event_chat_button_label,
               e.is_offline, e.address, e.address_button_label, e.geo_lat, e.geo_lon,
               e.accent_button AS event_accent_button,
               e.hide_stream_button AS event_hide_stream_button,
               e.show_welcome_tab AS event_show_welcome_tab,
               e.disabled_platforms AS event_disabled_platforms,
               e.landing_url AS event_landing_url,
               (SELECT chat_id FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS event_tg_chat_id,
               (SELECT chat_id FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS event_vk_chat_id,
               (SELECT chat_id FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS event_max_chat_id,
               e.tg_chat_ref, e.vk_chat_ref, e.max_chat_ref,
               e.tg_speakers_chat_id, e.vk_speakers_chat_id, e.max_speakers_chat_id,
               e.tg_speakers_chat_url, e.vk_speakers_chat_url, e.max_speakers_chat_url,
               e.thanks_destination AS event_thanks_destination,
               e.registration_mode AS event_registration_mode,
               e.skip_contact_form AS event_skip_contact_form,
               e.end_action AS event_end_action,
               e.end_gift_lead_magnet_id AS event_end_gift_lead_magnet_id,
               e.end_gift_package_id AS event_end_gift_package_id
        FROM conf_conferences cc
        JOIN events e ON e.id = cc.event_id
        WHERE cc.event_id = $1
        """,
        event_id
    )
    if not conf:
        return {"conference": None}
    d = dict(conf)
    # chat_url / vip_url / landing_url — единый источник истины events.
    d["chat_url"]      = d.pop("event_chat_url")     or d.get("chat_url") or ""
    d["chat_url_tg"]   = d.pop("event_chat_url_tg")  or ""
    d["chat_url_vk"]   = d.pop("event_chat_url_vk")  or ""
    d["chat_url_max"]  = d.pop("event_chat_url_max") or ""
    d["primary_chat_platform"] = d.pop("event_primary_chat_platform") or None
    # Ссылка эфира = вебинарная комната по первому дню (events.stream_url удалён, миграция 233)
    d["stream_url"] = await day_stream_url(db, event_id, None) or ""
    d["vip_url"]    = d.pop("event_vip_url")    or ""
    d["vip_button_label"] = d.pop("event_vip_button_label") or ""
    d["offer_url"]    = d.pop("event_offer_url")    or ""
    d["offer_id"]     = d.pop("event_offer_id")
    d["chat_button_label"] = d.pop("event_chat_button_label") or ""
    d["accent_button"]     = d.pop("event_accent_button") or None
    d["hide_stream_button"] = bool(d.pop("event_hide_stream_button"))
    d["show_welcome_tab"] = bool(d.pop("event_show_welcome_tab"))
    # Способ регистрации и связанные поля живут в events, а страница настроек
    # читает их отсюда — без распаковки выбор в списке всегда сбрасывался.
    d["thanks_destination"] = d.pop("event_thanks_destination", None) or "bots"
    d["registration_mode"] = d.pop("event_registration_mode", None)
    d["skip_contact_form"] = bool(d.pop("event_skip_contact_form", None))
    d["disabled_platforms"] = list(d.pop("event_disabled_platforms", None) or [])
    d["end_action"] = d.pop("event_end_action", None) or "next_event"
    d["end_gift_lead_magnet_id"] = d.pop("event_end_gift_lead_magnet_id", None)
    d["end_gift_package_id"] = d.pop("event_end_gift_package_id", None)
    d["tg_chat_id"] = d.pop("event_tg_chat_id", None) or ""
    d["vk_chat_id"] = d.pop("event_vk_chat_id", None) or ""
    d["max_chat_id"] = d.pop("event_max_chat_id", None) or ""
    # event_landing_url — для шаблонов рассылок и превью; conf_conferences.landing_url
    # (если осталось) — это устаревший шаблон встроенного лендинга, не путать.
    d["event_landing_url"] = d.pop("event_landing_url") or ""
    # Готовая ссылка регистрации — тем же резолвером, что и в рассылках
    # ({landing_url}). Фронт-превью берёт её отсюда, а не собирает само:
    # у события со своим лендингом (сторонний пуст) в превью была пустота.
    from app.services.message_builder import resolve_landing_url
    d["registration_link"] = await resolve_landing_url(db, event_id)
    # Ссылки эфира ПО ДНЯМ — той же общей day_stream_url, что при отправке.
    # ⚠️ Фронт-превью НЕ собирает адрес сам: у события может быть сторонний
    # вебинар (тогда ссылка чужая) или комнаты может не быть вовсе (тогда
    # пусто и превью должно ругаться). Раньше фронт всегда склеивал
    # pluson.ru/webinar/{slug}/{day} — показывал несуществующую комнату.
    _days = await db.fetch(
        "SELECT day_number FROM conf_days WHERE event_id=$1 ORDER BY day_number", event_id)
    d["stream_links"] = {
        str(r["day_number"]): (await day_stream_url(db, event_id, r["day_number"]) or "")
        for r in _days
    }
    return {"conference": d}


@router.post("/init", summary="Инициализировать конференцию")
async def init_conference(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    existing = await db.fetchrow("SELECT id FROM conf_conferences WHERE event_id = $1", event_id)
    if existing:
        conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
        return {"conference": dict(conf)}
    conf = await db.fetchrow(
        "INSERT INTO conf_conferences (event_id) VALUES ($1) RETURNING *", event_id
    )
    return {"conference": dict(conf)}


@router.patch("/", summary="Обновить настройки конференции")
async def update_conference(
    event_id: int,
    data: ConferenceUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)

    # Создаём если не существует
    existing = await db.fetchrow("SELECT id FROM conf_conferences WHERE event_id = $1", event_id)
    if not existing:
        await db.execute("INSERT INTO conf_conferences (event_id) VALUES ($1)", event_id)

    raw = data.model_dump(exclude_unset=True)
    # Поля, которые живут в events (не в conf_conferences) — единый источник истины.
    EVENT_FIELDS = (
        "primary_chat_platform",
        "vip_url", "vip_button_label", "offer_url", "offer_id",
        "chat_button_label", "accent_button", "hide_stream_button", "show_welcome_tab",
        "is_offline", "address", "address_button_label", "geo_lat", "geo_lon",
        # Выключенные площадки события (миграция 263)
        "disabled_platforms",
        # Куда вести со страницы после оплаты (миграция 261)
        "thanks_destination",
        # Способ регистрации и галочка регистрации на нашем лендинге (262)
        "registration_mode",
        # Что показывать на «Итогах» при завершении (миграция 195)
        "end_action", "end_gift_lead_magnet_id", "end_gift_package_id",
        # Чаты события — ссылки на client_broadcast_chats (миграция 174)
        "tg_chat_ref", "vk_chat_ref", "max_chat_ref",
        "tg_speakers_chat_id", "vk_speakers_chat_id", "max_speakers_chat_id",
        "tg_speakers_chat_url", "vk_speakers_chat_url", "max_speakers_chat_url",
        "chat_greeting_enabled", "chat_greeting_keyword", "chat_greeting_exact",
    )
    sent = data.model_dump(exclude_unset=True)
    event_updates: dict = {}
    for f in EVENT_FIELDS:
        if f in raw:
            val = raw.pop(f)
            # Для строковых *_url полей нормализуем пустую строку в NULL
            if f in ("vip_url", "vip_button_label") and isinstance(val, str):
                val = val.strip() or None
            event_updates[f] = val

    # Оферта события — документ из раздела «Оферты». Проверяем ВЛАДЕНИЕ:
    # иначе, зная id, можно повесить на своё событие чужую оферту.
    # 0 / null — снять привязку (остаётся ссылка offer_url, если задана).
    if "offer_id" in event_updates:
        v = event_updates["offer_id"]
        if not v:
            event_updates["offer_id"] = None
        else:
            own = await db.fetchval(
                "SELECT id FROM client_offers WHERE id = $1 AND client_id = $2",
                int(v), int(client["sub"]),
            )
            if not own:
                raise HTTPException(status_code=404, detail="Оферта не найдена")
            event_updates["offer_id"] = int(v)

    # end_action / подарок при завершении: валидация + взаимоисключение (миграция 195)
    if "end_action" in event_updates:
        v = event_updates["end_action"]
        if v is None:
            del event_updates["end_action"]
        elif v not in ("next_event", "gift"):
            raise HTTPException(status_code=400, detail="end_action должен быть 'next_event' или 'gift'")
    if event_updates.get("end_gift_lead_magnet_id"):
        event_updates["end_gift_lead_magnet_id"] = int(event_updates["end_gift_lead_magnet_id"])
        event_updates["end_gift_package_id"] = None
    elif event_updates.get("end_gift_package_id"):
        event_updates["end_gift_package_id"] = int(event_updates["end_gift_package_id"])
        event_updates["end_gift_lead_magnet_id"] = None
    else:
        if "end_gift_lead_magnet_id" in event_updates and not event_updates["end_gift_lead_magnet_id"]:
            event_updates["end_gift_lead_magnet_id"] = None
        if "end_gift_package_id" in event_updates and not event_updates["end_gift_package_id"]:
            event_updates["end_gift_package_id"] = None

    # Потолок номинаций на человека (миграция 328). Пусто/0/мусор = без
    # ограничений: клиент стирает поле именно чтобы снять лимит, и падать
    # на этом нельзя. Верхний край («не больше, чем есть номинаций»)
    # проверяется при выборе, а не здесь: номинации добавляют и после.
    for f in ("max_nominations_speakers", "max_nominations_jury"):
        if f in raw:
            try:
                v = int(raw[f]) if raw[f] not in (None, "") else None
            except (TypeError, ValueError):
                v = None
            raw[f] = v if (v is not None and v > 0) else None

    if raw:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(raw.keys())]
        await db.execute(
            f"UPDATE conf_conferences SET {', '.join(set_parts)} WHERE event_id = $1",
            event_id, *raw.values()
        )

    if event_updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(event_updates.keys())]
        await db.execute(
            f"UPDATE events SET {', '.join(set_parts)} WHERE id = $1",
            event_id, *event_updates.values()
        )
        # (chat_url теперь вычисляется из ref при чтении — shadow-пересчёт не нужен)

        # ⚠️⚠️ Галочка «офлайн» сама включает секцию «Место проведения» на
        # лендинге — то же правило, что у мероприятия (см. events.py). Клиент
        # уже сказал формат в настройках; заставлять его вспоминать про секцию
        # в конструкторе нельзя — он решит, что карты на лендинге нет вовсе.
        if "is_offline" in event_updates:
            await db.execute(
                """UPDATE event_landing_blocks b SET is_active = $2
                     FROM event_landing_pages p
                    WHERE b.page_id = p.id AND p.event_id = $1 AND b.kind = 'venue'""",
                event_id, bool(event_updates["is_offline"]),
            )

    await regenerate_landing_data(event_id, db)
    # Возвращаем тот же обогащённый объект что и в GET /conference/ —
    # с подменой chat_url/stream_url/vip_url/event_landing_url из events.
    # Иначе frontend в SettingsTab перезаливает state из response и теряет
    # эти поля (они не лежат в conf_conferences).
    conf = await db.fetchrow(
        """
        SELECT cc.*, e.title AS event_title,
               (SELECT chat_url FROM client_broadcast_chats
                  WHERE id = CASE e.primary_chat_platform
                               WHEN 'vk'  THEN e.vk_chat_ref
                               WHEN 'max' THEN e.max_chat_ref
                               ELSE e.tg_chat_ref END) AS event_chat_url,
               (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS event_chat_url_tg,
               (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS event_chat_url_vk,
               (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS event_chat_url_max,
               e.primary_chat_platform AS event_primary_chat_platform,
               e.vip_url     AS event_vip_url,
               e.vip_button_label AS event_vip_button_label,
               e.offer_url   AS event_offer_url,
               e.offer_id    AS event_offer_id,
               e.chat_button_label AS event_chat_button_label,
               e.is_offline, e.address, e.address_button_label, e.geo_lat, e.geo_lon,
               e.accent_button AS event_accent_button,
               e.hide_stream_button AS event_hide_stream_button,
               e.show_welcome_tab AS event_show_welcome_tab,
               e.disabled_platforms AS event_disabled_platforms,
               e.landing_url AS event_landing_url,
               (SELECT chat_id FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS event_tg_chat_id,
               (SELECT chat_id FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS event_vk_chat_id,
               (SELECT chat_id FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS event_max_chat_id,
               e.tg_chat_ref, e.vk_chat_ref, e.max_chat_ref,
               e.tg_speakers_chat_id, e.vk_speakers_chat_id, e.max_speakers_chat_id,
               e.tg_speakers_chat_url, e.vk_speakers_chat_url, e.max_speakers_chat_url,
               e.end_action AS event_end_action,
               e.end_gift_lead_magnet_id AS event_end_gift_lead_magnet_id,
               e.end_gift_package_id AS event_end_gift_package_id
        FROM conf_conferences cc
        JOIN events e ON e.id = cc.event_id
        WHERE cc.event_id = $1
        """,
        event_id,
    )
    d = dict(conf)
    d["chat_url"]          = d.pop("event_chat_url")   or d.get("chat_url") or ""
    d["chat_url_tg"]       = d.pop("event_chat_url_tg")  or ""
    d["chat_url_vk"]       = d.pop("event_chat_url_vk")  or ""
    d["chat_url_max"]      = d.pop("event_chat_url_max") or ""
    d["primary_chat_platform"] = d.pop("event_primary_chat_platform") or None
    # Ссылка эфира = вебинарная комната по первому дню (events.stream_url удалён, миграция 233)
    d["stream_url"]        = await day_stream_url(db, event_id, None) or ""
    d["vip_url"]           = d.pop("event_vip_url")    or ""
    d["vip_button_label"]  = d.pop("event_vip_button_label") or ""
    d["offer_url"]         = d.pop("event_offer_url")  or ""
    d["offer_id"]          = d.pop("event_offer_id")
    d["chat_button_label"] = d.pop("event_chat_button_label") or ""
    d["accent_button"]     = d.pop("event_accent_button") or None
    d["hide_stream_button"] = bool(d.pop("event_hide_stream_button"))
    d["show_welcome_tab"] = bool(d.pop("event_show_welcome_tab"))
    d["disabled_platforms"] = list(d.pop("event_disabled_platforms", None) or [])
    d["end_action"] = d.pop("event_end_action", None) or "next_event"
    d["end_gift_lead_magnet_id"] = d.pop("event_end_gift_lead_magnet_id", None)
    d["end_gift_package_id"] = d.pop("event_end_gift_package_id", None)
    d["event_landing_url"] = d.pop("event_landing_url") or ""
    d["tg_chat_id"] = d.pop("event_tg_chat_id", None) or ""
    d["vk_chat_id"] = d.pop("event_vk_chat_id", None) or ""
    d["max_chat_id"] = d.pop("event_max_chat_id", None) or ""
    return {"conference": d}


@router.post("/regenerate-landing", summary="Пересобрать JSON лендинга")
async def regenerate_landing(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    data = await regenerate_landing_data(event_id, db)
    return {"landing_data": data, "message": "JSON лендинга обновлён"}


# ─── Спикеры события (event_collaborators) ────────────────────────────────────
# Личные данные (фото, регалии, контакты) хранятся в таблице speakers (глобально).
# Здесь — только то, что специфично для конкретного события: роль, тема, подарок.

class SpeakerAddToEvent(BaseModel):
    """Добавить спикера из глобальной базы в событие."""
    speaker_id: int
    role: str = "speaker"
    speaker_topic: Optional[str] = None  # устаревшее, оставлено для совместимости
    # Темы выступления. Элемент — строка (только название) ЛИБО объект
    # {topic, description}: описание хранится отдельно, в программу и в
    # заголовок письма идёт только название.
    topics: Optional[List[Union[str, dict]]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    # Какая афиша из библиотеки коллаба используется в этом событии
    # (для рассылок, виджетов, Mini App). NULL = первая из библиотеки.
    poster_id: Optional[int] = None
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    notes: Optional[str] = None
    is_commercial: bool = False
    is_visible: bool = True
    sort_order: int = 0


class SpeakerCreateAndAdd(BaseModel):
    """Создать нового спикера в базе и сразу добавить в событие."""
    # Глобальные данные спикера
    name: str
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    # Личные идентичности — пишутся в platform_users (миграции 107/108).
    # Обязательна минимум одна из платформ — валидация в обработчике.
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    # Данные участия в этом событии
    role: str = "speaker"
    speaker_topic: Optional[str] = None  # устаревшее, оставлено для совместимости
    # Темы выступления. Элемент — строка (только название) ЛИБО объект
    # {topic, description}: описание хранится отдельно, в программу и в
    # заголовок письма идёт только название.
    topics: Optional[List[Union[str, dict]]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    # poster_id выбирается в карточке спикера после создания (тут нет
    # библиотеки афиш, потому что коллаб только что родился).
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    notes: Optional[str] = None
    is_commercial: bool = False
    is_visible: bool = True
    sort_order: int = 0
    # Дедуп по имени: если у клиента уже есть контакт с таким именем —
    # без force_create эндпоинт вернёт needs_choice с вариантами для UI.
    # Если клиент выбрал «привязать к существующему» — передаёт existing_contact_id.
    force_create: bool = False
    existing_contact_id: Optional[int] = None


class SpeakerEventUpdate(BaseModel):
    """Обновить данные участия спикера в событии (тема, подарок, роль и т.д.)"""
    role: Optional[str] = None
    speaker_topic: Optional[str] = None  # устаревшее, оставлено для совместимости
    # Темы выступления. Элемент — строка (только название) ЛИБО объект
    # {topic, description}: описание хранится отдельно, в программу и в
    # заголовок письма идёт только название.
    topics: Optional[List[Union[str, dict]]] = None
    # В каких этапах турнира участвует (поимённая привязка к conf_stages).
    # Управляет видимостью в кабинете, распределении и турнирной таблице.
    stage_ids: Optional[List[int]] = None
    # При снятии этапа с уже проставленными оценками нужно подтверждение —
    # force=True разрешает удалить оценки+назначения снятых этапов.
    force_remove_stage_data: Optional[bool] = None
    # Сколько номинаций доступно человеку в ЭТОМ событии (миграция 328).
    # Заполняется при оплате тарифа и подтягивается за отметками организатора;
    # правится и руками — например, по бартеру. NULL = без ограничений.
    # ⚠️ Присылать вместе со stage_ids нельзя: синхронизация с отметками
    # затрёт ручное число. Фронт шлёт что-то одно.
    nominations_limit: Optional[int] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    # Подарок-лид-магнит из ПЛЮСОН (для подсчёта баллов в турнире). Взаимоисключимы
    # с ручным подарком: выбор ПЛЮСОН-магнита чистит ручные поля, ручной ввод —
    # снимает ПЛЮСОН-подарки. gift_lead_magnet_id=0 → снять обе ПЛЮСОН-привязки.
    gift_lead_magnet_id: Optional[int] = None
    gift_package_id: Optional[int] = None
    # ⚠️ Снять ПЛЮСОН-ПОДАРКИ спикера (список event_collaborator_lead_magnets +
    # gift_lead_magnet_id/gift_package_id), НЕ трогая привязку linked_client_id
    # (её снимает только спикер в своём кабинете). Веб-дашборд шлёт это при
    # переключении вкладки подарка «ПЛЮСОН → вручную».
    clear_pluson_gifts: Optional[bool] = None
    # Список подарков спикера (до 4): magnet/package/manual. Полностью переписывает
    # event_collaborator_lead_magnets. В дашборде организатор задаёт РУЧНЫЕ подарки
    # (kind='manual', title+url) — для спикеров без ПЛЮСОНа. ПЛЮСОН-строки из веба
    # не шлём (их настраивает спикер в кабинете).
    gift_lead_magnets: Optional[list] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    knowledge_base_title: Optional[str] = None
    knowledge_base_url: Optional[str] = None
    show_topic_field: Optional[bool] = None
    show_gift_after_speech_field: Optional[bool] = None
    show_knowledge_base_field: Optional[bool] = None
    # Показывать ли спикеру поле «Заметки» в его кабинете (миграция 201).
    show_notes_field: Optional[bool] = None
    # Показывать ли спикеру в его кабинете блок «Регистрация партнёром»
    # клиента (миграция 123). Default TRUE; при саморегистрации через
    # бот выставляется FALSE — самозаписавшимся партнёрку не агитируем
    # до явной отметки клиентом.
    show_partner_registration_link: Optional[bool] = None
    # Какая афиша из библиотеки коллаба используется в этом событии для
    # рассылок бота (speaker_intro / 5min_before / gift). NULL = первая
    # из библиотеки. См. миграцию 121.
    poster_id: Optional[int] = None
    # Какие афиши из библиотеки коллаба отмечены «для анонсов» в этом событии.
    # Видны спикеру в его кабинете в разделе «Афиши для анонсов» —
    # скачивает и постит в своих каналах. Множественный выбор. Миграция 122.
    announcement_poster_ids: Optional[List[int]] = None
    # TRUE = в этом событии индивидуальные афиши спикера не используются вовсе:
    # везде (рассылки, лендинг, кабинет спикера, экспорт) берётся обычное фото
    # коллаборатора. Библиотека афиш при этом сохраняется. Миграция 237.
    use_photo_instead_of_poster: Optional[bool] = None
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    notes: Optional[str] = None
    is_commercial: Optional[bool] = None
    is_visible: Optional[bool] = None
    sort_order: Optional[int] = None
    bot_in_channel: Optional[bool] = None
    priority: Optional[int] = None
    exclude_gift_from_broadcast: Optional[bool] = None
    exclude_channel_from_subscription: Optional[bool] = None


def _speaker_row_to_dict(row) -> dict:
    """Объединяет данные из speakers + event_collaborators в один объект."""
    d = dict(row)
    return d


async def _load_topics(cse_ids: list, db) -> dict:
    """Загружает темы для списка event_collaborators.id. Возвращает {cse_id: [{id, topic}, ...]}."""
    if not cse_ids:
        return {}
    rows = await db.fetch(
        "SELECT id, cse_id, topic, description FROM conf_speaker_topics "
        "WHERE cse_id = ANY($1::int[]) ORDER BY cse_id, sort_order",
        cse_ids
    )
    result: dict = {}
    for r in rows:
        result.setdefault(r["cse_id"], []).append(
            {"id": r["id"], "topic": r["topic"], "description": r["description"] or ""})
    return result


async def ensure_speaker_topic_placeholder(db, cse_id: int) -> int:
    """Гарантирует, что у спикера есть хотя бы ОДНА запись-тема, и возвращает
    её id. Если тем нет — создаёт заглушку с пустым текстом.

    Смысл: слот в программе привязывается к теме по её ПОСТОЯННОМУ id
    (conf_sessions.topic_id). Пока у спикера всегда есть тема-запись, слот
    можно привязать к ней сразу при занятии — даже если текст ещё не задан.
    Спикер впишет текст позже (UPDATE по тому же id), привязка слота не слетит.
    """
    tid = await db.fetchval(
        "SELECT id FROM conf_speaker_topics WHERE cse_id = $1 ORDER BY sort_order, id LIMIT 1",
        cse_id,
    )
    if tid is None:
        tid = await db.fetchval(
            "INSERT INTO conf_speaker_topics (cse_id, topic, sort_order) VALUES ($1, '', 0) RETURNING id",
            cse_id,
        )
    return tid


async def _rewrite_speaker_topics(db, cse_id: int, topics: list) -> None:
    """Единая точка правки тем спикера — из дашборда и из кабинета спикера.

    ⚠️ Правим темы ПО ID, а не «удалить всё → создать заново». Слот привязан к
    теме по её id (conf_sessions.topic_id); пересоздание меняет id и рвёт
    привязку — в т.ч. если слот указывал на 2-ю/3-ю тему, выбранную вручную.
    Поэтому переиспользуем существующие записи по порядку: первым N обновляем
    текст (id сохраняются), лишние в хвосте удаляем, недостающие добавляем.
    Тема №1 существует всегда — если тем не осталось, держим её пустой
    (заглушка для привязки слота).

    Элемент списка — либо строка (старый формат: только название), либо словарь
    {topic, description}. Описание (что будет на выступлении) хранится отдельно
    от названия: в ПРОГРАММУ (лендинг, Mini App, веб, слоты) и в заголовок письма
    идёт только название, описание — в тело рассылки и на карточку спикера.
    """
    def _split(t):
        if isinstance(t, dict):
            return (t.get("topic") or "").strip(), (t.get("description") or "").strip()
        return (t or "").strip(), ""

    # Пустое НАЗВАНИЕ = темы нет (описание без названия не имеет смысла).
    clean = [(name, desc) for name, desc in (_split(t) for t in (topics or [])) if name]

    rows = await db.fetch(
        "SELECT id FROM conf_speaker_topics WHERE cse_id = $1 ORDER BY sort_order, id",
        cse_id,
    )
    ids = [r["id"] for r in rows]
    if not ids:
        ids = [await db.fetchval(
            "INSERT INTO conf_speaker_topics (cse_id, topic, sort_order) VALUES ($1, '', 0) RETURNING id",
            cse_id,
        )]

    # Что записываем: реальные темы, а если их нет — одну пустую (заглушку).
    texts = clean if clean else [("", "")]

    for i, (name, desc) in enumerate(texts):
        if i < len(ids):
            await db.execute(
                "UPDATE conf_speaker_topics SET topic = $1, description = $2, sort_order = $3 WHERE id = $4",
                name, (desc or None), i, ids[i],
            )
        else:
            await db.execute(
                "INSERT INTO conf_speaker_topics (cse_id, topic, description, sort_order) VALUES ($1, $2, $3, $4)",
                cse_id, name, (desc or None), i,
            )
    if len(ids) > len(texts):
        await db.execute(
            "DELETE FROM conf_speaker_topics WHERE id = ANY($1::int[])", ids[len(texts):],
        )

    # event_collaborators.speaker_topic — денормализованное НАЗВАНИЕ (без описания):
    # оно уходит в программу и в заголовки, описание туда не идёт.
    await db.execute(
        "UPDATE event_collaborators SET speaker_topic = $1 WHERE id = $2",
        (clean[0][0] if clean else ""), cse_id,
    )

    # ⚠️ Спикер мог занять слот РАНЬШЕ, чем появилась тема (или тему вписал
    # организатор в дашборде — раньше эта ветка была только в кабинете спикера,
    # из-за чего слот, занятый до темы, оставался с «Тема будет уточнена позже»).
    # Как только у спикера появилась первая непустая тема — привязываем её к его
    # слоту, если тот ещё без темы. Работает из ВСЕХ точек правки тем: дашборд,
    # кабинет спикера, импорт.
    if clean:
        await db.execute(
            """
            UPDATE conf_sessions cs
               SET topic_id = t.id,
                   title    = t.topic
              FROM (SELECT id, topic FROM conf_speaker_topics
                     WHERE cse_id = $1 AND NULLIF(topic,'') IS NOT NULL
                     ORDER BY sort_order, id LIMIT 1) t
             WHERE cs.speaker_id = $1 AND cs.topic_id IS NULL
            """,
            cse_id,
        )


async def _save_topics(cse_id: int, topics: list, db) -> None:
    """Полностью заменяет темы спикера в событии (обёртка над общим хелпером)."""
    await _rewrite_speaker_topics(db, cse_id, topics)


async def save_ec_gifts(db, ec_id: int, items: list, linked_client_id: int | None) -> None:
    """Полностью переписывает список подарков спикера (до 4) в
    event_collaborator_lead_magnets. Строка — ОДИН из трёх видов:
      • {'kind':'magnet','id':N}  — ПЛЮСОН-лид-магнит (проверяется по linked_client_id)
      • {'kind':'package','id':N} — ПЛЮСОН-пакет (проверяется по linked_client_id)
      • {'kind':'manual','title':..,'url':..} — ручной подарок (оба поля обязательны)
    Синхронизирует legacy gift_lead_magnet_id/gift_package_id с ПЕРВОЙ ПЛЮСОН-строкой.
    ⚠️ Привязку linked_client_id НЕ трогает.
    """
    items = items or []
    # ⚠️ Подарков может быть МНОГО — и ручных, и плюсоновских, одновременно.
    # Прежний предел 4 не давал спикеру выложить весь свой набор. Оставляем
    # только защиту от явного мусора (случайная пакетная вставка).
    if len(items) > 30:
        raise HTTPException(status_code=400, detail="Слишком много подарков — не больше 30")
    clean = []  # [(kind, id|None, title|None, url|None)]
    for it in items:
        kind = (it or {}).get("kind")
        if kind == "manual":
            title = ((it or {}).get("title") or "").strip()
            url = ((it or {}).get("url") or "").strip()
            # ⚠️ ХВАТАЕТ НАЗВАНИЯ. Ссылка обязательной быть не может: подарок
            # часто отдают руками после эфира, а в карточке и рассылке нужно
            # только название. Прежнее правило «оба поля» молча отбивало
            # сохранение (жалоба 16.09.2026).
            if not title and not url:
                raise HTTPException(status_code=400, detail="У ручного подарка нужно хотя бы название")
            clean.append(("manual", None, title, url))
            continue
        try:
            iid = int((it or {}).get("id") or 0)
        except (ValueError, TypeError):
            iid = 0
        if iid <= 0 or kind not in ("magnet", "package"):
            continue
        # ПЛЮСОН-подарок — только из привязанного аккаунта спикера.
        if kind == "magnet":
            ok = await db.fetchval("SELECT 1 FROM lead_magnets WHERE id=$1 AND client_id=$2", iid, linked_client_id)
            if not ok:
                raise HTTPException(status_code=400, detail="Лид-магнит не найден в ПЛЮСОН-аккаунте спикера")
        else:
            ok = await db.fetchval("SELECT 1 FROM lead_magnet_packages WHERE id=$1 AND client_id=$2", iid, linked_client_id)
            if not ok:
                raise HTTPException(status_code=400, detail="Пакет не найден в ПЛЮСОН-аккаунте спикера")
        clean.append((kind, iid, None, None))

    await db.execute("DELETE FROM event_collaborator_lead_magnets WHERE ec_id=$1", ec_id)
    for idx, (kind, iid, title, url) in enumerate(clean):
        if kind == "magnet":
            await db.execute(
                "INSERT INTO event_collaborator_lead_magnets (ec_id, lead_magnet_id, sort_order) VALUES ($1,$2,$3)",
                ec_id, iid, idx)
        elif kind == "package":
            await db.execute(
                "INSERT INTO event_collaborator_lead_magnets (ec_id, package_id, sort_order) VALUES ($1,$2,$3)",
                ec_id, iid, idx)
        else:  # manual
            await db.execute(
                "INSERT INTO event_collaborator_lead_magnets (ec_id, manual_title, manual_url, sort_order) VALUES ($1,$2,$3,$4)",
                ec_id, title, url, idx)

    # legacy gift_lead_magnet_id/gift_package_id — по первой ПЛЮСОН-строке (для
    # старого кода/medialift). Если ПЛЮСОН-строк нет — обнуляем.
    first_pluson = next(((k, i) for k, i, _, _ in clean if k in ("magnet", "package")), None)
    if first_pluson and first_pluson[0] == "magnet":
        await db.execute("UPDATE event_collaborators SET gift_lead_magnet_id=$2, gift_package_id=NULL WHERE id=$1", ec_id, first_pluson[1])
    elif first_pluson and first_pluson[0] == "package":
        await db.execute("UPDATE event_collaborators SET gift_package_id=$2, gift_lead_magnet_id=NULL WHERE id=$1", ec_id, first_pluson[1])
    else:
        await db.execute("UPDATE event_collaborators SET gift_lead_magnet_id=NULL, gift_package_id=NULL WHERE id=$1", ec_id)



async def _save_single_gift_to_list(db, ec_id: int, title, url) -> None:
    """Одиночный подарок из payload → В СПИСОК event_collaborator_lead_magnets.

    ⚠️ Колонок gift_after_speech_title/url в таблице БОЛЬШЕ НЕТ (перенос
    2026-07-30): подарков может быть много и любого вида, они живут в списке.
    Пустые название+ссылка = очистка РУЧНЫХ подарков (плюсоновские спикера
    не трогаем — их привязывает он сам в своём кабинете).
    """
    t = (title or "").strip()
    u = (url or "").strip()
    # ⚠️⚠️ ХВАТАЕТ ОДНОГО ПОЛЯ, а не обоих. Раньше стояло `if t and u` — и
    # подарок с названием без ссылки (или наоборот) НЕ СОХРАНЯЛСЯ ВОВСЕ: он не
    # попадал ни в эту ветку, ни в ветку очистки ниже. Для спикера это выглядело
    # так, что кнопка «Сохранить» просто ничего не делает.
    #
    # ⚠️ Ссылка обязательной быть не может: подарок часто отдают руками после
    # эфира, а в карточке и рассылке нужно только НАЗВАНИЕ.
    if t or u:
        # ⚠️ НЕ save_ec_gifts: она перезаписывает ВЕСЬ список и снесла бы
        # плюсоновские подарки спикера. Меняем только ручную часть.
        await db.execute(
            "DELETE FROM event_collaborator_lead_magnets "
            " WHERE ec_id=$1 AND manual_title IS NOT NULL", ec_id)
        await db.execute(
            "INSERT INTO event_collaborator_lead_magnets (ec_id, manual_title, manual_url, sort_order) "
            "VALUES ($1, $2, $3, COALESCE((SELECT max(sort_order)+1 FROM "
            "  event_collaborator_lead_magnets WHERE ec_id=$1), 0))",
            ec_id, t, u)
    elif not t and not u:
        await db.execute(
            "DELETE FROM event_collaborator_lead_magnets "
            " WHERE ec_id=$1 AND manual_title IS NOT NULL", ec_id)


async def apply_default_speaker_stages(ec_id: int, event_id: int, db) -> None:
    """Стартовые настройки нового спикера: этапы «по умолчанию» + купленные
    номинации.

    Этапы берутся из conf_conferences.default_speaker_stage_ids, только этого
    события; при пустом списке шаг пропускается.

    Заодно дочитывается лимит номинаций из уже оплаченных тарифов (миграция
    328) — оплата и карточка появляются в любом порядке.

    Зовётся из всех трёх точек создания карточки: саморегистрация по ссылке,
    «Новый спикер» и добавление из базы."""
    stage_ids = await db.fetchval(
        "SELECT default_speaker_stage_ids FROM conf_conferences WHERE event_id = $1",
        event_id,
    )
    # Номинации из уже оплаченного тарифа (миграция 328). Здесь, а не только
    # в вебхуке оплаты: человек чаще платит РАНЬШЕ, чем заводит карточку, и
    # без этого купленные номинации молча пропадали бы.
    # ⚠️ Зовём до раннего выхода по пустому списку этапов — эти две вещи
    # независимы: этапы по умолчанию могут быть не настроены, а оплата есть.
    try:
        from app.services.nominations_grant import pull_paid_nominations
        await pull_paid_nominations(db, ec_id, event_id)
    except Exception:
        pass

    if not stage_ids:
        return
    await db.execute(
        """INSERT INTO event_collaborator_stages (ec_id, stage_id)
           SELECT $1, s.id FROM conf_stages s
           WHERE s.id = ANY($2::int[]) AND s.event_id = $3
           ON CONFLICT DO NOTHING""",
        ec_id, list(stage_ids), event_id,
    )


@router.get("/speakers/self-register-links", summary="Прямые ссылки саморегистрации спикером (TG/VK/MAX)")
async def speaker_self_register_links(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Возвращает прямые ссылки для шаринга — клиент копирует и
    отправляет потенциальным спикерам. По клику бот: TG — шлёт текст +
    кнопку «Включить в спикеры», VK/MAX — сразу регистрирует."""
    client_id = int(client["sub"])
    ev = await db.fetchrow(
        "SELECT id, slug FROM events WHERE id = $1 AND EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id = events.id AND eo.client_id = $2 AND eo.status='accepted')",
        event_id, client_id,
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    from app.services.share_links import build_speaker_self_register_links
    links = await build_speaker_self_register_links(db, client_id, event_id)

    # ⚠️ Веб-ссылка — БЕЗ мессенджеров и БЕЗ ботов. Отдаём всегда, даже когда
    # `links` пуст: клиент, который платит за модуль ради организации работы,
    # а каналы не подключал, иначе не может завести состав ссылкой вовсе.
    # Адрес — на домене клиента (литералов pluson.ru в коде быть не должно).
    web_url = None
    try:
        web_url = await client_public_link(db, client_id, f"/speaker/{ev['slug']}/join")
    except Exception:
        logger.exception("self-register-links: не собралась веб-ссылка")

    return {"links": links, "web_url": web_url}


@router.get("/speakers/self-edit-links", summary="Прямые ссылки входа в кабинет (для добавленных спикеров и ассистентов)")
async def speaker_self_edit_links(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Ссылки для УЖЕ добавленных спикеров и их ассистентов — вход в кабинет
    без создания нового коллаба. Бот по TG зашедшего находит спикера события
    (личный TG или assistant_tg_username) и отдаёт его код доступа."""
    client_id = int(client["sub"])
    ev = await db.fetchval(
        "SELECT id FROM events WHERE id = $1 AND EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id = events.id AND eo.client_id = $2 AND eo.status='accepted')",
        event_id, client_id,
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    from app.services.share_links import build_speaker_self_edit_links
    links = await build_speaker_self_edit_links(db, client_id, event_id)
    return {"links": links}


@router.get("/speakers", summary="Спикеры события")
async def list_event_speakers(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url,
                  cse.gift_lead_magnet_id, cse.gift_package_id,
                  lm.name AS gift_lm_name, lm.url AS gift_lm_url,
                  lp.name AS gift_lp_name, lp.slug AS gift_lp_slug,
                  lp.client_id AS gift_lp_client_id,
                  (SELECT json_agg(g ORDER BY g.sort_order, g.id) FROM (
                     SELECT eclm.id, eclm.sort_order, eclm.lead_magnet_id, eclm.package_id,
                            COALESCE(eclm.manual_title, glm.name, glp.name) AS name,
                            CASE WHEN eclm.manual_title IS NOT NULL THEN 'manual'
                                 WHEN eclm.lead_magnet_id IS NOT NULL THEN 'magnet' ELSE 'package' END AS kind,
                            -- funnel_slug + funnel_kind: для лид-магнита/пакета фронт сам
                            -- строит платформенную ссылку на воронку (m_/p_). url оставлен
                            -- для ручного подарка (прямая ссылка) и обратной совместимости.
                            CASE WHEN eclm.lead_magnet_id IS NOT NULL THEN glm.slug
                                 WHEN eclm.package_id IS NOT NULL THEN glp.slug END AS funnel_slug,
                            CASE WHEN eclm.manual_title IS NOT NULL THEN NULL
                                 WHEN eclm.lead_magnet_id IS NOT NULL THEN 'm'
                                 WHEN eclm.package_id IS NOT NULL THEN 'p' END AS funnel_kind,
                            -- Владелец пакета: домен воронки принадлежит ЕМУ, а не
                            -- владельцу события. Ссылка собирается в Python после
                            -- fetch — в SQL домен захардкодить нельзя.
                            glp.client_id AS funnel_pkg_client_id,
                            CASE WHEN eclm.manual_title IS NOT NULL THEN eclm.manual_url
                                 WHEN eclm.package_id IS NOT NULL AND glp.slug IS NOT NULL
                                 THEN NULL ELSE glm.url END AS url
                       FROM event_collaborator_lead_magnets eclm
                       LEFT JOIN lead_magnets glm ON glm.id = eclm.lead_magnet_id
                       LEFT JOIN lead_magnet_packages glp ON glp.id = eclm.package_id
                      WHERE eclm.ec_id = cse.id
                  ) g) AS gift_magnets,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.knowledge_base_title, cse.knowledge_base_url,
                  cse.show_topic_field, cse.show_gift_after_speech_field,
                  cse.show_knowledge_base_field, cse.show_notes_field,
                  cse.show_partner_registration_link,
                  cse.poster_id,
                  cse.announcement_poster_ids,
                  (SELECT COALESCE(array_agg(ecs.stage_id), ARRAY[]::int[])
                     FROM event_collaborator_stages ecs WHERE ecs.ec_id = cse.id) AS stage_ids,
                  cse.nominations_limit,
                  CASE WHEN cse.use_photo_instead_of_poster THEN NULL
                       ELSE cp_cse.url END AS cse_poster_url,
                  cse.use_photo_instead_of_poster,
                  cse.partner_url, cse.extra_info, cse.notes,
                  c.ref_code, cse.is_visible, cse.sort_order, cse.is_commercial,
                  cse.bot_in_channel, cse.priority,
                  cse.exclude_gift_from_broadcast, cse.exclude_channel_from_subscription,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.photo_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE NOT cse.use_photo_instead_of_poster
                       AND cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS speaker_poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.vk_url, sp.max_url,
                  sp.instagram_url, sp.website_url,
                  -- ⚠️ Медийные активы нужны кнопке «Скопировать список
                  -- спикеров с каналами»: в строке списка идёт число
                  -- подписчиков рядом со ссылкой на канал.
                  sp.media_assets,
                  sp.access_code,
                  sp.linked_client_id,
                  (SELECT lc.email FROM clients lc WHERE lc.id = sp.linked_client_id) AS linked_client_email,
                  pu_tg.username AS personal_tg_username,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_vk.username AS personal_vk_username,
                  pu_vk.platform_user_id AS personal_vk_id,
                  pu_max.username AS personal_max_username,
                  pu_max.platform_user_id AS personal_max_id
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN collaborator_posters cp_cse ON cp_cse.id = cse.poster_id
           LEFT JOIN lead_magnets lm ON lm.id = cse.gift_lead_magnet_id
           LEFT JOIN lead_magnet_packages lp ON lp.id = cse.gift_package_id
           LEFT JOIN contacts c ON c.id = sp.contact_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           LEFT JOIN platform_users pu_vk
             ON pu_vk.contact_id = sp.contact_id AND pu_vk.platform_slug = 'vk'
           LEFT JOIN platform_users pu_max
             ON pu_max.contact_id = sp.contact_id AND pu_max.platform_slug = 'max'
           WHERE cse.event_id = $1
           ORDER BY """ + collaborator_sort.order_by_sql("cse"),
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)
    # Слоты программы этих спикеров — чтобы в карточке показать, какая тема реально
    # привязана к слоту (conf_sessions.topic_id) и когда слот. Спикер мог иметь
    # несколько тем — важно видеть, какая из них уходит в программу/рассылки.
    slot_rows = await db.fetch(
        """SELECT cs.speaker_id AS cse_id, cs.topic_id, cs.day, cs.start_time, cs.end_time
             FROM conf_sessions cs
            WHERE cs.event_id = $1 AND cs.speaker_id = ANY($2::int[])
            ORDER BY cs.speaker_id, cs.day, cs.start_time""",
        event_id, [r["id"] for r in rows],
    )
    slot_map: dict = {}
    for s in slot_rows:
        slot_map.setdefault(s["cse_id"], []).append(dict(s))

    from app.services.share_links import build_gift_funnel_links_by_owner
    result = []
    import json as _json_c
    for r in rows:
        d = dict(r)
        d["topics"] = topics_map.get(d["id"], [])
        # Привязка темы к слоту: индекс темы (в массиве topics), которая стоит в
        # слоте, + человекочитаемая подпись слота (День N, HH:MM–HH:MM).
        slots = slot_map.get(d["id"], [])
        bound_topic_id = next((s["topic_id"] for s in slots if s["topic_id"]), None)
        d["bound_topic_index"] = next(
            (i for i, t in enumerate(d["topics"]) if t["id"] == bound_topic_id), None
        ) if bound_topic_id else None
        bound_slot = next((s for s in slots if s["topic_id"] == bound_topic_id), None) if bound_topic_id else None
        if bound_slot is None and slots:
            bound_slot = slots[0]  # слот занят, но темы в нём ещё нет
        if bound_slot:
            _st = str(bound_slot.get("start_time") or "")[:5]
            _et = str(bound_slot.get("end_time") or "")[:5]
            _time = (f"{_st}–{_et}" if _st and _et else _st) or ""
            d["slot_label"] = f"День {bound_slot['day']}" + (f", {_time} МСК" if _time else "")
            d["slot_has_topic"] = bound_topic_id is not None
        else:
            d["slot_label"] = None
            d["slot_has_topic"] = None
        d["poster_url"] = d.get("cse_poster_url") or d.get("speaker_poster_url")
        # Список подарков-лид-магнитов (до 4, миграция 200) — для карточки спикера
        # и превью рассылки gift.
        gm = d.get("gift_magnets")
        if isinstance(gm, str):
            try:
                gm = _json_c.loads(gm)
            except (ValueError, TypeError):
                gm = None
        d["gift_magnets"] = [g for g in (gm or []) if g and g.get("name")]
        # ⚠️ Ссылки воронки — по каналам ХОЗЯИНА магнита (общая
        # build_gift_funnel_links_by_owner, та же что при отправке). Фронт-превью
        # раньше строил их из ботов ТОГО, КТО СМОТРИТ — показывал чужой подарок
        # через свой бот. Ручной подарок ссылку не меняет (url как есть).
        for _g in d["gift_magnets"]:
            if _g.get("funnel_slug") and _g.get("funnel_kind"):
                _g["owner_links"] = await build_gift_funnel_links_by_owner(
                    db, _g["funnel_kind"], _g["funnel_slug"])
            # Веб-ссылка на воронку пакета — на домене ЕГО владельца.
            if not _g.get("url") and _g.get("funnel_kind") == "p" and _g.get("funnel_slug"):
                _g["url"] = await client_public_link(
                    db, _g.get("funnel_pkg_client_id"), f"p/{_g['funnel_slug']}")
            _g.pop("funnel_pkg_client_id", None)   # служебное поле резолва домена
        # Подарок спикера (одиночный, обратная совместимость): приоритет ручному
        # вводу; иначе резолв из ПЛЮСОНа по старым одиночным полям.
        # ⚠️ Первый элемент gift_magnets сюда НЕ копируем: фронт-превью считал
        # непустое одиночное поле признаком «подарок один» и показывал только его,
        # пряча остальные. Подарков может быть сколько угодно и любого вида —
        # список отдаётся целиком в gift_magnets.
        if not (d.get("gift_after_speech_title") or "").strip():
            if d.get("gift_lm_name"):
                d["gift_after_speech_title"] = d["gift_lm_name"]
                d["gift_after_speech_url"] = d.get("gift_lm_url") or d.get("gift_after_speech_url")
            elif d.get("gift_lp_name"):
                d["gift_after_speech_title"] = d["gift_lp_name"]
                if d.get("gift_lp_slug"):
                    # Воронка пакета — на домене его владельца (см. выше).
                    d["gift_after_speech_url"] = await client_public_link(
                        db, d.get("gift_lp_client_id"), f"p/{d['gift_lp_slug']}")
        d.pop("gift_lp_client_id", None)   # служебное поле резолва домена
        result.append(d)
    return {"speakers": result}


@router.get("/speakers/public", summary="Спикеры для Mini App")
async def list_event_speakers_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.role, cse.speaker_topic,
                  (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url,
                  cse.gift_lead_magnet_id, cse.gift_package_id,
                  lm.name AS gift_lm_name, lp.name AS gift_lp_name,
                  cse.gift_raffle_title, cse.gift_raffle_url, cse.sort_order,
                  cse.knowledge_base_title, cse.knowledge_base_url,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name,
                  sp.title, sp.photo_url, sp.photo_focal, sp.achievements,
                  -- Кадр круглого аватара (мигр. 451, 452): настроен в карточке.
                  sp.crop_zoom_circle::float8 AS crop_zoom_circle,
                  sp.crop_dx_circle::float8 AS crop_dx_circle,
                  sp.crop_dy_circle::float8 AS crop_dy_circle,
                  sp.tg_channel_url, sp.vk_url, sp.max_url,
                  sp.instagram_url, sp.website_url,
                  pu_tg.username AS personal_tg_username
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN lead_magnets lm ON lm.id = cse.gift_lead_magnet_id
           LEFT JOIN lead_magnet_packages lp ON lp.id = cse.gift_package_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.event_id = $1 AND cse.is_visible = TRUE
           ORDER BY """ + collaborator_sort.order_by_sql("cse"),
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)
    result = []
    for r in rows:
        d = dict(r)
        d["topics"] = topics_map.get(d["id"], [])
        result.append(d)
    return {"speakers": result}


@router.get("/speakers/{speaker_event_id}/gift-stats", summary="Статистика переходов по подаркам спикера")
async def get_speaker_gift_stats(
    event_id: int,
    speaker_event_id: int,
    client: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """То же, что видит спикер у себя, — но глазами организатора.

    ⚠️ Считается ОДНИМ сервисом с кабинетом спикера: разъедутся запросы —
    разъедутся цифры, а спикер их с организатором сверяет.
    """
    await check_conference_access(event_id, int(client["sub"]), db)
    # Спикер обязан принадлежать ЭТОМУ событию — иначе по чужому id можно
    # посмотреть отдачу спикера в чужом событии.
    ok = await db.fetchval(
        "SELECT 1 FROM event_collaborators WHERE id=$1 AND event_id=$2",
        speaker_event_id, event_id,
    )
    if not ok:
        raise HTTPException(404, "Спикер не найден в этом событии")
    return await speaker_lead_magnet_stats(db, speaker_event_id)


@router.get("/speakers/{speaker_event_id}/public", summary="Полный профиль спикера для публичной страницы проверки")
async def get_speaker_profile_public(event_id: int, speaker_event_id: int, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный endpoint без авторизации.
    Возвращает полные данные спикера (профиль + данные выступления) для страницы проверки данных.
    Спикер может открыть ссылку и убедиться, что его данные заполнены правильно.
    """
    row = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.poster_id,
                  cse.use_photo_instead_of_poster,
                  CASE WHEN cse.use_photo_instead_of_poster THEN NULL
                       ELSE cp_cse.url END AS event_poster_url,
                  cse.is_commercial,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.photo_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE NOT cse.use_photo_instead_of_poster
                       AND cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  sp.assistant_tg_username
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN collaborator_posters cp_cse ON cp_cse.id = cse.poster_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.id = $1 AND cse.event_id = $2""",
        speaker_event_id, event_id
    )
    if not row:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Спикер не найден")
    topics_map = await _load_topics([speaker_event_id], db)
    d = dict(row)
    d["topics"] = topics_map.get(speaker_event_id, [])
    return {"speaker": d}


@router.post("/speakers/add-from-base", summary="Добавить спикера из базы в событие")
async def add_speaker_from_base(
    event_id: int,
    data: SpeakerAddToEvent,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    # Проверяем что спикер существует
    sp = await db.fetchrow("SELECT id FROM collaborators WHERE id = $1", data.speaker_id)
    if not sp:
        raise HTTPException(status_code=404, detail="Спикер не найден в базе")
    # Проверяем что уже не добавлен
    existing = await db.fetchrow(
        "SELECT id FROM event_collaborators WHERE speaker_id = $1 AND event_id = $2",
        data.speaker_id, event_id
    )
    if existing:
        raise HTTPException(status_code=400, detail="Спикер уже добавлен в это событие")

    # Гарантируем что у коллаба есть контакт с ref_code (это и будет реф-код спикера)
    await ensure_collaborator_contact(data.speaker_id, db)

    # Определяем темы: если передан topics — используем его, иначе speaker_topic
    topics_list = data.topics if data.topics is not None else (
        [data.speaker_topic] if data.speaker_topic else []
    )
    first_topic = topics_list[0] if topics_list else None

    # Стартовые тумблеры «что человек видит в своей форме» — из настроек
    # СОБЫТИЯ (миграция 336), с поправкой на роль (жюри не выступает и не
    # дарит). Единая точка на все способы завести карточку.
    _flags = await default_show_flags(db, event_id, data.role)

    # poster_id если передан — проверим что принадлежит этому коллабу
    if data.poster_id is not None:
        belongs = await db.fetchval(
            "SELECT 1 FROM collaborator_posters WHERE id = $1 AND collaborator_id = $2",
            data.poster_id, data.speaker_id,
        )
        if not belongs:
            raise HTTPException(status_code=400, detail="poster_id не из библиотеки этого коллаба")
    cse = await db.fetchrow(
        """INSERT INTO event_collaborators
           (speaker_id, event_id, role, speaker_topic,
            gift_raffle_title, gift_raffle_url,
            poster_id, partner_url, extra_info, notes, is_commercial, is_visible, sort_order,
            show_topic_field, show_gift_after_speech_field, show_knowledge_base_field,
            show_notes_field, show_partner_registration_link)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *""",
        data.speaker_id, event_id, data.role, first_topic,
        data.gift_raffle_title, data.gift_raffle_url,
        data.poster_id, data.partner_url, data.extra_info, data.notes,
        data.is_commercial, data.is_visible, data.sort_order,
        _flags["show_topic_field"], _flags["show_gift_after_speech_field"],
        _flags["show_knowledge_base_field"], _flags["show_notes_field"],
        _flags["show_partner_registration_link"],
    )
    await _save_topics(cse["id"], topics_list, db)
    await apply_default_speaker_stages(cse["id"], event_id, db)
    # Карточка в событии = участник события: иначе человек, открыв ссылку на
    # своё событие, видит форму регистрации вместо своей карточки.
    from app.services.collaborator_participant import ensure_collaborator_participant
    await ensure_collaborator_participant(
        db, event_id=event_id, collaborator_id=data.speaker_id)
    # Возвращаем с данными из глобальной базы
    row = await db.fetchrow(
        """SELECT cse.*, btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.photo_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE NOT cse.use_photo_instead_of_poster
                       AND cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM event_collaborators cse JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1""",
        cse["id"]
    )
    d = dict(row)
    topics_map = await _load_topics([cse["id"]], db)
    d["topics"] = topics_map.get(cse["id"], [])
    await regenerate_landing_data(event_id, db)
    return {"speaker": d}


@router.post("/speakers", summary="Создать нового спикера и добавить в событие")
async def create_and_add_speaker(
    event_id: int,
    data: SpeakerCreateAndAdd,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    client_id = int(client["sub"])
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Имя обязательно")

    contact_id: Optional[int] = data.existing_contact_id

    # Если клиент сразу указал existing_contact_id — проверяем что он его
    if contact_id is not None:
        own = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
            contact_id, client_id
        )
        if not own:
            raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")
    else:
        # При создании нового контакта обязательна минимум одна личная идентичность —
        # иначе мы не сможем отправить спикеру invite-сообщение для самообслуживания.
        has_personal = any([
            (data.personal_tg_id or "").strip(),
            (data.personal_tg_username or "").strip(),
            (data.personal_vk_id or "").strip(),
            (data.personal_vk_username or "").strip(),
            (data.personal_max_id or "").strip(),
            (data.personal_max_username or "").strip(),
        ])
        if not has_personal:
            raise HTTPException(
                status_code=422,
                detail="Укажите хотя бы один личный аккаунт спикера: Telegram, VK или MAX. Без этого ему не получится отправить инструкцию для редактирования профиля."
            )

    # Идентичность ПЕРВЕЕ имени: если указанный TG/VK/MAX уже есть в базе клиента,
    # это тот же человек (пусть и записанный под другим именем) — берём его контакт.
    # Иначе рядом с настоящим контактом рождается пустой дубль, а занятый аккаунт
    # к нему всё равно не привязывается (UNIQUE) → 409 и спикера не завести.
    if contact_id is None:
        from app.api.collaborators import _find_contact_by_personal_identity
        contact_id = await _find_contact_by_personal_identity(db, client_id, data)

    # Если existing_contact_id не дали и не force_create — ищем похожие по имени.
    # Возвращаем клиенту выбор (UI: «Использовать существующего» / «Создать нового»).
    if contact_id is None and not data.force_create:
        matches = await db.fetch(
            """SELECT c.id, c.name,
                      (SELECT pe.platform_user_id FROM platform_users pe
                        WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                        ORDER BY pe.id LIMIT 1) AS email,
                      c.phone,
                      EXISTS(SELECT 1 FROM collaborators col WHERE col.contact_id = c.id) AS has_collab
                 FROM contacts c
                WHERE c.client_id = $1
                  AND c.merged_into IS NULL
                  AND LOWER(TRIM(c.name)) = LOWER($2)
                ORDER BY c.id
                LIMIT 10""",
            client_id, name
        )
        if matches:
            return {
                "needs_choice": True,
                "matches": [
                    {"id": m["id"], "name": m["name"], "email": m["email"],
                     "phone": m["phone"], "has_collab": m["has_collab"]}
                    for m in matches
                ],
            }

    async with db.transaction():
        # 1. Контакт: либо существующий, либо новый
        if contact_id is None:
            contact_id = await db.fetchval(
                """INSERT INTO contacts (client_id, name, ref_code)
                   VALUES ($1, $2, SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8))
                   RETURNING id""",
                client_id, name
            )
        else:
            # Если уже есть коллаб у этого контакта — 409 (один коллаб на контакт).
            # Контакт сюда попадает и явным existing_contact_id, и резолвом по
            # личной идентичности (TG/VK/MAX) — в обоих случаях дубль карточки не нужен.
            existing_coll = await db.fetchval(
                "SELECT id FROM collaborators WHERE contact_id = $1", contact_id
            )
            if existing_coll:
                raise HTTPException(
                    status_code=409,
                    detail=f"У этого контакта уже есть коллаборатор (id={existing_coll}). Откройте его карточку и добавьте в событие через «Из базы»."
                )

        # 2. Коллаб в глобальной базе
        # access_code (миграция 108, NOT NULL без дефолта) — генерим в коде,
        # как во всех остальных путях создания коллаба.
        from app.api.collaborators import _generate_unique_access_code
        access_code = await _generate_unique_access_code(db)
        sp = await db.fetchrow(
            """INSERT INTO collaborators
               (contact_id, name, title, achievements,
                photo_url, photo_folder_url, video_folder_url,
                tg_channel_url, vk_url, max_url, instagram_url, website_url, created_by_client_id,
                access_code)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *""",
            contact_id, name, data.title, data.achievements,
            data.photo_url, data.photo_folder_url, data.video_folder_url,
            data.tg_channel_url, data.vk_url, data.max_url, data.instagram_url, data.website_url,
            client_id, access_code
        )
        # Личные идентичности — пишем в platform_users (миграции 107/108).
        from app.api.collaborators import _upsert_personal_identities
        await _upsert_personal_identities(db, client_id, contact_id, data)

        # 3. Участие в событии
        topics_list = data.topics if data.topics is not None else (
            [data.speaker_topic] if data.speaker_topic else []
        )
        first_topic = topics_list[0] if topics_list else None

        # Стартовые тумблеры — из настроек события (миграция 336).
        _flags = await default_show_flags(db, event_id, data.role)
        cse = await db.fetchrow(
            """INSERT INTO event_collaborators
               (speaker_id, event_id, role, speaker_topic,
                gift_raffle_title, gift_raffle_url,
                partner_url, extra_info, notes, is_commercial, is_visible, sort_order,
                show_topic_field, show_gift_after_speech_field, show_knowledge_base_field,
                show_notes_field, show_partner_registration_link)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *""",
            sp["id"], event_id, data.role, first_topic,
            data.gift_raffle_title, data.gift_raffle_url,
            data.partner_url, data.extra_info, data.notes,
            data.is_commercial, data.is_visible, data.sort_order,
            _flags["show_topic_field"], _flags["show_gift_after_speech_field"],
            _flags["show_knowledge_base_field"], _flags["show_notes_field"],
            _flags["show_partner_registration_link"],
        )
        await _save_topics(cse["id"], topics_list, db)
        await apply_default_speaker_stages(cse["id"], event_id, db)

    # Карточка в событии = участник события (см. collaborator_participant).
    from app.services.collaborator_participant import ensure_collaborator_participant
    await ensure_collaborator_participant(
        db, event_id=event_id, collaborator_id=sp["id"])

    topics_map = await _load_topics([cse["id"]], db)
    result = {**dict(sp), **dict(cse), "speaker_id": sp["id"], "topics": topics_map.get(cse["id"], [])}
    await regenerate_landing_data(event_id, db)
    return {"speaker": result}


@router.patch("/speakers/{speaker_event_id}", summary="Обновить участие спикера в событии")
async def update_speaker_event(
    event_id: int,
    speaker_event_id: int,
    data: SpeakerEventUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    raw = data.model_dump()
    topics_list = raw.pop("topics", None)
    stage_ids = raw.pop("stage_ids", None)  # этапы участия — отдельной таблицей
    force_remove = bool(raw.pop("force_remove_stage_data", None))
    gift_items = raw.pop("gift_lead_magnets", None)  # список подарков (magnet/package/manual)
    if gift_items is not None:
        # Организатор задаёт РУЧНЫЕ подарки (до 4). Ручные — без привязки к ПЛЮСОНу,
        # поэтому linked_client_id тут не нужен (magnet/package из веба не приходят).
        linked = await db.fetchval(
            "SELECT c.linked_client_id FROM collaborators c JOIN event_collaborators ec ON ec.speaker_id=c.id WHERE ec.id=$1",
            speaker_event_id)
        # ⚠️ Одиночных колонок gift_after_speech_* больше НЕТ — все подарки
        # живут в event_collaborator_lead_magnets (перенос 2026-07-30).
        await save_ec_gifts(db, speaker_event_id, gift_items, linked)
    clear_pluson_gifts = bool(raw.pop("clear_pluson_gifts", None))
    if clear_pluson_gifts:
        # Снимаем ПЛЮСОН-подарки (список + одиночные), привязку linked_client_id
        # не трогаем — она принадлежит спикеру, снимается только в его кабинете.
        await db.execute(
            "DELETE FROM event_collaborator_lead_magnets WHERE ec_id=$1 "
            "  AND (lead_magnet_id IS NOT NULL OR package_id IS NOT NULL)", speaker_event_id)
        await db.execute(
            "UPDATE event_collaborators SET gift_lead_magnet_id=NULL, gift_package_id=NULL WHERE id=$1 AND event_id=$2",
            speaker_event_id, event_id)
    # Не обновляем speaker_topic через общий механизм — управляем темами отдельно
    raw.pop("speaker_topic", None)
    # Валидация poster_id и announcement_poster_ids: все должны принадлежать
    # библиотеке этого коллаба (миграции 121-122).
    if raw.get("poster_id") is not None or raw.get("announcement_poster_ids") is not None:
        sp_id = await db.fetchval(
            "SELECT speaker_id FROM event_collaborators WHERE id=$1 AND event_id=$2",
            speaker_event_id, event_id,
        )
        if not sp_id:
            raise HTTPException(status_code=404, detail="Спикер не найден в событии")
        check_ids = []
        if raw.get("poster_id") is not None:
            check_ids.append(int(raw["poster_id"]))
        if raw.get("announcement_poster_ids") is not None:
            check_ids.extend(int(x) for x in raw["announcement_poster_ids"])
        if check_ids:
            valid_count = await db.fetchval(
                "SELECT COUNT(*) FROM collaborator_posters WHERE id = ANY($1::int[]) AND collaborator_id = $2",
                list(set(check_ids)), sp_id,
            )
            if valid_count != len(set(check_ids)):
                raise HTTPException(
                    status_code=400,
                    detail="poster_id / announcement_poster_ids ссылаются на афиши не из библиотеки этого коллаба"
                )
    # ⚠️ Подарочные поля различают «не прислали» и «прислали null» (очистка),
    # иначе снять ПЛЮСОН-подарок или стереть ручной было бы нельзя (null молча
    # выбрасывался). Плюс взаимоисключение ПЛЮСОН ↔ ручной, как в кабинете спикера.
    fs = data.model_fields_set
    GIFT_NULLABLE = {"gift_lead_magnet_id", "gift_package_id"}
    # ⚠️ Одиночный подарок из payload (старый формат клиента) пишем В СПИСОК —
    # колонок gift_after_speech_* в таблице больше нет.
    if "gift_after_speech_title" in fs or "gift_after_speech_url" in fs:
        _t = (raw.pop("gift_after_speech_title", None) or "").strip()
        _u = (raw.pop("gift_after_speech_url", None) or "").strip()
        if _t and _u:
            await save_ec_gifts(db, speaker_event_id,
                                [{"kind": "manual", "title": _t, "url": _u}], None)
        elif not _t and not _u:
            # очистка: убираем только РУЧНЫЕ подарки, плюсоновские спикера не трогаем
            await db.execute(
                "DELETE FROM event_collaborator_lead_magnets "
                " WHERE ec_id=$1 AND manual_title IS NOT NULL", speaker_event_id)
    raw.pop("gift_after_speech_title", None)
    raw.pop("gift_after_speech_url", None)
    # ⚠️ Лимит номинаций тоже различает «не прислали» и «прислали null»:
    # пустое поле = «без ограничений», и снять уже стоящее число иначе нельзя.
    NULLABLE = GIFT_NULLABLE | {"nominations_limit"}
    updates = {}
    for k, v in raw.items():
        if k in NULLABLE:
            if k in fs:
                updates[k] = v  # применяем даже None (очистка)
        elif v is not None:
            updates[k] = v

    # Лимит: 0 и мусор = без ограничений. Верхнюю границу («не больше, чем
    # есть номинаций») тут не режем — номинации добавляют и после, и
    # обрезанное задним числом число выглядело бы как потеря настройки.
    if "nominations_limit" in updates and updates["nominations_limit"] is not None:
        try:
            _lim = int(updates["nominations_limit"])
        except (TypeError, ValueError):
            _lim = 0
        updates["nominations_limit"] = _lim if _lim > 0 else None

    # Выбрали ПЛЮСОН-магнит/пакет → снимаем ручной подарок; 0 = снять ПЛЮСОН-привязки.
    # ⚠️ Колонок gift_after_speech_* больше НЕТ — в UPDATE их не кладём.
    # «Взаимоисключение» ручного и плюсоновского живёт в списке подарков.
    if updates.get("gift_lead_magnet_id"):
        updates["gift_package_id"] = None
    elif updates.get("gift_package_id"):
        updates["gift_lead_magnet_id"] = None
    else:
        if updates.get("gift_lead_magnet_id") == 0:
            updates["gift_lead_magnet_id"] = None
        # Ввели ручной подарок (название или ссылка) → снимаем ПЛЮСОН-привязки.
        manual_set = (("gift_after_speech_title" in fs and (data.gift_after_speech_title or "").strip())
                      or ("gift_after_speech_url" in fs and (data.gift_after_speech_url or "").strip()))
        if manual_set:
            updates["gift_lead_magnet_id"] = None
            updates["gift_package_id"] = None

    if updates:
        set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
        await db.execute(
            f"UPDATE event_collaborators SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2",
            speaker_event_id, event_id, *updates.values()
        )
    if topics_list is not None:
        # ⚠️ speaker_topic (денормализованное НАЗВАНИЕ первой темы) проставляет сам
        # _rewrite_speaker_topics — отдельный UPDATE здесь не нужен и ЛОМАЛСЯ:
        # тема теперь приходит объектом {topic, description}, и в TEXT-колонку
        # уезжал dict → asyncpg DataError «expected str, got dict» (500 при
        # сохранении описания).
        await _save_topics(speaker_event_id, topics_list, db)
    if stage_ids is not None:
        new_set = {int(x) for x in stage_ids}
        old_set = {r["stage_id"] for r in await db.fetch(
            "SELECT stage_id FROM event_collaborator_stages WHERE ec_id=$1", speaker_event_id)}
        removed = old_set - new_set   # этапы, с которых спикера СНЯЛИ
        if removed:
            # Есть ли оценки на снятых этапах, где этот ec — субъект (его оценивали)
            # ИЛИ жюри (он оценивал). Оценки привязаны к этапу через критерий/пакет,
            # поэтому проверяем по назначениям + наличию строк tournament_scores.
            rlist = list(removed)
            scores_cnt = await db.fetchval(
                """SELECT COUNT(*) FROM tournament_scores ts
                     JOIN tournament_criteria tc ON tc.id = ts.criterion_id
                     JOIN tournament_packages tp ON tp.id = tc.package_id
                    WHERE ts.event_id=$1
                      AND COALESCE(tp.stage_id, -1) = ANY($2::int[])
                      AND ( (ts.subject_kind='ec' AND ts.subject_id=$3) OR ts.juror_ec_id=$3 )""",
                event_id, rlist, speaker_event_id)
            if scores_cnt and not force_remove:
                raise HTTPException(status_code=409, detail={
                    "code": "stage_has_scores",
                    "message": "На снимаемом этапе уже есть оценки. Если убрать участие — все эти оценки и привязки удалятся. Продолжить?",
                    "scores": int(scores_cnt),
                })
            # Чистим привязки турнирной таблицы для снятых этапов: назначения жюри
            # (как субъект и как жюри) + при force — оценки + фиксации + фидбек.
            await db.execute(
                """DELETE FROM tournament_jury_assignments
                    WHERE event_id=$1 AND stage_id = ANY($2::int[])
                      AND ( (subject_kind='ec' AND subject_id=$3) OR juror_ec_id=$3 )""",
                event_id, rlist, speaker_event_id)
            if scores_cnt and force_remove:
                await db.execute(
                    """DELETE FROM tournament_scores ts
                        USING tournament_criteria tc, tournament_packages tp
                       WHERE ts.criterion_id=tc.id AND tc.package_id=tp.id
                         AND ts.event_id=$1 AND COALESCE(tp.stage_id,-1) = ANY($2::int[])
                         AND ( (ts.subject_kind='ec' AND ts.subject_id=$3) OR ts.juror_ec_id=$3 )""",
                    event_id, rlist, speaker_event_id)
                await db.execute(
                    """DELETE FROM tournament_jury_locks
                        WHERE event_id=$1 AND stage_id = ANY($2::int[])
                          AND ( (subject_kind='ec' AND subject_id=$3) OR juror_ec_id=$3 )""",
                    event_id, rlist, speaker_event_id)
                await db.execute(
                    """DELETE FROM tournament_feedback
                        WHERE event_id=$1 AND stage_id = ANY($2::int[])
                          AND ( (subject_kind='ec' AND subject_id=$3) OR juror_ec_id=$3 )""",
                    event_id, rlist, speaker_event_id)
        # перезаписываем набор этапов участия: только этапы ЭТОГО события
        await db.execute("DELETE FROM event_collaborator_stages WHERE ec_id=$1", speaker_event_id)
        if stage_ids:
            await db.execute(
                """INSERT INTO event_collaborator_stages (ec_id, stage_id)
                   SELECT $1, s.id FROM conf_stages s
                   WHERE s.id = ANY($2::int[]) AND s.event_id = $3
                   ON CONFLICT DO NOTHING""",
                speaker_event_id, [int(x) for x in stage_ids], event_id,
            )
        # Лимит номинаций следует за отметками организатора (миграция 328):
        # отметил пятерым — значит доступно пять, вписывать число отдельно
        # не надо; снял одну — стало четыре. Только ручная правка карточки:
        # самовыбор в кабинете лимит не двигает, иначе человек поднимал бы
        # себе потолок сам, просто отмечая номинации.
        # ⚠️ Явно присланное число главнее: иначе организатор, вписавший «3»
        # в том же сохранении, получил бы вместо него количество отметок.
        if "nominations_limit" not in fs:
            from app.services.nominations_limit import sync_limit_with_marked
            await sync_limit_with_marked(db, speaker_event_id)
    row = await db.fetchrow(
        """SELECT cse.*, btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.photo_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE NOT cse.use_photo_instead_of_poster
                       AND cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM event_collaborators cse JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1""",
        speaker_event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден в событии")
    topics_map = await _load_topics([speaker_event_id], db)
    d = dict(row)
    d["topics"] = topics_map.get(speaker_event_id, [])
    await regenerate_landing_data(event_id, db)
    return {"speaker": d}


@router.post("/speakers/{speaker_event_id}/verify-channel", summary="Проверить, что бот видит подписку самого спикера на его канал")
async def verify_speaker_channel(
    event_id: int,
    speaker_event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Проверка идёт по personal_tg_id самого спикера — он гарантированно подписан
    на свой канал. Если бот добавлен в админы канала и видит подписчиков —
    getChatMember вернёт статус creator/administrator/member. Если нет — ошибка
    Telegram расскажет почему (бот не в канале, нет прав, и т.п.).
    """
    client_id = int(client["sub"])
    await check_conference_access(event_id, client_id, db, write=True)

    from app.config import settings
    from app.services.channels import get_client_telegram_token
    token = await get_client_telegram_token(client_id, db)  # только свой бот клиента
    if not token:
        raise HTTPException(status_code=400, detail="Не настроен главный бот клиента — подключите его в разделе «Каналы»")

    # Получаем username бота для понятных сообщений об ошибках
    bot_handle = ""
    try:
        async with httpx.AsyncClient(timeout=5) as http:
            br = await http.get(f"https://api.telegram.org/bot{token}/getMe")
        bot_handle = ((br.json() or {}).get("result") or {}).get("username", "") or ""
    except Exception:
        pass
    bot_ref = f"@{bot_handle}" if bot_handle else "главный бот"

    row = await db.fetchrow(
        """SELECT c.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  c.name
           FROM event_collaborators cse
           JOIN collaborators c ON c.id = cse.speaker_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.id = $1 AND cse.event_id = $2""",
        speaker_event_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    channel_id = (row["tg_channel_id"] or "").strip()
    if not channel_id:
        raise HTTPException(status_code=400, detail="Сначала укажите ID канала спикера и сохраните профиль")

    speaker_tg_id = row["personal_tg_id"]
    if not speaker_tg_id:
        raise HTTPException(
            status_code=400,
            detail="Заполните «ID личного аккаунта» спикера и сохраните — без него не получится проверить канал автоматически"
        )

    try:
        async with httpx.AsyncClient(timeout=8) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChatMember",
                params={"chat_id": channel_id, "user_id": speaker_tg_id}
            )
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ошибка Telegram API: {e}")

    if not data.get("ok"):
        desc = (data.get("description") or "").lower()
        if "member list is inaccessible" in desc:
            detail = f"Бот не админ канала. Добавьте {bot_ref} в администраторы канала спикера (без прав публикации — достаточно нулевых прав)."
        elif "chat not found" in desc:
            if not channel_id.startswith("-100"):
                detail = f"Канал не найден. ID канала должен начинаться с «-100» (у вас: «{channel_id}»). Скопируйте правильный ID и сохраните профиль."
            else:
                detail = f"Канал не найден. Скорее всего {bot_ref} ещё не добавлен в канал. Откройте канал спикера → Управление → Администраторы → добавьте {bot_ref}, и нажмите ещё раз."
        elif "user not found" in desc:
            detail = "Личный аккаунт спикера не найден в Telegram. Проверьте «ID личного аккаунта»."
        elif "bot was kicked" in desc or "kicked" in desc:
            detail = f"Бот удалён из канала. Добавьте {bot_ref} обратно в администраторы."
        elif "not enough rights" in desc or "no rights" in desc:
            detail = f"У бота нет прав видеть подписчиков. Добавьте {bot_ref} как администратора."
        elif "forbidden" in desc:
            detail = f"Нет доступа к каналу. Убедитесь, что {bot_ref} добавлен в администраторы канала."
        else:
            detail = f"Не удалось проверить канал. Telegram ответил: {data.get('description') or 'неизвестная ошибка'}"
        raise HTTPException(status_code=400, detail=detail)

    status = (data.get("result") or {}).get("status", "")
    if status not in ("member", "administrator", "creator", "restricted"):
        # Спикер не подписан на собственный канал? Странно, но возможно — сами выгнали себя.
        speaker_name = row["name"] or "Спикер"
        raise HTTPException(
            status_code=400,
            detail=f"Бот видит канал, но {speaker_name} НЕ подписан(а) на свой канал (статус: {status or 'нет данных'}). Подпишитесь и попробуйте снова."
        )

    await db.execute(
        "UPDATE event_collaborators SET bot_in_channel = TRUE WHERE id = $1",
        speaker_event_id
    )
    speaker_name = row["name"] or "спикер"
    return {"ok": True, "message": f"Бот видит подписку — {speaker_name} в канале (статус: {status}). Канал добавлен в проверку."}


@router.delete("/speakers/{speaker_event_id}", summary="Убрать спикера из события")
async def remove_speaker_from_event(
    event_id: int,
    speaker_event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    await db.execute(
        "DELETE FROM event_collaborators WHERE id = $1 AND event_id = $2",
        speaker_event_id, event_id
    )
    await regenerate_landing_data(event_id, db)
    return {"message": "Спикер убран из события (остался в базе)"}


# ─── Этапы конференции/турнира ────────────────────────────────────────────────
# Опциональный уровень над днями. Если у события нет ни одного этапа —
# дни лежат «без группировки», UI рендерит плоский список (как раньше).

class StageCreate(BaseModel):
    title: str
    subtitle: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[str] = None  # "YYYY-MM-DD"
    end_date: Optional[str] = None
    sort_order: int = 0
    category_id: Optional[int] = None  # надкатегория (миграция 303)


class StageUpdate(BaseModel):
    title: Optional[str] = None
    subtitle: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    sort_order: Optional[int] = None
    # ⚠️ nullable: явный null = «убрать из категории». Обрабатывается через
    # model_fields_set (exclude_unset), а не `is not None` — иначе отвязать
    # номинацию от категории было бы нечем.
    category_id: Optional[int] = None


class StagesBulkCreate(BaseModel):
    """Пакетное создание номинаций — по строке на название."""
    titles: List[str]
    category_id: Optional[int] = None


class StageCategoryCreate(BaseModel):
    title: str
    sort_order: int = 0


class StageCategoryUpdate(BaseModel):
    title: Optional[str] = None
    sort_order: Optional[int] = None


def _parse_date(s: Optional[str]):
    return date.fromisoformat(s) if s else None


@router.get("/stages", summary="Этапы события")
async def list_stages(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    stages = await db.fetch(
        "SELECT * FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id",
        event_id,
    )
    return {"stages": [dict(s) for s in stages]}


@router.post("/stages", summary="Создать этап")
async def create_stage(
    event_id: int,
    data: StageCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    if not data.title.strip():
        raise HTTPException(status_code=422, detail="Название этапа обязательно")
    # Категория проверяется на принадлежность ЭТОМУ событию — иначе можно было бы
    # подсунуть чужую и увидеть в своём списке номинацию из чужого кабинета.
    cat_id = data.category_id
    if cat_id:
        ok = await db.fetchval(
            "SELECT 1 FROM conf_stage_categories WHERE id=$1 AND event_id=$2", cat_id, event_id)
        if not ok:
            raise HTTPException(status_code=422, detail="Категория не найдена в этом событии")
    stage = await db.fetchrow(
        """INSERT INTO conf_stages (event_id, sort_order, title, subtitle, description,
                                    start_date, end_date, category_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *""",
        event_id, data.sort_order, data.title.strip(),
        data.subtitle, data.description,
        _parse_date(data.start_date), _parse_date(data.end_date), cat_id,
    )
    return {"stage": dict(stage)}


@router.patch("/stages/{stage_id}", summary="Обновить этап")
async def update_stage(
    event_id: int,
    stage_id: int,
    data: StageUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    payload = data.model_dump(exclude_unset=True)
    if "start_date" in payload:
        payload["start_date"] = _parse_date(payload["start_date"])
    if "end_date" in payload:
        payload["end_date"] = _parse_date(payload["end_date"])
    if "title" in payload and (not payload["title"] or not payload["title"].strip()):
        raise HTTPException(status_code=422, detail="Название этапа обязательно")
    if payload.get("category_id"):
        ok = await db.fetchval(
            "SELECT 1 FROM conf_stage_categories WHERE id=$1 AND event_id=$2",
            payload["category_id"], event_id)
        if not ok:
            raise HTTPException(status_code=422, detail="Категория не найдена в этом событии")
    if not payload:
        row = await db.fetchrow("SELECT * FROM conf_stages WHERE id=$1 AND event_id=$2", stage_id, event_id)
        if not row:
            raise HTTPException(status_code=404, detail="Этап не найден")
        return {"stage": dict(row)}
    set_parts = [f"{k} = ${i+3}" for i, k in enumerate(payload.keys())]
    row = await db.fetchrow(
        f"UPDATE conf_stages SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2 RETURNING *",
        stage_id, event_id, *payload.values()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Этап не найден")
    return {"stage": dict(row)}


@router.post("/stages/bulk", summary="Создать несколько номинаций/туров разом")
async def create_stages_bulk(
    event_id: int,
    data: StagesBulkCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Пакетное заведение номинаций — по строке на название.

    ⚠️ Нужно именно для премий: там номинаций бывает 70, и создавать их
    по одной кнопкой «Добавить» физически нереально.
    Дубли по названию внутри события молча пропускаются — повторный
    вход со списком не наплодит копий.
    """
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    titles = [t.strip() for t in (data.titles or []) if t and t.strip()]
    if not titles:
        raise HTTPException(status_code=422, detail="Список названий пуст")
    if data.category_id:
        ok = await db.fetchval(
            "SELECT 1 FROM conf_stage_categories WHERE id=$1 AND event_id=$2",
            data.category_id, event_id)
        if not ok:
            raise HTTPException(status_code=422, detail="Категория не найдена в этом событии")

    existing = {
        (r["title"] or "").strip().lower()
        for r in await db.fetch("SELECT title FROM conf_stages WHERE event_id=$1", event_id)
    }
    base = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), 0) FROM conf_stages WHERE event_id=$1", event_id) or 0

    created, skipped = [], 0
    async with db.transaction():
        for t in titles:
            if t.lower() in existing:
                skipped += 1
                continue
            existing.add(t.lower())
            base += 10
            row = await db.fetchrow(
                """INSERT INTO conf_stages (event_id, sort_order, title, category_id)
                   VALUES ($1,$2,$3,$4) RETURNING *""",
                event_id, base, t, data.category_id,
            )
            created.append(dict(row))
    return {"created": created, "created_count": len(created), "skipped": skipped}


# ─── Категории номинаций/туров (миграция 303) ─────────────────────────────────
# Надкатегория группирует номинации: «Медицина» → «Лучший хирург», «Медсестра года».
# Одна номинация — одна категория (решение владельца), поэтому связь один-ко-многим.

@router.get("/stage-categories", summary="Категории номинаций/туров")
async def list_stage_categories(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT c.*, (SELECT count(*) FROM conf_stages s WHERE s.category_id = c.id) AS stages_count
             FROM conf_stage_categories c
            WHERE c.event_id = $1 ORDER BY c.sort_order, c.id""",
        event_id,
    )
    return {"categories": [dict(r) for r in rows]}


@router.post("/stage-categories", summary="Создать категорию")
async def create_stage_category(
    event_id: int,
    data: StageCategoryCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    if not data.title.strip():
        raise HTTPException(status_code=422, detail="Название категории обязательно")
    row = await db.fetchrow(
        "INSERT INTO conf_stage_categories (event_id, title, sort_order) VALUES ($1,$2,$3) RETURNING *",
        event_id, data.title.strip(), data.sort_order,
    )
    return {"category": dict(row)}


@router.patch("/stage-categories/{category_id}", summary="Обновить категорию")
async def update_stage_category(
    event_id: int,
    category_id: int,
    data: StageCategoryUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    payload = data.model_dump(exclude_unset=True)
    if "title" in payload and (not payload["title"] or not payload["title"].strip()):
        raise HTTPException(status_code=422, detail="Название категории обязательно")
    if "title" in payload:
        payload["title"] = payload["title"].strip()
    if not payload:
        row = await db.fetchrow(
            "SELECT * FROM conf_stage_categories WHERE id=$1 AND event_id=$2", category_id, event_id)
        if not row:
            raise HTTPException(status_code=404, detail="Категория не найдена")
        return {"category": dict(row)}
    set_parts = [f"{k} = ${i+3}" for i, k in enumerate(payload.keys())]
    row = await db.fetchrow(
        f"UPDATE conf_stage_categories SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2 RETURNING *",
        category_id, event_id, *payload.values(),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Категория не найдена")
    return {"category": dict(row)}


@router.delete("/stage-categories/{category_id}", summary="Удалить категорию")
async def delete_stage_category(
    event_id: int,
    category_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """⚠️ Номинации НЕ удаляются — у них просто пропадает категория
    (ON DELETE SET NULL). Иначе удаление категории уносило бы вместе с собой
    критерии, распределение жюри и уже выставленные оценки."""
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    res = await db.execute(
        "DELETE FROM conf_stage_categories WHERE id=$1 AND event_id=$2", category_id, event_id)
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="Категория не найдена")
    return {"ok": True}


@router.delete("/stages/{stage_id}", summary="Удалить этап")
async def delete_stage(
    event_id: int,
    stage_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    # ON DELETE SET NULL на conf_days.stage_id — дни не теряются, просто становятся «вне этапа»
    res = await db.execute("DELETE FROM conf_stages WHERE id=$1 AND event_id=$2", stage_id, event_id)
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="Этап не найден")
    return {"ok": True}


# ─── Программа целиком (для Mini App) ─────────────────────────────────────────

@router.get("/program-public", summary="Программа этапов/дней/сессий для Mini App")
async def get_program_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    """
    Возвращает структурированную программу события: этапы → дни → сессии.
    Если этапов нет — массив пустой; фронт рисует плоский список дней.
    stream_url у дней и сессий не возвращаем (отдельный приватный запрос для зарегистрированных).
    """
    stages = await db.fetch(
        "SELECT id, sort_order, title, subtitle, description, start_date, end_date "
        "FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id",
        event_id,
    )
    days = await db.fetch(
        "SELECT id, day_number, day_date, open_time, close_time, stage_id, title "
        "FROM conf_days WHERE event_id = $1 ORDER BY day_number",
        event_id,
    )
    sessions = await db.fetch(
        """SELECT s.id, s.day, s.start_time, s.end_time,
                  COALESCE(NULLIF(cst.topic,''), (SELECT NULLIF(t.topic,'') FROM conf_speaker_topics t WHERE t.cse_id = s.speaker_id ORDER BY t.sort_order, t.id LIMIT 1), s.title) AS title, s.gift_description,
                  s.track_label, s.track_color, s.track_id, s.sort_order,
                  s.speaker_id AS speaker_event_id,
                  btrim(CASE WHEN COALESCE(btrim(col.last_name),'')='' THEN COALESCE(col.name,'') ELSE COALESCE(col.name,'')||' '||COALESCE(col.last_name,'') END) AS speaker_name, col.title AS speaker_title,
                  col.photo_url, col.photo_focal,
                  col.crop_zoom_circle::float8 AS crop_zoom_circle,
                  col.crop_dx_circle::float8 AS crop_dx_circle,
                  col.crop_dy_circle::float8 AS crop_dy_circle,
                  cse.role AS speaker_role
           FROM conf_sessions s
           -- is_visible=FALSE → слот остаётся, скрытый спикер не показывается.
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id AND cse.is_visible = TRUE
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id
           WHERE s.event_id = $1
           ORDER BY s.day, NULLIF(s.start_time,'') NULLS LAST, s.sort_order""",
        event_id,
    )
    return {
        "stages":   [dict(s) for s in stages],
        "days":     [dict(d) for d in days],
        "sessions": [dict(s) for s in sessions],
    }


# ─── Дни конференции ──────────────────────────────────────────────────────────

class DayUpdate(BaseModel):
    day_date: Optional[str] = None
    open_time: Optional[str] = None
    close_time: Optional[str] = None
    stream_url: Optional[str] = None
    stage_id: Optional[int] = None  # NULL = день вне этапа
    title: Optional[str] = None     # кастомное имя дня (fallback "День N")
    show_for_speakers: Optional[bool] = None  # показывать день в кабинете спикера
    has_webinar: Optional[bool] = None  # день имеет эфир/вебинар → показывать в разделе Вебинары


@router.get("/days", summary="Дни конференции")
async def list_days(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    # speaker_join_url — вход СПИКЕРА в зум, поле комнаты этого дня (миграция 433).
    # Отдаём вместе с днём, чтобы превью рассылки «вы следующие» могло показать
    # реальную ссылку: отдельного запроса комнат у страницы шаблонов нет.
    days = await db.fetch(
        """SELECT d.*,
                  (SELECT wr.speaker_join_url FROM webinar_rooms wr
                    WHERE wr.event_id = d.event_id AND wr.day_number = d.day_number)
                  AS speaker_join_url
             FROM conf_days d WHERE d.event_id = $1 ORDER BY d.day_number""",
        event_id
    )
    return {"days": [dict(d) for d in days]}


@router.get("/days/public", summary="Дни конференции (для Mini App)")
async def list_days_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный список дней без stream_url (его видят только зарегистрированные —
    отдельный запрос). Нужен, чтобы Mini App мог отрисовать аккордеон с днями.
    """
    days = await db.fetch(
        """SELECT day_number, day_date, open_time, close_time, stage_id, title
             FROM conf_days
            WHERE event_id = $1
         ORDER BY day_number""",
        event_id,
    )
    return {"days": [dict(d) for d in days]}


@router.get("/stages/public", summary="Этапы (для Mini App)")
async def list_stages_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный список этапов для рендера в Mini App. Группировка дней под этапами —
    клиентская: фронт читает day.stage_id и сопоставляет.
    """
    stages = await db.fetch(
        """SELECT id, sort_order, title, subtitle, description, start_date, end_date
             FROM conf_stages
            WHERE event_id = $1
         ORDER BY sort_order, id""",
        event_id,
    )
    return {"stages": [dict(s) for s in stages]}


@router.put("/days/{day_number}", summary="Сохранить день")
async def upsert_day(
    event_id: int,
    day_number: int,
    data: DayUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    day_date = date.fromisoformat(data.day_date) if data.day_date else None
    # open_time / close_time теперь — простые строки "HH:MM" (МСК по соглашению).
    open_time = _normalize_hhmm(data.open_time)
    close_time = _normalize_hhmm(data.close_time)

    # show_for_speakers: прислали явно → берём его; не прислали → при INSERT дефолт TRUE,
    # при UPDATE не трогаем текущее значение (правка даты/времени дня не сбрасывает галочку).
    sfs = data.show_for_speakers  # None = не прислали
    hw = data.has_webinar         # None = не прислали (INSERT дефолт TRUE, UPDATE не трогаем)
    day = await db.fetchrow(
        """INSERT INTO conf_days (event_id, day_number, day_date, open_time, close_time, stream_url, stage_id, title, show_for_speakers, has_webinar)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, TRUE), COALESCE($10, TRUE))
           ON CONFLICT (event_id, day_number) DO UPDATE
             SET day_date=$3, open_time=$4, close_time=$5, stream_url=$6, stage_id=$7, title=$8,
                 show_for_speakers=COALESCE($9, conf_days.show_for_speakers),
                 has_webinar=COALESCE($10, conf_days.has_webinar)
           RETURNING *""",
        event_id, day_number, day_date, open_time, close_time, data.stream_url, data.stage_id, data.title, sfs, hw
    )
    await regenerate_landing_data(event_id, db)
    return {"day": dict(day)}


@router.delete("/days/{day_number}", summary="Удалить день")
async def delete_day(
    event_id: int,
    day_number: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    # Сначала каскадно удаляем сессии этого дня (на conf_sessions.day нет FK,
    # только колонка INT, поэтому удаляем вручную).
    await db.execute("DELETE FROM conf_sessions WHERE event_id=$1 AND day=$2", event_id, day_number)
    res = await db.execute("DELETE FROM conf_days WHERE event_id=$1 AND day_number=$2", event_id, day_number)
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="День не найден")
    await regenerate_landing_data(event_id, db)
    return {"ok": True}


# ─── Сессии ───────────────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    speaker_id: Optional[int] = None
    topic_id: Optional[int] = None
    day: int
    start_time: Optional[str] = None  # "HH:MM" — МСК
    end_time:   Optional[str] = None  # "HH:MM" — МСК
    title: Optional[str] = None  # если не передан — берётся из topic_id
    gift_description: Optional[str] = None
    stream_url: Optional[str] = None
    track_label: Optional[str] = None
    track_color: Optional[str] = None
    track_id: Optional[int] = None  # FK на conf_tracks (на будущее, UI пока не использует)
    # ⚠️ None (а не 0) — «не задан». Дашборд сортирует слоты дня ПО sort_order, а
    # фронт его при создании не шлёт: с дефолтом 0 новый слот улетал в САМОЕ
    # НАЧАЛО дня (выше 13:00), клиент его не находил и жал «Добавить» снова →
    # дубли. Не задан → ставим в конец дня (см. create_session).
    sort_order: Optional[int] = None


class SessionUpdate(BaseModel):
    speaker_id: Optional[int] = None
    topic_id: Optional[int] = None
    day: Optional[int] = None
    start_time: Optional[str] = None
    end_time:   Optional[str] = None
    title: Optional[str] = None
    gift_description: Optional[str] = None
    stream_url: Optional[str] = None
    track_id: Optional[int] = None
    sort_order: Optional[int] = None


class ScheduleGenerateRequest(BaseModel):
    day: int
    start_time: str          # "11:00"
    slot_duration: int = 30  # минут
    break_duration: int = 10 # минут
    speaker_ids: List[int]   # в порядке выступления


@router.get("/sessions", summary="Все сессии")
async def list_sessions(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    sessions = await db.fetch(
        f"""SELECT s.*,
                  COALESCE(NULLIF(cst.topic,''), (SELECT NULLIF(t.topic,'') FROM conf_speaker_topics t WHERE t.cse_id = s.speaker_id ORDER BY t.sort_order, t.id LIMIT 1), s.title) AS title,
                  {DISPLAY_NAME_SQL("col")} AS speaker_name, col.title as speaker_title,
                  col.photo_url,
                  pu_tg.username AS personal_tg_username,
                  cse.role as speaker_role, cse.is_commercial,
                  (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url,
                  cse.exclude_gift_from_broadcast,
                  -- Список подарков спикера (ручные + плюсоновские). ⚠️ Нужен
                  -- превью «Итогов дня»: оно смотрело только на одиночное
                  -- gift_after_speech_title и у всех писало «пишите в личку»,
                  -- хотя подарки заданы. Порядок и состав — как в рассылке.
                  (SELECT json_agg(g ORDER BY g.sort_order, g.id) FROM (
                     SELECT eclm.id, eclm.sort_order,
                            COALESCE(eclm.manual_title, glm.name, glp.name) AS title,
                            CASE WHEN eclm.lead_magnet_id IS NOT NULL THEN glm.slug
                                 WHEN eclm.package_id IS NOT NULL THEN glp.slug END AS funnel_slug,
                            CASE WHEN eclm.manual_title IS NOT NULL THEN NULL
                                 WHEN eclm.lead_magnet_id IS NOT NULL THEN 'm'
                                 WHEN eclm.package_id IS NOT NULL THEN 'p' END AS funnel_kind,
                            eclm.manual_url AS url
                       FROM event_collaborator_lead_magnets eclm
                       LEFT JOIN lead_magnets glm ON glm.id = eclm.lead_magnet_id
                       LEFT JOIN lead_magnet_packages glp ON glp.id = eclm.package_id
                      WHERE eclm.ec_id = cse.id
                  ) g) AS gift_magnets_json
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = col.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE s.event_id = $1
           ORDER BY s.day, NULLIF(s.start_time,'') NULLS LAST, s.sort_order""",
        event_id
    )
    # ⚠️ JSONB из asyncpg приходит СТРОКОЙ — разбираем. Ссылки подарков строим
    # по каналам ХОЗЯИНА магнита (та же функция, что при отправке).
    import json as _js
    from app.services.share_links import build_gift_funnel_links_by_owner
    out = []
    for s in sessions:
        d = dict(s)
        gm = d.pop("gift_magnets_json", None)
        if isinstance(gm, str):
            try:
                gm = _js.loads(gm)
            except (ValueError, TypeError):
                gm = None
        items = [g for g in (gm or []) if g and g.get("title")]
        for g in items:
            if g.get("funnel_slug") and g.get("funnel_kind"):
                g["owner_links"] = await build_gift_funnel_links_by_owner(
                    db, g["funnel_kind"], g["funnel_slug"])
        d["gift_magnets"] = items
        out.append(d)
    return {"sessions": out}



@router.get("/sessions/day/{day}", summary="Сессии по дню (для Mini App)")
async def get_sessions_by_day(event_id: int, day: int, db: asyncpg.Connection = Depends(get_db)):
    sessions = await db.fetch(
        f"""SELECT s.id, s.day, s.start_time, s.end_time,
                  COALESCE(NULLIF(cst.topic,''), (SELECT NULLIF(t.topic,'') FROM conf_speaker_topics t WHERE t.cse_id = s.speaker_id ORDER BY t.sort_order, t.id LIMIT 1), s.title) AS title,
                  s.gift_description, s.stream_url, s.track_label, s.track_color, s.track_id,
                  s.speaker_id AS speaker_event_id,
                  {DISPLAY_NAME_SQL("col")} AS speaker_name, col.title as speaker_title,
                  col.photo_url, cse.role as speaker_role,
                  (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id
           WHERE s.event_id = $1 AND s.day = $2
           ORDER BY NULLIF(s.start_time,'') NULLS LAST, s.sort_order""",
        event_id, day
    )
    return {"sessions": [dict(s) for s in sessions], "day": day}


@router.post("/sessions", summary="Добавить сессию")
async def create_session(
    event_id: int,
    data: SessionCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    start_t = _normalize_hhmm(data.start_time)
    end_t   = _normalize_hhmm(data.end_time)

    # Если передан topic_id — берём title из темы (если title не передан явно)
    title = data.title
    if data.topic_id and not title:
        row = await db.fetchrow("SELECT topic FROM conf_speaker_topics WHERE id = $1", data.topic_id)
        if row:
            title = row["topic"]
    if not title:
        raise HTTPException(status_code=422, detail="Нужно указать тему слота или выбрать тему спикера")

    # sort_order не задан → в конец дня (список в дашборде сортируется по нему).
    sort_order = data.sort_order
    if sort_order is None:
        sort_order = (await db.fetchval(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM conf_sessions WHERE event_id=$1 AND day=$2",
            event_id, data.day,
        )) or 1

    session = await db.fetchrow(
        """INSERT INTO conf_sessions
          (event_id, speaker_id, topic_id, day, start_time, end_time, title,
           gift_description, stream_url, track_label, track_color, track_id, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *""",
        event_id, data.speaker_id, data.topic_id, data.day, start_t, end_t, title,
        data.gift_description, data.stream_url, data.track_label, data.track_color, data.track_id, sort_order
    )
    await regenerate_landing_data(event_id, db)
    return {"session": dict(session)}


@router.patch("/sessions/{session_id}", summary="Обновить сессию")
async def update_session(
    event_id: int,
    session_id: int,
    data: SessionUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    # ⚠️ Различаем «поле не прислали» и «прислали null»: явный null у speaker_id /
    # topic_id — это ОСВОБОЖДЕНИЕ слота (снять спикера / отвязать тему). Раньше
    # тут стояло `if v is not None` — null молча выбрасывался, и слот навсегда
    # оставался за прежним спикером.
    fs = data.model_fields_set
    NULLABLE = ("speaker_id", "topic_id", "track_id")
    updates = {}
    for k, v in data.model_dump().items():
        if k not in fs:
            continue
        if v is None and k not in NULLABLE:
            continue
        if k in ("start_time", "end_time") and v is not None:
            updates[k] = _normalize_hhmm(v)
        else:
            updates[k] = v

    # Сняли спикера — слот освобождается целиком: тема спикера к нему больше не
    # относится (иначе в программе осталась бы чужая тема).
    if updates.get("speaker_id") is None and "speaker_id" in updates:
        updates["topic_id"] = None

    # Если меняется topic_id но title не передан — обновляем title из темы
    if updates.get("topic_id") is not None and "title" not in updates:
        row = await db.fetchrow("SELECT topic FROM conf_speaker_topics WHERE id = $1", updates["topic_id"])
        if row:
            updates["title"] = row["topic"]

    if updates:
        set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
        session = await db.fetchrow(
            f"UPDATE conf_sessions SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2 RETURNING *",
            session_id, event_id, *updates.values()
        )
        if not session:
            raise HTTPException(status_code=404, detail="Сессия не найдена")
    else:
        session = await db.fetchrow("SELECT * FROM conf_sessions WHERE id=$1", session_id)
    await regenerate_landing_data(event_id, db)
    return {"session": dict(session)}


@router.delete("/sessions/{session_id}", summary="Удалить сессию")
async def delete_session(
    event_id: int,
    session_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    await db.execute("DELETE FROM conf_sessions WHERE id = $1 AND event_id = $2", session_id, event_id)
    await regenerate_landing_data(event_id, db)
    return {"message": "Сессия удалена"}


@router.post("/sessions/generate", summary="Сгенерировать расписание")
async def generate_schedule(
    event_id: int,
    data: ScheduleGenerateRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)

    # Удаляем старые сессии этого дня
    await db.execute(
        "DELETE FROM conf_sessions WHERE event_id=$1 AND day=$2", event_id, data.day
    )

    # Парсим время начала и шагаем строкой "HH:MM" — без TZ-математики.
    h, m = map(int, _normalize_hhmm(data.start_time).split(":"))
    cursor_min = h * 60 + m  # минут от 00:00 МСК

    def _mm_to_hhmm(mm: int) -> str:
        mm = mm % (24 * 60)
        return f"{mm // 60:02d}:{mm % 60:02d}"

    created = []
    for idx, speaker_event_id in enumerate(data.speaker_ids):
        # speaker_ids теперь — это event_collaborators.id
        cse = await db.fetchrow(
            """SELECT cse.id, btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name FROM event_collaborators cse
               JOIN collaborators sp ON sp.id = cse.speaker_id
               WHERE cse.id=$1 AND cse.event_id=$2""",
            speaker_event_id, event_id
        )
        if not cse:
            continue
        slot_start = _mm_to_hhmm(cursor_min)
        slot_end = _mm_to_hhmm(cursor_min + data.slot_duration)
        session = await db.fetchrow(
            """INSERT INTO conf_sessions
               (event_id, speaker_id, day, start_time, end_time, title, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
            event_id, speaker_event_id, data.day, slot_start, slot_end,
            "Выступление", idx
        )
        created.append(dict(session))
        cursor_min += data.slot_duration + data.break_duration

    await regenerate_landing_data(event_id, db)
    return {"sessions": created, "message": f"Создано {len(created)} сессий"}


class DayTimingRequest(BaseModel):
    day: int                      # day_number
    start_time: str               # "10:00" — время начала первого слота
    speaker_count: int            # сколько слотов сгенерировать
    talk_duration: int = 20       # минут на выступление
    break_duration: int = 10      # минут перерыв между выступлениями


@router.post("/sessions/generate-timing", summary="Сгенерировать пустые слоты дня по таймингу (добавить к существующим)")
async def generate_day_timing(
    event_id: int,
    data: DayTimingRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Генерит N ПУСТЫХ слотов дня (без спикеров — их займут сами) и ДОБАВЛЯЕТ к
    уже существующим слотам этого дня. Слот = выступление + перерыв. Тема пустая —
    «Тема будет уточнена позже». Для конференций и турниров."""
    await check_conference_access(event_id, int(client["sub"]), db, write=True)

    if data.speaker_count < 1 or data.speaker_count > 100:
        raise HTTPException(status_code=400, detail="Количество спикеров должно быть от 1 до 100")
    if data.talk_duration < 1:
        raise HTTPException(status_code=400, detail="Длительность выступления должна быть больше 0")

    h, m = map(int, _normalize_hhmm(data.start_time).split(":"))
    cursor_min = h * 60 + m

    def _mm_to_hhmm(mm: int) -> str:
        mm = mm % (24 * 60)
        return f"{mm // 60:02d}:{mm % 60:02d}"

    # следующий sort_order после уже имеющихся слотов дня
    base_sort = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM conf_sessions WHERE event_id=$1 AND day=$2",
        event_id, data.day,
    ) or 0

    created = []
    for i in range(data.speaker_count):
        slot_start = _mm_to_hhmm(cursor_min)
        slot_end = _mm_to_hhmm(cursor_min + data.talk_duration)
        session = await db.fetchrow(
            """INSERT INTO conf_sessions
               (event_id, speaker_id, day, start_time, end_time, title, sort_order)
               VALUES ($1, NULL, $2, $3, $4, $5, $6) RETURNING *""",
            event_id, data.day, slot_start, slot_end,
            "Тема будет уточнена позже", base_sort + i,
        )
        created.append(dict(session))
        cursor_min += data.talk_duration + data.break_duration

    await regenerate_landing_data(event_id, db)
    return {"sessions": created, "message": f"Добавлено {len(created)} слотов"}


# ─── Сдвиг тайминга слотов внутри дня ─────────────────────────────────────────
#
# Программа поехала: с какого-то слота всё сдвигается на N минут. Двигаем время
# выбранного слота и всех, кто идёт после него в ЭТОТ ЖЕ день (порядок — по
# start_time). Другие дни не трогаем.
#
# Заодно двигаем уже поставленные в очередь спикерские рассылки этих слотов
# («за 5 мин до выступления» + «подарок после эфира»), иначе программа уехала,
# а рассылки остались на старом времени. Только draft/pending — отправленные
# не трогаем.

_SHIFT_BROADCAST_TYPES = ("5min_before", "gift")


class ShiftSessionsRequest(BaseModel):
    day: int
    from_session_id: int
    minutes: int


@router.post("/sessions/shift-timing", summary="Сдвинуть слоты дня начиная с выбранного")
async def shift_sessions_timing(
    event_id: int,
    data: ShiftSessionsRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)

    if data.minutes == 0:
        raise HTTPException(status_code=400, detail="Сдвиг на 0 минут ничего не изменит")

    rows = await db.fetch(
        """SELECT id, start_time, end_time
             FROM conf_sessions
            WHERE event_id = $1 AND day = $2 AND start_time IS NOT NULL
            ORDER BY start_time, sort_order, id""",
        event_id, data.day,
    )
    if not rows:
        raise HTTPException(status_code=400, detail="В этом дне нет слотов со временем — сдвигать нечего")

    ids = [r["id"] for r in rows]
    if data.from_session_id not in ids:
        raise HTTPException(status_code=400, detail="Выбранный слот не найден в этом дне")

    def _shift(hhmm, delta: int):
        """Сдвиг "HH:MM" на delta минут. Через полночь не переносим — упираемся в границы суток."""
        if not hhmm:
            return None
        h, m = map(int, str(hhmm)[:5].split(":"))
        total = h * 60 + m + delta
        total = max(0, min(total, 23 * 60 + 59))
        return f"{total // 60:02d}:{total % 60:02d}"

    start_idx = ids.index(data.from_session_id)
    targets = rows[start_idx:]

    async with db.transaction():
        for r in targets:
            await db.execute(
                "UPDATE conf_sessions SET start_time = $1, end_time = $2 WHERE id = $3",
                _shift(r["start_time"], data.minutes),
                _shift(r["end_time"], data.minutes),
                r["id"],
            )

        # Синхронно двигаем ещё не отправленные спикерские рассылки этих слотов.
        shifted_broadcasts = await db.fetch(
            """UPDATE broadcast_schedules
                  SET fire_at = fire_at + ($4 || ' minutes')::interval
                WHERE event_id = $1
                  AND session_id = ANY($2::int[])
                  AND type = ANY($3::text[])
                  AND status IN ('draft', 'pending')
                  AND fire_at IS NOT NULL
             RETURNING id""",
            event_id, [r["id"] for r in targets], list(_SHIFT_BROADCAST_TYPES), str(data.minutes),
        )

    await regenerate_landing_data(event_id, db)
    return {
        "ok": True,
        "sessions_shifted": len(targets),
        "broadcasts_shifted": len(shifted_broadcasts),
        "minutes": data.minutes,
    }


# ─── Рассылки ─────────────────────────────────────────────────────────────────

class BroadcastCreate(BaseModel):
    session_id: Optional[int] = None
    speaker_id: Optional[int] = None
    type: str  # pre_5min|pre_30min|pre_1day|post_thanks|day_start|manual
    scheduled_at: Optional[str] = None
    text: str


class BroadcastUpdate(BaseModel):
    text: Optional[str] = None
    scheduled_at: Optional[str] = None
    status: Optional[str] = None


@router.get("/broadcasts", summary="Список рассылок")
async def list_broadcasts(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        f"""SELECT b.*, {DISPLAY_NAME_SQL("col")} AS speaker_name, s.title as session_title,
                  s.start_time as session_time
           FROM conf_broadcast_messages b
           LEFT JOIN event_collaborators cse ON cse.id = b.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           LEFT JOIN conf_sessions s ON s.id = b.session_id
           WHERE b.event_id = $1
           ORDER BY b.scheduled_at NULLS LAST, b.id""",
        event_id
    )
    return {"broadcasts": [dict(r) for r in rows]}


@router.post("/broadcasts", summary="Создать рассылку")
async def create_broadcast(
    event_id: int,
    data: BroadcastCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    scheduled = datetime.fromisoformat(data.scheduled_at) if data.scheduled_at else None
    row = await db.fetchrow(
        """INSERT INTO conf_broadcast_messages
           (event_id, session_id, speaker_id, type, scheduled_at, text, status)
           VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING *""",
        event_id, data.session_id, data.speaker_id, data.type, scheduled, data.text
    )
    return {"broadcast": dict(row)}


@router.patch("/broadcasts/{broadcast_id}", summary="Обновить рассылку")
async def update_broadcast(
    event_id: int,
    broadcast_id: int,
    data: BroadcastUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    updates = {}
    if data.text is not None:
        updates["text"] = data.text
        updates["is_edited"] = True
    if data.scheduled_at is not None:
        updates["scheduled_at"] = datetime.fromisoformat(data.scheduled_at)
    if data.status is not None:
        updates["status"] = data.status

    if updates:
        set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
        row = await db.fetchrow(
            f"UPDATE conf_broadcast_messages SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2 RETURNING *",
            broadcast_id, event_id, *updates.values()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Рассылка не найдена")
    else:
        row = await db.fetchrow("SELECT * FROM conf_broadcast_messages WHERE id=$1", broadcast_id)
    return {"broadcast": dict(row)}


@router.post("/broadcasts/{broadcast_id}/approve", summary="Утвердить рассылку")
async def approve_broadcast(
    event_id: int,
    broadcast_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    row = await db.fetchrow(
        """UPDATE conf_broadcast_messages
           SET status='approved', approved_at=NOW(), approved_by=$3
           WHERE id=$1 AND event_id=$2 RETURNING *""",
        broadcast_id, event_id, client.get("email", "client")
    )
    if not row:
        raise HTTPException(status_code=404, detail="Рассылка не найдена")
    return {"broadcast": dict(row), "message": "Рассылка утверждена и будет отправлена по расписанию"}


@router.post("/broadcasts/{broadcast_id}/cancel", summary="Отменить рассылку")
async def cancel_broadcast(
    event_id: int,
    broadcast_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    row = await db.fetchrow(
        "UPDATE conf_broadcast_messages SET status='cancelled' WHERE id=$1 AND event_id=$2 RETURNING *",
        broadcast_id, event_id
    )
    return {"broadcast": dict(row)}


@router.post("/broadcasts/{broadcast_id}/test", summary="Тест рассылки — отправить себе")
async def test_broadcast(
    event_id: int,
    broadcast_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    broadcast = await db.fetchrow(
        "SELECT * FROM conf_broadcast_messages WHERE id=$1 AND event_id=$2", broadcast_id, event_id
    )
    if not broadcast:
        raise HTTPException(status_code=404, detail="Рассылка не найдена")

    # Получаем Telegram клиента
    client_row = await db.fetchrow(
        "SELECT telegram_username FROM clients WHERE id=$1", int(client["sub"])
    )

    import httpx, os
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    text = f"🧪 ТЕСТ РАССЫЛКИ\n\n{broadcast['text']}"

    # Ищем tg_id клиента по username
    if client_row and client_row["telegram_username"]:
        username = client_row["telegram_username"].lstrip("@")
        # Идентичности живут в platform_users; таблицы telegram_users давно нет.
        # Берём только ЧИСЛОВОЙ id — по псевдо-записи «@ник» отправить нельзя.
        tg_user = await db.fetchrow(
            """SELECT platform_user_id AS tg_id
                 FROM platform_users
                WHERE platform_slug = 'telegram'
                  AND lower(username) = lower($1)
                  AND platform_user_id ~ '^[0-9]+$'
                ORDER BY id LIMIT 1""",
            username,
        )
        if tg_user:
            async with httpx.AsyncClient() as http:
                await http.post(
                    f"https://api.telegram.org/bot{bot_token}/sendMessage",
                    json={"chat_id": tg_user["tg_id"], "text": text}
                )
            return {"message": "Тест отправлен в Telegram"}

    return {"message": "Telegram-аккаунт не найден. Укажите @username в настройках профиля."}


@router.post("/broadcasts/generate-from-schedule", summary="Авто-создать рассылки из программы")
async def generate_broadcasts_from_schedule(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    sessions = await db.fetch(
        f"""SELECT s.*, d.day_date,
                  {DISPLAY_NAME_SQL("spg")} AS speaker_name, (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url
           FROM conf_sessions s
           LEFT JOIN conf_days d ON d.event_id = s.event_id AND d.day_number = s.day
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators spg ON spg.id = cse.speaker_id
           WHERE s.event_id = $1 AND s.start_time IS NOT NULL
           ORDER BY s.day, s.start_time""",
        event_id
    )

    created = 0
    for s in sessions:
        if not s["start_time"] or not s["day_date"]:
            continue
        # Собираем UTC момент отправки: МСК (start_time на day_date) минус 3 часа.
        sh, sm = map(int, str(s["start_time"])[:5].split(":"))
        msk_naive_start = datetime.combine(s["day_date"], time(sh, sm))
        utc_start = msk_naive_start - timedelta(hours=3)
        pre5 = utc_start - timedelta(minutes=5)

        speaker_name = s["speaker_name"] or "Спикер"
        title = s["title"] or "Выступление"

        existing = await db.fetchrow(
            "SELECT id FROM conf_broadcast_messages WHERE session_id=$1 AND type='pre_5min'",
            s["id"]
        )
        if not existing:
            await db.execute(
                """INSERT INTO conf_broadcast_messages
                   (event_id, session_id, speaker_id, type, scheduled_at, text, status)
                   VALUES ($1,$2,$3,'pre_5min',$4,$5,'draft')""",
                event_id, s["id"], s["speaker_id"], pre5,
                f"🔔 Через 5 минут начинается выступление!\n\n👤 {speaker_name}\n📌 {title}\n\nНе пропусти!"
            )
            created += 1

        # После выступления — подарок
        if s["end_time"] and (s.get("gift_after_speech_title") or s.get("gift_description")):
            eh, em = map(int, str(s["end_time"])[:5].split(":"))
            msk_naive_end = datetime.combine(s["day_date"], time(eh, em))
            utc_end = msk_naive_end - timedelta(hours=3)
            gift_text = s.get("gift_after_speech_title") or s.get("gift_description") or "Подарок"
            gift_url = s.get("gift_after_speech_url") or ""
            existing2 = await db.fetchrow(
                "SELECT id FROM conf_broadcast_messages WHERE session_id=$1 AND type='post_thanks'",
                s["id"]
            )
            if not existing2:
                gift_msg = f"🎁 {speaker_name} дарит подарок!\n\n{gift_text}"
                if gift_url:
                    gift_msg += f"\n\n👉 Получить: {gift_url}"
                await db.execute(
                    """INSERT INTO conf_broadcast_messages
                       (event_id, session_id, speaker_id, type, scheduled_at, text, status)
                       VALUES ($1,$2,$3,'post_thanks',$4,$5,'draft')""",
                    event_id, s["id"], s["speaker_id"], utc_end, gift_msg
                )
                created += 1

    return {"message": f"Создано {created} рассылок из расписания"}


# ─── Коммерческие предложения ──────────────────────────────────────────────────

class CommercialItemCreate(BaseModel):
    type: str = "service"
    title: str
    description: Optional[str] = None
    is_paid: bool = False
    action_url: Optional[str] = None
    sort_order: int = 0


@router.get("/commercial", summary="Услуги и материалы")
async def list_commercial(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    items = await db.fetch(
        "SELECT * FROM conf_commercial_items WHERE event_id = $1 ORDER BY sort_order", event_id
    )
    return {"items": [dict(i) for i in items]}


@router.post("/commercial", summary="Добавить услугу/материал")
async def create_commercial_item(
    event_id: int, data: CommercialItemCreate,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    item = await db.fetchrow(
        """INSERT INTO conf_commercial_items (event_id, type, title, description, is_paid, action_url, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
        event_id, data.type, data.title, data.description, data.is_paid, data.action_url, data.sort_order
    )
    return {"item": dict(item)}


@router.delete("/commercial/{item_id}", summary="Удалить услугу")
async def delete_commercial_item(
    event_id: int, item_id: int,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    await db.execute("DELETE FROM conf_commercial_items WHERE id=$1 AND event_id=$2", item_id, event_id)
    return {"message": "Удалено"}


# ─── Кодовые слова ────────────────────────────────────────────────────────────

class SecretCodeCreate(BaseModel):
    speaker_id: Optional[int] = None
    code_word: str
    tickets_reward: int = 1


class VerifyCodeRequest(BaseModel):
    code: str
    participant_id: int


@router.get("/codes", summary="Кодовые слова")
async def list_secret_codes(
    event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    codes = await db.fetch(
        f"""SELECT sc.*, {DISPLAY_NAME_SQL("col")} AS speaker_name FROM conf_secret_codes sc
           LEFT JOIN event_collaborators cse ON cse.id = sc.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           WHERE sc.event_id = $1""",
        event_id
    )
    return {"codes": [dict(c) for c in codes]}


@router.post("/codes", summary="Добавить кодовое слово")
async def create_secret_code(
    event_id: int, data: SecretCodeCreate,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    code = await db.fetchrow(
        "INSERT INTO conf_secret_codes (event_id, speaker_id, code_word, tickets_reward) VALUES ($1,$2,$3,$4) RETURNING *",
        event_id, data.speaker_id, data.code_word.lower().strip(), data.tickets_reward
    )
    return {"code": dict(code)}


@router.post("/codes/verify", summary="Проверить кодовое слово")
async def verify_code(event_id: int, data: VerifyCodeRequest, db: asyncpg.Connection = Depends(get_db)):
    code = await db.fetchrow(
        "SELECT * FROM conf_secret_codes WHERE event_id=$1 AND code_word=$2",
        event_id, data.code.lower().strip()
    )
    if not code:
        return {"valid": False, "message": "Неверное слово, попробуйте ещё раз"}
    await db.execute(
        "UPDATE event_participants SET points_total = points_total + $1 WHERE id=$2",
        code["tickets_reward"], data.participant_id
    )
    return {"valid": True, "tickets_reward": code["tickets_reward"],
            "message": f"Поздравляем! Вы получили {code['tickets_reward']} билетов на розыгрыш"}


# ─── Промо-партнёры ───────────────────────────────────────────────────────────

class PromoPartnerCreate(BaseModel):
    name: str
    telegram_url: Optional[str] = None
    partner_code: str


@router.get("/promo-partners", summary="Промо-партнёры события")
async def list_promo_partners(
    event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    partners = await db.fetch(
        "SELECT * FROM conf_promo_partners WHERE event_id=$1 ORDER BY created_at", event_id
    )
    return {"partners": [dict(p) for p in partners]}


@router.post("/promo-partners", summary="Добавить промо-партнёра")
async def create_promo_partner(
    event_id: int, data: PromoPartnerCreate,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    partner = await db.fetchrow(
        "INSERT INTO conf_promo_partners (event_id, name, telegram_url, partner_code) VALUES ($1,$2,$3,$4) RETURNING *",
        event_id, data.name, data.telegram_url, data.partner_code.upper()
    )
    return {"partner": dict(partner)}


# ─── Публичное саморедактирование спикера по ref_code ────────────────────────
# Спикер получает персональную ссылку вида /speaker-edit.html?code=sp_xxxx
# и может сам проверить и исправить свои данные без авторизации в кабинете.

class SpeakerSelfUpdate(BaseModel):
    """Поля, которые спикер может обновить сам."""
    # Профиль (таблица collaborators)
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    # poster_url убран миграцией 121 — афиши теперь в библиотеке (collaborator_posters).
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    # Данные выступления (таблица event_collaborators)
    # Темы выступления. Элемент — строка (только название) ЛИБО объект
    # {topic, description}: описание хранится отдельно, в программу и в
    # заголовок письма идёт только название.
    topics: Optional[List[Union[str, dict]]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    keyword_code: Optional[str] = None
    knowledge_base_title: Optional[str] = None
    knowledge_base_url: Optional[str] = None
    # Тогглы видимости полей в self-edit (миграция 108)
    show_topic_field: Optional[bool] = None
    show_gift_after_speech_field: Optional[bool] = None
    show_knowledge_base_field: Optional[bool] = None
    show_notes_field: Optional[bool] = None


@router.get("/speakers/by-code/{ref_code}", summary="Профиль спикера по ref_code (без авторизации)")
async def get_speaker_by_ref_code(event_id: int, ref_code: str, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный endpoint без авторизации.
    Возвращает полные данные спикера по его персональному ref_code.
    Используется для страницы самопроверки/редактирования спикером.
    """
    # Резолв: ref_code → contacts → collaborators → event_collaborators
    row = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.is_commercial, c.ref_code, cse.keyword_code,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.photo_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE NOT cse.use_photo_instead_of_poster
                       AND cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  sp.assistant_tg_username
           FROM contacts c
           JOIN collaborators sp ON sp.contact_id = c.id
           JOIN event_collaborators cse ON cse.speaker_id = sp.id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = c.id AND pu_tg.platform_slug = 'telegram'
           WHERE c.ref_code = $1 AND cse.event_id = $2""",
        ref_code, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Ссылка недействительна")
    topics_map = await _load_topics([row["id"]], db)
    d = dict(row)
    d["topics"] = topics_map.get(d["id"], [])
    return {"speaker": d}


@router.patch("/speakers/by-code/{ref_code}", summary="Обновить данные спикера по ref_code (без авторизации)")
async def update_speaker_by_ref_code(
    event_id: int,
    ref_code: str,
    data: SpeakerSelfUpdate,
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Публичный endpoint без авторизации.
    Позволяет спикеру самостоятельно обновить свои данные по персональной ссылке.
    Обновляет и профиль (collaborators), и данные выступления (event_collaborators).
    """
    cse = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id
           FROM contacts ct
           JOIN collaborators c ON c.contact_id = ct.id
           JOIN event_collaborators cse ON cse.speaker_id = c.id
           WHERE ct.ref_code = $1 AND cse.event_id = $2""",
        ref_code, event_id
    )
    if not cse:
        raise HTTPException(status_code=404, detail="Ссылка недействительна")

    speaker_event_id = cse["id"]
    speaker_id = cse["speaker_id"]

    # Обновляем глобальный профиль спикера (collaborators).
    # Личный TG (personal_tg_id/username) живёт в platform_users — апсертим отдельно.
    profile_fields = ["name", "title", "achievements", "photo_url",
                      "photo_folder_url", "video_folder_url", "tg_channel_url",
                      "vk_url", "max_url",
                      "instagram_url", "website_url", "tg_channel_id",
                      "assistant_tg_username"]
    profile_updates = {}
    for k in profile_fields:
        v = getattr(data, k)
        if v is not None:
            profile_updates[k] = v
    if "assistant_tg_username" in profile_updates:
        from app.api.collaborators import normalize_tg_username
        profile_updates["assistant_tg_username"] = normalize_tg_username(
            profile_updates["assistant_tg_username"]
        )

    if profile_updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(profile_updates.keys())]
        set_parts.append("updated_at = NOW()")
        await db.execute(
            f"UPDATE collaborators SET {', '.join(set_parts)} WHERE id = $1",
            speaker_id, *profile_updates.values()
        )

    if any(getattr(data, fld, None) is not None for fld in (
        "personal_tg_id", "personal_tg_username",
        "personal_vk_id", "personal_vk_username",
        "personal_max_id", "personal_max_username",
    )):
        from app.api.collaborators import _upsert_personal_identities
        coll_info = await db.fetchrow(
            "SELECT contact_id, created_by_client_id FROM collaborators WHERE id = $1",
            speaker_id
        )
        if coll_info and coll_info["contact_id"]:
            await _upsert_personal_identities(
                db, coll_info["created_by_client_id"], coll_info["contact_id"], data
            )

    # Обновляем данные выступления (event_collaborators)
    event_updates: dict = {}
    if getattr(data, "gift_after_speech_title", None) is not None \
            or getattr(data, "gift_after_speech_url", None) is not None:
        await _save_single_gift_to_list(
            db, speaker_event_id,
            getattr(data, "gift_after_speech_title", None),
            getattr(data, "gift_after_speech_url", None))
    for f in ("gift_raffle_title", "gift_raffle_url",
              "knowledge_base_title", "knowledge_base_url",
              "show_topic_field", "show_gift_after_speech_field",
              "show_knowledge_base_field", "show_notes_field"):
        v = getattr(data, f, None)
        if v is not None:
            event_updates[f] = v

    if event_updates:
        set_parts2 = [f"{k} = ${i+2}" for i, k in enumerate(event_updates.keys())]
        await db.execute(
            f"UPDATE event_collaborators SET {', '.join(set_parts2)} WHERE id = $1",
            speaker_event_id, *event_updates.values()
        )

    # Темы выступления — единый хелпер (правит по id, привязка слота держится).
    if data.topics is not None:
        await _rewrite_speaker_topics(db, speaker_event_id, data.topics)

    # Возвращаем обновлённые данные
    return await get_speaker_by_ref_code(event_id, ref_code, db)


# ─── Режим ассистента: один код на всё событие ───────────────────────────────

@router.get("/editor-info", summary="Данные конференции по editor_code (публичный)")
async def get_editor_info(event_id: int, code: str, db: asyncpg.Connection = Depends(get_db)):
    """Публичный endpoint — проверяет editor_code и возвращает список всех спикеров."""
    conf = await db.fetchrow(
        "SELECT event_id, editor_code FROM conf_conferences WHERE event_id = $1 AND editor_code = $2",
        event_id, code
    )
    if not conf:
        raise HTTPException(status_code=403, detail="Неверный код доступа")

    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role, c.ref_code, cse.keyword_code,
                  cse.speaker_topic, (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.is_commercial,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.photo_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE NOT cse.use_photo_instead_of_poster
                       AND cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  sp.assistant_tg_username
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = sp.contact_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.event_id = $1
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)
    result = []
    for r in rows:
        d = dict(r)
        d["topics"] = topics_map.get(d["id"], [])
        result.append(d)
    return {"speakers": result, "event_id": event_id}


@router.patch("/speakers/{speaker_event_id}/editor", summary="Обновить данные спикера от имени ассистента")
async def update_speaker_as_editor(
    event_id: int,
    speaker_event_id: int,
    data: SpeakerSelfUpdate,
    code: str,
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Публичный endpoint — ассистент обновляет данные любого спикера по editor_code.
    """
    conf = await db.fetchrow(
        "SELECT event_id FROM conf_conferences WHERE event_id = $1 AND editor_code = $2",
        event_id, code
    )
    if not conf:
        raise HTTPException(status_code=403, detail="Неверный код доступа")

    cse = await db.fetchrow(
        "SELECT id, speaker_id FROM event_collaborators WHERE id = $1 AND event_id = $2",
        speaker_event_id, event_id
    )
    if not cse:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    speaker_id = cse["speaker_id"]

    # Профиль (без personal_tg_* — они живут в platform_users, миграция 107)
    profile_fields = ["name", "title", "achievements", "photo_url",
                      "photo_folder_url", "video_folder_url", "tg_channel_url",
                      "vk_url", "max_url",
                      "instagram_url", "website_url", "tg_channel_id",
                      "assistant_tg_username"]
    profile_updates = {k: getattr(data, k) for k in profile_fields if getattr(data, k) is not None}
    if "assistant_tg_username" in profile_updates:
        from app.api.collaborators import normalize_tg_username
        profile_updates["assistant_tg_username"] = normalize_tg_username(
            profile_updates["assistant_tg_username"]
        )
    if profile_updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(profile_updates.keys())]
        set_parts.append("updated_at = NOW()")
        await db.execute(
            f"UPDATE collaborators SET {', '.join(set_parts)} WHERE id = $1",
            speaker_id, *profile_updates.values()
        )

    if any(getattr(data, fld, None) is not None for fld in (
        "personal_tg_id", "personal_tg_username",
        "personal_vk_id", "personal_vk_username",
        "personal_max_id", "personal_max_username",
    )):
        from app.api.collaborators import _upsert_personal_identities
        coll_info = await db.fetchrow(
            "SELECT contact_id, created_by_client_id FROM collaborators WHERE id = $1",
            speaker_id
        )
        if coll_info and coll_info["contact_id"]:
            await _upsert_personal_identities(
                db, coll_info["created_by_client_id"], coll_info["contact_id"], data
            )

    # Выступление
    event_updates: dict = {}
    if getattr(data, "gift_after_speech_title", None) is not None \
            or getattr(data, "gift_after_speech_url", None) is not None:
        await _save_single_gift_to_list(
            db, speaker_event_id,
            getattr(data, "gift_after_speech_title", None),
            getattr(data, "gift_after_speech_url", None))
    for k in ["gift_raffle_title", "gift_raffle_url",
              "keyword_code",
              "knowledge_base_title", "knowledge_base_url",
              "show_topic_field", "show_gift_after_speech_field",
              "show_knowledge_base_field", "show_notes_field"]:
        v = getattr(data, k, None)
        if v is not None:
            event_updates[k] = v
    if event_updates:
        set_parts2 = [f"{k} = ${i+2}" for i, k in enumerate(event_updates.keys())]
        await db.execute(
            f"UPDATE event_collaborators SET {', '.join(set_parts2)} WHERE id = $1",
            speaker_event_id, *event_updates.values()
        )

    # Темы — единый хелпер (правит по id, привязка слота держится).
    if data.topics is not None:
        await _rewrite_speaker_topics(db, speaker_event_id, data.topics)

    # Возвращаем обновлённые данные
    row = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role, c.ref_code, cse.keyword_code,
                  cse.speaker_topic, (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, (SELECT g1.manual_url FROM event_collaborator_lead_magnets g1 WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url, cse.is_commercial,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.photo_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE NOT cse.use_photo_instead_of_poster
                       AND cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  sp.assistant_tg_username
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = sp.contact_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.id = $1""",
        speaker_event_id
    )
    topics_map = await _load_topics([speaker_event_id], db)
    d = dict(row)
    d["topics"] = topics_map.get(speaker_event_id, [])
    return {"speaker": d}


@router.post("/generate-editor-code", summary="Сгенерировать editor_code для конференции")
async def generate_editor_code(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Генерирует или обновляет editor_code для конференции."""
    await check_conference_access(event_id, int(client["sub"]), db, write=True)
    import random, string
    new_code = "edit_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    await db.execute(
        "UPDATE conf_conferences SET editor_code = $1 WHERE event_id = $2",
        new_code, event_id
    )
    return {"editor_code": new_code, "event_id": event_id}


@router.get("/export/salebot", summary="Экспорт для Salebot в виде .txt файла")
async def export_salebot(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    from fastapi.responses import Response
    from urllib.parse import quote
    import json as _json
    await check_conference_access(event_id, int(client["sub"]), db)

    event = await db.fetchrow("SELECT * FROM events WHERE id = $1", event_id)
    conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)

    # Спикеры
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.role,
                  (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, cse.gift_raffle_title,
                  cse.sort_order, cse.is_visible,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.title, sp.achievements,
                  sp.tg_channel_url, sp.tg_channel_id, sp.instagram_url
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)

    # Дни + сессии: время хранится строкой "HH:MM" (МСК), показываем как есть.
    days = await db.fetch(
        "SELECT * FROM conf_days WHERE event_id = $1 ORDER BY day_number", event_id
    )
    sessions = await db.fetch(
        """SELECT s.id, s.day, s.sort_order, s.title,
                  s.start_time AS start_local,
                  s.end_time   AS end_local,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS speaker_name, cse.role AS speaker_role
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1
           ORDER BY s.day, NULLIF(s.start_time,'') NULLS LAST, s.sort_order""",
        event_id
    )

    speakers_list = [dict(r) for r in rows]

    def fmt_time(val):
        if val is None or val == "":
            return ""
        return str(val)[:5]

    def fmt_date(val):
        if val is None:
            return ""
        months = ["января","февраля","марта","апреля","мая","июня",
                  "июля","августа","сентября","октября","ноября","декабря"]
        if hasattr(val, "day"):
            return f"{val.day} {months[val.month - 1]}"
        return str(val)

    # Разбиваем спикеров на группы для каналов.
    # Организатор определяется ролью спикера (cse.role == 'organizer'),
    # а не отдельным полем conf_conferences.organizer_speaker_id (удалено).
    def split_by_role(sp_list, role_key="role"):
        organizers = [s for s in sp_list if s.get("role") == "organizer"]
        organizer_ids = {s["id"] for s in organizers}
        partners = [s for s in sp_list if s["id"] not in organizer_ids and s.get("role") == "partner"]
        others = [s for s in sp_list if s["id"] not in organizer_ids and s.get("role") != "partner"]
        return organizers, others, partners

    lines = []

    # ─── ИНФО О СПИКЕРАХ ───
    lines.append("ИНФО О СПИКЕРАХ:")
    lines.append("")

    for i, sp in enumerate(speakers_list):
        lines.append(sp["name"])

        tg = (sp.get("tg_channel_url") or "").strip()
        if tg:
            lines.append(f"Тг канал: {tg}")

        insta = (sp.get("instagram_url") or "").strip()
        if insta:
            lines.append(f"Нельзяграм: {insta}")

        if tg or insta:
            lines.append("")

        # Партнёрам тему не выводим
        if sp.get("role") != "partner":
            lines.append("Тема лекции:")
            lines.append("")

            sp_topics = topics_map.get(sp["id"], [])
            topic_texts = [t["topic"] for t in sp_topics if t["topic"].strip()]
            if topic_texts:
                for topic in topic_texts:
                    lines.append(topic)
            else:
                lines.append("уточняется")

            lines.append("")

        # Регалии из achievements · (точка по центру U+00B7)
        raw = sp.get("achievements") or []
        if isinstance(raw, str):
            try:
                raw = _json.loads(raw)
            except Exception:
                raw = [raw] if raw.strip() else []
        achievements_list = [a for a in raw if str(a).strip()]

        if achievements_list:
            for ach in achievements_list:
                lines.append(f"• {ach}")
        else:
            lines.append("• (регалии уточняются)")

        lines.append("")

        gift_speech = (sp.get("gift_after_speech_title") or "").strip()
        gift_raffle = (sp.get("gift_raffle_title") or "").strip()

        if gift_speech:
            lines.append(f"🎁 На эфире подарит: {gift_speech}")
            lines.append("")

        if gift_raffle:
            lines.append(f"🏆Подарок для большого розыгрыша: {gift_raffle}")
            lines.append("")

        if i < len(speakers_list) - 1:
            lines.append("###")
            lines.append("")

    lines.append("")
    lines.append("—")

    # ─── ПРОГРАММА ───
    lines.append("ПРОГРАММА Конференции:")
    lines.append("")

    for d in days:
        day_num = d["day_number"]
        day_date = fmt_date(d["day_date"])
        lines.append(f"ДЕНЬ {day_num} - {day_date}" if day_date else f"ДЕНЬ {day_num}")
        lines.append("")

        day_sessions = [s for s in sessions if s["day"] == day_num]
        for s in day_sessions:
            t_start = fmt_time(s["start_local"])
            t_end = fmt_time(s["end_local"])
            time_part = f"{t_start} - {t_end}: " if (t_start or t_end) else ""
            title_part = s["title"] or ""
            sp_name = s.get("speaker_name") or ""
            sp_role = (s.get("speaker_role") or "").strip()
            role_label = {"headliner": "хедлайнер", "organizer": "организатор", "jury": "жюри"}.get(sp_role, "")
            if sp_name and role_label:
                person_part = f" ({sp_name} - {role_label})"
            elif sp_name:
                person_part = f" ({sp_name})"
            else:
                person_part = ""
            lines.append(f"{time_part}{title_part}{person_part}")

        lines.append("")

    lines.append("—")

    # ─── ПОДАРКИ ДЛЯ РОЗЫГРЫША ───
    lines.append("ПОДАРКИ ДЛЯ РОЗЫГРЫША")
    lines.append("")

    raffle_items = [(sp["name"], sp["gift_raffle_title"]) for sp in speakers_list if (sp.get("gift_raffle_title") or "").strip()]
    for idx, (sp_name, gift_title) in enumerate(raffle_items, 1):
        lines.append(f"{idx}.{gift_title} ({sp_name})")

    lines.append("")
    lines.append("—")

    # ─── КАНАЛЫ НА ПОДПИСКУ ───
    # Организаторы первыми, партнёры отдельно в конце
    organizers_sp, others_sp, partners_sp = split_by_role(speakers_list)

    lines.append("Список каналов на подписку :")
    lines.append("")

    main_channel_list = organizers_sp + others_sp
    idx = 1
    for sp in main_channel_list:
        tg = (sp.get("tg_channel_url") or "").strip()
        if tg:
            lines.append(f"{idx}.{sp['name']}: {tg}")
            idx += 1

    partner_channels = [(sp["name"], (sp.get("tg_channel_url") or "").strip()) for sp in partners_sp if (sp.get("tg_channel_url") or "").strip()]
    if partner_channels:
        lines.append("")
        lines.append("Партнёры:")
        for pidx, (sp_name, tg_url) in enumerate(partner_channels, 1):
            lines.append(f"{pidx}.{sp_name}: {tg_url}")

    lines.append("")
    lines.append("—")

    # ─── СПИСОК ID КАНАЛОВ ───
    lines.append("Список id каналов спикеров")
    lines.append("")

    idx = 1
    for sp in main_channel_list:
        ch_id = (sp.get("tg_channel_id") or "").strip()
        if ch_id:
            lines.append(f"{idx}.{sp['name']}: {ch_id}")
            idx += 1

    partner_ids = [(sp["name"], (sp.get("tg_channel_id") or "").strip()) for sp in partners_sp if (sp.get("tg_channel_id") or "").strip()]
    if partner_ids:
        lines.append("")
        lines.append("Партнёры:")
        for pidx, (sp_name, ch_id) in enumerate(partner_ids, 1):
            lines.append(f"{pidx}.{sp_name}: {ch_id}")

    text = "\n".join(lines)

    slug = event["slug"] if event and event.get("slug") else str(event_id)
    filename = f"{slug}_info.txt"
    encoded_filename = quote(filename, safe="")

    return Response(
        content=text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
    )


# ─── Отправка карточки спикера в Telegram ─────────────────────────────────────

def _build_speaker_caption(sp: dict, topics: list) -> str:
    """Строит текст-подпись для карточки спикера (формат Salebot, \n как разделитель)."""
    parts = []

    name = (sp.get("name") or "").strip()
    parts.append(name)

    tg = (sp.get("tg_channel_url") or "").strip()
    insta = (sp.get("instagram_url") or "").strip()
    if tg:
        parts.append(f"Тг канал: {tg}")
    if insta:
        parts.append(f"Нельзяграм: {insta}")
    if tg or insta:
        parts.append("")

    # Тема лекции (только не партнёрам)
    if sp.get("role") != "partner":
        parts.append("Тема лекции:")
        parts.append("")
        topic_texts = [t["topic"] for t in topics if t.get("topic", "").strip()]
        if topic_texts:
            for topic in topic_texts:
                parts.append(topic)
        else:
            parts.append("уточняется")
        parts.append("")

    # Регалии
    import json as _json
    raw = sp.get("achievements") or []
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except Exception:
            raw = [raw] if raw.strip() else []
    achievements_list = [a for a in raw if str(a).strip()]
    if achievements_list:
        for ach in achievements_list:
            parts.append(f"· {ach}")
    parts.append("")

    gift_speech = (sp.get("gift_after_speech_title") or "").strip()
    gift_raffle = (sp.get("gift_raffle_title") or "").strip()

    if gift_speech:
        parts.append(f"🎁 На эфире подарит: {gift_speech}")
        parts.append("")

    if gift_raffle:
        parts.append(f"🏆Подарок для большого розыгрыша: {gift_raffle}")
        parts.append("")

    return "\n".join(parts).rstrip()


@router.get("/speakers/{speaker_event_id}/send-to-telegram",
            summary="Отправить карточку спикера в Telegram (нужен токен интеграции)")
async def send_speaker_to_telegram(
    event_id: int,
    speaker_event_id: int,
    chat_id: str,
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Отправляет карточку спикера (афиша + текст) в Telegram-чат.
    chat_id — Telegram ID получателя. Бот берётся у клиента-владельца события.

    ⚠️ Раньше эндпоинт работал БЕЗ всякой авторизации: любой, кто знал номер
    события и номер чата, мог заставить систему слать сообщения чужим ботом.
    По логам за две недели обращений не было ни одного, поэтому закрыт токеном
    интеграции (`clients.integration_token`), как остальные внешние точки.
    """
    import httpx, os

    # Определяем клиента по событию
    event_row = await db.fetchrow("SELECT client_id FROM event_owners WHERE event_id = $1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1", event_id)
    if not event_row:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    client_id = event_row["client_id"]

    await _assert_send_allowed(db, client_id=client_id, event_id=event_id,
                               token=x_integration_token)

    # Получаем bot_token из channels (telegram-канал клиента)
    from app.services.channels import get_client_telegram_token
    bot_token = (await get_client_telegram_token(client_id, db)) or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=400, detail="bot_token не настроен в профиле клиента")

    # Данные спикера
    row = await db.fetchrow(
        """SELECT cse.id, cse.role,
                  (SELECT COALESCE(g1.manual_title, l1.name, p1.name) FROM event_collaborator_lead_magnets g1 LEFT JOIN lead_magnets l1 ON l1.id = g1.lead_magnet_id LEFT JOIN lead_magnet_packages p1 ON p1.id = g1.package_id WHERE g1.ec_id = cse.id ORDER BY g1.sort_order, g1.id LIMIT 1) AS gift_after_speech_title, cse.gift_raffle_title,
                  CASE WHEN cse.use_photo_instead_of_poster THEN NULL
                       ELSE cp_cse.url END AS cse_poster_url,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name, sp.achievements,
                  sp.photo_url,
                  -- Миграция 237: тумблер «не использовать индивидуальную афишу».
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE NOT cse.use_photo_instead_of_poster
                       AND cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.tg_channel_url, sp.instagram_url
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN collaborator_posters cp_cse ON cp_cse.id = cse.poster_id
           WHERE cse.id = $1 AND cse.event_id = $2""",
        speaker_event_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    topics_map = await _load_topics([speaker_event_id], db)
    sp = dict(row)
    topics = topics_map.get(speaker_event_id, [])

    # poster_url: сначала афиша события, потом первая из библиотеки коллаба.
    # Миграция 237: если индивидуальные афиши отключены тумблером — обе пустые,
    # тогда шлём обычное фото коллаба (иначе карточка ушла бы вовсе без фото).
    poster_url = (sp.get("cse_poster_url") or sp.get("poster_url")
                  or sp.get("photo_url") or "").strip()
    caption = _build_speaker_caption(sp, topics)

    reply_markup = {
        "inline_keyboard": [[
            {"text": "Программа конференции", "url": "https://t.me/ivision_conf_bot?start=program"}
        ]]
    }

    CAPTION_LIMIT = 1024

    async with httpx.AsyncClient(timeout=15) as http:
        if poster_url:
            if len(caption) <= CAPTION_LIMIT:
                # Фото + caption + кнопка
                payload = {
                    "chat_id": chat_id,
                    "photo": poster_url,
                    "caption": caption,
                    "disable_web_page_preview": True,
                    "reply_markup": reply_markup,
                }
                resp = await http.post(
                    f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                    json=payload
                )
                tg_result = resp.json()
            else:
                # Фото без caption — потом текст отдельным сообщением
                resp1 = await http.post(
                    f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                    json={"chat_id": chat_id, "photo": poster_url}
                )
                tg_result = resp1.json()
                if tg_result.get("ok"):
                    resp2 = await http.post(
                        f"https://api.telegram.org/bot{bot_token}/sendMessage",
                        json={
                            "chat_id": chat_id,
                            "text": caption,
                            "disable_web_page_preview": True,
                            "reply_markup": reply_markup,
                        }
                    )
                    tg_result = resp2.json()
        else:
            payload = {
                "chat_id": chat_id,
                "text": caption,
                "disable_web_page_preview": True,
                "reply_markup": reply_markup,
            }
            resp = await http.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json=payload
            )
            tg_result = resp.json()

    if not tg_result.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"Ошибка Telegram API: {tg_result.get('description', 'неизвестно')}"
        )

    return {
        "ok": True,
        "speaker": sp.get("name"),
        "chat_id": chat_id,
        "telegram_response": tg_result,
    }


# ─── Отправка программы конференции в Telegram ────────────────────────────────

SCHEDULE_ROLES_WITH_LABEL = {"headliner", "organizer", "jury", "partner", "general_partner"}

ROLE_LABELS_RU = {
    "headliner": "хедлайнер",
    "organizer": "организатор",
    "jury": "жюри",
    "partner": "партнёр",
    "general_partner": "генеральный партнёр",
}

MONTHS_RU = {
    1: "января", 2: "февраля", 3: "марта", 4: "апреля",
    5: "мая", 6: "июня", 7: "июля", 8: "августа",
    9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
}

def _format_date_ru(d) -> str:
    if d is None:
        return ""
    if hasattr(d, "day"):
        return f"{d.day} {MONTHS_RU[d.month]}"
    return str(d)

def _fmt_time(val) -> str:
    # Время в БД теперь хранится строкой "HH:MM" — отдаём как есть, без TZ-математики.
    if val is None or val == "":
        return "?"
    return str(val)[:5]

def _build_schedule_text(days_data: list) -> str:
    """Строит текст программы конференции с HTML-разметкой для Telegram."""
    lines = ["ПРОГРАММА КОНФЕРЕНЦИИ:"]
    for day in days_data:
        lines.append("")
        date_label = day["date"]
        day_header = f"ДЕНЬ {day['day_number']} - {date_label}" if date_label else f"ДЕНЬ {day['day_number']}"
        lines.append(f"<b>{day_header}</b>")
        for s in day["sessions"]:
            time_start = s["time_start"]
            time_end = s["time_end"]
            title = s["title"]
            speaker = s["speaker_name"] or ""
            role = s["role"] or ""
            line = f"<b>{time_start} - {time_end} МСК</b>: {title}"
            if speaker:
                if role in SCHEDULE_ROLES_WITH_LABEL:
                    role_label = ROLE_LABELS_RU.get(role, role)
                    line += f" (<b>{speaker}</b> - {role_label})"
                else:
                    line += f" (<b>{speaker}</b>)"
            lines.append(line)
    return "\n".join(lines)


@router.get(
    "/send-schedule",
    summary="Отправить программу конференции в Telegram",
    tags=["Конференция"],
)
async def send_schedule_to_telegram(
    event_id: int,
    chat_id: int,
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db),
):
    """
    Публичный GET endpoint.
    Параметры: event_id (path), chat_id (query).
    Отправляет текст программы конференции с тремя inline-кнопками в Telegram.
    bot_token берётся из таблицы clients по client_id события.
    """
    import httpx, os

    # Получаем client_id из события
    event_row = await db.fetchrow("SELECT client_id FROM event_owners WHERE event_id = $1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1", event_id)
    if not event_row:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    client_id = event_row["client_id"]
    await _assert_send_allowed(db, client_id=client_id, event_id=event_id,
                               token=x_integration_token)

    # bot_token из channels (telegram-канал клиента)
    from app.services.channels import get_client_telegram_token
    bot_token = (await get_client_telegram_token(client_id, db)) or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=400, detail="bot_token не настроен в профиле клиента")

    # Данные конференции (для ссылки). Лендинг = events.landing_url
    # (после миграции 057), fallback на legacy getcourse_form_url.
    conf = await db.fetchrow(
        """SELECT e.landing_url, cc.getcourse_form_url
             FROM events e
             LEFT JOIN conf_conferences cc ON cc.event_id = e.id
            WHERE e.id = $1""",
        event_id
    )
    conf_url = ""
    if conf:
        conf_url = (conf["landing_url"] or conf["getcourse_form_url"] or "").strip()

    # Дни конференции
    days_db = await db.fetch(
        "SELECT day_number, day_date FROM conf_days WHERE event_id = $1 ORDER BY day_number",
        event_id
    )

    # Сессии с ролью
    sessions_db = await db.fetch(
        """SELECT s.day, s.start_time, s.end_time, s.title, s.sort_order,
                  btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS speaker_name, cse.role
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1
           ORDER BY s.day, NULLIF(s.start_time,'') NULLS LAST, s.sort_order""",
        event_id
    )

    # Группируем сессии по дням
    sessions_by_day: dict = {}
    for s in sessions_db:
        d = s["day"]
        sessions_by_day.setdefault(d, []).append(s)

    days_data = []
    for day in days_db:
        dn = day["day_number"]
        days_data.append({
            "day_number": dn,
            "date": _format_date_ru(day["day_date"]),
            "sessions": [
                {
                    "time_start": _fmt_time(s["start_time"]),
                    "time_end": _fmt_time(s["end_time"]),
                    "title": s["title"],
                    "speaker_name": s["speaker_name"],
                    "role": s["role"],
                }
                for s in sessions_by_day.get(dn, [])
            ],
        })

    text = _build_schedule_text(days_data)

    # Inline-кнопки
    buttons = [
        [{"text": "ИНФОРМАЦИЯ О СПИКЕРАХ", "url": "https://t.me/ivision_conf_bot?start=spikers"}],
    ]
    if conf_url:
        buttons.append([{"text": "ПОЛУЧИТЬ ЗАПИСИ И VIP-ТАРИФ", "url": conf_url}])
        buttons.append([{"text": "ЗАРЕГИСТРИРОВАТЬСЯ", "url": conf_url}])

    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "reply_markup": {"inline_keyboard": buttons},
    }

    # ⚠️ Адрес хранилища НИКОГДА не пишем в коде: при переезде (Cloudflare →
    # Cloud.ru, 2026-08-21) такие строки молча продолжают указывать на старое
    # место. Собираем через settings — единственную точку настройки.
    from app.config import settings as _s
    SCHEDULE_IMAGE_URL = f"{_s.cf_r2_public_url.rstrip('/')}/img/ivision_program.jpg"

    async with httpx.AsyncClient(timeout=15) as http:
        # Сначала отправляем изображение без текста
        photo_resp = await http.post(
            f"https://api.telegram.org/bot{bot_token}/sendPhoto",
            json={"chat_id": chat_id, "photo": SCHEDULE_IMAGE_URL},
        )
        photo_result = photo_resp.json()
        if not photo_result.get("ok"):
            raise HTTPException(
                status_code=502,
                detail=f"Ошибка отправки фото: {photo_result.get('description', 'неизвестно')}",
            )

        # Затем текст программы с кнопками
        resp = await http.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json=payload,
        )
        tg_result = resp.json()

    if not tg_result.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"Ошибка Telegram API: {tg_result.get('description', 'неизвестно')}",
        )

    return {
        "ok": True,
        "chat_id": chat_id,
        "days": len(days_data),
        "telegram_response": tg_result,
    }


# ─── Отправка списка подарков для розыгрыша в Telegram ───────────────────────

RAFFLE_ROLES_WITH_LABEL = {"headliner", "organizer", "jury", "partner", "general_partner"}

RAFFLE_ROLE_LABELS_RU = {
    "headliner": "хедлайнер",
    "organizer": "организатор",
    "jury": "жюри",
    "partner": "партнёр",
    "general_partner": "генеральный партнёр",
}

@router.get(
    "/send-raffle-gifts",
    summary="Отправить список подарков розыгрыша в Telegram",
    tags=["Конференция"],
)
async def send_raffle_gifts_to_telegram(
    event_id: int,
    chat_id: int,
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db),
):
    """
    Публичный GET endpoint.
    Параметры: event_id (path), chat_id (query).
    Отправляет нумерованный список подарков для розыгрыша с кнопкой в Telegram.
    bot_token берётся из таблицы clients по client_id события.
    """
    import httpx, os

    # Получаем client_id из события
    event_row = await db.fetchrow("SELECT client_id FROM event_owners WHERE event_id = $1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1", event_id)
    if not event_row:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    client_id = event_row["client_id"]
    await _assert_send_allowed(db, client_id=client_id, event_id=event_id,
                               token=x_integration_token)

    # bot_token из channels (telegram-канал клиента)
    from app.services.channels import get_client_telegram_token
    bot_token = (await get_client_telegram_token(client_id, db)) or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=400, detail="bot_token не настроен в профиле клиента")

    # Подарки для розыгрыша — только те у кого заполнен gift_raffle_title
    gifts = await db.fetch(
        """SELECT cse.gift_raffle_title, cse.role, btrim(CASE WHEN COALESCE(btrim(sp.last_name),'')='' THEN COALESCE(sp.name,'') ELSE COALESCE(sp.name,'')||' '||COALESCE(sp.last_name,'') END) AS name
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
             AND cse.gift_raffle_title IS NOT NULL
             AND cse.gift_raffle_title != ''
             AND cse.is_visible = TRUE
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )

    if not gifts:
        raise HTTPException(status_code=404, detail="Подарки для розыгрыша не найдены")

    lines = []
    for i, g in enumerate(gifts, 1):
        gift_title = g["gift_raffle_title"]
        speaker = g["name"] or ""
        role = g["role"] or ""
        if speaker:
            if role in RAFFLE_ROLES_WITH_LABEL:
                role_label = RAFFLE_ROLE_LABELS_RU.get(role, role)
                speaker_part = f"<b>{speaker} - {role_label}</b>"
            else:
                speaker_part = f"<b>{speaker}</b>"
            lines.append(f"{i}.{gift_title} ({speaker_part})")
        else:
            lines.append(f"{i}.{gift_title}")

    text = "\n\n".join(lines)

    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "reply_markup": {
            "inline_keyboard": [[
                {"text": "Проверить/Получить билеты", "url": "https://t.me/ivision_conf_bot?start=check_get_bilets"}
            ]]
        },
    }

    async with httpx.AsyncClient(timeout=15) as http:
        resp = await http.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json=payload,
        )
        tg_result = resp.json()

    if not tg_result.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"Ошибка Telegram API: {tg_result.get('description', 'неизвестно')}",
        )

    return {
        "ok": True,
        "chat_id": chat_id,
        "gifts_count": len(gifts),
        "telegram_response": tg_result,
    }


# ─── Билеты розыгрыша ─────────────────────────────────────────────────────────

class RaffleTicketPublicCreate(BaseModel):
    ticket_number: int
    tg_username: Optional[str] = None
    tg_id: Optional[int] = None
    tg_name: Optional[str] = None
    salebot_client_id: Optional[str] = None
    code_word: Optional[str] = None


@router.get("/raffle-tickets", summary="Список билетов розыгрыша")
async def list_raffle_tickets(
    event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    tickets = await db.fetch(
        """SELECT rt.*,
                  pu.username  AS pu_username,
                  pu.first_name AS pu_first_name,
                  pu.last_name  AS pu_last_name,
                  c.salebot_id AS pu_salebot_id
             FROM conf_raffle_tickets rt
        LEFT JOIN event_participants ep ON ep.id = rt.pluson_participant_id
        LEFT JOIN contacts           c  ON c.id = ep.contact_id
        LEFT JOIN platform_users     pu ON pu.contact_id = c.id AND pu.platform_slug = 'telegram'
            WHERE rt.event_id = $1
         ORDER BY rt.ticket_number""",
        event_id
    )
    return {"tickets": [dict(t) for t in tickets]}


@router.post("/raffle-tickets/public", summary="Добавить билет (публичный, без авторизации)")
async def add_raffle_ticket_public(
    event_id: int, data: RaffleTicketPublicCreate, db: asyncpg.Connection = Depends(get_db)
):
    # Проверяем что событие существует и является конференцией
    event = await db.fetchrow(
        "SELECT id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id FROM events WHERE id = $1 AND module_slug IN ('conference','turnir')", event_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Конференция не найдена")

    # Ищем pluson_participant_id: сначала по tg_id (platform_user_id в platform_users),
    # затем по salebot_client_id (поле salebot_id в contacts)
    pluson_participant_id = None
    if data.tg_id:
        pluson_participant_id = await db.fetchval(
            """SELECT ep.id FROM event_participants ep
               JOIN platform_users pu ON pu.contact_id = ep.contact_id
               WHERE pu.platform_slug = 'telegram'
                 AND pu.platform_user_id = $1
                 AND ep.event_id = $2""",
            str(data.tg_id), event_id
        )
    if not pluson_participant_id and data.salebot_client_id:
        pluson_participant_id = await db.fetchval(
            """SELECT ep.id FROM event_participants ep
               JOIN contacts c ON c.id = ep.contact_id
               WHERE c.salebot_id = $1 AND ep.event_id = $2""",
            data.salebot_client_id, event_id
        )

    try:
        ticket = await db.fetchrow(
            """INSERT INTO conf_raffle_tickets
               (event_id, ticket_number, tg_username, tg_id, tg_name, salebot_client_id, pluson_participant_id, code_word)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (event_id, ticket_number) DO UPDATE SET
                 tg_username = EXCLUDED.tg_username,
                 tg_id = EXCLUDED.tg_id,
                 tg_name = EXCLUDED.tg_name,
                 salebot_client_id = EXCLUDED.salebot_client_id,
                 pluson_participant_id = EXCLUDED.pluson_participant_id,
                 code_word = EXCLUDED.code_word
               RETURNING *""",
            event_id, data.ticket_number, data.tg_username, data.tg_id,
            data.tg_name, data.salebot_client_id, pluson_participant_id, data.code_word
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ─── Отчёты конференции ────────────────────────────────────────────────────────

class ReportCreate(BaseModel):
    announcements: int = 0


@router.post("/reports", summary="Создать отчёт (снимок статистики)")
async def create_report(
    event_id: int,
    data: ReportCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)

    # Все спикеры/организаторы конференции с трафиком по реф-коду
    # ref_code теперь живёт в contacts (через collaborators.contact_id)
    speakers_rows = await db.fetch(
        """SELECT cse.id AS speaker_event_id, cse.speaker_id, c.ref_code,
                  cse.role, cse.is_commercial, cse.sort_order,
                  col.name,
                  pu_tg.username AS username,
                  COUNT(ep.id) FILTER (WHERE ep.id IS NOT NULL) AS entered,
                  COUNT(ep.id) FILTER (WHERE ep.is_registered = TRUE) AS registered
           FROM event_collaborators cse
           JOIN collaborators col ON col.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = col.contact_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = col.contact_id AND pu_tg.platform_slug = 'telegram'
           LEFT JOIN event_participants ep ON ep.event_id = $1
               AND ep.referrer_ref_code = c.ref_code
           WHERE cse.event_id = $1
           GROUP BY cse.id, cse.speaker_id, c.ref_code, cse.role,
                    cse.is_commercial, cse.sort_order, col.name, pu_tg.username
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )

    # Реф-коды всех спикеров/организаторов — для исключения из рефералов и базы
    all_speaker_ref_codes = {row["ref_code"] for row in speakers_rows if row["ref_code"]}

    speakers_data = []
    for row in speakers_rows:
        speakers_data.append({
            "speaker_event_id": row["speaker_event_id"],
            "speaker_id": row["speaker_id"],
            "name": row["name"] or "",
            "username": row["username"] or "",
            "role": row["role"] or "speaker",
            "is_commercial": row["is_commercial"] or False,
            "ref_code": row["ref_code"] or "",
            "entered": int(row["entered"]),
            "registered": int(row["registered"]),
        })

    # Группа «Ошибка распределения» больше не существует:
    # маркер 'new_partner_id' зачищен, такие участники теперь идут в «Из базы».
    errors_rows = []

    errors_data = []
    for row in errors_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["username"] or str(row["tg_id"] or "")
        errors_data.append({
            "participant_id": row["id"],
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": 1,
            "registered": 1 if row["is_registered"] else 0,
        })

    # Рефоводы = те кто привёл других И сами являются участниками события
    # Исключаем спикеров через JOIN: спикер — это коллаб со связкой на contact, и есть запись в event_collaborators
    referrals_rows = await db.fetch(
        """SELECT ep2.referrer_ref_code,
                  COUNT(ep2.id) AS entered,
                  COUNT(ep2.id) FILTER (WHERE ep2.is_registered = TRUE) AS registered,
                  pu.platform_user_id AS tg_id, pu.first_name, pu.last_name, pu.username, ct.id AS contact_id
           FROM event_participants ep2
           JOIN contacts ct ON ct.ref_code = ep2.referrer_ref_code AND ct.client_id = (
               SELECT client_id FROM event_owners WHERE event_id = $1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1
           )
           LEFT JOIN platform_users pu ON pu.contact_id = ct.id AND pu.platform_slug = 'telegram'
           WHERE ep2.event_id = $1
             AND ep2.referrer_ref_code IS NOT NULL
             AND ep2.referrer_ref_code <> ''
             AND ct.is_staff = FALSE
             AND NOT EXISTS (
                 SELECT 1 FROM collaborators c
                 JOIN event_collaborators cse ON cse.speaker_id = c.id
                 WHERE c.contact_id = ct.id AND cse.event_id = $1
             )
             AND EXISTS (
                 SELECT 1 FROM event_participants ep_check
                 WHERE ep_check.contact_id = ct.id AND ep_check.event_id = $1
             )
           GROUP BY ep2.referrer_ref_code, pu.platform_user_id, pu.first_name, pu.last_name, pu.username, ct.id
           ORDER BY entered DESC""",
        event_id
    )

    # Сотрудники/лидгены (contacts.is_staff) — их трафик идёт в группу «Организатор»
    # отдельной именной строкой, а не в раздел «Рефоводы».
    staff_rows = await db.fetch(
        """SELECT ep2.referrer_ref_code,
                  COUNT(ep2.id) AS entered,
                  COUNT(ep2.id) FILTER (WHERE ep2.is_registered = TRUE) AS registered,
                  pu.platform_user_id AS tg_id, pu.first_name, pu.last_name, pu.username,
                  ct.id AS contact_id, ct.name AS ct_name
           FROM event_participants ep2
           JOIN contacts ct ON ct.ref_code = ep2.referrer_ref_code AND ct.client_id = (
               SELECT client_id FROM event_owners WHERE event_id = $1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1
           )
           LEFT JOIN platform_users pu ON pu.contact_id = ct.id AND pu.platform_slug = 'telegram'
           WHERE ep2.event_id = $1
             AND ep2.referrer_ref_code IS NOT NULL
             AND ep2.referrer_ref_code <> ''
             AND ct.is_staff = TRUE
           GROUP BY ep2.referrer_ref_code, pu.platform_user_id, pu.first_name, pu.last_name, pu.username, ct.id, ct.name
           ORDER BY entered DESC""",
        event_id
    )
    staff_data = []
    for row in staff_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["ct_name"] or row["username"] or row["referrer_ref_code"] or "—"
        staff_data.append({
            "participant_id": row["contact_id"] or 0,
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": int(row["entered"]),
            "registered": int(row["registered"]),
        })

    referrals_data = []
    for row in referrals_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["username"] or row["referrer_ref_code"] or "—"
        referrals_data.append({
            "participant_id": row["contact_id"] or 0,
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": int(row["entered"]),
            "registered": int(row["registered"]),
        })

    # Из базы: 1) участники без реф-кода, 2) рефоводы не являющиеся участниками события
    base_rows = await db.fetch(
        """SELECT ep.id, ep.is_registered,
                  pu.platform_user_id AS tg_id, pu.first_name, pu.last_name, pu.username
           FROM event_participants ep
           JOIN contacts ct ON ct.id = ep.contact_id
           LEFT JOIN platform_users pu ON pu.contact_id = ct.id AND pu.platform_slug = 'telegram'
           WHERE ep.event_id = $1
             AND (ep.referrer_ref_code IS NULL OR ep.referrer_ref_code = '')
           ORDER BY ep.id""",
        event_id
    )

    # Рефоводы не являющиеся участниками события — тоже идут в базу
    # (исключаем спикеров через JOIN на collaborators)
    base_referrers_rows = await db.fetch(
        """SELECT ep2.referrer_ref_code,
                  COUNT(ep2.id) AS entered,
                  COUNT(ep2.id) FILTER (WHERE ep2.is_registered = TRUE) AS registered,
                  pu.platform_user_id AS tg_id, pu.first_name, pu.last_name, pu.username, ct.id AS contact_id
           FROM event_participants ep2
           JOIN contacts ct ON ct.ref_code = ep2.referrer_ref_code AND ct.client_id = (
               SELECT client_id FROM event_owners WHERE event_id = $1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1
           )
           LEFT JOIN platform_users pu ON pu.contact_id = ct.id AND pu.platform_slug = 'telegram'
           WHERE ep2.event_id = $1
             AND ep2.referrer_ref_code IS NOT NULL
             AND ep2.referrer_ref_code <> ''
             AND ct.is_staff = FALSE
             AND NOT EXISTS (
                 SELECT 1 FROM collaborators c
                 JOIN event_collaborators cse ON cse.speaker_id = c.id
                 WHERE c.contact_id = ct.id AND cse.event_id = $1
             )
             AND NOT EXISTS (
                 SELECT 1 FROM event_participants ep_check
                 WHERE ep_check.contact_id = ct.id AND ep_check.event_id = $1
             )
           GROUP BY ep2.referrer_ref_code, pu.platform_user_id, pu.first_name, pu.last_name, pu.username, ct.id
           ORDER BY entered DESC""",
        event_id
    )

    base_data = []
    for row in base_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["username"] or str(row["tg_id"] or "")
        base_data.append({
            "participant_id": row["id"],
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": 1,
            "registered": 1 if row["is_registered"] else 0,
        })
    for row in base_referrers_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["username"] or str(row["tg_id"] or "")
        base_data.append({
            "participant_id": row["contact_id"] or 0,
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": int(row["entered"]),
            "registered": int(row["registered"]),
        })

    # Сводные цифры
    speakers_entered = sum(s["entered"] for s in speakers_data)
    speakers_registered = sum(s["registered"] for s in speakers_data)
    referrals_entered = sum(r["entered"] for r in referrals_data)
    referrals_registered = sum(r["registered"] for r in referrals_data)
    base_entered = sum(r["entered"] for r in base_data)
    base_registered = sum(r["registered"] for r in base_data)
    staff_entered = sum(r["entered"] for r in staff_data)
    staff_registered = sum(r["registered"] for r in staff_data)
    errors_entered = len(errors_data)
    errors_registered = sum(r["registered"] for r in errors_data)
    total_entered = speakers_entered + referrals_entered + base_entered + staff_entered + errors_entered
    total_registered = speakers_registered + referrals_registered + base_registered + staff_registered + errors_registered

    report = await db.fetchrow(
        """INSERT INTO conf_reports
           (event_id, announcements, total_entered, total_registered,
            speakers_entered, speakers_registered,
            referrals_entered, referrals_registered,
            speakers_data, referrals_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *""",
        event_id, data.announcements,
        total_entered, total_registered,
        speakers_entered, speakers_registered,
        referrals_entered + base_entered, referrals_registered + base_registered,
        json.dumps(speakers_data, ensure_ascii=False),
        json.dumps({
            "referrals": referrals_data,
            "base": base_data,
            "errors": errors_data,
            "staff": staff_data,
        }, ensure_ascii=False),
    )

    return {"report": dict(report)}


@router.get("/reports", summary="Список отчётов конференции")
async def list_reports(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    rows = await db.fetch(
        """SELECT id, event_id, created_at, announcements,
                  total_entered, total_registered,
                  speakers_entered, speakers_registered,
                  referrals_entered, referrals_registered
           FROM conf_reports
           WHERE event_id = $1
           ORDER BY created_at DESC""",
        event_id
    )

    return {"reports": [dict(r) for r in rows]}


@router.get("/reports/{report_id}", summary="Детальный отчёт")
async def get_report(
    event_id: int,
    report_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    row = await db.fetchrow(
        "SELECT * FROM conf_reports WHERE id = $1 AND event_id = $2",
        report_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Отчёт не найден")

    r = dict(row)
    if isinstance(r.get("speakers_data"), str):
        r["speakers_data"] = json.loads(r["speakers_data"])
    raw_ref = r.get("referrals_data")
    if isinstance(raw_ref, str):
        raw_ref = json.loads(raw_ref)
    # Поддержка старого формата (список) и нового (dict с ключами referrals/base/errors)
    if isinstance(raw_ref, list):
        r["referrals_data"] = raw_ref
        r["base_data"] = []
        r["errors_data"] = []
        r["staff_data"] = []
    else:
        r["referrals_data"] = raw_ref.get("referrals", [])
        r["base_data"] = raw_ref.get("base", [])
        r["errors_data"] = raw_ref.get("errors", [])
        r["staff_data"] = raw_ref.get("staff", [])

    return {"report": r}


@router.delete("/reports/{report_id}", summary="Удалить отчёт")
async def delete_report(
    event_id: int,
    report_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db, write=True)

    deleted = await db.fetchval(
        "DELETE FROM conf_reports WHERE id = $1 AND event_id = $2 RETURNING id",
        report_id, event_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Отчёт не найден")
    return {"ok": True}

    return {"ok": True, "ticket": dict(ticket)}


@router.get("/speakers/{speaker_event_id}/click-stats",
            summary="Статистика кликов по карточке спикера в Mini App (миграция 109)")
async def speaker_click_stats(
    event_id: int,
    speaker_event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Возвращает счётчики кликов по платформам + список контактов, кто кликнул."""
    await check_conference_access(event_id, int(client["sub"]), db)
    counts = await db.fetch(
        """SELECT click_kind, COUNT(*) AS cnt
             FROM event_collaborator_clicks
            WHERE event_collaborator_id = $1
            GROUP BY click_kind""",
        speaker_event_id,
    )
    by_kind = {r["click_kind"]: int(r["cnt"]) for r in counts}
    recent = await db.fetch(
        """SELECT c.id, c.name,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email,
                  c.phone, cl.click_kind, cl.clicked_at,
                  cl.contact_name AS snapshot_name,
                  cl.tg_id        AS snapshot_tg_id,
                  cl.tg_nickname  AS snapshot_tg_nickname,
                  cl.vk_id        AS snapshot_vk_id,
                  cl.max_id       AS snapshot_max_id,
                  -- COALESCE: используем актуальные данные контакта (если жив),
                  -- иначе fallback на снапшот при клике (миграция 110).
                  COALESCE(c.name, cl.contact_name) AS display_name,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS contact_tg_id,
                  (SELECT pu.username        FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS contact_tg_nickname,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS contact_vk_id,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS contact_max_id
             FROM event_collaborator_clicks cl
             LEFT JOIN contacts c ON c.id = cl.contact_id
            WHERE cl.event_collaborator_id = $1
            ORDER BY cl.clicked_at DESC
            LIMIT 200""",
        speaker_event_id,
    )
    # Финальные поля для фронта: эффективные tg_id/vk_id/max_id (актуальные → снапшот)
    out_recent = []
    for r in recent:
        d = dict(r)
        d["tg_id"]       = d.pop("contact_tg_id")       or d.pop("snapshot_tg_id")
        d["tg_nickname"] = d.pop("contact_tg_nickname") or d.pop("snapshot_tg_nickname")
        d["vk_id"]       = d.pop("contact_vk_id")       or d.pop("snapshot_vk_id")
        d["max_id"]      = d.pop("contact_max_id")      or d.pop("snapshot_max_id")
        d["name"]        = d.pop("display_name") or d.get("name")
        d.pop("snapshot_name", None)
        out_recent.append(d)
    return {
        "by_kind": by_kind,
        "total": sum(by_kind.values()),
        "recent": out_recent,
    }


@router.get("/click-report",
            summary="Сводный отчёт кликов по всем спикерам конференции")
async def conference_click_report(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Для отдельной подвкладки в Отчёте: имя спикера + counts по платформам."""
    await check_conference_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT cse.id AS ec_id, cse.role, c.name AS speaker_name,
                  SUM(CASE WHEN cl.click_kind = 'tg_channel'     THEN 1 ELSE 0 END) AS tg_channel,
                  SUM(CASE WHEN cl.click_kind = 'vk'             THEN 1 ELSE 0 END) AS vk,
                  SUM(CASE WHEN cl.click_kind = 'max'            THEN 1 ELSE 0 END) AS max_clicks,
                  SUM(CASE WHEN cl.click_kind = 'instagram'      THEN 1 ELSE 0 END) AS instagram,
                  SUM(CASE WHEN cl.click_kind = 'website'        THEN 1 ELSE 0 END) AS website,
                  SUM(CASE WHEN cl.click_kind = 'knowledge_base' THEN 1 ELSE 0 END) AS knowledge_base
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             LEFT JOIN event_collaborator_clicks cl ON cl.event_collaborator_id = cse.id
            WHERE cse.event_id = $1
            GROUP BY cse.id, cse.role, c.name, cse.sort_order
            ORDER BY cse.sort_order, c.name""",
        event_id,
    )
    return {"rows": [dict(r) for r in rows]}

