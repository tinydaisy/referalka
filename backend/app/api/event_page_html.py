"""
Простая серверная HTML-страница события: GET /event/{slug}

НЕ React, НЕ Mini App — обычная HTML-страница, собранная на сервере с уже
вставленными данными. Открывается мгновенно, без спиннеров и загрузок.
Узкая колонка по центру (как телефон), бренд-цвета (тёмный градиент + персик).

Цель: вкладки повторяют содержимое Mini App:
  - «Программа»  ≈ ProgramTab  (галерея спикеров + VIP-кнопка + описание + дни/сессии + организаторы)
  - «Спикеры»    ≈ SpeakersTab  (аккордеон по группам)
  - «Кабинет»    ≈ GameTab      (только при валидном ?c={contact_id})

Источники данных — те же запросы/функции, что и Mini App / landing_widget:
collaborator_sort.order_by_sql для порядка спикеров, share_links.build_share_links
для реф-ссылок кабинета.
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from app.database import get_db
from app.services.collaborator_sort import order_by_sql
import asyncpg
import html as _html
import json

router = APIRouter(tags=["Публичная HTML-страница события"])

PEACH = "#FFCFA4"
DARK = "#25455D"

RU_MONTHS = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
             "июля", "августа", "сентября", "октября", "ноября", "декабря"]


# ── Хелперы данных ────────────────────────────────────────────────────────

async def _resolve_event(db: asyncpg.Connection, ref: str):
    cols = ("id, slug, title, module_slug, status, description, "
            "description_post_register, vip_url, vip_button_label, "
            "(SELECT eo.client_id FROM event_owners eo WHERE eo.event_id = events.id "
            "AND eo.status = 'accepted' ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id, "
            "landing_url, start_at, end_at, link_mode, "
            "chat_url, chat_url_tg, chat_url_vk, chat_url_max, "
            "primary_chat_platform, chat_button_label")
    if ref.isdigit():
        ev = await db.fetchrow(
            f"SELECT {cols} FROM events WHERE id = $1", int(ref))
        if ev:
            return ev
    return await db.fetchrow(
        f"SELECT {cols} FROM events WHERE slug = $1", ref)


def _parse_jsonb(value):
    if value is None:
        return []
    if isinstance(value, str):
        try:
            v = json.loads(value)
            return v if isinstance(v, list) else []
        except Exception:
            return []
    return value if isinstance(value, list) else []


async def _load_collaborators(db, event_id):
    """Все коллабы события в порядке order_by_sql (как Mini App). Поле ec_id =
    event_collaborators.id (для якорей #speaker-{ec_id})."""
    rows = await db.fetch(
        f"""SELECT cse.id AS ec_id, cse.role, cse.speaker_topic,
                   cse.knowledge_base_title, cse.knowledge_base_url,
                   cse.gift_after_speech_title, cse.gift_raffle_title,
                   c.name, c.title, c.achievements, c.photo_url,
                   c.tg_channel_url, c.vk_url, c.max_url, c.instagram_url
              FROM event_collaborators cse
              JOIN collaborators c ON c.id = cse.speaker_id
             WHERE cse.event_id = $1
             ORDER BY {order_by_sql('cse')}""",
        event_id,
    )
    out = []
    for r in rows:
        d = dict(r)
        d["achievements"] = d.get("achievements") or []
        out.append(d)
    return out


async def _load_program(db, event_id):
    days = await db.fetch(
        """SELECT id, day_number, day_date, open_time, close_time, stage_id, title
             FROM conf_days WHERE event_id = $1 ORDER BY day_number, id""",
        event_id,
    )
    stages = await db.fetch(
        """SELECT id, sort_order, title, subtitle, description, start_date, end_date
             FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id""",
        event_id,
    )
    sessions = await db.fetch(
        """SELECT s.day, s.start_time, s.end_time, s.title,
                  cse.id AS sp_ec_id,
                  col.name AS sp_name, col.title AS sp_title,
                  col.photo_url AS sp_photo
             FROM conf_sessions s
             LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
             LEFT JOIN collaborators col ON col.id = cse.speaker_id
            WHERE s.event_id = $1
            ORDER BY s.day, s.sort_order, s.start_time, s.id""",
        event_id,
    )
    return days, stages, sessions


async def _load_gifts(db, event_id):
    """Пороги-подарки события (как getGifts в Mini App)."""
    rows = await db.fetch(
        """SELECT t.threshold_count AS points_cost,
                  COALESCE(lm.name, 'Подарок') AS title,
                  t.gift_template_text AS description,
                  lm.url AS link_url,
                  t.certificate_url
             FROM event_referral_thresholds t
             LEFT JOIN lead_magnets lm ON lm.id = t.lead_magnet_id
            WHERE t.event_id = $1
            ORDER BY t.threshold_count""",
        event_id,
    )
    return [dict(r) for r in rows]


async def _load_share_materials(db, event_id):
    texts = await db.fetch(
        """SELECT content FROM event_referral_share_texts
            WHERE event_id = $1 ORDER BY sort, id""", event_id)
    rows = await db.fetch(
        """SELECT media_type, image_url, video_url FROM event_referral_materials
            WHERE event_id = $1 ORDER BY sort, id""", event_id)
    images = [r["image_url"] for r in rows if r["media_type"] != "video" and r["image_url"]]
    videos = [r["video_url"] for r in rows if r["media_type"] == "video" and r["video_url"]]
    return [r["content"] for r in texts if r["content"]], images, videos


async def _referral_enabled(db, event_id):
    val = await db.fetchval(
        "SELECT is_enabled FROM event_referral_settings WHERE event_id = $1",
        event_id)
    return bool(val)


async def _load_ref_cabinet(db, event, contact_id):
    """Реф-кабинет человека: его счётчики, реф-ссылки, ТОП, список людей.
    None если контакт не найден у этого клиента или невалиден (merged)."""
    if not contact_id:
        return None
    c = await db.fetchrow(
        """SELECT id, ref_code, name FROM contacts
            WHERE id = $1 AND client_id = $2 AND merged_into IS NULL""",
        int(contact_id), event["client_id"],
    )
    if not c or not c["ref_code"]:
        return None
    ref_code = c["ref_code"]
    visited = await db.fetchval(
        """SELECT COUNT(*) FROM event_participants ep
            WHERE ep.event_id = $1 AND ep.referrer_ref_code = $2""",
        event["id"], ref_code,
    ) or 0
    registered = await db.fetchval(
        """SELECT COUNT(*) FROM event_participants ep
            WHERE ep.event_id = $1 AND ep.referrer_ref_code = $2
              AND ep.is_registered = TRUE""",
        event["id"], ref_code,
    ) or 0
    # Список «Ваши люди». Для каждого приводим основную платформенную
    # идентичность (приоритет telegram → vk → max), чтобы показать иконку
    # и сделать имя кликабельным (личка в его приложении).
    people_rows = await db.fetch(
        """SELECT ct.name, ep.is_registered,
                  pu.platform_slug, pu.platform_user_id, pu.username
             FROM event_participants ep
             JOIN contacts ct ON ct.id = ep.contact_id
             LEFT JOIN LATERAL (
                 SELECT p.platform_slug, p.platform_user_id, p.username
                   FROM platform_users p
                  WHERE p.contact_id = ct.id
                  ORDER BY CASE p.platform_slug
                             WHEN 'telegram' THEN 1
                             WHEN 'vk' THEN 2
                             WHEN 'max' THEN 3
                             WHEN 'email' THEN 4
                             ELSE 5 END, p.id
                  LIMIT 1
             ) pu ON TRUE
            WHERE ep.event_id = $1 AND ep.referrer_ref_code = $2
            ORDER BY ep.is_registered DESC, ep.id DESC
            LIMIT 100""",
        event["id"], ref_code,
    )
    my_people = [{
        "name": r["name"] or "Без имени",
        "is_registered": bool(r["is_registered"]),
        "platform_slug": r["platform_slug"],
        "platform_user_id": r["platform_user_id"],
        "username": r["username"],
    } for r in people_rows]

    # ТОП рефереров события (по числу приведённых).
    # Кто попадает в топ:
    #  - турнир (module_slug='turnir'): участники события + коллабы с ролью
    #    speaker/headliner (исключаем organizer/jury/partner/general_partner);
    #  - все остальные типы: только участники события (исключаем всех коллабов).
    is_turnir = (event.get("module_slug") == "turnir")
    # Роли коллабов, которые НИКОГДА не попадают в топ (даже если они участники).
    # Турнир: исключаем организаторов/жюри/партнёров, но оставляем спикеров.
    # Остальные типы: исключаем ВСЕХ коллабов (organizer/jury/speaker/...).
    if is_turnir:
        excluded_roles = "'organizer','jury','partner','general_partner'"
    else:
        excluded_roles = "'organizer','jury','speaker','headliner','partner','general_partner'"
    top_where = (
        " ct.is_staff = FALSE"
        " AND ct.ref_code NOT IN ("
        "   SELECT c3.ref_code FROM event_collaborators ec3"
        "   JOIN collaborators col3 ON col3.id = ec3.speaker_id"
        "   JOIN contacts c3 ON c3.id = col3.contact_id"
        f"  WHERE ec3.event_id = $1 AND ec3.role IN ({excluded_roles})"
        "   AND c3.ref_code IS NOT NULL)"
    )
    top_rows = await db.fetch(
        f"""SELECT ct.name, ct.ref_code,
                   COUNT(*) AS cnt
              FROM event_participants ep
              JOIN contacts ct ON ct.ref_code = ep.referrer_ref_code
             WHERE ep.event_id = $1 AND ep.referrer_ref_code IS NOT NULL
               AND ct.client_id = $2
               AND {top_where}
             GROUP BY ct.name, ct.ref_code
             ORDER BY cnt DESC, ct.name""",
        event["id"], event["client_id"],
    )
    top = []
    for i, r in enumerate(top_rows):
        top.append({
            "rank": i + 1,
            "name": r["name"] or "Без имени",
            "count": r["cnt"],
            "is_me": r["ref_code"] == ref_code,
        })
    # Персональные реф-ссылки
    links = {}
    try:
        from app.services.share_links import build_share_links
        links = await build_share_links(
            db, event_slug=event["slug"], client_id=event["client_id"],
            partner_id=ref_code,
            link_mode=(event["link_mode"] if "link_mode" in event else None) or "miniapp",
        )
    except Exception:
        links = {}
    return {
        "ref_code": ref_code,
        "name": c["name"] or "",
        "visited": visited,
        "registered": registered,
        "my_people": my_people,
        "top": top,
        "links": links if isinstance(links, dict) else {},
    }


async def _load_client(db, client_id):
    return await db.fetchrow(
        "SELECT name, brand_name FROM clients WHERE id = $1", client_id)


async def _load_event_poster(db, event_id):
    """Лучшая афиша события (square > horizontal > vertical) — как в send_event_menu."""
    return await db.fetchval(
        """SELECT url FROM event_posters
            WHERE event_id = $1
            ORDER BY CASE orientation
                       WHEN 'square'     THEN 1
                       WHEN 'horizontal' THEN 2
                       WHEN 'vertical'   THEN 3
                       ELSE 4
                     END, sort, id
            LIMIT 1""",
        event_id,
    )


async def _load_venue(db, client_id):
    """Профиль клиента (бренд + основатель) + продукты — для вкладки «О площадке»
    (повторяет EcosystemTab + OwnerPage Mini App)."""
    profile = await db.fetchrow(
        """SELECT brand_name, name, profile_photo_url, positioning, achievements,
                  owner_photo_url, owner_positioning, owner_achievements, bio,
                  social_links
             FROM clients WHERE id = $1""",
        client_id,
    )
    offerings = await db.fetch(
        """SELECT title, description, action_url, is_paid, cover_url
             FROM client_offerings WHERE client_id = $1
            ORDER BY is_paid DESC, sort_order, id""",
        client_id,
    )
    return profile, [dict(o) for o in offerings]


def _parse_jsonb_obj(value):
    if value is None:
        return {}
    if isinstance(value, str):
        try:
            v = json.loads(value)
            return v if isinstance(v, dict) else {}
        except Exception:
            return {}
    return value if isinstance(value, dict) else {}


# ── Рендер ────────────────────────────────────────────────────────────────

def esc(s) -> str:
    return _html.escape(str(s)) if s is not None else ""


def _fmt_time(v):
    if v is None:
        return ""
    return str(v)[:5]


def _fmt_time_range(t1, t2):
    a = _fmt_time(t1)
    b = _fmt_time(t2)
    if a and b:
        return f"{a}–{b} МСК"
    if a:
        return f"{a} МСК"
    return ""


def _fmt_event_date(start_at):
    """'DD.MM.YYYY HH:MM МСК' для плейсхолдера {date}. МСК = UTC+3."""
    if not start_at:
        return ""
    try:
        from datetime import timedelta
        dt = start_at
        if getattr(dt, "tzinfo", None) is not None:
            dt = dt.astimezone(tz=None)
        # start_at в БД naive UTC → прибавляем 3 часа для МСК
        msk = dt + timedelta(hours=3) if getattr(dt, "tzinfo", None) is None else dt
        return msk.strftime("%d.%m.%Y %H:%M") + " МСК"
    except Exception:
        return ""


def _initials(name):
    if not name:
        return "?"
    parts = str(name).strip().split()
    a = parts[0][0] if parts else ""
    b = parts[1][0] if len(parts) > 1 else ""
    return (a + b).upper() or "?"


ROLE_LABELS = {
    "speaker": "Спикер", "headliner": "Хедлайнер", "partner": "Партнёр",
    "general_partner": "Генеральный партнёр", "organizer": "Организатор",
    "jury": "Жюри",
}


def _instagram_url(raw):
    if not raw:
        return None
    if raw.startswith("http"):
        return raw
    return "https://instagram.com/" + raw.lstrip("@")


def _tg_url(raw):
    if not raw:
        return None
    if raw.lower().startswith("http"):
        return raw
    if raw.startswith("@"):
        return "https://t.me/" + raw[1:]
    return "https://t.me/" + raw


def _avatar_html(photo, name, size=56):
    photo = esc(photo or "")
    if photo:
        return (f'<div class="ava" style="width:{size}px;height:{size}px;'
                f'background:center/cover url(\'{photo}\')"></div>')
    return (f'<div class="ava ava-empty" style="width:{size}px;height:{size}px">'
            f'{esc(_initials(name))}</div>')


def _speaker_card(p) -> str:
    """Карточка спикера для вкладки «Спикеры». id=speaker-{ec_id} (для якорей)."""
    ec_id = p.get("ec_id")
    name = esc(p.get("name") or "")
    title = esc(p.get("title") or "")
    role = p.get("role") or ""
    role_label = ROLE_LABELS.get(role, "")
    topic = p.get("speaker_topic") or ""
    ach = [a for a in (p.get("achievements") or []) if a]

    badge = (f'<span class="role-badge">{esc(role_label)}</span>'
             if role_label else "")
    title_html = f'<div class="ptitle">{title}</div>' if title else ""
    topic_html = ""
    if topic:
        topic_html = (f'<div class="topic-wrap"><div class="topic-lbl">Тема</div>'
                      f'<div class="topic">{esc(topic)}</div></div>')
    ach_html = ""
    if ach:
        items = "".join(f'<li>{esc(a)}</li>' for a in ach)
        ach_html = f'<ul class="ach">{items}</ul>'

    # Подарок на эфире / в розыгрыше
    gift_html = ""
    gas = p.get("gift_after_speech_title")
    if gas:
        gift_html += (
            '<div class="gift-tag gift-tag-air">'
            '<div class="gift-tag-lbl">🎁 Подарок на эфире</div>'
            f'<div class="gift-tag-val">{esc(gas)}</div></div>'
        )
    graf = p.get("gift_raffle_title")
    if graf:
        gift_html += (
            '<div class="gift-tag gift-tag-raffle">'
            '<div class="gift-tag-lbl">🎟 Подарок в розыгрыше</div>'
            f'<div class="gift-tag-val">{esc(graf)}</div></div>'
        )

    # соцсети 2×2 (только непустые)
    socials = []
    tg = _tg_url(p.get("tg_channel_url"))
    if tg:
        socials.append(("Тг-канал", tg, True))
    if p.get("vk_url"):
        socials.append(("ВКонтакте", p.get("vk_url"), False))
    if p.get("max_url"):
        socials.append(("MAX", p.get("max_url"), False))
    insta = _instagram_url(p.get("instagram_url"))
    if insta:
        socials.append(("Нельзяграм", insta, False))
    soc_html = ""
    if socials:
        btns = "".join(
            f'<a class="soc {"soc-primary" if prim else ""}" '
            f'href="{esc(url)}" target="_blank" rel="noopener">'
            f'<span>{esc(lbl)}</span><span class="soc-arr">→</span></a>'
            for lbl, url, prim in socials
        )
        soc_html = f'<div class="socs">{btns}</div>'

    # база знаний
    kb_html = ""
    kb_t = p.get("knowledge_base_title")
    kb_u = p.get("knowledge_base_url")
    if kb_t and kb_u:
        kb_html = (
            f'<a class="kb" href="{esc(kb_u)}" target="_blank" rel="noopener">'
            f'<span class="kb-ico">📖</span>'
            f'<span class="kb-body"><span class="kb-lbl">База знаний</span>'
            f'<span class="kb-title">{esc(kb_t)}</span></span>'
            f'<span class="kb-arr">→</span></a>'
        )

    return (
        f'<div class="sp-card" id="speaker-{ec_id}">'
        f'<div class="sp-head">'
        f'{_avatar_html(p.get("photo_url"), p.get("name"), 56)}'
        f'<div class="sp-meta">{badge}'
        f'<div class="pname">{name}</div>{title_html}</div>'
        f'</div>'
        f'{topic_html}{ach_html}{gift_html}{soc_html}{kb_html}'
        f'</div>'
    )


def _speakers_panel(collabs) -> str:
    """Аккордеон по группам. Порядок внутри группы = как пришёл из SQL."""
    segments = [
        ("organizer", "Организаторы", {"organizer"}),
        ("jury", "Жюри", {"jury"}),
        ("speaker", "Спикеры", {"headliner", "speaker"}),
        ("partner", "Партнёры", {"general_partner", "partner"}),
    ]
    buckets = {key: [] for key, _, _ in segments}
    for c in collabs:
        role = c.get("role")
        for key, _, roles in segments:
            if role in roles:
                buckets[key].append(c)
                break
    out = ""
    for key, label, _ in segments:
        people = buckets[key]
        if not people:
            continue
        cards = "".join(_speaker_card(p) for p in people)
        out += (
            f'<div class="acc">'
            f'<button class="acc-h" data-acc="{key}" type="button">'
            f'<span>{esc(label)} · {len(people)}</span>'
            f'<span class="acc-chev">▾</span></button>'
            f'<div class="acc-body" id="acc-{key}">{cards}</div>'
            f'</div>'
        )
    if not out:
        out = '<div class="empty">Список спикеров пока пуст.</div>'
    return out


def _gallery_html(speakers) -> str:
    """Горизонтальная лента аватаров (как ProgramTab). Кликабельны → #speakers
    + якорь к карточке."""
    if not speakers:
        return ""
    items = ""
    for p in speakers:
        ec_id = p.get("ec_id")
        items += (
            f'<a class="g-item" href="#speakers" data-speaker="{ec_id}">'
            f'{_avatar_html(p.get("photo_url"), p.get("name"), 56)}'
            f'<div class="g-name">{esc(p.get("name") or "")}</div>'
            f'</a>'
        )
    return f'<div class="gallery">{items}</div>'


def _program_panel(event, collabs, days, stages, sessions) -> str:
    """Вкладка «Программа»: галерея + VIP + описание + дни/сессии + организаторы."""
    # Спикеры для галереи — все НЕ-организаторы (как лента в Mini App).
    gallery_people = [c for c in collabs if c.get("role") != "organizer"]
    if not gallery_people:
        gallery_people = collabs
    out = _gallery_html(gallery_people)

    # VIP-кнопка
    vip_url = (event.get("vip_url") or "").strip()
    if vip_url:
        vip_label = esc(event.get("vip_button_label") or "Расшириться до VIP-тарифа")
        out += (f'<a class="vip-btn" href="{esc(vip_url)}" '
                f'target="_blank" rel="noopener">{vip_label}</a>')

    # Чаты события (прямые ссылки, без проверки подписки — как просили).
    # Главный по primary_chat_platform — сверху и подписан «(главный)».
    chats = []
    chat_map = {
        "telegram": (event.get("chat_url_tg"), "Telegram"),
        "vk": (event.get("chat_url_vk"), "VK"),
        "max": (event.get("chat_url_max"), "MAX"),
    }
    primary = event.get("primary_chat_platform") or "telegram"
    # сначала главный, потом остальные
    order = [primary] + [p for p in ("telegram", "vk", "max") if p != primary]
    for plat in order:
        url, plat_name = chat_map.get(plat, (None, ""))
        url = (url or "").strip()
        if url:
            chats.append((url, plat_name, plat == primary))
    # legacy одиночное поле chat_url — если ни одного платформенного нет
    if not chats:
        legacy = (event.get("chat_url") or "").strip()
        if legacy:
            chats.append((legacy, "", True))

    if chats:
        base_label = esc(event.get("chat_button_label") or "Чат события")
        rows = ""
        for url, plat_name, is_primary in chats:
            sfx = ""
            if plat_name:
                sfx = f' · {esc(plat_name)}'
            main = ' <span class="chat-main">(главный)</span>' if (is_primary and len(chats) > 1) else ""
            rows += (f'<a class="chat-btn" href="{esc(url)}" target="_blank" '
                     f'rel="noopener">💬 {base_label}{sfx}{main}</a>')
        out += f'<div class="chats">{rows}</div>'

    # Описание после регистрации (HTML как есть)
    dpr = event.get("description_post_register") or ""
    if dpr.strip():
        out += f'<div class="desc">{dpr}</div>'

    # Программа: ВСЕ этапы (даже без дней — с описанием/датами, как в Mini App),
    # внутри каждого — его дни; дни без этапа — отдельным блоком в конце.
    def _render_day(day):
        dn = day.get("day_number")
        dtitle = esc(day.get("title") or (f"День {dn}" if dn else "День"))
        ddate = esc(str(day.get("day_date") or ""))
        day_sessions = [s for s in sessions if s.get("day") == dn]
        rows = ""
        for s in day_sessions:
            tm = _fmt_time_range(s.get("start_time"), s.get("end_time"))
            stitle = esc(s.get("title") or "")
            spk = esc(s.get("sp_name") or "")
            sp_ec = s.get("sp_ec_id")
            sp_photo = esc(s.get("sp_photo") or "")
            if spk:
                if sp_photo:
                    av = (f'<span class="ss-ava" style="background-image:'
                          f"url('{sp_photo}')\"></span>")
                else:
                    inits = "".join([w[0] for w in spk.split()[:2]]).upper()
                    av = f'<span class="ss-ava ss-ava-empty">{inits}</span>'
                arrow = '<span class="ss-go">Карточка →</span>' if sp_ec else ""
                tag = "a" if sp_ec else "div"
                attrs = (f'href="#speakers" data-speaker="{sp_ec}"'
                         if sp_ec else "")
                spk_html = (f'<{tag} class="ss-card" {attrs}>{av}'
                            f'<span class="ss-name">{spk}</span>{arrow}</{tag}>')
            else:
                spk_html = ""
            time_html = f'<div class="s-time">{tm}</div>' if tm else ""
            rows += (
                f'<div class="s-row">{time_html}'
                f'<div class="s-main"><div class="s-title">{stitle}</div>'
                f'{spk_html}</div></div>'
            )
        date_sfx = f' · {ddate}' if ddate else ""
        body = rows if rows else '<div class="empty-sm">—</div>'
        return (f'<div class="day"><div class="day-h">{dtitle}{date_sfx}</div>'
                f'{body}</div>')

    def _stage_header(st):
        st_title = esc(st.get("title") or "Этап")
        st_sub = esc(st.get("subtitle") or "")
        sub_html = f'<div class="stage-sub">{st_sub}</div>' if st_sub else ""
        # Диапазон дат этапа
        sd = str(st.get("start_date") or "")
        ed = str(st.get("end_date") or "")
        date_html = ""
        if sd or ed:
            rng = f"{sd} – {ed}" if (sd and ed and sd != ed) else (sd or ed)
            date_html = f'<div class="stage-date">{esc(rng)}</div>'
        desc = (st.get("description") or "").strip()
        desc_html = f'<div class="stage-desc">{desc}</div>' if desc else ""
        return (f'<div class="stage-h">{st_title}{sub_html}{date_html}</div>'
                f'{desc_html}')

    if days or stages:
        days_by_stage = {}
        for d in days:
            days_by_stage.setdefault(d.get("stage_id"), []).append(d)
        prog = ""
        # Этапы по порядку (все, даже без дней)
        for st in stages:
            prog += _stage_header(dict(st))
            for d in days_by_stage.get(st["id"], []):
                prog += _render_day(d)
        # Дни без этапа (stage_id IS NULL) — в конце
        for d in days_by_stage.get(None, []):
            prog += _render_day(d)
        out += '<h2 class="sec-h">Программа</h2>' + prog
    elif not dpr.strip() and not vip_url:
        out += '<div class="empty">Программа пока не опубликована</div>'

    # Организаторы внизу
    organizers = [c for c in collabs if c.get("role") == "organizer"]
    if organizers:
        cards = "".join(_speaker_card(p) for p in organizers)
        out += '<h2 class="sec-h">Организаторы</h2>' + cards

    return out


_PLATFORM_ICON = {
    "telegram": ("✈️", "#0088cc", "rgba(0,136,204,0.10)"),
    "vk": ("VK", "#4680bd", "rgba(70,128,189,0.10)"),
    "max": ("M", "#e07b00", "rgba(255,138,0,0.12)"),
    "email": ("@", "#6b7c8e", "#f0f3f7"),
}


def _people_dm_link(slug_platform, pu_id, username):
    """Ссылка в личку человека по его платформе. None если построить нельзя."""
    if slug_platform == "telegram":
        if username:
            return "https://t.me/" + str(username).lstrip("@")
        if pu_id and str(pu_id).lstrip("@").isdigit():
            return "tg://user?id=" + str(pu_id)
        return None
    if slug_platform == "vk":
        if pu_id and str(pu_id).isdigit():
            return "https://vk.com/id" + str(pu_id)
        if username:
            return "https://vk.com/" + str(username).lstrip("@")
        return None
    if slug_platform == "max":
        if username:
            return "https://max.ru/" + str(username).lstrip("@")
        return None
    return None


def _cabinet_email_gate(event) -> str:
    """Форма ввода email, когда кабинет ещё не определён.

    Человек вводит свой email → JS находит contact_id → перезагрузка
    страницы с ?c={id} и запоминание email в localStorage (дальше
    открывается автоматически). Если email не найден — предлагаем
    зарегистрироваться.
    """
    slug = esc(event.get("slug") or "")
    reg_url = f"/event/{slug}/register"
    return (
        '<div class="email-gate">'
        '<div class="eg-icon">🎁</div>'
        '<div class="eg-title">Ваши подарки за приглашённых друзей</div>'
        '<div class="eg-sub">Введите email, который указывали при '
        'регистрации, — откроем ваш кабинет с подарками и реф-ссылками.</div>'
        '<input type="email" id="eg-email" class="eg-input" '
        'placeholder="you@example.com" autocomplete="email" '
        'inputmode="email">'
        '<button id="eg-btn" class="eg-btn">Открыть подарки</button>'
        '<div id="eg-err" class="eg-err"></div>'
        f'<div class="eg-reg">Ещё не регистрировались? '
        f'<a href="{reg_url}">Зарегистрироваться на событие</a></div>'
        '</div>'
    )


def _cabinet_panel(rc, event, gifts, share_texts, share_images,
                   ref_enabled, brand, title, start_at, share_videos=None) -> str:
    """Вкладка «Кабинет» = копия GameTab."""
    visited = rc.get("visited", 0)
    registered = rc.get("registered", 0)

    out = ""
    # Пиллы статистики
    out += (
        '<div class="cab-stats">'
        f'<div class="cab-stat"><div class="cab-num muted">{visited}</div>'
        f'<div class="cab-lbl">переходов</div></div>'
        f'<div class="cab-stat accent"><div class="cab-num">{registered}</div>'
        f'<div class="cab-lbl">регистраций</div></div>'
        '</div>'
    )

    # Реф-программа: подарки + ссылки + материалы — только если включена
    links = rc.get("links") or {}
    ref_link = (links.get("telegram") or links.get("vk") or links.get("max") or
                ("https://pluson.ru/l/" + str(event.get("slug") or "")
                 + "?app=tg&pid=" + str(rc.get("ref_code") or "")))

    if ref_enabled:
        sorted_g = sorted(gifts, key=lambda g: g.get("points_cost") or 0)

        # ── Подарки (сворачиваемый аккордеон) ──
        received = [g for g in sorted_g if registered >= (g.get("points_cost") or 0)]
        next_gift = next((g for g in sorted_g
                          if (g.get("points_cost") or 0) > registered), None)
        gifts_count = len(received)
        total = len(sorted_g)
        if total > 0:
            # Сводка-шапка подарков
            count_html = str(gifts_count)
            if total > 0:
                count_html += f'<span class="g-total">/{total}</span>'
            last_html = ""
            if received:
                last_html = (f'<div class="g-last">«'
                             f'{esc(received[-1].get("title") or "")}»</div>')
            if next_gift:
                to_next = (next_gift.get("points_cost") or 0) - registered
                word = "человек" if to_next == 1 else "человека"
                next_html = (f'<div class="g-next">🎁 Ещё {to_next} {word} '
                             f'до подарка «{esc(next_gift.get("title") or "")}»</div>')
                pct = min(100, round(registered / max(1, next_gift.get("points_cost") or 1) * 100))
                bar = (f'<div class="g-bar"><div class="g-bar-fill" '
                       f'style="width:{pct}%"></div></div>')
            else:
                next_html = '<div class="g-next done">🎉 Все подарки получены!</div>'
                bar = ""
            summary = (
                '<div class="gift-box">'
                f'<div class="gift-top"><div class="gift-num">{count_html}</div>'
                f'<div class="gift-info"><div class="gift-cap">Получено подарков</div>'
                f'{last_html}</div></div>'
                f'{next_html}{bar}</div>'
            )
            # Список порогов: получено / заблокировано. Первый виден всегда,
            # остальные — под жёлтой кнопкой «Показать ещё N».
            def _gift_row(g):
                cost = g.get("points_cost") or 0
                got = registered >= cost
                gtitle = esc(g.get("title") or "")
                gdesc = esc(g.get("description") or "")
                desc_html = f'<div class="gi-desc">{gdesc}</div>' if gdesc else ""
                if got:
                    link = (g.get("link_url") or "").strip()
                    btn = (f'<a class="gi-open" href="{esc(link)}" target="_blank" '
                           f'rel="noopener">Открыть</a>') if link else ""
                    return (
                        '<div class="gi gi-got">'
                        '<div class="gi-ico">🎁</div>'
                        f'<div class="gi-body"><div class="gi-title">{gtitle}</div>'
                        f'{desc_html}</div>'
                        f'<div class="gi-side"><span class="gi-badge got">за {cost} чел</span>'
                        f'{btn}</div></div>'
                    )
                need = cost - registered
                word = "человек" if need == 1 else "человека"
                return (
                    '<div class="gi gi-lock">'
                    '<div class="gi-ico locked">🎁</div>'
                    f'<div class="gi-body"><div class="gi-title">{gtitle}</div>'
                    f'<div class="gi-need">Нужно ещё {need} {word}</div></div>'
                    f'<span class="gi-badge lock">за {cost} чел</span></div>'
                )
            first_gift = _gift_row(sorted_g[0]) if sorted_g else ""
            rest_gifts = sorted_g[1:]
            rest_gifts_html = ""
            if rest_gifts:
                rest_rows = "".join(_gift_row(g) for g in rest_gifts)
                rest_gifts_html = (
                    f'<div class="gifts-rest" id="gifts-rest" style="display:none">{rest_rows}</div>'
                    f'<button class="top-more" data-giftsmore type="button">'
                    f'Показать ещё {len(rest_gifts)} ↓</button>'
                )
            out += (
                '<div class="cab-block">'
                f'<div class="cab-block-h">🎁 Подарки · {gifts_count}/{total}</div>'
                f'{summary}{first_gift}{rest_gifts_html}'
                '</div>'
                '<hr class="cab-divider">'
            )

        # ── ТОП рейтинг: первые 3 видны всегда, остальные — «Показать ещё».
        # Сам блок вставляется НИЖЕ (после материалов, перед «Ваши люди»). ──
        top = rc.get("top") or []
        top_block = ""
        if top:
            def _top_row(t):
                rk = t.get("rank")
                medal = {1: "🥇", 2: "🥈", 3: "🥉"}.get(rk, str(rk))
                me_cls = " me" if t.get("is_me") else ""
                nm = "Вы" if t.get("is_me") else esc(t.get("name") or "")
                return (
                    f'<div class="top-row{me_cls}">'
                    f'<div class="top-rank">{medal}</div>'
                    f'<div class="top-name">{nm}</div>'
                    f'<div class="top-cnt">{t.get("count", 0)}</div></div>'
                )
            head_rows = "".join(_top_row(t) for t in top[:3])
            rest = top[3:]
            rest_html = ""
            if rest:
                rest_rows = "".join(_top_row(t) for t in rest)
                rest_html = (
                    f'<div class="top-rest" id="top-rest" style="display:none">{rest_rows}</div>'
                    f'<button class="top-more" data-topmore type="button">'
                    f'Показать ещё {len(rest)} ↓</button>'
                )
            top_block = (
                '<div class="cab-block">'
                '<div class="cab-block-h">🏆 ТОП рейтинг</div>'
                f'<div class="top-box">{head_rows}{rest_html}</div>'
                '</div>'
            )

        # ── Реф-ссылки (с кнопками копирования) ──
        plabels = {"telegram": "Telegram", "vk": "ВКонтакте", "max": "MAX"}
        link_rows = ""
        for plat in ("telegram", "vk", "max"):
            url = links.get(plat)
            if not url:
                continue
            ico, fg, bg = _PLATFORM_ICON[plat]
            link_rows += (
                '<div class="cab-link">'
                f'<div class="cl-ico" style="color:{fg};background:{bg}">{esc(ico)}</div>'
                '<div class="cl-body">'
                f'<div class="cl-lbl">{esc(plabels[plat])}</div>'
                f'<div class="cl-url">{esc(url)}</div></div>'
                f'<button class="cl-copy copy-btn" type="button" '
                f'data-copy="{esc(url)}">Копировать</button></div>'
            )
        if link_rows:
            out += '<h2 class="sec-h">🔗 Ваши ссылки для друзей</h2>'
            out += ('<div class="hint">Отправьте другу ту ссылку, которая ведёт '
                    'в его приложение. За приглашённых — подарки.</div>')
            out += link_rows

        # ── Материалы (сворачиваемый аккордеон): афиши + тексты ──
        date_str = _fmt_event_date(start_at)
        share_videos = share_videos or []
        if share_images or share_videos or share_texts:
            mat_inner = ""
            if share_images:
                tiles = "".join(
                    f'<a class="mat-img" href="{esc(u)}" target="_blank" rel="noopener">'
                    f'<img src="{esc(u)}" alt="" loading="lazy"></a>'
                    for u in share_images
                )
                mat_inner += '<div class="mat-sub">🖼 Афиши для друзей</div>'
                mat_inner += f'<div class="mat-grid">{tiles}</div>'
            if share_videos:
                vids = "".join(
                    f'<video src="{esc(u)}" controls playsinline preload="metadata" '
                    f'style="width:100%;border-radius:10px;background:#000;margin-bottom:8px"></video>'
                    for u in share_videos
                )
                mat_inner += '<div class="mat-sub">🎬 Видео для друзей</div>'
                mat_inner += f'<div>{vids}</div>'
            if share_texts:
                mat_inner += '<div class="mat-sub">✍️ Тексты для друзей</div>'
                for tpl in share_texts:
                    rendered = (tpl or "")
                    rendered = rendered.replace("{link}", ref_link)
                    rendered = rendered.replace("{event}", title)
                    rendered = rendered.replace("{date}", date_str)
                    rendered = rendered.replace("{brand}", brand)
                    mat_inner += (
                        '<div class="mat-text">'
                        f'<div class="mat-body">{esc(rendered)}</div>'
                        f'<button class="mat-copy copy-btn" type="button" '
                        f'data-copy="{esc(rendered)}">📋 Скопировать текст</button>'
                        '</div>'
                    )
            out += (
                '<div class="acc collapsed">'
                '<button class="acc-h" data-acc="materials" type="button">'
                '<span>🖼 Готовые материалы для анонсов</span>'
                '<span class="acc-chev">▾</span></button>'
                f'<div class="acc-body" id="acc-materials">{mat_inner}</div>'
                '</div>'
            )

        # ── ТОП рейтинг (перенесён сюда: после ссылок и материалов) ──
        out += top_block

        # ── Ваши люди (с иконкой платформы + кликабельные) ──
        people = rc.get("my_people") or []
        if people:
            rows = ""
            for p in people:
                reg = p.get("is_registered")
                mark = "✓" if reg else "·"
                mcls = "reg" if reg else "noreg"
                plat = p.get("platform_slug")
                ico_html = ""
                if plat in _PLATFORM_ICON:
                    pico, pfg, pbg = _PLATFORM_ICON[plat]
                    ico_html = (f'<div class="pp-plat" style="color:{pfg};'
                                f'background:{pbg}">{esc(pico)}</div>')
                dm = _people_dm_link(plat, p.get("platform_user_id"),
                                     p.get("username"))
                name_html = esc(p.get("name") or "")
                inner = (
                    f'{ico_html}'
                    f'<div class="people-name">{name_html}</div>'
                    f'<div class="people-mark {mcls}">{mark}</div>'
                )
                if dm:
                    rows += (f'<a class="people-row people-link" href="{esc(dm)}" '
                             f'target="_blank" rel="noopener">{inner}'
                             '<span class="pp-arr">›</span></a>')
                else:
                    rows += f'<div class="people-row">{inner}</div>'
            out += (f'<h2 class="sec-h">👥 Ваши люди · {len(people)}</h2>'
                    f'<div class="people-box">{rows}</div>')
    else:
        out += ('<div class="hint">Реферальная программа для этого события '
                'пока не подключена.</div>')

    return out


def _achievements_grid(ach_list) -> str:
    """Сетка «Факты в цифрах» 2×N. ach_list = [{label,value}]. Пусто → ''."""
    items = []
    for a in ach_list:
        if not isinstance(a, dict):
            continue
        label = a.get("label")
        value = a.get("value")
        if not (label and str(label).strip()) and not (value and str(value).strip()):
            continue
        items.append(
            '<div class="fact">'
            f'<div class="fact-val">{esc(value or "")}</div>'
            f'<div class="fact-lbl">{esc(label or "")}</div></div>'
        )
    if not items:
        return ""
    return '<div class="facts">' + "".join(items) + "</div>"


def _social_links_html(social) -> str:
    """Соцсети основателя (как OwnerPage). telegram_channels — массив, остальные
    ключи — одиночные ссылки."""
    social = social if isinstance(social, dict) else {}
    btns = []
    tg_channels = social.get("telegram_channels")
    if isinstance(tg_channels, list):
        for ch in tg_channels:
            if not isinstance(ch, dict):
                continue
            url = ch.get("url")
            if not url:
                continue
            label = ch.get("name") or "Telegram"
            btns.append(
                f'<a class="social-btn" href="{esc(url)}" target="_blank" '
                f'rel="noopener">✈️ {esc(label)}</a>'
            )
    single = [
        ("instagram", "Instagram", "📷"),
        ("youtube", "YouTube", "▶"),
        ("vk", "VK", "VK"),
        ("website", "Сайт", "🌐"),
    ]
    for key, label, ico in single:
        url = social.get(key)
        if not url:
            continue
        href = url
        if key == "instagram" and not str(url).startswith("http"):
            href = "https://instagram.com/" + str(url).lstrip("@")
        btns.append(
            f'<a class="social-btn" href="{esc(href)}" target="_blank" '
            f'rel="noopener">{ico} {esc(label)}</a>'
        )
    if not btns:
        return ""
    return ('<div class="social-h">Соцсети</div>'
            '<div class="socials-wrap">' + "".join(btns) + "</div>")


def _offering_card(o) -> str:
    cover = esc(o.get("cover_url") or "")
    is_paid = bool(o.get("is_paid"))
    title = esc(o.get("title") or "")
    desc = esc(o.get("description") or "")
    action = (o.get("action_url") or "").strip()
    if cover:
        ico_html = (f'<div class="off-cover" style="background:center/cover '
                    f'url(\'{cover}\')"></div>')
    else:
        emoji = "💼" if is_paid else "📄"
        ico_html = f'<div class="off-cover off-cover-empty">{emoji}</div>'
    desc_html = f'<div class="off-desc">{desc}</div>' if desc else ""
    free_html = '<div class="off-free">Бесплатно</div>' if not is_paid else ""
    btn_html = ""
    if action:
        btn_cls = "off-btn off-btn-paid" if is_paid else "off-btn off-btn-free"
        btn_html = (f'<a class="{btn_cls}" href="{esc(action)}" target="_blank" '
                    f'rel="noopener">Получить</a>')
    return (
        '<div class="off-card">'
        f'<div class="off-top">{ico_html}'
        f'<div class="off-body"><div class="off-title">{title}</div>'
        f'{desc_html}{free_html}</div></div>{btn_html}</div>'
    )


def _venue_panel(profile, offerings) -> str:
    """Вкладка «О площадке» = копия EcosystemTab + OwnerPage."""
    if not profile:
        return '<div class="empty">Нет данных об экосистеме.</div>'
    brand = esc(profile["brand_name"] or profile["name"] or "")
    brand_role = esc(profile["positioning"] or "")
    brand_ach = _parse_jsonb(profile["achievements"])[:4]
    owner_name = esc(profile["name"] or "")
    owner_role = esc(profile["owner_positioning"] or "")
    owner_ach = _parse_jsonb(profile["owner_achievements"])
    bio = profile["bio"] or ""
    social = _parse_jsonb_obj(profile["social_links"])

    # Шапка бренда
    photo = esc(profile["profile_photo_url"] or "")
    if photo:
        avatar = (f'<div class="venue-ava" style="background:center/cover '
                  f'url(\'{photo}\')"></div>')
    else:
        avatar = (f'<div class="venue-ava venue-ava-empty">'
                  f'{esc(_initials(profile["brand_name"] or profile["name"]))}</div>')
    role_html = (f'<div class="venue-role">{brand_role}</div>'
                 if brand_role else "")
    out = (
        '<div class="venue-head">'
        f'{avatar}'
        f'<div class="venue-head-body"><div class="venue-brand">{brand}</div>'
        f'{role_html}</div></div>'
    )

    # Факты бренда
    out += _achievements_grid(brand_ach)

    # Карточка-тизер основателя (раскрываемый блок)
    has_owner = bool(owner_name or profile["owner_photo_url"]
                     or owner_role or bio)
    if has_owner:
        o_photo = esc(profile["owner_photo_url"] or "")
        teaser_ava = (
            f'<img class="owner-teaser-ava" src="{o_photo}" alt="">'
            if o_photo else "")
        teaser_role = (f'<div class="owner-teaser-role">{owner_role}</div>'
                       if owner_role else "")
        # Контент основателя
        owner_body = ""
        if o_photo:
            owner_body += (f'<img class="owner-photo" src="{o_photo}" '
                           f'alt="{owner_name}">')
        owner_body += _achievements_grid(owner_ach)
        if bio.strip():
            owner_body += f'<div class="owner-bio">{bio}</div>'
        owner_body += _social_links_html(social)
        out += (
            '<div class="acc collapsed owner-acc">'
            '<button class="owner-teaser" data-acc="owner" type="button">'
            f'{teaser_ava}'
            '<div class="owner-teaser-body">'
            '<div class="owner-teaser-lbl">Об основателе</div>'
            f'<div class="owner-teaser-name">{owner_name}</div>'
            f'{teaser_role}</div>'
            '<span class="owner-teaser-chev">›</span></button>'
            f'<div class="acc-body owner-acc-body" id="acc-owner">{owner_body}</div>'
            '</div>'
        )

    # Продукты: Платно / Бесплатно
    paid = [o for o in offerings if o.get("is_paid")]
    free = [o for o in offerings if not o.get("is_paid")]
    out += ('<div class="venue-tabs">'
            '<button class="vt-btn active" data-vt="free" type="button">Бесплатно</button>'
            '<button class="vt-btn" data-vt="paid" type="button">Платно</button>'
            '</div>')
    free_cards = ("".join(_offering_card(o) for o in free) if free
                  else '<div class="empty">Бесплатных продуктов пока нет</div>')
    paid_cards = ("".join(_offering_card(o) for o in paid) if paid
                  else '<div class="empty">Платных продуктов пока нет</div>')
    out += f'<div class="vt-pane" id="vt-free">{free_cards}</div>'
    out += f'<div class="vt-pane" id="vt-paid" style="display:none">{paid_cards}</div>'
    return out


def render_page(event, collabs, days, stages, sessions, gifts,
                share_texts, share_images, ref_enabled,
                client, ref_cabinet=None, venue_profile=None,
                venue_offerings=None, share_videos=None) -> str:
    title = esc(event.get("title") or event.get("slug"))
    brand_raw = ((client["brand_name"] if client else None)
                 or (client["name"] if client else None) or "")
    brand = esc(brand_raw)
    start_at = event.get("start_at")

    # Favicon — первая буква названия события на бренд-фоне (SVG data-URI).
    # Title вкладки = название события (уже в title выше).
    _ev_title_raw = (event.get("title") or event.get("slug") or "•").strip()
    fav_letter = _html.escape(_ev_title_raw[0].upper() if _ev_title_raw else "•")
    favicon_svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
        "<rect width='64' height='64' rx='14' fill='#25455D'/>"
        "<text x='32' y='44' font-size='38' font-family='Roboto,Arial,sans-serif' "
        f"font-weight='700' fill='#FFCFA4' text-anchor='middle'>{fav_letter}</text></svg>"
    )
    import urllib.parse as _up
    favicon_uri = "data:image/svg+xml," + _up.quote(favicon_svg)

    has_people = bool(collabs)
    module = event.get("module_slug") or "base"
    is_program_event = module in ("conference", "turnir") or bool(days)

    # ── Панели ──
    program_html = _program_panel(event, collabs, days, stages, sessions)
    speakers_html = _speakers_panel(collabs) if has_people else ""
    cabinet_html = ""
    if ref_cabinet:
        cabinet_html = _cabinet_panel(
            ref_cabinet, event, gifts, share_texts, share_images,
            ref_enabled, brand_raw, event.get("title") or "", start_at,
            share_videos=share_videos or [])
    elif ref_enabled:
        # Кабинет неизвестен (нет ?c / ?email не нашёл) — показываем форму
        # ввода email, чтобы человек открыл свои подарки без реф-ссылки.
        cabinet_html = _cabinet_email_gate(event)
    venue_html = _venue_panel(venue_profile, venue_offerings or [])

    # ── Вкладки ──
    tabs = []
    show_program = is_program_event or bool(days) or has_people
    if show_program:
        tabs.append(("program", "Программа"))
    if has_people:
        tabs.append(("speakers", "Спикеры"))
    if cabinet_html:
        tabs.append(("cabinet", "Подарки"))
    # Вкладка «Экосистема» (раньше «О площадке») — всегда (последней)
    tabs.append(("venue", "🌐 Экосистема"))
    if not tabs:
        # совсем пустое событие — хотя бы программа-заглушка
        tabs.append(("program", "Программа"))

    first_tab = tabs[0][0]

    nav_html = "".join(
        f'<a class="tab" href="#{tid}" data-tab="{tid}">{esc(label)}</a>'
        for tid, label in tabs
    )

    panels = ""
    if show_program:
        panels += f'<div class="panel" id="program">{program_html}</div>'
    if has_people:
        panels += f'<div class="panel" id="speakers">{speakers_html}</div>'
    if cabinet_html:
        panels += f'<div class="panel" id="cabinet">{cabinet_html}</div>'
    panels += f'<div class="panel" id="venue">{venue_html}</div>'

    brand_block = f'<div class="brand">{brand}</div>' if brand else ""

    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<link rel="icon" href="{favicon_uri}">
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ margin:0; padding:0; font-family: 'Roboto', -apple-system, BlinkMacSystemFont, sans-serif;
    background: linear-gradient(45deg, #25455D, #0a1520); background-attachment: fixed; color: #1f2d3a; }}
  .wrap {{ max-width: 480px; margin: 0 auto; min-height: 100vh; background: #f7f8fa;
    box-shadow: 0 0 40px rgba(0,0,0,.35); display:flex; flex-direction:column; }}
  .hero {{ background: linear-gradient(45deg, #25455D, #0a1520); color:#fff; padding: 22px 18px 16px; }}
  .hero .brand {{ font-size: 12px; letter-spacing:.5px; color:#FFCFA4; text-transform:uppercase; margin-bottom:6px; }}
  .hero h1 {{ font-size: 21px; margin: 0; line-height:1.25; }}
  .tabs {{ display:flex; gap:4px; padding: 10px 12px; background:#fff; position: sticky; top:0; z-index:5;
    overflow-x:auto; border-bottom:1px solid #eef1f4; }}
  .tab {{ flex:0 0 auto; padding: 8px 14px; border-radius: 20px; font-size:14px; font-weight:600;
    color:#5b6b7a; text-decoration:none; white-space:nowrap; }}
  .tab.active {{ background: #FFCFA4; color:#25455D; }}
  .content {{ flex:1; padding: 16px; padding-bottom: 40px; }}
  .panel {{ display:none; }}
  .panel.active {{ display:block; }}
  .sec-h {{ font-size: 15px; color:#25455D; margin: 20px 0 10px; padding-bottom:6px;
    border-bottom: 2px solid #FFCFA4; display:inline-block; }}
  .empty {{ color:#8593a1; font-size:14px; padding:20px; text-align:center; }}
  .empty-sm {{ color:#b0bcc8; font-size:13px; padding:6px 0; }}
  .hint {{ font-size:12.5px; color:#6b7c8e; line-height:1.45; margin: 4px 0 12px; }}

  /* Галерея спикеров (ProgramTab) */
  .gallery {{ display:flex; gap:14px; overflow-x:auto; padding: 4px 2px 12px; -webkit-overflow-scrolling: touch; }}
  .g-item {{ flex:0 0 auto; width:64px; text-decoration:none; text-align:center; }}
  .g-name {{ font-size:11px; color:#41566a; margin-top:6px; line-height:1.2;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }}
  .ava {{ border-radius:50%; flex:0 0 auto; border:2px solid #FFCFA4; margin:0 auto; }}
  .ava-empty {{ background: linear-gradient(45deg,#25455D,#0a1520); color:#FFCFA4;
    display:flex; align-items:center; justify-content:center; font-weight:700; font-size:18px; }}

  /* VIP-кнопка */
  .vip-btn {{ display:block; width:100%; text-align:center; text-decoration:none;
    margin: 8px 0 14px; padding: 14px 16px; border-radius: 14px; font-size:15px; font-weight:800;
    color:#fff; background: linear-gradient(135deg, #7f1d1d, #ef4444);
    box-shadow: 0 4px 14px rgba(239,68,68,.3); }}

  /* Чаты события */
  .chats {{ display:flex; flex-direction:column; gap:8px; margin: 8px 0 14px; }}
  .chat-btn {{ display:block; width:100%; text-align:center; text-decoration:none;
    padding: 13px 16px; border-radius: 12px; font-size:14.5px; font-weight:700;
    color:#FFCFA4; background: linear-gradient(135deg, #25455D, #0a1520);
    box-shadow: 0 2px 8px rgba(37,69,93,.2); }}
  .chat-main {{ font-weight:600; color:rgba(255,207,164,.7); font-size:12px; }}

  /* Описание */
  .desc {{ background:#fff; border-radius:14px; padding:16px; line-height:1.6; font-size:14.5px;
    box-shadow:0 1px 4px rgba(0,0,0,.06); margin-bottom:8px; }}
  .desc img {{ max-width:100%; border-radius:8px; }}
  .desc a {{ color:#0088cc; }}

  /* Этапы / дни / сессии */
  .stage-h {{ background: linear-gradient(45deg,#25455D,#0a1520); color:#fff; border-radius:12px;
    padding:12px 14px; margin: 14px 0 10px; font-weight:700; font-size:15px; }}
  .stage-sub {{ font-size:12px; color:#FFCFA4; margin-top:3px; font-weight:500; }}
  .stage-date {{ font-size:11.5px; color:#FFCFA4; margin-top:4px; opacity:.85; }}
  .stage-desc {{ font-size:13px; color:#41566a; line-height:1.5; margin:-4px 2px 12px;
    padding:0 2px; white-space:pre-wrap; }}
  .day {{ background:#fff; border-radius:14px; padding:14px; margin-bottom:12px; box-shadow:0 1px 4px rgba(0,0,0,.06); }}
  .day-h {{ font-weight:700; color:#25455D; margin-bottom:10px; font-size:15px; }}
  .s-row {{ display:flex; gap:10px; padding:8px 0; border-top:1px solid #f0f3f6; }}
  .s-row:first-of-type {{ border-top:none; }}
  .s-time {{ flex:0 0 92px; font-size:12.5px; color:#8593a1; }}
  .s-main {{ flex:1; min-width:0; }}
  .s-title {{ font-size:14px; color:#1f2d3a; }}
  .s-spk {{ font-size:12.5px; color:#b86b00; margin-top:2px; text-decoration:none; display:inline-block; }}
  .ss-card {{ display:flex; align-items:center; gap:8px; margin-top:8px; padding:6px 8px;
    background:#f3f6f9; border-radius:10px; text-decoration:none; }}
  .ss-ava {{ width:32px; height:32px; flex:0 0 32px; border-radius:50%; background-size:cover;
    background-position:center; background-color:#dde4ea; display:flex; align-items:center;
    justify-content:center; font-size:11px; font-weight:700; color:#25455D; }}
  .ss-ava-empty {{ background:linear-gradient(135deg,#d4dde5,#b9c6d2); }}
  .ss-name {{ flex:1; min-width:0; font-size:13px; font-weight:600; color:#1f2d3a;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .ss-go {{ font-size:11.5px; color:#b86b00; flex:0 0 auto; }}
  .top-rest {{ }}
  .top-more {{ width:100%; margin-top:8px; padding:9px; border:none; border-radius:10px;
    background:{PEACH}; color:#25455D; font-weight:700; font-size:13px; cursor:pointer; }}
  .top-more:active {{ filter:brightness(.95); }}
  .cab-divider {{ height:1px; background:#e7ecf1; margin:14px 2px; border:none; }}

  /* Карточки спикеров (SpeakersTab) */
  .acc {{ margin-bottom:18px; }}
  .acc-h {{ width:100%; display:flex; align-items:center; justify-content:space-between;
    padding:11px 14px; border-radius:12px; border:1px solid #d9e2ea;
    background: linear-gradient(45deg, #25455D, #0a1520); color:#fff;
    font-size:14px; font-weight:700; cursor:pointer; margin-bottom:10px; font-family:inherit; }}
  .acc-chev {{ display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px;
    border-radius:50%; background:#FFCFA4; color:#25455D; font-weight:800; font-size:14px; transition:transform .2s; }}
  .acc.collapsed .acc-chev {{ transform: rotate(-90deg); }}
  .acc.collapsed .acc-body {{ display:none; }}
  .acc-body {{ display:flex; flex-direction:column; gap:10px; }}
  .sp-card {{ background:#fff8f0; border-radius:14px; padding:14px; box-shadow:0 2px 8px rgba(37,69,93,.05);
    scroll-margin-top: 70px; border:2px solid transparent; transition: border-color .3s, box-shadow .3s; }}
  .sp-card.flash {{ border-color:#FFCFA4; box-shadow:0 4px 16px rgba(255,207,164,.5); }}
  .sp-head {{ display:flex; gap:12px; align-items:flex-start; margin-bottom:10px; }}
  .sp-meta {{ flex:1; min-width:0; }}
  .role-badge {{ display:inline-block; background:#FFCFA4; color:#25455D; font-size:10px;
    padding:2px 8px; border-radius:10px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; margin-bottom:4px; }}
  .pname {{ font-weight:700; font-size:15px; color:#1a2a3a; line-height:1.2; }}
  .ptitle {{ font-size:12px; color:#6b7c8e; margin-top:2px; line-height:1.3; }}
  .topic-wrap {{ margin-bottom:8px; }}
  .topic-lbl {{ font-size:10px; color:#8593a1; text-transform:uppercase; letter-spacing:.4px; font-weight:700; margin-bottom:4px; }}
  .topic {{ font-size:13px; color:#1a2a3a; font-weight:600; line-height:1.35; }}
  .ach {{ margin:0 0 8px; padding:0; list-style:none; }}
  .ach li {{ font-size:12px; color:#3a4a5a; line-height:1.4; padding-left:14px; position:relative; margin-bottom:3px; }}
  .ach li:before {{ content:'•'; position:absolute; left:0; top:-1px; color:#25455D; font-weight:700; font-size:14px; }}
  .socs {{ display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }}
  .soc {{ display:flex; align-items:center; justify-content:center; gap:6px; padding:7px 8px;
    border-radius:10px; font-size:11px; font-weight:600; text-decoration:none;
    background:#fff; color:#25455D; border:1px solid #25455D; }}
  .soc-primary {{ background:#25455D; color:#fff; border:none; }}
  .soc-arr {{ display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px;
    border-radius:50%; background:#FFCFA4; color:#25455D; font-weight:800; font-size:11px; }}
  .kb {{ display:flex; align-items:center; gap:10px; margin-top:10px; padding:10px 12px; border-radius:10px;
    background:rgba(37,69,93,.06); border:1px solid rgba(37,69,93,.15); color:#25455D; text-decoration:none; }}
  .kb-ico {{ font-size:18px; }}
  .kb-body {{ flex:1; min-width:0; display:flex; flex-direction:column; }}
  .kb-lbl {{ font-size:10px; color:#6b7c8e; text-transform:uppercase; letter-spacing:.4px; font-weight:700; }}
  .kb-title {{ font-size:12px; font-weight:600; color:#25455D; line-height:1.3; }}
  .kb-arr {{ display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
    border-radius:50%; background:#FFCFA4; color:#25455D; font-weight:800; font-size:13px; flex-shrink:0; }}

  /* Кабинет (GameTab) */
  .cab-stats {{ display:flex; gap:8px; margin-bottom:12px; }}
  .cab-stat {{ flex:1; background:#fff; border-radius:10px; padding:10px 12px; text-align:center;
    box-shadow:0 2px 6px rgba(37,69,93,.05); }}
  .cab-stat.accent {{ background: linear-gradient(135deg,#fff8f0,#fff); border:1.5px solid #FFCFA4; }}
  .cab-num {{ font-size:22px; font-weight:900; color:#25455D; line-height:1; }}
  .cab-num.muted {{ color:#6b7c8e; }}
  .cab-lbl {{ font-size:10px; color:#6b7c8e; margin-top:4px; }}
  .gift-box {{ background:#fff; border-radius:14px; padding:14px; margin-bottom:12px; box-shadow:0 2px 8px rgba(37,69,93,.05); }}
  .gift-top {{ display:flex; align-items:center; gap:12px; }}
  .gift-num {{ font-size:30px; font-weight:900; color:#25455D; line-height:1; white-space:nowrap; }}
  .g-total {{ font-size:18px; font-weight:700; color:#8a96a3; }}
  .gift-info {{ flex:1; min-width:0; }}
  .gift-cap {{ font-size:12px; color:#6b7c8e; }}
  .g-last {{ font-size:13px; font-weight:700; color:#25455D; margin-top:2px; }}
  .g-next {{ font-size:12px; font-weight:700; margin-top:10px; color:#b86b00; }}
  .g-next.done {{ color:#2e7d32; }}
  .g-bar {{ height:6px; background:#eef2f7; border-radius:3px; overflow:hidden; margin-top:8px; }}
  .g-bar-fill {{ height:100%; background: linear-gradient(90deg,#FFCFA4,#f5b97e); border-radius:3px; }}
  .top-box {{ background:#fff; border-radius:14px; padding:6px 14px; box-shadow:0 2px 8px rgba(37,69,93,.05); }}
  .top-row {{ display:flex; align-items:center; gap:10px; padding:8px 4px; border-top:1px solid #f0f2f5; }}
  .top-row:first-child {{ border-top:none; }}
  .top-row.me {{ background:#fff8f0; border-radius:6px; }}
  .top-rank {{ width:24px; text-align:center; font-weight:700; color:#25455D; }}
  .top-name {{ flex:1; min-width:0; font-size:13px; font-weight:600; color:#1a2a3a;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .top-cnt {{ font-size:13px; font-weight:700; color:#25455D; }}
  .cab-link {{ display:flex; align-items:center; gap:8px; background:#fff; border-radius:12px;
    padding:10px 12px; margin-bottom:8px; box-shadow:0 1px 4px rgba(0,0,0,.06); }}
  .cab-link span {{ flex:0 0 88px; font-size:13px; font-weight:600; color:#25455D; }}
  .cab-link input {{ flex:1; min-width:0; border:none; background:#f3f6f9; border-radius:8px;
    padding:8px 10px; font-size:12px; color:#41566a; }}
  .mat-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:8px; }}
  .mat-img {{ display:block; aspect-ratio:1/1; background:#f0f3f7; border-radius:12px; overflow:hidden; }}
  .mat-img img {{ width:100%; height:100%; object-fit:cover; display:block; }}
  .mat-text {{ background:#fff; border-radius:14px; padding:12px; margin-bottom:10px; box-shadow:0 2px 8px rgba(37,69,93,.05); }}
  .mat-text textarea {{ width:100%; border:none; background:#f7f8fa; border-radius:10px; padding:10px;
    font-size:13px; color:#1a2a3a; line-height:1.55; font-family:inherit; resize:vertical; }}
  .mat-copy-hint {{ font-size:11px; color:#8593a1; margin-top:6px; text-align:center; }}
  .people-box {{ background:#fff; border-radius:14px; padding:6px 14px; box-shadow:0 2px 8px rgba(37,69,93,.05); }}
  .people-row {{ display:flex; align-items:center; gap:10px; padding:9px 0; border-top:1px solid #f0f2f5; }}
  .people-row:first-child {{ border-top:none; }}
  .people-name {{ flex:1; min-width:0; font-size:13px; font-weight:600; color:#1a2a3a;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .people-mark {{ width:22px; height:22px; border-radius:6px; display:flex; align-items:center;
    justify-content:center; font-size:13px; font-weight:800; }}
  .people-mark.reg {{ background:#e8f5e9; color:#2e7d32; }}
  .people-mark.noreg {{ background:#f0f3f7; color:#c5cdd6; }}
  .people-link {{ text-decoration:none; color:inherit; }}
  .pp-plat {{ flex:0 0 26px; width:26px; height:26px; border-radius:8px; display:flex;
    align-items:center; justify-content:center; font-size:13px; font-weight:800; }}
  .pp-arr {{ color:#FFCFA4; font-size:18px; font-weight:700; flex:0 0 auto; }}

  /* Подарок на эфире/розыгрыше в карточке спикера */
  .gift-tag {{ margin-top:8px; padding:8px 10px; border-radius:10px; }}
  .gift-tag-air {{ background:rgba(255,207,164,.18); border:1px solid rgba(255,207,164,.35); }}
  .gift-tag-raffle {{ background:rgba(156,39,176,.06); border:1px solid rgba(156,39,176,.18); }}
  .gift-tag-lbl {{ font-size:10px; text-transform:uppercase; letter-spacing:.4px; font-weight:700; margin-bottom:2px; }}
  .gift-tag-air .gift-tag-lbl {{ color:#a86b2c; }}
  .gift-tag-raffle .gift-tag-lbl {{ color:#6a1b9a; }}
  .gift-tag-val {{ font-size:12px; color:#1a2a3a; font-weight:600; }}

  /* Кнопки копирования (общие) */
  .copy-btn {{ border:none; cursor:pointer; font-family:inherit; font-weight:700;
    background:#FFCFA4; color:#25455D; border-radius:10px; transition:background .2s; }}
  .copy-btn.copied {{ background:#6bb572; color:#fff; }}

  /* Реф-ссылки с иконкой + копированием */
  .cab-link {{ display:flex; align-items:center; gap:10px; background:#fff; border-radius:12px;
    padding:10px 12px; margin-bottom:8px; box-shadow:0 1px 4px rgba(0,0,0,.06); }}
  .cl-ico {{ flex:0 0 36px; width:36px; height:36px; border-radius:10px; display:flex;
    align-items:center; justify-content:center; font-size:13px; font-weight:800; }}
  .cl-body {{ flex:1; min-width:0; }}
  .cl-lbl {{ font-size:11px; color:#6b7c8e; font-weight:600; margin-bottom:2px; }}
  .cl-url {{ background:#f7f8fa; padding:6px 10px; border-radius:8px; font-size:11px; color:#25455D;
    font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  .cl-copy {{ flex:0 0 auto; padding:10px 12px; font-size:12px; min-width:84px; }}

  /* Подарки внутри аккордеона */
  .gi {{ display:flex; align-items:center; gap:12px; border-radius:14px; padding:12px; margin-bottom:8px; }}
  .gi-got {{ background:#fff; box-shadow:0 2px 8px rgba(37,69,93,.05); }}
  .gi-lock {{ background:#f7f8fa; opacity:.75; }}
  .gi-ico {{ flex:0 0 44px; width:44px; height:44px; border-radius:12px; display:flex; align-items:center;
    justify-content:center; font-size:20px; background:linear-gradient(135deg,#fff4e0,#FFCFA4); }}
  .gi-ico.locked {{ background:#eef2f7; color:#b0bcc8; }}
  .gi-body {{ flex:1; min-width:0; }}
  .gi-title {{ font-size:13px; font-weight:700; color:#1a2a3a; margin-bottom:3px; }}
  .gi-desc {{ font-size:11px; color:#6b7c8e; }}
  .gi-need {{ font-size:11px; color:#b86b00; font-weight:700; }}
  .gi-side {{ display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0; }}
  .gi-badge {{ font-size:10px; font-weight:700; padding:3px 7px; border-radius:5px; white-space:nowrap; }}
  .gi-badge.got {{ color:#2e7d32; background:#e8f5e9; }}
  .gi-badge.lock {{ color:#b86b00; background:#fff4e0; flex-shrink:0; }}
  .gi-open {{ background:linear-gradient(135deg,#25455D,#0a1520); color:#FFCFA4; padding:8px 14px;
    border-radius:8px; font-size:12px; font-weight:700; text-decoration:none; }}

  /* Материалы: подзаголовки + текст-карточка с кнопкой */
  .mat-sub {{ font-size:11px; font-weight:700; letter-spacing:.8px; text-transform:uppercase;
    color:#6b7c8e; margin:10px 0 8px; }}
  .mat-body {{ font-size:13px; color:#1a2a3a; white-space:pre-wrap; line-height:1.55;
    margin-bottom:10px; word-break:break-word; }}
  .mat-copy {{ width:100%; padding:10px 14px; font-size:13px; }}

  /* Email-gate: форма входа в кабинет подарков */
  .email-gate {{ background:#fff; border-radius:14px; padding:26px 20px; text-align:center;
    border:1px solid #f0f0f0; box-shadow:0 1px 6px rgba(37,69,93,.06); }}
  .eg-icon {{ font-size:40px; line-height:1; margin-bottom:10px; }}
  .eg-title {{ font-size:17px; font-weight:800; color:#25455D; line-height:1.25; margin-bottom:8px; }}
  .eg-sub {{ font-size:13px; color:#6b7c8e; line-height:1.5; margin-bottom:18px; }}
  .eg-input {{ width:100%; padding:13px 14px; font-size:15px; border:1.5px solid #d7dee5;
    border-radius:10px; outline:none; font-family:inherit; }}
  .eg-input:focus {{ border-color:#25455D; }}
  .eg-btn {{ width:100%; margin-top:12px; padding:13px 14px; font-size:15px; font-weight:700;
    border:none; border-radius:10px; cursor:pointer; color:#FFCFA4;
    background:linear-gradient(135deg,#25455D,#0a1520); font-family:inherit; }}
  .eg-btn:disabled {{ opacity:.6; cursor:default; }}
  .eg-err {{ font-size:13px; color:#c0392b; margin-top:10px; min-height:1px; line-height:1.4; }}
  .eg-reg {{ font-size:12.5px; color:#6b7c8e; margin-top:18px; line-height:1.5; }}
  .eg-reg a {{ color:#25455D; font-weight:700; }}

  /* Вкладка «О площадке» */
  .venue-head {{ display:flex; gap:14px; align-items:center; padding:18px 16px;
    background:linear-gradient(45deg,#25455D,#0a1520); color:#fff; border-radius:14px; margin-bottom:14px; }}
  .venue-ava {{ flex:0 0 72px; width:72px; height:72px; border-radius:14px; border:2px solid #FFCFA4; }}
  .venue-ava-empty {{ display:flex; align-items:center; justify-content:center;
    background:linear-gradient(135deg,#d4789a,#8b4561); color:#fff; font-weight:700; font-size:24px; }}
  .venue-head-body {{ flex:1; min-width:0; }}
  .venue-brand {{ font-size:18px; font-weight:900; letter-spacing:.5px; line-height:1.15; }}
  .venue-role {{ font-size:12.5px; color:rgba(255,255,255,.75); margin-top:5px; line-height:1.35; }}
  .facts {{ display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:14px; }}
  .fact {{ background:#fff; padding:10px 12px; border-radius:12px; border:1px solid #f0f0f0;
    box-shadow:0 1px 4px rgba(37,69,93,.06); }}
  .fact-val {{ font-size:17px; font-weight:800; color:#25455D; line-height:1.1; }}
  .fact-lbl {{ font-size:11px; color:#6b7c8e; margin-top:3px; line-height:1.25; }}
  .owner-acc {{ margin-bottom:14px; }}
  .owner-teaser {{ width:100%; display:flex; align-items:center; gap:12px; text-align:left; cursor:pointer;
    background:#FFF1E2; border:1px solid #FFE0C2; border-radius:14px; padding:12px; font-family:inherit;
    box-shadow:0 1px 4px rgba(37,69,93,.06); }}
  .owner-teaser-ava {{ flex:0 0 48px; width:48px; height:48px; border-radius:50%; object-fit:cover;
    border:2px solid #FFCFA4; }}
  .owner-teaser-body {{ flex:1; min-width:0; }}
  .owner-teaser-lbl {{ font-size:11px; color:#25455D; font-weight:800; letter-spacing:1px; text-transform:uppercase; }}
  .owner-teaser-name {{ font-size:15px; font-weight:700; color:#25455D; margin-top:2px; line-height:1.2; }}
  .owner-teaser-role {{ font-size:12px; color:#6b7c8e; margin-top:3px; line-height:1.3; }}
  .owner-teaser-chev {{ font-size:24px; color:#25455D; font-weight:600; transition:transform .2s; }}
  .owner-acc.collapsed .owner-teaser-chev {{ transform:rotate(0); }}
  .owner-acc:not(.collapsed) .owner-teaser-chev {{ transform:rotate(90deg); }}
  .owner-acc-body {{ display:block; padding-top:12px; }}
  .owner-acc.collapsed .owner-acc-body {{ display:none; }}
  .owner-photo {{ width:100%; max-height:360px; object-fit:cover; border-radius:16px; border:2px solid #FFCFA4;
    margin-bottom:14px; display:block; }}
  .owner-bio {{ background:#fff; padding:14px; border-radius:14px; border:1px solid #f0f0f0;
    box-shadow:0 1px 4px rgba(37,69,93,.06); font-size:14px; color:#3a4a5a; line-height:1.55;
    white-space:pre-wrap; margin-bottom:14px; }}
  .owner-bio img {{ max-width:100%; border-radius:8px; }}
  .owner-bio a {{ color:#0088cc; }}
  .social-h {{ font-size:10px; color:#b86b00; font-weight:700; letter-spacing:1.5px; text-transform:uppercase;
    margin-bottom:8px; }}
  .socials-wrap {{ display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }}
  .social-btn {{ display:inline-flex; align-items:center; gap:6px;
    background:linear-gradient(135deg,#25455D,#0a1520); padding:10px 14px; border-radius:12px;
    color:#FFCFA4; font-weight:800; font-size:13px; text-decoration:none; box-shadow:0 2px 6px rgba(37,69,93,.18); }}
  .venue-tabs {{ display:flex; padding:4px; margin:0 0 12px; gap:4px; border-radius:14px;
    background:linear-gradient(135deg,#25455D,#0a1520); box-shadow:inset 0 2px 4px rgba(0,0,0,.15); }}
  .vt-btn {{ flex:1; padding:10px 4px; text-align:center; font-size:13px; font-weight:700; cursor:pointer;
    color:rgba(255,255,255,.55); background:transparent; border:none; border-radius:11px; font-family:inherit; }}
  .vt-btn.active {{ color:#25455D; background:linear-gradient(135deg,#FFCFA4,#f5b97e);
    box-shadow:0 2px 8px rgba(255,207,164,.4); }}
  .off-card {{ background:#fff; border-radius:14px; padding:14px; margin-bottom:10px; box-shadow:0 2px 8px rgba(37,69,93,.05); }}
  .off-top {{ display:flex; gap:12px; }}
  .off-cover {{ flex:0 0 44px; width:44px; height:44px; border-radius:10px; }}
  .off-cover-empty {{ display:flex; align-items:center; justify-content:center; font-size:20px;
    background:linear-gradient(135deg,#fff4e0,#FFCFA4); }}
  .off-body {{ flex:1; min-width:0; }}
  .off-title {{ font-size:14px; font-weight:700; color:#1a2a3a; margin-bottom:3px; }}
  .off-desc {{ font-size:12px; color:#6b7c8e; line-height:1.4; margin-bottom:6px; }}
  .off-free {{ font-size:13px; font-weight:700; color:#2e7d32; }}
  .off-btn {{ display:block; margin-top:10px; padding:10px; border-radius:10px; text-align:center;
    font-weight:700; font-size:13px; text-decoration:none; }}
  .off-btn-paid {{ background:linear-gradient(135deg,#FFCFA4,#f5b97e); color:#25455D;
    box-shadow:0 2px 6px rgba(255,207,164,.4); }}
  .off-btn-free {{ background:linear-gradient(135deg,#25455D,#0a1520); color:#FFCFA4; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    {brand_block}
    <h1>{title}</h1>
  </div>
  <div class="tabs">{nav_html}</div>
  <div class="content">
    {panels}
  </div>
</div>
<script>
  function showTab(id) {{
    var panels = document.querySelectorAll('.panel');
    var tabs = document.querySelectorAll('.tab');
    var found = false;
    panels.forEach(function(p) {{
      var on = p.id === id; p.classList.toggle('active', on); if (on) found = true;
    }});
    if (!found) {{
      id = '{first_tab}';
      var el = document.getElementById(id);
      if (el) el.classList.add('active');
    }}
    tabs.forEach(function(t) {{ t.classList.toggle('active', t.getAttribute('data-tab') === id); }});
    window.scrollTo(0, 0);
  }}
  function currentTab() {{ return (location.hash || '').replace('#','') || '{first_tab}'; }}

  // Аккордеоны (Спикеры, Кабинет: подарки/топ/материалы, тизер основателя)
  document.querySelectorAll('.acc-h, .owner-teaser').forEach(function(btn) {{
    btn.addEventListener('click', function() {{
      btn.closest('.acc').classList.toggle('collapsed');
    }});
  }});

  // Копирование текста: navigator.clipboard с фолбэком на execCommand
  function copyText(text) {{
    if (navigator.clipboard && navigator.clipboard.writeText) {{
      return navigator.clipboard.writeText(text).catch(function() {{ return fallbackCopy(text); }});
    }}
    return fallbackCopy(text);
  }}
  function fallbackCopy(text) {{
    try {{
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }} catch (e) {{}}
    return Promise.resolve();
  }}
  document.querySelectorAll('.copy-btn').forEach(function(btn) {{
    btn.addEventListener('click', function(e) {{
      e.preventDefault();
      var text = btn.getAttribute('data-copy') || '';
      copyText(text);
      var orig = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = '✓ Скопировано';
      setTimeout(function() {{
        btn.classList.remove('copied');
        btn.textContent = orig;
      }}, 1500);
    }});
  }});

  // «Показать ещё» в ТОП рейтинге
  document.querySelectorAll('[data-topmore]').forEach(function(btn) {{
    btn.addEventListener('click', function() {{
      var rest = document.getElementById('top-rest');
      if (rest) rest.style.display = 'block';
      btn.style.display = 'none';
    }});
  }});

  // «Показать ещё» в подарках
  document.querySelectorAll('[data-giftsmore]').forEach(function(btn) {{
    btn.addEventListener('click', function() {{
      var rest = document.getElementById('gifts-rest');
      if (rest) rest.style.display = 'block';
      btn.style.display = 'none';
    }});
  }});

  // Переключатель Бесплатно/Платно на вкладке «О площадке»
  document.querySelectorAll('.vt-btn').forEach(function(btn) {{
    btn.addEventListener('click', function() {{
      var target = btn.getAttribute('data-vt');
      document.querySelectorAll('.vt-btn').forEach(function(b) {{
        b.classList.toggle('active', b === btn);
      }});
      var free = document.getElementById('vt-free');
      var paid = document.getElementById('vt-paid');
      if (free) free.style.display = (target === 'free') ? 'block' : 'none';
      if (paid) paid.style.display = (target === 'paid') ? 'block' : 'none';
    }});
  }});

  // Клик по аватару в галерее / по имени спикера в сессии → вкладка Спикеры + скролл
  var pendingSpeaker = null;
  document.querySelectorAll('[data-speaker]').forEach(function(a) {{
    a.addEventListener('click', function() {{
      pendingSpeaker = a.getAttribute('data-speaker');
    }});
  }});
  function scrollToSpeaker(ecId) {{
    var el = document.getElementById('speaker-' + ecId);
    if (!el) return;
    // если карточка в свёрнутом аккордеоне — раскрыть
    var acc = el.closest('.acc');
    if (acc && acc.classList.contains('collapsed')) acc.classList.remove('collapsed');
    setTimeout(function() {{
      el.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
      el.classList.add('flash');
      setTimeout(function() {{ el.classList.remove('flash'); }}, 1800);
    }}, 60);
  }}

  window.addEventListener('hashchange', function() {{
    showTab(currentTab());
    if (pendingSpeaker && currentTab() === 'speakers') {{
      var sp = pendingSpeaker; pendingSpeaker = null;
      scrollToSpeaker(sp);
    }}
  }});
  showTab(currentTab());

  // ── Кабинет подарков по email (когда нет ?c в ссылке) ──
  (function() {{
    var EV_SLUG = {json.dumps(event.get("slug") or "")};
    var LS_KEY = 'pluson_email_' + EV_SLUG;
    var hasC = /[?&]c=\\d+/.test(location.search);
    var triedAuto = /[?&]ea=1/.test(location.search);

    function gotoCabinet(cid, email) {{
      try {{ if (email) localStorage.setItem(LS_KEY, email); }} catch (e) {{}}
      var sep = location.pathname + '?c=' + cid;
      location.replace(sep + '#cabinet');
    }}

    async function findByEmail(email) {{
      var r = await fetch('/event/' + encodeURIComponent(EV_SLUG) + '/find-by-email', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ email: email }}),
      }});
      var data = {{}};
      try {{ data = await r.json(); }} catch (e) {{}}
      return {{ ok: r.ok, data: data }};
    }}

    // Авто-вход: если ?c нет, но email запомнен — тихо открываем кабинет.
    // Флаг ?ea=1 защищает от петли, если email больше не находится.
    if (!hasC && !triedAuto) {{
      var saved = '';
      try {{ saved = localStorage.getItem(LS_KEY) || ''; }} catch (e) {{}}
      if (saved) {{
        findByEmail(saved).then(function(res) {{
          if (res.ok && res.data && res.data.found && res.data.contact_id) {{
            gotoCabinet(res.data.contact_id, saved);
          }} else {{
            try {{ localStorage.removeItem(LS_KEY); }} catch (e) {{}}
          }}
        }}).catch(function() {{}});
      }}
    }}

    // Форма ввода email на вкладке «Подарки».
    var egBtn = document.getElementById('eg-btn');
    if (egBtn) {{
      var egInput = document.getElementById('eg-email');
      var egErr = document.getElementById('eg-err');
      // Подставить запомненный email в поле (если есть).
      try {{ if (egInput && !egInput.value) egInput.value = localStorage.getItem(LS_KEY) || ''; }} catch (e) {{}}
      function isEmail(s) {{ return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s); }}
      async function submitEmail() {{
        var email = (egInput.value || '').trim();
        if (!isEmail(email)) {{ egErr.textContent = 'Email указан неверно'; return; }}
        egErr.textContent = '';
        egBtn.disabled = true; egBtn.textContent = 'Открываем...';
        try {{
          var res = await findByEmail(email);
          if (res.ok && res.data && res.data.found && res.data.contact_id) {{
            gotoCabinet(res.data.contact_id, email);
            return;
          }}
          egErr.innerHTML = 'Не нашли регистрацию с таким email. ' +
            '<a href="/event/' + encodeURIComponent(EV_SLUG) + '/register">Зарегистрироваться</a>';
        }} catch (e) {{
          egErr.textContent = 'Не удалось проверить email, попробуйте ещё раз';
        }}
        egBtn.disabled = false; egBtn.textContent = 'Открыть подарки';
      }}
      egBtn.addEventListener('click', submitEmail);
      egInput.addEventListener('keydown', function(e) {{
        if (e.key === 'Enter') {{ e.preventDefault(); submitEmail(); }}
      }});
    }}
  }})();
</script>
</body>
</html>"""


@router.get("/event/{slug}", response_class=HTMLResponse, include_in_schema=False)
async def event_page(slug: str, c: str = "", email: str = "",
                     db: asyncpg.Connection = Depends(get_db)):
    event = await _resolve_event(db, slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    event_id = event["id"]
    ev = dict(event)

    collabs = await _load_collaborators(db, event_id)
    days, stages, sessions = await _load_program(db, event_id)
    gifts = await _load_gifts(db, event_id)
    share_texts, share_images, share_videos = await _load_share_materials(db, event_id)
    ref_enabled = await _referral_enabled(db, event_id)
    client = await _load_client(db, ev["client_id"]) if ev.get("client_id") else None

    venue_profile, venue_offerings = (None, [])
    if ev.get("client_id"):
        venue_profile, venue_offerings = await _load_venue(db, ev["client_id"])

    # ?c={contact_id} — реф-кабинет конкретного человека. Битый/пустой → None.
    contact_id = int(c) if c and c.isdigit() else None
    # ?email={email} — fallback: находим contact_id по email-идентичности.
    # Так человек без ссылки с contact_id может открыть свой кабинет подарков.
    if not contact_id and email:
        from app.services.contact_merge import normalize_email
        email_norm = normalize_email(email.strip())
        if email_norm and ev.get("client_id"):
            contact_id = await db.fetchval(
                """SELECT c.id FROM contacts c
                     JOIN platform_users pu ON pu.contact_id = c.id
                      AND pu.platform_slug = 'email'
                      AND pu.platform_user_id = $2
                    WHERE c.client_id = $1 AND c.merged_into IS NULL
                    LIMIT 1""",
                ev["client_id"], email_norm,
            )
    ref_cabinet = await _load_ref_cabinet(db, ev, contact_id) if contact_id else None

    html_str = render_page(
        ev, collabs, days, [dict(s) for s in stages], sessions, gifts,
        share_texts, share_images, ref_enabled, client,
        ref_cabinet=ref_cabinet,
        venue_profile=venue_profile, venue_offerings=venue_offerings,
        share_videos=share_videos,
    )
    return HTMLResponse(
        content=html_str,
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@router.post("/event/{slug}/find-by-email", include_in_schema=False)
async def event_find_by_email(slug: str, request: Request,
                              db: asyncpg.Connection = Depends(get_db)):
    """Поиск contact_id по email для открытия кабинета подарков.

    Возвращает {found, contact_id} — фронт перезагружает страницу с ?c={id}
    и запоминает email в localStorage, чтобы дальше открывать без ввода.
    """
    from app.services.contact_merge import normalize_email
    try:
        body = await request.json()
    except Exception:
        body = {}
    email_norm = normalize_email((body.get("email") or "").strip())
    if not email_norm:
        return JSONResponse({"found": False, "detail": "Укажите корректный email"},
                            status_code=400)
    event = await _resolve_event(db, slug)
    if not event:
        return JSONResponse({"found": False, "detail": "Событие не найдено"},
                            status_code=404)
    found_cid = await db.fetchval(
        """SELECT c.id FROM contacts c
             JOIN platform_users pu ON pu.contact_id = c.id
              AND pu.platform_slug = 'email'
              AND pu.platform_user_id = $2
            WHERE c.client_id = $1 AND c.merged_into IS NULL
            LIMIT 1""",
        event["client_id"], email_norm,
    )
    if not found_cid:
        return JSONResponse({"found": False})
    return JSONResponse({"found": True, "contact_id": found_cid})


# ── Внутренний веб-лендинг регистрации ─────────────────────────────────────
# Отдельная страница `pluson.ru/event/{slug}/register?c={contact_id}` + JSON-эндпоинт.
# Полностью изолировано от Mini App и от participants.register_participant:
# главный идентификатор — contact_id (tg_id НЕ используется). Шаг 1 — email
# (проверка «не регались ли раньше с другой соцсети»), шаг 2 — поля + согласия.


def _register_not_found_page() -> str:
    """Заглушка «событие не найдено» в бренд-стиле."""
    return f"""<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Событие не найдено</title>
<style>
  html,body {{ margin:0; padding:0; min-height:100vh; font-family:'Roboto',-apple-system,sans-serif;
    background:linear-gradient(45deg,#25455D,#0a1520); color:#fff;
    display:flex; align-items:center; justify-content:center; }}
  .box {{ text-align:center; padding:30px; max-width:340px; }}
  .box h1 {{ font-size:20px; margin:0 0 10px; }}
  .box p {{ font-size:14px; color:rgba(255,255,255,.7); line-height:1.5; }}
</style></head>
<body><div class="box"><h1>Событие не найдено</h1>
<p>Ссылка устарела или событие ещё не опубликовано.</p></div></body></html>"""


def render_register_page(event, client, poster_url, prefill=None) -> str:
    """Серверная HTML-страница формы регистрации на событие.

    prefill: None → форма с email-проверкой (контакт неизвестен, ?c отсутствует).
             dict {contact_id, email, phone, name, telegram_username} →
             известный незарегистрированный контакт; сразу полная форма
             с автозаполнением, без шага проверки email.
    """
    title = esc(event.get("title") or event.get("slug"))
    slug = esc(event.get("slug") or "")
    prefill = prefill or {}
    has_prefill = bool(prefill.get("contact_id"))
    pf_email = esc(prefill.get("email") or "")
    pf_phone = esc(prefill.get("phone") or "")
    pf_name = esc(prefill.get("name") or "")
    pf_tg = esc(prefill.get("telegram_username") or "")
    pf_contact_id = prefill.get("contact_id")
    client_id = event.get("client_id")
    brand_raw = ((client["brand_name"] if client else None)
                 or (client["name"] if client else None) or "организатора")
    brand = esc(brand_raw)
    brand_block = f'<div class="brand">{brand}</div>' if brand and brand != "организатора" else ""

    poster_html = ""
    if poster_url:
        poster_html = (f'<div class="poster" style="background:center/cover '
                       f'url(\'{esc(poster_url)}\')"></div>')

    # Ссылка на политику клиента (как в RegistrationFlow)
    if client_id:
        pd_link = (f'<a href="https://pluson.ru/c/{int(client_id)}/privacy" '
                   f'target="_blank" rel="noopener">Политикой обработки '
                   f'персональных данных</a>')
    else:
        pd_link = "Политикой обработки персональных данных"

    # Favicon — первая буква названия события (как на странице события)
    _ev_title_raw = (event.get("title") or event.get("slug") or "•").strip()
    fav_letter = _html.escape(_ev_title_raw[0].upper() if _ev_title_raw else "•")
    favicon_svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
        "<rect width='64' height='64' rx='14' fill='#25455D'/>"
        "<text x='32' y='44' font-size='38' font-family='Roboto,Arial,sans-serif' "
        f"font-weight='700' fill='#FFCFA4' text-anchor='middle'>{fav_letter}</text></svg>"
    )
    import urllib.parse as _up
    favicon_uri = "data:image/svg+xml," + _up.quote(favicon_svg)

    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Регистрация · {title}</title>
<link rel="icon" href="{favicon_uri}">
<style>
  * {{ box-sizing:border-box; }}
  html,body {{ margin:0; padding:0; font-family:'Roboto',-apple-system,BlinkMacSystemFont,sans-serif;
    background:linear-gradient(45deg,#25455D,#0a1520); background-attachment:fixed; color:#1f2d3a; }}
  .wrap {{ max-width:480px; margin:0 auto; min-height:100vh; background:#f7f8fa;
    box-shadow:0 0 40px rgba(0,0,0,.35); display:flex; flex-direction:column; }}
  .hero {{ background:linear-gradient(45deg,#25455D,#0a1520); color:#fff; padding:22px 18px 16px; }}
  .hero .brand {{ font-size:12px; letter-spacing:.5px; color:#FFCFA4; text-transform:uppercase; margin-bottom:6px; }}
  .hero h1 {{ font-size:21px; margin:0; line-height:1.25; }}
  .poster {{ width:100%; aspect-ratio:16/9; border-radius:0; }}
  .content {{ flex:1; padding:18px 16px 40px; }}
  .card {{ background:#fff; border-radius:16px; padding:18px; box-shadow:0 2px 10px rgba(37,69,93,.08); }}
  .lead {{ font-size:13px; color:#6b7c8e; line-height:1.45; margin:0 0 16px; }}
  .field {{ margin-bottom:14px; }}
  .field label {{ display:block; font-size:12px; font-weight:700; color:#25455D; margin-bottom:6px; }}
  .field input {{ width:100%; border:1.5px solid #dde4ea; background:#f7f8fa; border-radius:10px;
    padding:11px 12px; font-size:14px; color:#1a2a3a; font-family:inherit; }}
  .field input:focus {{ outline:none; border-color:#FFCFA4; background:#fff; }}
  .consents {{ margin:14px 0 4px; display:flex; flex-direction:column; gap:10px; }}
  .consent {{ display:flex; align-items:flex-start; gap:8px; font-size:12px; line-height:1.4; color:#6b7c8e; }}
  .consent input {{ margin-top:3px; flex-shrink:0; width:16px; height:16px; }}
  .consent a {{ color:#b86b00; text-decoration:underline; }}
  .btn {{ width:100%; padding:14px 16px; border:none; border-radius:12px; font-size:15px; font-weight:800;
    cursor:pointer; font-family:inherit; background:linear-gradient(135deg,#FFCFA4,#f5b97e); color:#25455D;
    box-shadow:0 2px 8px rgba(255,207,164,.4); margin-top:8px; }}
  .btn:disabled {{ opacity:.6; cursor:default; }}
  .err {{ color:#d9483b; font-size:13px; margin:10px 0 0; line-height:1.4; }}
  .step2 {{ display:none; }}
  .ok-box {{ text-align:center; padding:30px 10px; }}
  .ok-box .tick {{ font-size:56px; margin-bottom:10px; }}
  .ok-box h2 {{ color:#25455D; margin:0; }}
  .ok-box p {{ color:#6b7c8e; font-size:14px; margin-top:10px; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    {brand_block}
    <h1>{title}</h1>
  </div>
  {poster_html}
  <div class="content">
    <div class="card" id="form-card">
      <!-- ШАГ 1: email -->
      <div class="step1" id="step1">
        <p class="lead">Введите email — мы проверим, не регистрировались ли вы
          ранее с другой соцсети или мессенджера.</p>
        <div class="field">
          <label>Email</label>
          <input type="email" id="f-email" placeholder="you@example.com" autocomplete="email">
        </div>
        <button class="btn" id="btn-check" type="button">Продолжить</button>
        <p class="err" id="err1" style="display:none"></p>
      </div>

      <!-- ШАГ 2: данные + согласия -->
      <div class="step2" id="step2">
        <p class="lead">Заполните данные, чтобы организатор мог
          прислать материалы и подтвердить регистрацию.</p>
        <div class="field">
          <label>Email</label>
          <input type="email" id="f-email2" placeholder="you@example.com"
                 autocomplete="email" value="{pf_email}">
        </div>
        <div class="field">
          <label>Имя</label>
          <input type="text" id="f-name" placeholder="Ваше имя" value="{pf_name}">
        </div>
        <div class="field">
          <label>Телефон</label>
          <input type="tel" id="f-phone" placeholder="+7 999 123-45-67" value="{pf_phone}">
        </div>
        <div class="field">
          <label>Telegram-ник (необязательно)</label>
          <input type="text" id="f-tg" placeholder="@username" value="{pf_tg}">
        </div>
        <div class="consents">
          <label class="consent">
            <input type="checkbox" id="c-pd">
            <span>Я согласен на обработку моих персональных данных. С {pd_link} ознакомлен.</span>
          </label>
          <label class="consent">
            <input type="checkbox" id="c-mkt">
            <span>Я согласен на получение информационных и маркетинговых рассылок
              от {brand}. Вы в любой момент можете отказаться от получения писем.</span>
          </label>
        </div>
        <button class="btn" id="btn-create" type="button">Зарегистрироваться</button>
        <p class="err" id="err2" style="display:none"></p>
      </div>
    </div>
  </div>
</div>
<script>
  var SLUG = {json.dumps(slug)};
  var qs = new URLSearchParams(location.search);
  var cParam = qs.get('c');
  // contact_id из ?c=… (или из серверного prefill — известный контакт).
  var CONTACT_ID = (cParam && /^\\d+$/.test(cParam)) ? parseInt(cParam, 10) : {json.dumps(pf_contact_id)};
  var HAS_PREFILL = {json.dumps(has_prefill)};

  function isEmail(s) {{ return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s); }}
  function isPhone(s) {{ return s.replace(/\\D/g,'').length >= 10; }}
  function showErr(id, msg) {{
    var el = document.getElementById(id);
    el.textContent = msg; el.style.display = msg ? 'block' : 'none';
  }}

  async function post(body) {{
    var r = await fetch('/event/' + encodeURIComponent(SLUG) + '/register-submit', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify(body),
    }});
    var data = {{}};
    try {{ data = await r.json(); }} catch (e) {{}}
    if (!r.ok) {{ throw new Error((data && data.detail) || 'Ошибка регистрации'); }}
    return data;
  }}

  // Известный контакт (?c=… или prefill) → сразу полная форма, без проверки email.
  if (HAS_PREFILL || CONTACT_ID) {{
    document.getElementById('step1').style.display = 'none';
    document.getElementById('step2').style.display = 'block';
  }}

  // ШАГ 1 — проверка email (только когда контакт неизвестен)
  var btnCheck = document.getElementById('btn-check');
  if (btnCheck) {{
    btnCheck.addEventListener('click', async function() {{
      var email = (document.getElementById('f-email').value || '').trim();
      if (!isEmail(email)) {{ showErr('err1', 'Email указан неверно'); return; }}
      showErr('err1', '');
      btnCheck.disabled = true; btnCheck.textContent = 'Проверяем...';
      try {{
        var res = await post({{ email: email, step: 'check' }});
        if (res.found && res.registered && res.redirect) {{
          // контакт найден И уже зарегистрирован на событие → сразу в кабинет
          location.href = res.redirect;
          return;
        }}
        // не нашли ИЛИ нашли но НЕ зарегистрирован → шаг 2 (дозаполнение)
        if (res.found) {{
          CONTACT_ID = res.contact_id || CONTACT_ID;
          if (res.email) document.getElementById('f-email2').value = res.email;
          if (res.name) document.getElementById('f-name').value = res.name;
          if (res.phone) document.getElementById('f-phone').value = res.phone;
        }} else {{
          // новый — переносим введённый email в форму регистрации
          document.getElementById('f-email2').value = email;
        }}
        document.getElementById('step1').style.display = 'none';
        document.getElementById('step2').style.display = 'block';
      }} catch (e) {{
        showErr('err1', e.message || 'Не удалось проверить email');
        btnCheck.disabled = false; btnCheck.textContent = 'Продолжить';
      }}
    }});
  }}

  // ШАГ 2 — регистрация
  var btnCreate = document.getElementById('btn-create');
  btnCreate.addEventListener('click', async function() {{
    var email = (document.getElementById('f-email2').value || '').trim();
    var name = (document.getElementById('f-name').value || '').trim();
    var phone = (document.getElementById('f-phone').value || '').trim();
    var tg = (document.getElementById('f-tg').value || '').trim();
    var pd = document.getElementById('c-pd').checked;
    var mkt = document.getElementById('c-mkt').checked;
    if (!name) {{ showErr('err2', 'Укажите имя'); return; }}
    if (!isPhone(phone)) {{ showErr('err2', 'Телефон указан неверно'); return; }}
    if (!pd) {{ showErr('err2', 'Без согласия на обработку персональных данных регистрация невозможна (152-ФЗ)'); return; }}
    if (!mkt) {{ showErr('err2', 'Без согласия на маркетинговые рассылки регистрация невозможна'); return; }}
    showErr('err2', '');
    btnCreate.disabled = true; btnCreate.textContent = 'Регистрируем...';
    try {{
      var res = await post({{
        contact_id: CONTACT_ID || null,
        email: email || null, name: name, phone: phone,
        telegram_username: tg || null,
        consent_pd: true, consent_marketing: true, step: 'register',
      }});
      if (res.redirect) {{ location.href = res.redirect; return; }}
      location.reload();
    }} catch (e) {{
      showErr('err2', e.message || 'Не удалось зарегистрировать');
      btnCreate.disabled = false; btnCreate.textContent = 'Зарегистрироваться';
    }}
  }});
</script>
</body>
</html>"""


@router.get("/event/{slug}/register", response_class=HTMLResponse,
            include_in_schema=False)
async def event_register_page(slug: str, c: str = "",
                              db: asyncpg.Connection = Depends(get_db)):
    event = await _resolve_event(db, slug)
    if not event or event["status"] != "published":
        return HTMLResponse(content=_register_not_found_page(), status_code=404)
    ev = dict(event)

    contact_id = int(c) if c and c.isdigit() else None

    prefill = None
    if contact_id:
        # ВЕТКА 1: уже зарегистрирован на это событие → сразу в кабинет.
        is_reg = await db.fetchval(
            """SELECT TRUE FROM event_participants
                WHERE event_id = $1 AND contact_id = $2 AND is_registered = TRUE
                LIMIT 1""",
            ev["id"], contact_id,
        )
        if is_reg:
            return RedirectResponse(
                url=f"/event/{ev['slug']}?c={contact_id}", status_code=302)

        # ВЕТКА 2: контакт известен, не зареган → форма с автозаполнением.
        row = await db.fetchrow(
            """SELECT
                   c.name,
                   c.phone,
                   (SELECT pe.platform_user_id FROM platform_users pe
                      WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                      LIMIT 1) AS email,
                   (SELECT pt.username FROM platform_users pt
                      WHERE pt.contact_id = c.id AND pt.platform_slug = 'telegram'
                      LIMIT 1) AS tg_username
                 FROM contacts c
                WHERE c.id = $1 AND c.client_id = $2 AND c.merged_into IS NULL
                LIMIT 1""",
            contact_id, ev["client_id"],
        )
        if row:
            prefill = {
                "contact_id": contact_id,
                "email": row["email"] or "",
                "phone": row["phone"] or "",
                "name": row["name"] or "",
                "telegram_username": (
                    ("@" + row["tg_username"].lstrip("@"))
                    if row["tg_username"] else ""),
            }
        else:
            # ?c=… указывает на несуществующий/чужой контакт — как будто его нет.
            prefill = None

    # ВЕТКА 3: contact_id нет (или невалиден) → форма с email-проверкой.
    client = await _load_client(db, ev["client_id"]) if ev.get("client_id") else None
    poster_url = await _load_event_poster(db, ev["id"])

    html_str = render_register_page(ev, client, poster_url, prefill=prefill)
    return HTMLResponse(
        content=html_str,
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


async def _set_consents(db, contact_id, request, consent_pd, consent_marketing):
    """Фиксируем согласия 152-ФЗ (как в participants.register_participant)."""
    ip = (request.client.host if request and request.client else "") or ""
    if consent_pd is True:
        await db.execute(
            """UPDATE contacts
                  SET consent_pd_at = COALESCE(consent_pd_at, NOW()),
                      consent_pd_ip = COALESCE(consent_pd_ip, $2),
                      consent_pd_policy_ver = COALESCE(consent_pd_policy_ver, 0)
                WHERE id = $1""",
            contact_id, ip[:64],
        )
    if consent_marketing is True:
        await db.execute(
            """UPDATE contacts
                  SET consent_marketing_at = COALESCE(consent_marketing_at, NOW()),
                      consent_marketing_ip = COALESCE(consent_marketing_ip, $2),
                      consent_marketing_policy_ver = COALESCE(consent_marketing_policy_ver, 0)
                WHERE id = $1""",
            contact_id, ip[:64],
        )


@router.post("/event/{slug}/register-submit", include_in_schema=False)
async def event_register_submit(slug: str, request: Request,
                                db: asyncpg.Connection = Depends(get_db)):
    from app.services.contact_merge import (
        normalize_email, find_or_create_contact, merge_contacts,
        sync_email_identity_and_subscription,
    )
    from app.services.participant_registration import (
        finalize_participant_registration,
    )

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    event = await _resolve_event(db, slug)
    if not event or event["status"] != "published":
        return JSONResponse({"detail": "Событие не найдено"}, status_code=404)
    event_id = event["id"]
    client_id = event["client_id"]
    real_slug = event["slug"]

    step = body.get("step") or "check"

    link_cid = body.get("contact_id")
    try:
        link_cid = int(link_cid) if link_cid is not None else None
    except (ValueError, TypeError):
        link_cid = None

    email_raw = (body.get("email") or "").strip()
    email_norm = normalize_email(email_raw)
    name = (body.get("name") or "").strip() or None
    phone = (body.get("phone") or "").strip() or None
    tg_username = (body.get("telegram_username") or "").strip() or None

    async def _find_by_email(en):
        """contact_id по email-идентичности у этого клиента (или None)."""
        if not en:
            return None
        return await db.fetchval(
            """SELECT c.id FROM contacts c
                 JOIN platform_users pu ON pu.contact_id = c.id
                  AND pu.platform_slug = 'email'
                  AND pu.platform_user_id = $2
                WHERE c.client_id = $1 AND c.merged_into IS NULL
                LIMIT 1""",
            client_id, en,
        )

    async def _attach_tg(target_cid):
        """Опциональный TG-ник → псевдо-идентичность (если ещё нет telegram)."""
        if not tg_username:
            return
        uname = tg_username.lstrip("@")
        if not uname:
            return
        try:
            exists = await db.fetchval(
                """SELECT 1 FROM platform_users
                    WHERE contact_id = $1 AND platform_slug = 'telegram'
                    LIMIT 1""",
                target_cid,
            )
            if not exists:
                await db.execute(
                    """INSERT INTO platform_users
                           (client_id, contact_id, platform_slug,
                            platform_user_id, username)
                         VALUES ($1, $2, 'telegram', $3, $4)
                         ON CONFLICT DO NOTHING""",
                    client_id, target_cid, "@" + uname, uname,
                )
        except Exception:
            pass

    async def _register(target_cid):
        """UPSERT участника is_registered=TRUE + финализация."""
        await db.execute(
            """INSERT INTO event_participants (event_id, contact_id, is_registered)
                 VALUES ($1, $2, TRUE)
                 ON CONFLICT (event_id, contact_id)
                 DO UPDATE SET is_registered = TRUE""",
            event_id, target_cid,
        )
        await finalize_participant_registration(
            db, event_id=event_id, contact_id=target_cid)

    # ── ШАГ CHECK: только проверка email (контакт неизвестен) ──
    if step == "check":
        if not email_norm:
            return JSONResponse({"detail": "Укажите корректный email"},
                                status_code=400)
        found_cid = await _find_by_email(email_norm)
        if not found_cid:
            return JSONResponse({"found": False})

        already = await db.fetchval(
            """SELECT is_registered FROM event_participants
                WHERE event_id = $1 AND contact_id = $2 LIMIT 1""",
            event_id, found_cid,
        )
        if already:
            return JSONResponse({
                "found": True, "registered": True, "contact_id": found_cid,
                "redirect": f"/event/{real_slug}?c={found_cid}",
            })
        # Найден, не зареган → отдаём данные для автозаполнения формы.
        info = await db.fetchrow(
            """SELECT
                   c.name, c.phone,
                   (SELECT pe.platform_user_id FROM platform_users pe
                      WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                      LIMIT 1) AS email
                 FROM contacts c WHERE c.id = $1 LIMIT 1""",
            found_cid,
        )
        return JSONResponse({
            "found": True, "registered": False, "contact_id": found_cid,
            "name": (info["name"] if info else None),
            "phone": (info["phone"] if info else None),
            "email": (info["email"] if info else None) or email_norm,
        })

    # ── ШАГ REGISTER: финальная регистрация ──
    # Определяем целевой контакт.
    found_cid = await _find_by_email(email_norm) if email_norm else None

    if link_cid:
        target_cid = link_cid
        # Email введён и принадлежит ДРУГОМУ контакту → слить (найденный старше).
        if found_cid and found_cid != link_cid:
            try:
                await merge_contacts(
                    db, primary_id=found_cid, secondary_id=link_cid,
                    client_id=client_id)
                target_cid = found_cid
            except Exception:
                target_cid = link_cid  # мердж не критичен — берём из ссылки
    elif found_cid:
        target_cid = found_cid
    else:
        # Контакта нет — создаём.
        target_cid, _is_new = await find_or_create_contact(
            db, client_id=client_id, name=name, email=email_raw or None,
            phone=phone)

    # Привязать email-идентичность, если введён.
    if email_norm:
        try:
            await sync_email_identity_and_subscription(
                db, client_id=client_id, contact_id=target_cid,
                email=email_norm, first_name=name)
        except Exception:
            pass

    # Обновить данные: введённое — записываем, пустое — не трогаем.
    await db.execute(
        """UPDATE contacts
              SET name  = COALESCE($2, name),
                  phone = COALESCE($3, phone),
                  updated_at = NOW()
            WHERE id = $1""",
        target_cid, name, phone,
    )

    await _attach_tg(target_cid)
    await _set_consents(
        db, target_cid, request,
        bool(body.get("consent_pd")), bool(body.get("consent_marketing")))
    await _register(target_cid)
    return JSONResponse({
        "registered": True, "contact_id": target_cid,
        "redirect": f"/event/{real_slug}?c={target_cid}",
    })


# ════════════════ Публичная турнирная таблица: /t/{slug}/{stage_id} ════════════════

PLUSON_LOGO_URL = "https://pluson.ru/images/logo_no_ivision_wwhite.png"


def _fmt_num(v):
    """Число без хвостовых нулей: 5.0 -> 5, 3.25 -> 3.25, None -> ''."""
    if v is None:
        return ""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return esc(str(v))
    if f == int(f):
        return str(int(f))
    return ("%.3f" % f).rstrip("0").rstrip(".")


@router.get("/t/{slug}/{stage_id}", response_class=HTMLResponse, include_in_schema=False)
async def public_tournament_table(slug: str, stage_id: int,
                                  db: asyncpg.Connection = Depends(get_db)):
    from app.api.tournament import _compute  # локальный импорт против циклов

    event = await _resolve_event(db, slug)
    if not event or (event.get("module_slug") != "turnir"):
        raise HTTPException(status_code=404, detail="Турнир не найден")
    event_id = event["id"]

    stage = await db.fetchrow(
        "SELECT id, title, subtitle FROM conf_stages WHERE id=$1 AND event_id=$2",
        stage_id, event_id)
    if not stage:
        raise HTTPException(status_code=404, detail="Этап не найден")

    data = await _compute(event_id, stage_id, db)
    columns = data.get("columns") or []
    table = data.get("table") or []
    packages = data.get("packages") or []
    pkg_by_id = {p["id"]: p for p in packages}

    # бренд клиента + его реф-ссылка на платформу ПЛЮСОН
    cli = await db.fetchrow(
        "SELECT name, brand_name, brand_logo_url, referral_code FROM clients WHERE id=$1",
        event["client_id"]) if event.get("client_id") else None
    brand_name = ((cli["brand_name"] if cli else None)
                  or (cli["name"] if cli else None) or "")
    brand = esc(brand_name)
    brand_logo = (cli["brand_logo_url"] if cli else None) or ""
    ref_code = (cli["referral_code"] if cli else None) or ""
    pluson_ref_url = f"https://pluson.ru/?pid={esc(ref_code)}" if ref_code else "https://pluson.ru/"

    title = esc(event.get("title") or event.get("slug"))
    stage_title = esc(stage["title"] or "")

    # Favicon — буква названия
    _t = (event.get("title") or event.get("slug") or "•").strip()
    fav_letter = _html.escape(_t[0].upper() if _t else "•")
    favicon_svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
        "<rect width='64' height='64' rx='14' fill='#25455D'/>"
        "<text x='32' y='44' font-size='38' font-family='Roboto,Arial,sans-serif' "
        f"font-weight='700' fill='#FFCFA4' text-anchor='middle'>{fav_letter}</text></svg>")
    import urllib.parse as _up
    favicon_uri = "data:image/svg+xml," + _up.quote(favicon_svg)

    # ── Шапка таблицы: группировка колонок по пакетам ──
    groups = []  # [{pkg_id, title, weight, normalize, aggregate, span}]
    for c in columns:
        if groups and groups[-1]["pkg_id"] == c["package_id"]:
            groups[-1]["span"] += 1
        else:
            p = pkg_by_id.get(c["package_id"], {})
            groups.append({"pkg_id": c["package_id"], "title": c["package_title"],
                           "weight": p.get("weight", 1),
                           "normalize": bool(p.get("normalize")),
                           "aggregate": p.get("aggregate", "avg"), "span": 1})
    NORM_BADGE = "<span class='norm' title='Критерий нормализуется: баллы приводятся к доле от лучшего результата'>норм.</span>"

    # Порядок колонок (как в дашборде): Место · Участник · ИТОГ ·
    # блок «Баллы по пакетам» (по 1 колонке на пакет) · затем группы критериев.
    thead_grp = "<th rowspan='2' class='c-place'>Место</th><th rowspan='2' class='c-name'>Участник</th>"
    thead_grp += "<th rowspan='2' class='c-total'>ИТОГ</th>"
    if groups:
        thead_grp += f"<th colspan='{len(groups)}' class='c-grp'>Баллы по пакетам</th>"
    for g in groups:
        mode = "сумма" if g.get("aggregate") == "sum" else "среднее"
        extra = (" · норм." if g["normalize"] else "")
        thead_grp += (f"<th colspan='{g['span']}' class='c-grp'>{esc(g['title'])}"
                      f"<span class='w'>вес ×{_fmt_num(g['weight'])} · {mode}{extra}</span></th>")
    crit_by_pkg_seq = {}
    for c in columns:
        crit_by_pkg_seq.setdefault(c["package_id"], []).append(c)
    # 2-я строка шапки: сначала названия пакетов (для блока «Баллы по пакетам»), затем критерии
    thead_crit = ""
    for g in groups:
        thead_crit += (f"<th class='c-pkg'>{esc(g['title'])}"
                       f"<span class='cw'>вес ×{_fmt_num(g['weight'])} → итог</span></th>")
    _first_crit_head = True
    for g in groups:
        for c in crit_by_pkg_seq.get(g["pkg_id"], []):
            cw = float(c.get("weight", 1))
            cls = "c-crit crit-start" if _first_crit_head else "c-crit"
            cp = (c.get("code_phrase") or "").strip()
            cp_html = (f"<span class='cph'>Кодовая фраза для выкладки отчёта:<br>«{esc(cp)}»</span>"
                       if cp else "")
            thead_crit += (f"<th class='{cls}'>{esc(c['title'])}"
                           f"<span class='cw'>×{_fmt_num(cw)}</span>{cp_html}</th>")
            _first_crit_head = False

    total_cols = 3 + len(groups) + sum(g["span"] for g in groups)
    rows_html = ""
    if not table:
        rows_html = (f"<tr><td colspan='{total_cols}' class='empty'>"
                     "Пока нет участников или оценок на этом этапе.</td></tr>")
    for r in table:
        cells = ""
        # сначала баллы пакетов
        for g in groups:
            ps = r.get("package_scores", {}).get(str(g["pkg_id"]))
            cells += f"<td class='pkg-val'>{_fmt_num(ps)}</td>"
        # затем значения критериев
        _first_crit = True
        for g in groups:
            for c in crit_by_pkg_seq.get(g["pkg_id"], []):
                v = r["cells"].get(str(c["criterion_id"]))
                cls = "val crit-start" if _first_crit else "val"
                cells += f"<td class='{cls}'>{_fmt_num(v)}</td>"
                _first_crit = False
        place = r["place"]
        medal = {1: "🥇", 2: "🥈", 3: "🥉"}.get(place, "")
        rows_html += (
            f"<tr><td class='c-place'>{medal or place}</td>"
            f"<td class='c-name'>{esc(r['name'])}</td>"
            f"<td class='c-total'>{_fmt_num(r['total'])}</td>{cells}</tr>")

    # ── Блок бренда (логотип клиента справа в шапке) ──
    brand_logo_html = (f"<img class='brand-logo' src='{esc(brand_logo)}' alt='{brand}'>"
                       if brand_logo else "")
    brand_name_html = f"<div class='brand'>{brand}</div>" if brand else ""

    # ── Плашка ПЛЮСОН (слева сверху, ведёт по реф-ссылке клиента) ──
    pluson_badge = (
        f"<a class='pluson-badge' href='{pluson_ref_url}' target='_blank' rel='noopener noreferrer'>"
        f"<img src='{PLUSON_LOGO_URL}' alt='ПЛЮСОН'>"
        f"<span>Отчёт сформирован в Платформе ПЛЮСОН<br>для экспертов и организаторов</span>"
        f"</a>")

    has_norm = any(g["normalize"] for g in groups)
    norm_note = ("<p class='note'>«норм.» — критерий нормализуется: баллы приводятся к доле "
                 "от лучшего результата (для честного сравнения разных шкал).</p>") if has_norm else ""

    return HTMLResponse(content=f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Турнирная таблица — {title}</title>
<link rel="icon" href="{favicon_uri}">
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ margin:0; padding:0; font-family:'Roboto',-apple-system,BlinkMacSystemFont,sans-serif;
    background: linear-gradient(45deg, #25455D, #0a1520); background-attachment: fixed; color:#1f2d3a; }}
  .wrap {{ max-width: 1100px; margin: 0 auto; min-height: 100vh; background:#f7f8fa;
    box-shadow: 0 0 40px rgba(0,0,0,.35); }}
  .topbar {{ background: linear-gradient(45deg, #25455D, #0a1520); padding: 12px 18px; }}
  .pluson-badge {{ display:inline-flex; align-items:center; gap:10px; text-decoration:none; }}
  .pluson-badge img {{ height: 30px; width:auto; display:block; }}
  .pluson-badge span {{ font-size:11px; line-height:1.3; color:rgba(255,255,255,.78); }}
  .hero {{ background: linear-gradient(45deg, #25455D, #0a1520); color:#fff;
    padding: 8px 18px 20px; display:flex; align-items:center; gap:14px; border-top:1px solid rgba(255,255,255,.08); }}
  .hero .info {{ flex:1; min-width:0; }}
  .hero .brand {{ font-size:12px; letter-spacing:.5px; color:#FFCFA4; text-transform:uppercase; margin-bottom:4px; }}
  .hero h1 {{ font-size:22px; margin:0 0 4px; line-height:1.25; }}
  .hero .stage {{ font-size:14px; color:#FFCFA4; font-weight:600; }}
  .reg-link {{ display:inline-block; margin-top:8px; font-size:13px; color:#fff;
    text-decoration:underline; opacity:.85; }}
  .brand-logo {{ height:54px; width:auto; max-width:120px; object-fit:contain; flex:0 0 auto; }}
  .content {{ padding: 16px; }}
  .note {{ font-size:12.5px; color:#6b7c8e; margin: 0 0 12px; }}
  .scroll {{ overflow-x:auto; border:1px solid #e6eaee; border-radius:12px; background:#fff; }}
  table {{ border-collapse:collapse; width:100%; font-size:13px; }}
  th, td {{ padding:8px 10px; border-bottom:1px solid #eef1f4; text-align:center; white-space:nowrap; }}
  thead th {{ background:#f1f4f7; color:#41566a; font-weight:700; position:sticky; top:0; }}
  .c-grp {{ border-left:1px solid #dfe5ea; color:#25455D; }}
  .c-grp .w {{ display:block; font-size:10.5px; font-weight:500; color:#8593a1; }}
  .c-crit {{ font-weight:500; color:#5b6b7a; font-size:11.5px; min-width:64px; max-width:96px; white-space:normal; word-break:break-word; vertical-align:bottom; }}
  .c-crit .cw {{ display:block; font-size:10px; font-weight:700; color:#b45309; margin-top:2px; }}
  .c-pkg {{ font-weight:700; color:#25455D; font-size:11.5px; min-width:72px; max-width:96px; white-space:normal; word-break:break-word; background:#FFF7F0; border-left:1px solid #FFCFA4; vertical-align:bottom; }}
  .c-pkg .cw {{ display:block; font-size:9.5px; font-weight:600; color:#8593a1; margin-top:2px; }}
  .pkg-val {{ font-weight:800; color:#25455D; background:#FFF7F0; border-left:1px solid #FFCFA4; }}
  tbody tr:nth-child(even) .pkg-val {{ background:#FFF2E6; }}
  .norm {{ display:inline-block; margin-left:4px; font-size:9.5px; font-weight:700; color:#b45309;
    background:#FFF3E0; border:1px solid #FFCFA4; border-radius:5px; padding:0 4px; vertical-align:middle; }}
  .c-place {{ text-align:center; font-weight:700; color:#25455D; width:54px; }}
  .c-name {{ text-align:left; font-weight:600; color:#1f2d3a; position:sticky; left:0; background:#fff;
    width:200px; min-width:160px; max-width:220px; white-space:normal; word-break:break-word;
    border-right:2px solid #dfe5ea; }}
  thead .c-name {{ background:#f1f4f7; }}
  .c-total {{ font-weight:800; color:#25455D; border-left:2px solid #FFCFA4; background:#FFF7F0; }}
  thead .c-total {{ background:#FFEFE0; }}
  .val {{ color:#41566a; }}
  .crit-start {{ border-left:2px solid #cdd6df; }}
  .cph {{ display:block; font-size:9.5px; font-weight:600; color:#b45309; margin-top:3px; line-height:1.2; font-family:'Roboto Mono',monospace; white-space:normal; }}
  tbody tr:nth-child(even) td {{ background:#fafbfc; }}
  tbody tr:nth-child(even) .c-name {{ background:#fafbfc; }}
  tbody tr:nth-child(even) .c-total {{ background:#FFF2E6; }}
  .empty {{ color:#8593a1; padding:24px; text-align:center !important; }}
  .foot {{ font-size:11.5px; color:#9aa7b4; text-align:center; padding:18px 12px 30px; }}
  .foot a {{ color:#25455D; font-weight:600; text-decoration:none; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">{pluson_badge}</div>
  <div class="hero">
    <div class="info">
      {brand_name_html}
      <h1>{title}</h1>
      <div class="stage">{stage_title} · турнирная таблица</div>
      <a class="reg-link" href="/t/{slug}/{stage_id}/reglament">📋 Регламент подсчёта баллов</a>
    </div>
    {brand_logo_html}
  </div>
  <div class="content">
    <p class="note">Открытый рейтинг для всех участников. Сортировка — по итоговому баллу. Обновляется автоматически.</p>
    {norm_note}
    <div class="scroll">
      <table>
        <thead>
          <tr>{thead_grp}</tr>
          <tr>{thead_crit}</tr>
        </thead>
        <tbody>
          {rows_html}
        </tbody>
      </table>
    </div>
    <div class="foot">
      Сделано на <a href="{pluson_ref_url}" target="_blank" rel="noopener noreferrer">Платформе ПЛЮСОН</a> — для экспертов и организаторов
    </div>
  </div>
</div>
</body>
</html>""")


# ════════════════ Публичный регламент подсчёта: /t/{slug}/{stage_id}/reglament ════════════════

@router.get("/t/{slug}/{stage_id}/reglament", response_class=HTMLResponse, include_in_schema=False)
async def public_tournament_reglament(slug: str, stage_id: int,
                                      db: asyncpg.Connection = Depends(get_db)):
    from app.api.tournament import _compute

    event = await _resolve_event(db, slug)
    if not event or (event.get("module_slug") != "turnir"):
        raise HTTPException(status_code=404, detail="Турнир не найден")
    event_id = event["id"]
    stage = await db.fetchrow(
        "SELECT id, title FROM conf_stages WHERE id=$1 AND event_id=$2", stage_id, event_id)
    if not stage:
        raise HTTPException(status_code=404, detail="Этап не найден")

    data = await _compute(event_id, stage_id, db)
    packages = data.get("packages") or []
    columns = data.get("columns") or []
    crits_by_pkg: dict = {}
    for c in columns:
        crits_by_pkg.setdefault(c["package_id"], []).append(c)

    # бренд + реф-ссылка ПЛЮСОН (как на таблице)
    cli = await db.fetchrow(
        "SELECT name, brand_name, brand_logo_url, referral_code FROM clients WHERE id=$1",
        event["client_id"]) if event.get("client_id") else None
    brand = esc(((cli["brand_name"] if cli else None) or (cli["name"] if cli else None) or ""))
    brand_logo = (cli["brand_logo_url"] if cli else None) or ""
    ref_code = (cli["referral_code"] if cli else None) or ""
    pluson_ref_url = f"https://pluson.ru/?pid={esc(ref_code)}" if ref_code else "https://pluson.ru/"
    title = esc(event.get("title") or event.get("slug"))
    stage_title = esc(stage["title"] or "")

    _t = (event.get("title") or event.get("slug") or "•").strip()
    fav_letter = _html.escape(_t[0].upper() if _t else "•")
    favicon_svg = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
        "<rect width='64' height='64' rx='14' fill='#25455D'/>"
        "<text x='32' y='44' font-size='38' font-family='Roboto,Arial,sans-serif' "
        f"font-weight='700' fill='#FFCFA4' text-anchor='middle'>{fav_letter}</text></svg>")
    import urllib.parse as _up
    favicon_uri = "data:image/svg+xml," + _up.quote(favicon_svg)

    SCORER_RU = {"jury": "среднее по оценкам жюри", "vote": "народное голосование",
                 "manual": "ручной ввод организатором", "auto": "автоматически из системы"}
    AUTO_RU = {"referrals": "число приглашённых по реф-ссылке", "lead_magnet": "число пришедших в лид-магнит"}

    def fnum(v):
        if v == int(v):
            return str(int(v))
        return ("%.3f" % v).rstrip("0").rstrip(".")

    # ── Блоки по пакетам ──
    pkg_blocks = ""
    total_weight = sum(float(p["weight"]) for p in packages) or 1
    for p in packages:
        crits = crits_by_pkg.get(p["id"], [])
        if not crits:
            continue
        w = float(p["weight"])
        normalize = bool(p["normalize"])
        # таблица критериев пакета
        crit_rows = ""
        for c in crits:
            scorer = c.get("scorer")
            src = SCORER_RU.get(scorer, scorer)
            if scorer == "auto":
                src = AUTO_RU.get(c.get("auto_kind"), src)
            crit_rows += (f"<tr><td>{esc(c['title'])}</td>"
                          f"<td class='c'>{src}</td>"
                          f"<td class='c'>{fnum(float(c['scale_max']))}</td>"
                          f"<td class='c'>{fnum(float(c.get('weight', 1)))}</td></tr>")

        # пример расчёта на конкретных критериях пакета
        ex_crits = crits[:2] if len(crits) >= 2 else crits
        is_sum = (p.get("aggregate") == "sum")
        agg_word = "складываются" if is_sum else "усредняются"
        # описание нормализации (если включена)
        norm_note = (
            "<p>Пакет <b>нормализуется</b>: по каждому критерию находим лучший результат "
            "среди всех участников и переводим балл в долю от него (лучший = 1.0). "
            "Это уравнивает критерии с разными шкалами.</p>" if normalize else "")
        base_word = "доля от лучшего по критерию" if normalize else "балл критерия"
        if is_sum:
            formula = (
                norm_note +
                f"<p><b>Баллы критериев {agg_word}</b> (с учётом веса каждого), без усреднения:</p>"
                f"<p><code>балл пакета = Σ({base_word} × вес критерия)</code></p>")
        else:
            formula = (
                norm_note +
                f"<p><b>Баллы критериев {agg_word}</b> — берётся взвешенное среднее по весам:</p>"
                f"<p><code>балл пакета = Σ({base_word} × вес критерия) ÷ Σ(весов критериев)</code></p>")
        # числовой пример
        if normalize:
            c0 = ex_crits[0]
            w0 = float(c0.get("weight", 1))
            if is_sum:
                ex = (f"<p class='ex'><b>Пример.</b> По критерию «{esc(c0['title'])}» лучший "
                      f"набрал 10, а наш — 6 → доля 0.6 (вес {fnum(w0)}). Доли всех критериев "
                      f"умножаются на веса и складываются.</p>")
            else:
                ex = (f"<p class='ex'><b>Пример.</b> По критерию «{esc(c0['title'])}» лучший "
                      f"набрал 10, а наш — 6 → доля 0.6. Так считаем по всем критериям и берём "
                      f"их взвешенное среднее.</p>")
        elif len(ex_crits) >= 2:
            a, b = ex_crits[0], ex_crits[1]
            wa, wb = float(a.get("weight", 1)), float(b.get("weight", 1))
            if is_sum:
                ex = (f"<p class='ex'><b>Пример.</b> Пусть по «{esc(a['title'])}» балл 1 "
                      f"(вес {fnum(wa)}), по «{esc(b['title'])}» балл 1 (вес {fnum(wb)}). "
                      f"Тогда балл пакета = 1×{fnum(wa)} + 1×{fnum(wb)} = <b>{fnum(wa+wb)}</b>.</p>")
            else:
                ex = (f"<p class='ex'><b>Пример.</b> Пусть по «{esc(a['title'])}» балл 1 "
                      f"(вес {fnum(wa)}), по «{esc(b['title'])}» балл 1 (вес {fnum(wb)}). "
                      f"Тогда балл пакета = (1×{fnum(wa)} + 1×{fnum(wb)}) ÷ ({fnum(wa)}+{fnum(wb)}) = "
                      f"<b>{fnum((1*wa + 1*wb)/((wa+wb) or 1))}</b>.</p>")
        else:
            a = ex_crits[0]
            wa = float(a.get("weight", 1))
            if is_sum:
                ex = (f"<p class='ex'><b>Пример.</b> Если по «{esc(a['title'])}» балл 1 "
                      f"(вес {fnum(wa)}), то балл пакета = 1×{fnum(wa)} = <b>{fnum(wa)}</b>.</p>")
            else:
                ex = (f"<p class='ex'><b>Пример.</b> Если по «{esc(a['title'])}» балл 1, "
                      "то и балл пакета = <b>1</b> (критерий один).</p>")
        agg_badge = "сумма критериев" if is_sum else "среднее критериев"
        norm_badge = " · нормализуется" if normalize else ""

        pkg_blocks += f"""
        <div class="pkg">
          <div class="pkg-h">{esc(p['title'])} <span class="pkg-w">вес пакета {fnum(w)} · {agg_badge}{norm_badge}</span></div>
          <table class="crit">
            <thead><tr><th>Критерий</th><th>Кто ставит балл</th><th>Макс</th><th>Вес</th></tr></thead>
            <tbody>{crit_rows}</tbody>
          </table>
          {formula}
          {ex}
        </div>"""

    # ── ИТОГ ──
    weight_terms = " + ".join(
        f"«{esc(p['title'])}»×{fnum(float(p['weight']))}" for p in packages if crits_by_pkg.get(p["id"]))
    total_block = (
        "<div class='pkg'>"
        "<div class='pkg-h'>Итоговый балл</div>"
        "<p>Итог участника = сумма баллов всех пакетов, умноженных на вес пакета:</p>"
        f"<p><code>ИТОГ = {weight_terms or '—'}</code></p>"
        "<p>Участники сортируются по ИТОГ по убыванию. При равном ИТОГ участники делят одно "
        "и то же место.</p></div>") if packages else ""

    brand_logo_html = (f"<img class='brand-logo' src='{esc(brand_logo)}' alt='{brand}'>" if brand_logo else "")
    brand_name_html = f"<div class='brand'>{brand}</div>" if brand else ""
    pluson_badge = (
        f"<a class='pluson-badge' href='{pluson_ref_url}' target='_blank' rel='noopener noreferrer'>"
        f"<img src='{PLUSON_LOGO_URL}' alt='ПЛЮСОН'>"
        f"<span>Отчёт сформирован в Платформе ПЛЮСОН<br>для экспертов и организаторов</span></a>")

    body = pkg_blocks or "<p class='note'>На этом этапе ещё не настроены критерии оценки.</p>"

    return HTMLResponse(content=f"""<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Регламент — {title}</title>
<link rel="icon" href="{favicon_uri}">
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ margin:0; padding:0; font-family:'Roboto',-apple-system,BlinkMacSystemFont,sans-serif;
    background: linear-gradient(45deg, #25455D, #0a1520); background-attachment: fixed; color:#1f2d3a; }}
  .wrap {{ max-width: 760px; margin: 0 auto; min-height: 100vh; background:#f7f8fa; box-shadow: 0 0 40px rgba(0,0,0,.35); }}
  .topbar {{ background: linear-gradient(45deg, #25455D, #0a1520); padding: 12px 18px; }}
  .pluson-badge {{ display:inline-flex; align-items:center; gap:10px; text-decoration:none; }}
  .pluson-badge img {{ height: 30px; width:auto; display:block; }}
  .pluson-badge span {{ font-size:11px; line-height:1.3; color:rgba(255,255,255,.78); }}
  .hero {{ background: linear-gradient(45deg, #25455D, #0a1520); color:#fff; padding: 8px 18px 20px;
    display:flex; align-items:center; gap:14px; border-top:1px solid rgba(255,255,255,.08); }}
  .hero .info {{ flex:1; min-width:0; }}
  .hero .brand {{ font-size:12px; letter-spacing:.5px; color:#FFCFA4; text-transform:uppercase; margin-bottom:4px; }}
  .hero h1 {{ font-size:22px; margin:0 0 4px; line-height:1.25; }}
  .hero .stage {{ font-size:14px; color:#FFCFA4; font-weight:600; }}
  .brand-logo {{ height:54px; width:auto; max-width:120px; object-fit:contain; flex:0 0 auto; }}
  .content {{ padding: 18px; }}
  .lead {{ font-size:14px; color:#41566a; line-height:1.6; margin: 0 0 18px; }}
  .pkg {{ background:#fff; border:1px solid #e6eaee; border-radius:14px; padding:16px; margin-bottom:14px; }}
  .pkg-h {{ font-size:16px; font-weight:700; color:#25455D; margin-bottom:10px; }}
  .pkg-w {{ font-size:12px; font-weight:500; color:#b45309; background:#FFF3E0; border:1px solid #FFCFA4; border-radius:6px; padding:1px 7px; margin-left:6px; }}
  table.crit {{ width:100%; border-collapse:collapse; font-size:13px; margin-bottom:12px; }}
  table.crit th, table.crit td {{ padding:7px 9px; border-bottom:1px solid #eef1f4; text-align:left; }}
  table.crit th {{ background:#f1f4f7; color:#41566a; font-weight:600; }}
  table.crit td.c {{ text-align:center; color:#5b6b7a; }}
  .pkg p {{ font-size:13.5px; color:#41566a; line-height:1.6; margin: 8px 0; }}
  .pkg code {{ background:#f1f4f7; padding:1px 6px; border-radius:5px; font-size:12.5px; color:#25455D; }}
  .ex {{ background:#FFF7F0; border-left:3px solid #FFCFA4; padding:8px 12px; border-radius:0 8px 8px 0; }}
  .note {{ color:#8593a1; font-size:14px; }}
  .back {{ display:inline-block; margin-bottom:14px; font-size:13px; color:#25455D; text-decoration:underline; }}
  .foot {{ font-size:11.5px; color:#9aa7b4; text-align:center; padding:18px 12px 30px; }}
  .foot a {{ color:#25455D; font-weight:600; text-decoration:none; }}
</style></head>
<body><div class="wrap">
  <div class="topbar">{pluson_badge}</div>
  <div class="hero">
    <div class="info">
      {brand_name_html}
      <h1>{title}</h1>
      <div class="stage">{stage_title} · регламент подсчёта баллов</div>
    </div>
    {brand_logo_html}
  </div>
  <div class="content">
    <a class="back" href="/t/{slug}/{stage_id}">← К турнирной таблице</a>
    <p class="lead">Это автоматический регламент: он построен по критериям и весам, которые
    настроены для этапа «{stage_title}». Баллы критериев собираются в баллы пакетов, пакеты
    с учётом своих весов — в итоговый балл. Ниже — как именно считается каждый пакет, с примерами.</p>
    {body}
    {total_block}
    <div class="foot">Сделано на <a href="{pluson_ref_url}" target="_blank" rel="noopener noreferrer">Платформе ПЛЮСОН</a> — для экспертов и организаторов</div>
  </div>
</div></body></html>""")
