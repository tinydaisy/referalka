"""
Простая серверная HTML-страница события: GET /event/{slug}

НЕ React, НЕ Mini App — обычная HTML-страница, собранная на сервере с уже
вставленными данными. Открывается мгновенно, без спиннеров и загрузок.
Показывает спикеров/жюри/программу/экосистему события в наших бренд-цветах,
узкой колонкой по центру (как телефон). Вкладки = секции на одной странице,
переключение через #якоря (нативно, без JS-загрузок).

Данные берём теми же запросами, что отдают JSON-виджеты (landing_widget.py),
плюс профиль клиента и продукты для блока «Экосистема».
"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from app.database import get_db
import asyncpg
import html as _html
import json

router = APIRouter(tags=["Публичная HTML-страница события"])


# ── Хелперы данных (переиспользуют логику landing_widget) ─────────────────

async def _resolve_event(db: asyncpg.Connection, ref: str):
    if ref.isdigit():
        ev = await db.fetchrow(
            "SELECT id, slug, title, module_slug, status, description, "
            "client_id, landing_url FROM events WHERE id = $1", int(ref))
        if ev:
            return ev
    return await db.fetchrow(
        "SELECT id, slug, title, module_slug, status, description, "
        "client_id, landing_url FROM events WHERE slug = $1", ref)


_GROUP_RANK = """CASE
    WHEN cse.role = 'organizer'       THEN 1
    WHEN cse.role = 'jury'            THEN 2
    WHEN cse.role = 'headliner'       THEN 3
    WHEN cse.role = 'speaker'         THEN 4
    WHEN cse.role = 'general_partner' THEN 5
    WHEN cse.role = 'partner'         THEN 6
    ELSE 7 END"""


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
    rows = await db.fetch(
        f"""SELECT cse.role, cse.speaker_topic AS topic,
                   c.name, c.title, c.achievements, c.photo_url,
                   c.tg_channel_url, c.vk_url, c.max_url,
                   c.instagram_url, c.website_url, c.media_assets,
                   (SELECT url FROM collaborator_posters cp
                      WHERE cp.id = cse.poster_id OR
                            (cse.poster_id IS NULL AND cp.collaborator_id = c.id)
                      ORDER BY (cp.id = cse.poster_id) DESC, cp.sort_order, cp.id
                      LIMIT 1) AS poster_url
              FROM event_collaborators cse
              JOIN collaborators c ON c.id = cse.speaker_id
             WHERE cse.event_id = $1
             ORDER BY {_GROUP_RANK}, cse.sort_order, cse.priority, cse.id""",
        event_id,
    )
    groups = {"organizers": [], "jury": [], "speakers": [], "partners": []}
    for r in rows:
        d = dict(r)
        d["achievements"] = d.get("achievements") or []
        d["media_assets"] = _parse_jsonb(d.get("media_assets"))
        role = d.get("role")
        if role == "organizer":
            groups["organizers"].append(d)
        elif role == "jury":
            groups["jury"].append(d)
        elif role in ("speaker", "headliner"):
            groups["speakers"].append(d)
        elif role in ("general_partner", "partner"):
            groups["partners"].append(d)
    return groups


async def _load_program(db, event_id):
    days = await db.fetch(
        """SELECT id, day_number, day_date, title
             FROM conf_days WHERE event_id = $1 ORDER BY day_number, id""",
        event_id,
    )
    sessions = await db.fetch(
        """SELECT s.day, s.start_time, s.end_time, s.title,
                  col.name AS sp_name, col.title AS sp_title,
                  col.photo_url AS sp_photo
             FROM conf_sessions s
             LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
             LEFT JOIN collaborators col ON col.id = cse.speaker_id
            WHERE s.event_id = $1
            ORDER BY s.day, s.sort_order, s.start_time, s.id""",
        event_id,
    )
    return days, sessions


async def _load_client(db, client_id):
    cl = await db.fetchrow(
        """SELECT name, brand_name, profile_photo_url, positioning,
                  owner_photo_url, owner_positioning, bio, achievements,
                  owner_achievements, social_links
             FROM clients WHERE id = $1""", client_id)
    offerings = await db.fetch(
        """SELECT title, description, price, link_url, is_paid
             FROM client_offerings WHERE client_id = $1
            ORDER BY is_paid DESC, sort_order, id""", client_id)
    return cl, offerings


# ── Рендер HTML ───────────────────────────────────────────────────────────

def esc(s) -> str:
    return _html.escape(str(s)) if s is not None else ""


def _fmt_time(v):
    if v is None:
        return ""
    return str(v)[:5]


def _person_card(p) -> str:
    photo = esc(p.get("photo_url") or "")
    name = esc(p.get("name") or "")
    title = esc(p.get("title") or "")
    topic = esc(p.get("topic") or "")
    ach = p.get("achievements") or []
    photo_html = (
        f'<img class="ava" src="{photo}" alt="" loading="lazy" '
        f'onerror="this.style.display=\'none\'">' if photo else
        '<div class="ava ava-empty"></div>'
    )
    ach_html = ""
    if ach:
        items = "".join(f"<li>{esc(a)}</li>" for a in ach if a)
        ach_html = f'<ul class="ach">{items}</ul>'
    topic_html = f'<div class="topic">{topic}</div>' if topic else ""
    title_html = f'<div class="ptitle">{title}</div>' if title else ""
    # соцссылки
    links = []
    for url, label in [
        (p.get("tg_channel_url"), "Telegram"),
        (p.get("vk_url"), "VK"),
        (p.get("max_url"), "MAX"),
        (p.get("instagram_url"), "Instagram"),
        (p.get("website_url"), "Сайт"),
    ]:
        if url:
            links.append(f'<a class="soc" href="{esc(url)}" target="_blank" rel="noopener">{label}</a>')
    links_html = f'<div class="socs">{"".join(links)}</div>' if links else ""
    return (
        f'<div class="card">'
        f'{photo_html}'
        f'<div class="card-body">'
        f'<div class="pname">{name}</div>'
        f'{title_html}'
        f'{topic_html}{ach_html}{links_html}'
        f'</div></div>'
    )


def _people_section(title, people) -> str:
    if not people:
        return ""
    cards = "".join(_person_card(p) for p in people)
    return f'<h2 class="sec-h">{esc(title)}</h2><div class="cards">{cards}</div>'


def render_page(event, groups, days, sessions, client, offerings) -> str:
    title = esc(event.get("title") or event.get("slug"))
    brand = esc((client.get("brand_name") if client else None) or (client.get("name") if client else "") or "")
    desc = event.get("description") or ""

    # ── Секция: Спикеры/Жюри/Партнёры ──
    has_people = any(groups[k] for k in groups)
    people_html = ""
    people_html += _people_section("Организаторы", groups["organizers"])
    people_html += _people_section("Жюри", groups["jury"])
    people_html += _people_section("Спикеры", groups["speakers"])
    people_html += _people_section("Партнёры", groups["partners"])
    if not people_html:
        people_html = '<div class="empty">Список пока не заполнен</div>'

    # ── Секция: Программа ──
    prog_html = ""
    if days:
        for day in days:
            dn = day.get("day_number")
            dtitle = esc(day.get("title") or (f"День {dn}" if dn else "День"))
            ddate = esc(str(day.get("day_date") or ""))
            day_sessions = [s for s in sessions if s.get("day") == dn]
            rows = ""
            for s in day_sessions:
                t1 = _fmt_time(s.get("start_time"))
                t2 = _fmt_time(s.get("end_time"))
                tm = f"{t1}–{t2} МСК" if t1 and t2 else (f"{t1} МСК" if t1 else "")
                stitle = esc(s.get("title") or "")
                spk = esc(s.get("sp_name") or "")
                spk_html = f'<div class="s-spk">{spk}</div>' if spk else ""
                rows += (
                    f'<div class="s-row">'
                    f'<div class="s-time">{tm}</div>'
                    f'<div class="s-main"><div class="s-title">{stitle}</div>{spk_html}</div>'
                    f'</div>'
                )
            date_sfx = f" · {ddate}" if ddate else ""
            body = rows if rows else '<div class="empty">—</div>'
            prog_html += (
                f'<div class="day"><div class="day-h">{dtitle}{date_sfx}</div>{body}</div>'
            )
    else:
        prog_html = '<div class="empty">Программа пока не опубликована</div>'

    # ── Секция: Экосистема ──
    eco_html = ""
    if client:
        photo = esc(client.get("profile_photo_url") or "")
        pos = esc(client.get("positioning") or "")
        eco_html += '<div class="eco-head">'
        if photo:
            eco_html += f'<img class="eco-ava" src="{photo}" alt="" onerror="this.style.display=\'none\'">'
        eco_html += f'<div class="eco-name">{brand}</div>'
        if pos:
            eco_html += f'<div class="eco-pos">{pos}</div>'
        eco_html += '</div>'
        paid = [o for o in offerings if o.get("is_paid")]
        free = [o for o in offerings if not o.get("is_paid")]

        def _offer(o):
            ot = esc(o.get("title") or "")
            od = esc(o.get("description") or "")
            price = esc(o.get("price") or "")
            link = esc(o.get("link_url") or "")
            btn = f'<a class="o-btn" href="{link}" target="_blank" rel="noopener">Подробнее</a>' if link else ""
            pr = f'<div class="o-price">{price}</div>' if price else ""
            od_html = f'<div class="o-desc">{od}</div>' if od else ""
            return f'<div class="offer"><div class="o-title">{ot}</div>{od_html}{pr}{btn}</div>'

        if paid:
            eco_html += '<h2 class="sec-h">Платно</h2>' + "".join(_offer(o) for o in paid)
        if free:
            eco_html += '<h2 class="sec-h">Бесплатно</h2>' + "".join(_offer(o) for o in free)
    if not eco_html:
        eco_html = '<div class="empty">Экосистема пока не заполнена</div>'

    # ── Какие вкладки показываем ──
    tabs = []
    tabs.append(("about", "О событии"))
    if days:
        tabs.append(("program", "Программа"))
    if has_people:
        tabs.append(("speakers", "Спикеры"))
    tabs.append(("ecosystem", "Экосистема"))

    nav_html = "".join(
        f'<a class="tab" href="#{tid}" data-tab="{tid}">{esc(label)}</a>'
        for tid, label in tabs
    )

    # ── О событии ──
    about_html = ""
    if desc:
        about_html += f'<div class="desc">{desc}</div>'
    else:
        about_html += f'<div class="empty">Описание события не заполнено</div>'

    first_tab = tabs[0][0]

    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
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
  .sec-h {{ font-size: 15px; color:#25455D; margin: 18px 0 10px; padding-bottom:6px;
    border-bottom: 2px solid #FFCFA4; display:inline-block; }}
  .cards {{ display:flex; flex-direction:column; gap:12px; }}
  .card {{ background:#fff; border-radius:14px; padding:14px; display:flex; gap:12px; box-shadow:0 1px 4px rgba(0,0,0,.06); }}
  .ava {{ width:64px; height:64px; border-radius:12px; object-fit:cover; flex:0 0 64px; background:#e7ecf1; }}
  .ava-empty {{ background: linear-gradient(135deg,#d4dde5,#b9c6d2); }}
  .card-body {{ flex:1; min-width:0; }}
  .pname {{ font-weight:700; font-size:15px; color:#1f2d3a; }}
  .ptitle {{ font-size:13px; color:#FFCFA4; filter:brightness(.7); margin-top:2px; }}
  .topic {{ font-size:13px; color:#41566a; margin-top:6px; font-style:italic; }}
  .ach {{ margin:8px 0 0; padding-left:16px; font-size:12.5px; color:#52647a; line-height:1.5; }}
  .ach li {{ margin-bottom:2px; }}
  .socs {{ display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }}
  .soc {{ font-size:12px; padding:4px 10px; border-radius:14px; background:#eef2f6; color:#25455D; text-decoration:none; }}
  .day {{ background:#fff; border-radius:14px; padding:14px; margin-bottom:12px; box-shadow:0 1px 4px rgba(0,0,0,.06); }}
  .day-h {{ font-weight:700; color:#25455D; margin-bottom:10px; font-size:15px; }}
  .s-row {{ display:flex; gap:10px; padding:8px 0; border-top:1px solid #f0f3f6; }}
  .s-row:first-of-type {{ border-top:none; }}
  .s-time {{ flex:0 0 90px; font-size:12.5px; color:#8593a1; }}
  .s-main {{ flex:1; }}
  .s-title {{ font-size:14px; color:#1f2d3a; }}
  .s-spk {{ font-size:12.5px; color:#FFCFA4; filter:brightness(.7); margin-top:2px; }}
  .desc {{ background:#fff; border-radius:14px; padding:16px; line-height:1.6; font-size:14.5px; box-shadow:0 1px 4px rgba(0,0,0,.06); }}
  .desc img {{ max-width:100%; border-radius:8px; }}
  .eco-head {{ background:#fff; border-radius:14px; padding:16px; text-align:center; box-shadow:0 1px 4px rgba(0,0,0,.06); margin-bottom:8px; }}
  .eco-ava {{ width:84px; height:84px; border-radius:50%; object-fit:cover; }}
  .eco-name {{ font-weight:700; font-size:18px; margin-top:8px; color:#25455D; }}
  .eco-pos {{ font-size:13.5px; color:#52647a; margin-top:4px; }}
  .offer {{ background:#fff; border-radius:14px; padding:14px; margin-bottom:10px; box-shadow:0 1px 4px rgba(0,0,0,.06); }}
  .o-title {{ font-weight:700; font-size:15px; }}
  .o-desc {{ font-size:13.5px; color:#52647a; margin-top:4px; line-height:1.5; }}
  .o-price {{ font-weight:700; color:#25455D; margin-top:6px; }}
  .o-btn {{ display:inline-block; margin-top:10px; padding:9px 18px; border-radius:20px; background:#FFCFA4; color:#25455D; font-weight:700; text-decoration:none; font-size:14px; }}
  .empty {{ color:#8593a1; font-size:14px; padding:20px; text-align:center; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    {f'<div class="brand">{brand}</div>' if brand else ''}
    <h1>{title}</h1>
  </div>
  <div class="tabs">{nav_html}</div>
  <div class="content">
    <div class="panel" id="about"><div data-anchor></div>{about_html}</div>
    {'<div class="panel" id="program">' + prog_html + '</div>' if days else ''}
    {'<div class="panel" id="speakers">' + people_html + '</div>' if has_people else ''}
    <div class="panel" id="ecosystem">{eco_html}</div>
  </div>
</div>
<script>
  // Переключение вкладок по #якорю — без перезагрузки, мгновенно.
  function showTab(id) {{
    var panels = document.querySelectorAll('.panel');
    var tabs = document.querySelectorAll('.tab');
    var found = false;
    panels.forEach(function(p) {{
      var on = p.id === id; p.classList.toggle('active', on); if (on) found = true;
    }});
    if (!found) {{ // неизвестный якорь — первая вкладка
      id = '{first_tab}';
      document.getElementById(id).classList.add('active');
    }}
    tabs.forEach(function(t) {{ t.classList.toggle('active', t.getAttribute('data-tab') === id); }});
    window.scrollTo(0, 0);
  }}
  function currentTab() {{ return (location.hash || '').replace('#','') || '{first_tab}'; }}
  window.addEventListener('hashchange', function() {{ showTab(currentTab()); }});
  showTab(currentTab());
</script>
</body>
</html>"""


@router.get("/event/{slug}", response_class=HTMLResponse, include_in_schema=False)
async def event_page(slug: str, db: asyncpg.Connection = Depends(get_db)):
    event = await _resolve_event(db, slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    event_id = event["id"]
    groups = await _load_collaborators(db, event_id)
    days, sessions = await _load_program(db, event_id)
    client, offerings = await _load_client(db, event["client_id"]) if event["client_id"] else (None, [])
    html_str = render_page(dict(event), groups, days, sessions,
                           dict(client) if client else None,
                           [dict(o) for o in offerings])
    return HTMLResponse(content=html_str)
