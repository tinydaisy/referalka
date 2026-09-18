"""
Серверная HTML-страница «Все события клиента»: GET /o/{client_id}

НЕ React, НЕ Mini App — обычная HTML-страница, собранная на сервере с уже
вставленными данными. Открывается мгновенно. Узкая колонка по центру (как
телефон), бренд-цвета. Повторяет главный экран Mini App (HubSelector /
Календарь): бренд-шапка + карточки событий с бейджами «Идёт сейчас / Скоро /
Завершено» + блок «Архив прошедших».

Каждая карточка ведёт на /event/{slug} (серверная страница события).

Куда ведут боты по /start:
  TG/VK/MAX-бот VIP-клиента → /o/{client_id} (его события).
  Системный @pluson_bot → Mini App (там HubSelector по всем организаторам).
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from app.database import get_db
from app.services.safe_html import safe_html
from app.services.person_name import DISPLAY_NAME_SQL
import asyncpg
import html as _html
import urllib.parse as _up

router = APIRouter(tags=["Публичная HTML-страница «Все события»"])

PEACH = "#FFCFA4"
DARK = "#25455D"

RU_MONTHS = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
             "июля", "августа", "сентября", "октября", "ноября", "декабря"]


def esc(s) -> str:
    return _html.escape(str(s if s is not None else ""))


# Тот же SQL расчёта бакетов (now/upcoming/past), что в
# client_profile.public_client_events — для конференций/турниров даты
# берутся из conf_days/conf_stages, для остальных — из events.start_at/end_at.
_EVENTS_SQL = """
WITH conf_dates AS (
  SELECT e.id AS event_id,
         LEAST(
           (SELECT (d2.day_date + COALESCE(
                      NULLIF(d2.open_time,'')::time,
                      (SELECT MIN(NULLIF(s.start_time,'')::time)
                         FROM conf_sessions s
                        WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                      '00:00'::time
                    )) AT TIME ZONE 'Europe/Moscow'
              FROM conf_days d2
              WHERE d2.event_id = e.id AND d2.day_date IS NOT NULL
              ORDER BY d2.day_date ASC LIMIT 1),
           (SELECT MIN(st.start_date::timestamp AT TIME ZONE 'Europe/Moscow')
              FROM conf_stages st
              WHERE st.event_id = e.id AND st.start_date IS NOT NULL)
         ) AS start_at,
         GREATEST(
           (SELECT (d2.day_date + COALESCE(
                      NULLIF(d2.close_time,'')::time,
                      (SELECT MAX(NULLIF(s.end_time,'')::time)
                         FROM conf_sessions s
                        WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                      (SELECT MAX(NULLIF(s.start_time,'')::time)
                         FROM conf_sessions s
                        WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                      '23:59'::time
                    )) AT TIME ZONE 'Europe/Moscow'
              FROM conf_days d2
              WHERE d2.event_id = e.id AND d2.day_date IS NOT NULL
              ORDER BY d2.day_date DESC LIMIT 1),
           (SELECT MAX((st.end_date + '23:59'::time) AT TIME ZONE 'Europe/Moscow')
              FROM conf_stages st
              WHERE st.event_id = e.id AND st.end_date IS NOT NULL)
         ) AS end_at
    FROM events e
   WHERE e.module_slug IN ('conference', 'turnir')
)
SELECT e.id, e.slug, e.title, e.module_slug,
       -- ⚠️ Регистрация не открыта → в списке тоже афиша-ЗАГЛУШКА. Иначе в
       -- витрине готовая афиша, а по клику — другая картинка с «скоро»:
       -- выглядит как ошибка. Боевую афишу клиент готовит параллельно.
       COALESCE(
         CASE WHEN COALESCE(e.registration_closed, FALSE)
              THEN NULLIF(e.pre_reg_poster_url, '') END,
         (SELECT url FROM event_posters
           WHERE event_id = e.id AND day IS NULL
           ORDER BY CASE orientation
                      WHEN 'square'     THEN 1
                      WHEN 'horizontal' THEN 2
                      WHEN 'vertical'   THEN 3
                      ELSE 4
                    END, sort, id
           LIMIT 1)
       ) AS poster_url,
       e.status,
       -- Куда вести с карточки: способ регистрации + есть ли опубликованный
       -- лендинг. Раньше карточка жёстко вела на /event/{slug} (внутреннюю
       -- страницу), и человек не попадал на продающий лендинг события.
       e.registration_mode,
       -- Регистрация ещё не открыта (мигр. 345): карточка ведёт на страницу
       -- события, а не на лендинг/чужой сайт — там показывается заглушка.
       e.registration_closed,
       NULLIF(btrim(e.landing_url), '') AS landing_url,
       EXISTS (SELECT 1 FROM event_landing_pages lp
                WHERE lp.event_id = e.id AND lp.kind = 'main'
                  AND lp.is_published) AS has_landing,
       COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END, e.start_at) AS start_at,
       COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at)   AS end_at,
       CASE
         WHEN COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END, e.start_at) IS NULL
           OR COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at)   IS NULL
              THEN 'upcoming'
         WHEN NOW() BETWEEN
              COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END, e.start_at)
              AND
              COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at)
              THEN 'now'
         WHEN COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at END, e.end_at) < NOW()
              THEN 'past'
         ELSE 'upcoming'
       END AS bucket
  FROM events e
  LEFT JOIN conf_dates cd ON cd.event_id = e.id
 WHERE EXISTS(SELECT 1 FROM event_owners eo
               WHERE eo.event_id = e.id AND eo.client_id = $1 AND eo.status = 'accepted')
   AND e.status IN ('published','ended')
 ORDER BY COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END, e.start_at) NULLS LAST
"""


def _fmt_date(dt):
    """'15 июня' по МСК (как formatDate в SelectorEventsTab)."""
    if not dt:
        return ""
    try:
        from datetime import timedelta
        msk = dt + timedelta(hours=3) if getattr(dt, "tzinfo", None) is None else dt
        return f"{msk.day} {RU_MONTHS[msk.month]}"
    except Exception:
        return ""


def _date_range(start_at, end_at):
    s = _fmt_date(start_at)
    if not s:
        return ""
    e = _fmt_date(end_at)
    if e and e != s:
        return f"{s} — {e}"
    return s


def _card_href(e: dict) -> str:
    """Куда ведёт карточка события на витрине.

    ⚠️ Раньше здесь был жёсткий `/event/{slug}` — внутренняя страница события.
    Человек с витрины попадал сразу «внутрь», минуя продающий лендинг, ради
    которого событие и собиралось. Теперь ведём туда же, куда и все остальные
    кнопки регистрации, — по способу регистрации (`events.registration_mode`):
      landing  → наш конструктор /e/{slug};
      external → сторонний сайт клиента;
      form     → внутренняя страница /event/{slug}, как было.
    Лендинг выбран, но не опубликован → внутренняя страница (иначе 404).
    """
    slug = e.get("slug") or ""
    # ⚠️ Регистрация ещё не открыта (мигр. 345) — ведём на страницу события со
    # заглушкой, а не на лендинг и тем более не на сторонний сайт: там кнопка
    # покупки живёт своей жизнью и о нашей настройке не знает.
    if e.get("registration_closed"):
        return f"/event/{slug}/register"
    mode = e.get("registration_mode") or "form"
    if mode == "landing" and e.get("has_landing"):
        return f"/e/{slug}"
    if mode == "external" and e.get("landing_url"):
        return e["landing_url"]
    return f"/event/{slug}"


def _card_html(e: dict) -> str:
    bucket = e.get("bucket")
    if bucket == "now":
        badge_cls, badge_txt = "badge-green", "● Идёт сейчас"
    elif bucket == "past":
        badge_cls, badge_txt = "badge-gray", "Завершено"
    else:
        badge_cls, badge_txt = "badge-gold", "Скоро"

    poster = e.get("poster_url")
    poster_html = (f'<img class="poster" src="{esc(poster)}" alt="" '
                   f'onerror="this.style.display=\'none\'">' if poster else "")
    date_str = _date_range(e.get("start_at"), e.get("end_at"))
    date_html = f'<div class="meta">{esc(date_str)}</div>' if date_str else ""

    return f"""<a class="card" href="{esc(_card_href(e))}">
  {poster_html}
  <div class="body">
    <span class="badge {badge_cls}">{badge_txt}</span>
    <div class="ctitle">{esc(e.get('title') or e.get('slug'))}</div>
    {date_html}
  </div>
</a>"""


def _jsonb_list(val):
    """JSONB-поле → список (achievements/owner_achievements)."""
    import json as _json
    if val is None:
        return []
    if isinstance(val, str):
        try:
            val = _json.loads(val)
        except Exception:
            return []
    return val if isinstance(val, list) else []


def _jsonb_dict(val):
    import json as _json
    if val is None:
        return {}
    if isinstance(val, str):
        try:
            val = _json.loads(val)
        except Exception:
            return {}
    return val if isinstance(val, dict) else {}


def _facts_html(items) -> str:
    """Блок «Факты в цифрах»: [{label, value}]."""
    cells = ""
    for it in items:
        if not isinstance(it, dict):
            continue
        value = esc(it.get("value") or "")
        label = esc(it.get("label") or "")
        if not value and not label:
            continue
        cells += (f'<div class="fact"><div class="fact-v">{value}</div>'
                  f'<div class="fact-l">{label}</div></div>')
    return f'<div class="facts">{cells}</div>' if cells else ""


_SOCIAL_LABELS = {
    "telegram": "Telegram", "vk": "ВКонтакте", "max": "MAX",
    "instagram": "Instagram", "youtube": "YouTube", "website": "Сайт", "site": "Сайт",
}


def _socials_html(social: dict) -> str:
    links = ""
    for key, url in (social or {}).items():
        if not url or not isinstance(url, str) or not url.startswith("http"):
            continue
        label = _SOCIAL_LABELS.get(key, key.capitalize())
        links += f'<a class="soc" href="{esc(url)}" target="_blank" rel="noopener noreferrer">{esc(label)}</a>'
    return f'<div class="socs">{links}</div>' if links else ""


def _about_html(client, brand: str) -> str:
    """Вкладка «О проекте»: два подписанных раздела — основатель и бренд.

    ⚠️ РАЗДЕЛЫ ПОДПИСАНЫ И ИДУТ В ЭТОМ ПОРЯДКЕ (решение владельца, 18.09.2026):
    сначала «Информация об основателе» — человек, фото, регалии; следом
    «Информация о проекте/бренде» — логотип и рассказ о проекте. Раньше обе
    карточки шли без заголовков, и читалось это как один сплошной блок: фото
    бренда сверху, фото человека снизу, а где кончается «мы» и начинается «я» —
    непонятно. Тексты в полях устроены так же: `bio` — про человека,
    `brand_bio` — про проект (миграция 446).
    """
    positioning = esc(client["positioning"] or "")
    brand_photo = client["profile_photo_url"] or client["brand_logo_url"]
    brand_facts = _facts_html(_jsonb_list(client.get("achievements")))
    # Рассказ о проекте — теми же тегами, что и регалии основателя.
    brand_bio = safe_html(client["brand_bio"] or "")

    owner_name = esc(client["owner_full_name"] or client["name"] or "")
    owner_pos = safe_html(client["owner_positioning"] or "")
    owner_photo = client["owner_photo_url"]
    owner_facts = _facts_html(_jsonb_list(client.get("owner_achievements")))
    # ⚠️ Регалии клиент пишет тегами (<b>жирный</b>) — показываем разметку,
    # а не экранированный текст. safe_html оставляет только безопасные теги.
    bio = safe_html(client["bio"] or "")
    socials = _socials_html(_jsonb_dict(client.get("social_links")))

    # Точка лица (миграция 434). ⚠️ Инлайном, а не в классе: класс общий для
    # всех клиентов, а точка у каждого фото своя. Пусто — верхняя треть кадра,
    # где лицо почти всегда (центр срезал головы на снимках в полный рост).
    # ⚠️ Для фото БРЕНДА точка берётся только если это фото, а не логотип:
    # у логотипа в этом поле ничего не отмечают, и умолчание ему не вредит —
    # квадрат 88×88 всё равно кадрируется, и верх логотипа важнее низа.
    brand_pos = esc((client["profile_photo_focal"] or "").strip() or "50% 33%")
    owner_pos_focal = esc((client["owner_photo_focal"] or "").strip() or "50% 33%")

    brand_photo_html = (f'<img class="ab-photo" src="{esc(brand_photo)}" alt="" '
                        f'style="object-position:{brand_pos}" '
                        f'onerror="this.style.display=\'none\'">' if brand_photo else "")
    pos_html = f'<p class="ab-pos">{positioning}</p>' if positioning else ""

    owner_block = ""
    if owner_name or owner_photo or bio or owner_pos or owner_facts or socials:
        owner_photo_html = (f'<img class="ow-photo" src="{esc(owner_photo)}" alt="" '
                            f'style="object-position:{owner_pos_focal}" '
                            f'onerror="this.style.display=\'none\'">' if owner_photo else "")
        owner_pos_html = f'<p class="ow-pos">{owner_pos}</p>' if owner_pos else ""
        # ⚠️ Обёртка <div>, а не <p>: в регалиях бывают свои абзацы и списки,
        # а вкладывать <p>/<ul> внутрь <p> нельзя — браузер рвёт разметку и
        # текст рассыпается.
        bio_html = f'<div class="ow-bio">{bio}</div>' if bio else ""
        owner_block = f"""
        <div class="sec-h">Информация об основателе</div>
        <div class="ab-card ow-card">
          <div class="ow-head">
            {owner_photo_html}
            <div>
              <div class="ow-name">{owner_name}</div>
              {owner_pos_html}
            </div>
          </div>
          {owner_facts}
          {bio_html}
          {socials}
        </div>"""

    # ⚠️ Текст о бренде — в разделе бренда, а не под фактами основателя: иначе
    # рассказ «мы делаем» оказывался подписан именем человека.
    brand_bio_html = f'<div class="ow-bio">{brand_bio}</div>' if brand_bio else ""

    return f"""
    {owner_block}
    <div class="sec-h">Информация о проекте</div>
    <div class="ab-card">
      {brand_photo_html}
      <div class="ab-name">{esc(brand)}</div>
      {pos_html}
      {brand_facts}
      {brand_bio_html}
    </div>"""


@router.get("/o/{client_id}", include_in_schema=False)
async def events_list_page(
    client_id: int,
    db: asyncpg.Connection = Depends(get_db),
):
    client = await db.fetchrow(
        # ⚠️ `owner_full_name` — имя основателя с фамилией (миграция 381) для
        # блока «ОБ ОСНОВАТЕЛЕ». `name` остаётся фолбэком названия бренда.
        """SELECT brand_name, name, """ + DISPLAY_NAME_SQL("clients") + """ AS owner_full_name,
                  positioning, profile_photo_url, brand_logo_url,
                  -- Точки лица на фото (миграция 434): по ним кадрируются
                  -- миниатюры, иначе режет макушку.
                  profile_photo_focal, owner_photo_focal,
                  achievements, owner_photo_url, owner_positioning, owner_achievements,
                  -- bio — про основателя, brand_bio — про проект (мигр. 446).
                  bio, brand_bio, social_links
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not client:
        raise HTTPException(status_code=404, detail="Организатор не найден")

    rows = await db.fetch(_EVENTS_SQL, client_id)
    events = [dict(r) for r in rows]

    active = [e for e in events if e["bucket"] != "past"]
    # 'now' раньше 'soon', внутри — по start_at ASC (как bucketRank в Mini App)
    active.sort(key=lambda e: (0 if e["bucket"] == "now" else 1,
                               str(e.get("start_at") or "")))
    past = [e for e in events if e["bucket"] == "past"]
    past.sort(key=lambda e: str(e.get("end_at") or e.get("start_at") or ""),
              reverse=True)

    brand = esc(client["brand_name"] or client["name"] or "Организатор")
    tagline = esc(client["positioning"] or "")
    brand_logo = client["brand_logo_url"]

    # Favicon — первая буква бренда на бренд-фоне.
    fav_letter = _html.escape((brand or "•")[0].upper())
    favicon_svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
        "<rect width='64' height='64' rx='14' fill='#25455D'/>"
        "<text x='32' y='44' font-size='38' font-family='Roboto,Arial,sans-serif' "
        f"font-weight='700' fill='#FFCFA4' text-anchor='middle'>{fav_letter}</text></svg>"
    )
    # ⚠️ Значок вкладки — НАСТОЯЩИЙ логотип клиента, если он загружен. Буква на
    # фирменном фоне ПЛЮСОНа остаётся запасным вариантом: страница открыта под
    # брендом клиента, и узнаваться во вкладке должен он (решение владельца,
    # 2026-08-18).
    favicon_uri = brand_logo or ("data:image/svg+xml," + _up.quote(favicon_svg))

    logo_html = (f'<img class="blogo" src="{esc(brand_logo)}" alt="">'
                 if brand_logo else "")
    tagline_html = f'<p class="tagline">{tagline}</p>' if tagline else ""

    active_html = "".join(_card_html(e) for e in active)
    past_html = "".join(_card_html(e) for e in past)

    archive_html = ""
    if past:
        archive_html = f"""
        <button class="arch-btn" onclick="document.getElementById('arch').classList.toggle('open');this.classList.toggle('open')">
          <span>Архив прошедших · {len(past)}</span><span class="caret">▾</span>
        </button>
        <div class="arch" id="arch">{past_html}</div>"""

    if not active and not past:
        body_html = """
        <div class="empty">
          <div class="emoji">📭</div>
          <p class="e-title">Пока нет опубликованных событий</p>
          <p class="e-sub">Загляните позже — события появятся здесь.</p>
        </div>"""
    else:
        body_html = f"""
        <p class="lead">Выберите событие, которое вас интересует:</p>
        <div class="cards">{active_html}{archive_html}</div>"""

    # ── Вкладка «О проекте» (визитка бренда + основатель) ──
    about_html = _about_html(client, brand)

    return HTMLResponse(content=f"""<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{brand} — события</title>
<link rel="icon" href="{favicon_uri}">
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ margin:0; padding:0; font-family:'Roboto',-apple-system,BlinkMacSystemFont,sans-serif;
    background: linear-gradient(45deg, #25455D, #0a1520); background-attachment: fixed; color:#1f2d3a; }}
  .wrap {{ max-width:480px; margin:0 auto; min-height:100vh; background:#f7f8fa;
    box-shadow:0 0 40px rgba(0,0,0,.35); display:flex; flex-direction:column; }}
  .hero {{ background: linear-gradient(45deg,#25455D,#0a1520); color:#fff; padding:22px 18px 18px;
    position:relative; }}
  .hero h1 {{ font-size:22px; margin:0; line-height:1.25; padding-right:54px; }}
  .tagline {{ color:rgba(255,255,255,.75); font-size:13px; margin:6px 0 0; }}
  .blogo {{ position:absolute; top:18px; right:16px; width:40px; height:40px; border-radius:8px;
    object-fit:contain; }}
  .content {{ flex:1; padding:16px; padding-bottom:40px; }}
  .lead {{ font-size:14px; color:#41566a; font-weight:600; margin:2px 0 14px; }}
  .cards {{ display:flex; flex-direction:column; gap:12px; }}
  .card {{ display:block; background:#fff; border:1px solid #e6eaee; border-radius:16px;
    overflow:hidden; text-decoration:none; color:inherit; box-shadow:0 1px 4px rgba(0,0,0,.05);
    transition:transform .12s, box-shadow .12s; }}
  .card:active {{ transform:scale(.99); }}
  .poster {{ width:100%; display:block; aspect-ratio:16/9; object-fit:cover; background:#eef1f4; }}
  .body {{ padding:12px 14px 14px; }}
  .badge {{ display:inline-block; font-size:11px; font-weight:700; padding:3px 9px;
    border-radius:999px; margin-bottom:8px; }}
  .badge-green {{ background:#e7f6ec; color:#1f8a4c; }}
  .badge-gold  {{ background:#FFF3E0; color:#b45309; border:1px solid #FFCFA4; }}
  .badge-gray  {{ background:#eef1f4; color:#7a8a99; }}
  .ctitle {{ font-size:16px; font-weight:700; color:#25455D; line-height:1.3; }}
  .meta {{ font-size:13px; color:#6b7c8e; margin-top:4px; }}
  .arch-btn {{ width:100%; margin-top:4px; background:transparent; border:1px dashed #9aa7b4;
    border-radius:12px; padding:11px 14px; display:flex; align-items:center; justify-content:space-between;
    color:#6b7c8e; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }}
  .arch-btn .caret {{ transition:transform .2s; }}
  .arch-btn.open .caret {{ transform:rotate(180deg); }}
  .arch {{ display:none; flex-direction:column; gap:12px; margin-top:12px; }}
  .arch.open {{ display:flex; }}
  .empty {{ text-align:center; padding:60px 24px; }}
  .empty .emoji {{ font-size:48px; margin-bottom:12px; }}
  .empty .e-title {{ color:#25455D; font-weight:700; font-size:16px; margin:0; }}
  .empty .e-sub {{ color:#6b7c8e; font-size:13px; margin-top:8px; line-height:1.5; }}
  .foot {{ font-size:11.5px; color:#9aa7b4; text-align:center; padding:18px 12px 30px; }}
  .foot a {{ color:#25455D; font-weight:600; text-decoration:none; }}
  /* Вкладка «О проекте» */
  .ab-card {{ background:#fff; border:1px solid #e6eaee; border-radius:16px; padding:18px 16px;
    margin-bottom:14px; box-shadow:0 1px 4px rgba(0,0,0,.05); }}
  .ab-photo {{ width:88px; height:88px; border-radius:16px; object-fit:cover; display:block;
    margin:0 auto 12px; }}
  .ab-name {{ font-size:19px; font-weight:800; color:#25455D; text-align:center; }}
  .ab-pos {{ font-size:14px; color:#5a6b7d; text-align:center; margin:6px 0 0; line-height:1.4; }}
  .facts {{ display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; justify-content:center; }}
  .fact {{ flex:1; min-width:90px; background:#f4f7f9; border-radius:12px; padding:12px 8px; text-align:center; }}
  .fact-v {{ font-size:20px; font-weight:800; color:#25455D; }}
  .fact-l {{ font-size:11px; color:#7a8a99; margin-top:2px; line-height:1.25; }}
  .ow-head {{ display:flex; align-items:center; gap:12px; }}
  .ow-photo {{ width:60px; height:60px; border-radius:50%; object-fit:cover; border:2px solid #FFCFA4; flex-shrink:0; }}
  /* Заголовок раздела вкладки «О проекте» — «Информация об основателе» /
     «Информация о проекте». Пришёл на смену надписи ОБ ОСНОВАТЕЛЕ внутри
     карточки: разделов стало два, и подписывать нужно оба одинаково. */
  .sec-h {{ font-size:11px; font-weight:800; color:#25455D; letter-spacing:1px;
    text-transform:uppercase; margin:2px 0 8px 4px; }}
  .ow-name {{ font-size:17px; font-weight:700; color:#25455D; margin-top:2px; }}
  .ow-pos {{ font-size:13px; color:#5a6b7d; margin:3px 0 0; }}
  /* ⚠️ Без white-space:pre-wrap — переносы строк уже превращены в <br>
     (safe_html). С ним между строками выходил двойной отступ. */
  .ow-bio {{ font-size:14px; color:#41566a; line-height:1.55; margin:14px 0 0; }}
  .socs {{ display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }}
  .soc {{ font-size:13px; font-weight:600; color:#25455D; background:#f4f7f9; border:1px solid #e6eaee;
    border-radius:999px; padding:7px 14px; text-decoration:none; }}
  /* Нижняя навигация */
  .tabpane {{ display:none; }}
  .tabpane.on {{ display:block; }}
  .bnav {{ position:sticky; bottom:0; display:flex; background:#fff; border-top:1px solid #e6eaee; }}
  .bnav button {{ flex:1; background:none; border:none; padding:11px 4px 9px; cursor:pointer;
    font-family:inherit; font-size:12px; font-weight:600; color:#9aa7b4; display:flex;
    flex-direction:column; align-items:center; gap:3px; }}
  .bnav button.on {{ color:#25455D; }}
  .bnav button.on .bn-ic {{ background:#25455D; }}
  .bn-ic {{ width:22px; height:22px; border-radius:7px; background:#c3cfd8; -webkit-mask-size:contain;
    mask-size:contain; -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; -webkit-mask-position:center; mask-position:center; }}
</style></head>
<body><div class="wrap">
  <div class="hero">
    {logo_html}
    <h1>{brand}</h1>
    {tagline_html}
  </div>
  <div class="content">
    <div class="tabpane on" id="pane-calendar">
      {body_html}
    </div>
    <div class="tabpane" id="pane-about">
      {about_html}
    </div>
  </div>
  <div class="foot">Сделано на <a href="https://pluson.ru/" target="_blank" rel="noopener noreferrer">Платформе ПЛЮСОН</a> — для экспертов и организаторов</div>
  <nav class="bnav">
    <button id="tab-calendar" class="on" onclick="showTab('calendar')">
      <span class="bn-ic" style="-webkit-mask-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22black%22%3E%3Cpath d=%22M7 2v2H5a2 2 0 00-2 2v13a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2V2h-2v2H9V2H7zm12 7v10H5V9h14z%22/%3E%3C/svg%3E');mask-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22black%22%3E%3Cpath d=%22M7 2v2H5a2 2 0 00-2 2v13a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2V2h-2v2H9V2H7zm12 7v10H5V9h14z%22/%3E%3C/svg%3E')"></span>
      Календарь
    </button>
    <button id="tab-about" onclick="showTab('about')">
      <span class="bn-ic" style="-webkit-mask-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22black%22%3E%3Cpath d=%22M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z%22/%3E%3C/svg%3E');mask-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22black%22%3E%3Cpath d=%22M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z%22/%3E%3C/svg%3E')"></span>
      О проекте
    </button>
  </nav>
</div>
<script>
  function showTab(t) {{
    document.getElementById('pane-calendar').classList.toggle('on', t==='calendar');
    document.getElementById('pane-about').classList.toggle('on', t==='about');
    document.getElementById('tab-calendar').classList.toggle('on', t==='calendar');
    document.getElementById('tab-about').classList.toggle('on', t==='about');
    location.hash = t;
  }}
  var _q = new URLSearchParams(location.search);
  if (location.hash === '#about' || location.hash === '#ecosystem'
      || _q.get('tab') === 'ecosystem' || _q.get('tab') === 'about') showTab('about');
</script>
</body></html>""",
        headers={"Cache-Control": "no-cache, must-revalidate"})
