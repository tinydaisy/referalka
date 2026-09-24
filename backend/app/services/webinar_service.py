"""Общие хелперы вебинарной комнаты (миграция 221).

Переиспользуются клиентским и публичным роутерами + WS-хабом:
- владение событием (через event_owners),
- резолв client_id по slug,
- генерация ключа потока,
- «текущий спикер по слоту программы дня» (для авто-кнопки подписки/подарка),
- тегирование контакта (JSONB contacts.tags — отдельного write-эндпоинта в проекте нет).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import HTTPException

from app.services.client_domains import client_public_link

# Московское время — вся программа проекта в МСК (см. правило "время HH:MM МСК").
MSK = timezone(timedelta(hours=3))

_KEY_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"  # без похожих 0/o/1/l/i


async def _event_public_link(db, event_id: int, path: str,
                             contact_id: Optional[int] = None) -> str:
    """Публичная ссылка события на домене его ОРГАНИЗАТОРА (у events нет client_id).

    ⚠️ КОЛЛАБА: если известен человек — домен ТОГО организатора, в чьей базе его
    контакт (см. services/event_client.py). Иначе — владелец события, как было.
    """
    client_id = await db.fetchval(
        """SELECT eo.client_id FROM event_owners eo
            WHERE eo.event_id=$1 AND eo.status='accepted'
            ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1""",
        event_id)
    if contact_id:
        from app.services.event_client import resolve_event_client
        client_id = await resolve_event_client(
            db, event_id=event_id, client_id=client_id, contact_id=contact_id)
    return await client_public_link(db, client_id, path)


def make_stream_key(n: int = 16) -> str:
    return "".join(secrets.choice(_KEY_ALPHABET) for _ in range(n))


async def resolve_event_contact_id(db, event_id: int, platform: str, platform_user_id) -> Optional[int]:
    """contact_id пользователя В БАЗЕ ОРГАНИЗАТОРА события. Один tg/vk/max-id
    живёт у разных клиентов разными контактами — резолвим строго по организаторам
    события, иначе берётся чужой contact_id. Единая точка для ботов/эндпоинтов.

    ⚠️ КОЛЛАБА: организаторов несколько и они равноправны, поэтому ищем среди
    ВСЕХ (`IN`, а не «первый из event_owners»). Раньше человека из базы второго
    организатора тут просто не находили: contact_id уходил NULL, и дальше по
    цепочке он выглядел незарегистрированным — вкладки под замками, ссылка
    эфира без контакта. Предпочтение — участнику события (он в нужной базе),
    затем более свежей идентичности.

    Логика живёт в services/event_client.py — здесь только обёртка, чтобы не
    держать вторую копию запроса (она бы разъехалась).
    """
    from app.services.event_client import resolve_event_contact_id_any_owner
    return await resolve_event_contact_id_any_owner(
        db, event_id, platform, platform_user_id)


async def current_event_day(db, event_id: int) -> Optional[int]:
    """День эфира «сейчас»: сегодняшний по МСК (conf_days.day_date=today), иначе
    ближайший будущий, иначе первый день С вебинарной комнатой, иначе 1.
    Для мероприятия (нет conf_days) вернёт первый day_number из webinar_rooms или 1."""
    today = datetime.now(MSK).date()
    # среди дней программы: сегодня → ближайший будущий → первый
    d = await db.fetchval(
        "SELECT day_number FROM conf_days WHERE event_id=$1 AND day_date=$2 LIMIT 1",
        event_id, today)
    if d:
        return d
    d = await db.fetchval(
        "SELECT day_number FROM conf_days WHERE event_id=$1 AND day_date>=$2 "
        "ORDER BY day_date LIMIT 1", event_id, today)
    if d:
        return d
    # нет подходящего дня программы → первый день с комнатой
    # ⚠️ Первый — ПО ДАТЕ дня программы, а не по номеру (правило владельца,
    # 19.09.2026): номер — это порядок заведения, дни добавляют не подряд.
    # У комнаты своей даты нет, поэтому берём её из conf_days; дни без даты и
    # комнаты без дня программы — в конец, между собой по номеру.
    d = await db.fetchval(
        "SELECT wr.day_number FROM webinar_rooms wr "
        " LEFT JOIN conf_days cd ON cd.event_id=wr.event_id AND cd.day_number=wr.day_number "
        "WHERE wr.event_id=$1 ORDER BY cd.day_date NULLS LAST, wr.day_number LIMIT 1",
        event_id)
    return d or 1


_RU_MON = ["января","февраля","марта","апреля","мая","июня",
           "июля","августа","сентября","октября","ноября","декабря"]


async def nearest_live_info(db, event_id: int) -> dict:
    """Что писать в меню про ближайший эфир — ОДНА точка на три площадки.

    Возвращает: {is_today, when, day_number, days_total, title}.

    ⚠️ ОДНА функция на TG/VK/MAX (24.09.2026). Раньше текст собирался в трёх
    местах отдельно, и правка в одном тут же расходилась с двумя другими.

    ⚠️ «Сегодня» = дата дня совпадает с сегодняшней И день ещё не закончился
    с запасом +1 час: эфир, начавшийся в 19:00, в 19:30 ещё идёт, и писать
    «ближайший эфир завтра» было бы ложью. Запас берём от ПОСЛЕДНЕГО слота дня.

    ⚠️ `day_number` отдаём только когда дней в программе БОЛЬШЕ ОДНОГО: писать
    «День 1» у однодневного события — лишний шум.
    """
    today = datetime.now(MSK).date()
    now = datetime.now(MSK)

    days_total = await db.fetchval(
        "SELECT COUNT(*) FROM conf_days WHERE event_id=$1 AND day_date IS NOT NULL",
        event_id) or 0

    # Дни с границами: первый слот (начало) и последний (конец дня).
    rows = await db.fetch(
        """SELECT cd.day_number, cd.day_date,
                  MIN(s.start_time) AS first_start,
                  MAX(COALESCE(s.end_time, s.start_time)) AS last_end
             FROM conf_days cd
             LEFT JOIN conf_sessions s
                    ON s.event_id = cd.event_id AND s.day = cd.day_number
                   AND s.start_time IS NOT NULL
            WHERE cd.event_id = $1 AND cd.day_date IS NOT NULL
            GROUP BY cd.day_number, cd.day_date
            ORDER BY cd.day_date""",
        event_id)

    def _hhmm(v):
        try:
            hh, mm = str(v)[:5].split(":")
            return int(hh), int(mm)
        except Exception:
            return None

    # 1) Идёт сегодня и ещё не закончился (+1 час запаса)?
    for r in rows:
        if r["day_date"] != today:
            continue
        end = _hhmm(r["last_end"]) or _hhmm(r["first_start"])
        if end is None:
            continue
        end_dt = datetime(today.year, today.month, today.day,
                          end[0], end[1], tzinfo=MSK) + timedelta(hours=1)
        if now <= end_dt:
            st = _hhmm(r["first_start"]) or (0, 0)
            return {
                "is_today": True,
                "when": f"{r['day_date'].day} {_RU_MON[r['day_date'].month - 1]} "
                        f"{st[0]:02d}:{st[1]:02d} МСК",
                "day_number": r["day_number"] if days_total > 1 else None,
                "days_total": days_total,
            }

    # 2) Иначе — ближайший будущий день.
    for r in rows:
        if r["day_date"] < today:
            continue
        st = _hhmm(r["first_start"]) or (0, 0)
        return {
            "is_today": False,
            "when": f"{r['day_date'].day} {_RU_MON[r['day_date'].month - 1]} "
                    f"{st[0]:02d}:{st[1]:02d} МСК",
            "day_number": r["day_number"] if days_total > 1 else None,
            "days_total": days_total,
        }

    # 3) Программы нет вовсе (мероприятие) → старт самого события.
    # ⚠️ Без этой ветки у события без conf_days текст остался бы без даты:
    # раньше её считал каждый бот у себя, при переносе в общую точку её легко
    # было потерять.
    st_at = await db.fetchval("SELECT start_at FROM events WHERE id=$1", event_id)
    if st_at:
        dt = st_at if st_at.tzinfo else st_at.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(MSK)
        return {
            "is_today": dt.date() == today and now <= dt + timedelta(hours=1),
            "when": f"{dt.day} {_RU_MON[dt.month - 1]} {dt.hour:02d}:{dt.minute:02d} МСК",
            "day_number": None,
            "days_total": days_total,
        }

    return {"is_today": False, "when": "", "day_number": None, "days_total": days_total}


def build_live_menu_text(info: dict, event_title: str, has_stream: bool,
                         *, html: bool = True) -> str:
    """Текст кнопки «Эфир» в меню события — одинаковый в TG/VK/MAX.

    ⚠️ Формат согласован с владельцем 24.09.2026:
      идёт сегодня → «Уже сегодня — <дата>» + пустая строка + «<Событие> — День N»
                     + пустая строка + «Нажмите на кнопку, чтобы войти в эфир:»
      иначе        → «Ближайший эфир — <дата>» + «<Событие> — День N»
                     + «Ссылка на эфир покажется в день эфира…»

    ⚠️ «День N» пишем ТОЛЬКО когда дней больше одного (см. nearest_live_info).
    """
    # ⚠️ `html=False` — для ВК и MAX: они HTML-теги НЕ понимают и покажут
    # «<b>» текстом. Экранировать там тоже нечего — разметки нет вовсе.
    import html as _h
    _esc = (lambda v: _h.escape(v or "")) if html else (lambda v: v or "")
    _b = (lambda v: f"<b>{v}</b>") if html else (lambda v: v)
    title = _esc(event_title)
    when = _esc(info.get("when"))
    dn = info.get("day_number")
    line2 = f"{title} — День {dn}" if dn else title

    if info.get("is_today"):
        head = f"{_b('Уже сегодня')} — {when}" if when else _b("Уже сегодня")
        tail = ("Нажмите на кнопку, чтобы войти в эфир 👇" if has_stream
                else "Ссылка на эфир появится здесь перед началом.")
        return f"{head}\n\n{line2}\n\n{tail}"

    head = f"{_b('Ближайший эфир')} — {when}" if when else _b("Ближайший эфир")
    tail = ("Ссылка на эфир покажется в день эфира, "
            "а пока нажмите на кнопку и изучите программу 👇")
    return f"{head}\n\n{line2}\n\n{tail}"


async def day_stream_url(db, event_id: int, day: Optional[int],
                         contact_id: Optional[int] = None) -> str:
    """Единая ссылка на эфир ДНЯ (после удаления events.stream_url).

    Источник — вебинарная комната дня (webinar_rooms по event_id+day_number):
      • сторонний вебинар (stream_type='external_link') → её external_url;
      • наша комната (encoder) → {домен клиента}/webinar/{slug}/{day}
        (+ ?c={contact_id} для сквозной идентификации зрителя).
    Нет дня / нет комнаты / пусто → ''. Общей events.stream_url больше нет.

    ⚠️ НИКАКИХ ЗАХАРДКОЖЕННЫХ ССЫЛОК-ЗАТЫЧЕК. Ссылка эфира берётся ТОЛЬКО из
    настроек события (вебинарная комната дня). Нет комнаты → пустая строка,
    кнопка эфира не рисуется, плейсхолдер в рассылке пустой. Подставлять
    постороннюю ссылку (которую клиент нигде не задавал и не может изменить в
    кабинете) нельзя — так уже было с legacy-Zoom, больше не повторять.
    """
    if not day:
        return ""
    wr = await db.fetchrow(
        "SELECT stream_type, external_url FROM webinar_rooms "
        "WHERE event_id=$1 AND day_number=$2", event_id, day)
    if not wr:
        return ""
    if wr["stream_type"] == "external_link":
        return (wr["external_url"] or "").strip()
    slug = await db.fetchval("SELECT slug FROM events WHERE id=$1", event_id)
    if not slug:
        return ""
    # Зритель приходит из рассылки клиента → комната открывается на его домене.
    url = await _event_public_link(db, event_id, f"webinar/{slug}/{day}", contact_id)
    if contact_id:
        url += f"?c={contact_id}"
    return url


async def resolve_event_by_slug(db, slug: str) -> Optional[dict]:
    """Событие + client_id владельца по slug (у events нет client_id — берём из event_owners)."""
    row = await db.fetchrow(
        "SELECT id, title, slug, module_slug, status, "
        "  (SELECT eo.client_id FROM event_owners eo "
        "     WHERE eo.event_id=events.id AND eo.status='accepted' "
        "     ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id "
        "FROM events WHERE slug = $1",
        slug,
    )
    return dict(row) if row else None


async def assert_event_owner(db, event_id: int, client_id: int) -> None:
    """404 если событие не принадлежит клиенту (через event_owners, status='accepted')."""
    row = await db.fetchrow(
        "SELECT 1 FROM events WHERE id = $1 AND id IN "
        "(SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено или нет доступа")


async def get_room_or_404(db, event_id: int, day_number: int) -> dict:
    row = await db.fetchrow(
        "SELECT * FROM webinar_rooms WHERE event_id=$1 AND day_number=$2",
        event_id, day_number,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Вебинарная комната не найдена")
    return dict(row)


async def current_speaker_ec_id(db, event_id: int, day_number: int) -> Optional[int]:
    """event_collaborators.id спикера, чей слот программы дня идёт СЕЙЧАС (МСК).

    conf_sessions.speaker_id = event_collaborators.id (не collaborators.id).
    Ориентир — start_time/end_time слота (TEXT "HH:MM"). Если сейчас между началом
    и концом какого-то слота — его спикер «в эфире». Иначе None.

    ⚠️ Проверяем И ДАТУ дня: текущий спикер показывается ТОЛЬКО если сегодня (МСК)
    совпадает с датой этого дня программы. Иначе слот 11:20 «сработал бы» в любой
    день по одному только времени.
    """
    now = datetime.now(MSK)
    # дата этого дня программы
    day_date = await db.fetchval(
        "SELECT day_date FROM conf_days WHERE event_id=$1 AND day_number=$2", event_id, day_number)
    if day_date is None or day_date != now.date():
        return None
    hhmm = now.strftime("%H:%M")
    row = await db.fetchrow(
        "SELECT speaker_id FROM conf_sessions "
        " WHERE event_id=$1 AND day=$2 AND speaker_id IS NOT NULL "
        "   AND start_time IS NOT NULL AND start_time <= $3 "
        "   AND (end_time IS NULL OR end_time >= $3) "
        " ORDER BY start_time DESC LIMIT 1",
        event_id, day_number, hhmm,
    )
    return row["speaker_id"] if row else None


async def speaker_follow_card(db, event_id: int, ec_id: Optional[int]) -> Optional[dict]:
    """Данные для авто-кнопки «Подписаться на спикера» / плашки «Сейчас выступает».

    По event_collaborators.id → имя коллаба + его каналы (TG/VK/MAX).
    """
    if not ec_id:
        return None
    row = await db.fetchrow(
        "SELECT ec.id AS ec_id, btrim(CASE WHEN COALESCE(btrim(c.last_name),'')='' THEN COALESCE(c.name,'') ELSE COALESCE(c.name,'')||' '||COALESCE(c.last_name,'') END) AS name, c.tg_channel_url, c.vk_url, c.max_url, c.photo_url "
        "FROM event_collaborators ec JOIN collaborators c ON c.id = ec.speaker_id "
        "WHERE ec.id = $1 AND ec.event_id = $2",
        ec_id, event_id,
    )
    if not row:
        return None
    d = dict(row)
    return {
        "ec_id": d["ec_id"],
        "name": d["name"],
        "photo_url": d["photo_url"],
        "channels": {
            "telegram": d["tg_channel_url"],
            "vk": d["vk_url"],
            "max": d["max_url"],
        },
    }


async def speaker_gift_card(db, event_id: int, ec_id: Optional[int]) -> Optional[dict]:
    """Подарок спикера для всплытия по таймингу слота.

    Источник — event_collaborator_lead_magnets (ручные + плюсоновские) ИЛИ
    привязанный лид-магнит/пакет ПЛЮСОНа.
    """
    if not ec_id:
        return None
    # имя спикера
    name = await db.fetchval(
        "SELECT btrim(CASE WHEN COALESCE(btrim(col.last_name),'')='' THEN COALESCE(col.name,'') ELSE COALESCE(col.name,'')||' '||COALESCE(col.last_name,'') END) FROM event_collaborators ec JOIN collaborators col ON col.id=ec.speaker_id "
        "WHERE ec.id=$1 AND ec.event_id=$2", ec_id, event_id)

    gifts = []
    # 1) СПИСОК подарков (event_collaborator_lead_magnets) — их может быть несколько
    rows = await db.fetch(
        "SELECT lead_magnet_id, package_id, manual_title, manual_url "
        "FROM event_collaborator_lead_magnets WHERE ec_id=$1 ORDER BY sort_order, id", ec_id)
    # ⚠️ Домен воронки — у ВЛАДЕЛЬЦА магнита/пакета (у спикера может быть свой
    # ПЛЮСОН-аккаунт), а не у владельца события: воронку обслуживает его кабинет.
    for r in rows:
        if r["manual_title"] and r["manual_url"]:
            gifts.append({"title": r["manual_title"], "url": r["manual_url"]})
        elif r["lead_magnet_id"]:
            lm = await db.fetchrow("SELECT name, slug, client_id FROM lead_magnets WHERE id=$1", r["lead_magnet_id"])
            if lm and lm["slug"]:
                gifts.append({"title": lm["name"],
                              "url": await client_public_link(db, lm["client_id"], f"m/{lm['slug']}")})
        elif r["package_id"]:
            pk = await db.fetchrow("SELECT name, slug, client_id FROM lead_magnet_packages WHERE id=$1", r["package_id"])
            if pk and pk["slug"]:
                gifts.append({"title": pk["name"],
                              "url": await client_public_link(db, pk["client_id"], f"p/{pk['slug']}")})

    # 2) Fallback на старые одиночные поля event_collaborators (если список пуст)
    if not gifts:
        old = await db.fetchrow(
            "SELECT gift_lead_magnet_id, gift_package_id "
            "FROM event_collaborators WHERE id=$1 AND event_id=$2", ec_id, event_id)
        if old:
            # ⚠️ Одиночные gift_after_speech_* УДАЛЕНЫ: все подарки живут в
            # event_collaborator_lead_magnets (перенесены 2026-07-30). Остались
            # только legacy-привязки к магниту/пакету.
            if old["gift_lead_magnet_id"]:
                lm = await db.fetchrow("SELECT name, slug, client_id FROM lead_magnets WHERE id=$1", old["gift_lead_magnet_id"])
                if lm and lm["slug"]:
                    gifts.append({"title": lm["name"],
                                  "url": await client_public_link(db, lm["client_id"], f"m/{lm['slug']}")})
            elif old["gift_package_id"]:
                pk = await db.fetchrow("SELECT name, slug, client_id FROM lead_magnet_packages WHERE id=$1", old["gift_package_id"])
                if pk and pk["slug"]:
                    gifts.append({"title": pk["name"],
                                  "url": await client_public_link(db, pk["client_id"], f"p/{pk['slug']}")})

    if not gifts:
        return None
    return {"speaker_name": name, "gifts": gifts}


async def tag_contact(db, client_id: int, contact_id: int, tag: str) -> None:
    """Добавить тег контакту (JSONB contacts.tags), без дублей.

    В проекте нет готового write-эндпоинта тегов — паттерн через
    jsonb_array_elements_text + agg (операторы уже используются в contacts.py).
    """
    if not tag:
        return
    await db.execute(
        "UPDATE contacts SET tags = ("
        "  SELECT to_jsonb(array_agg(DISTINCT t)) FROM jsonb_array_elements_text("
        "    COALESCE(tags,'[]'::jsonb) || to_jsonb(ARRAY[$2::text])) t"
        ") WHERE id = $1 AND client_id = $3",
        contact_id, tag, client_id,
    )


def rtmp_url(stream_key: str) -> str:
    """URL трансляции для видеокодера — БЕЗ ключа в конце.

    ⚠️ Zoom (и большинство кодеров) поле «URL трансляции» и «Ключ трансляции»
    заполняют РАЗДЕЛЬНО и склеивают сами → path = live/{key}. Если отдать ключ
    внутри URL, а клиент ещё раз впишет его в поле ключа, получится live/{key}/{key}
    и HLS не совпадёт с тем, что ждёт плеер (live/{key}). Поэтому URL — только база.
    """
    from app.config import settings
    return f"rtmp://{settings.webinar_rtmp_host}/live"


def hls_url(stream_key: str) -> str:
    from app.config import settings
    return f"{settings.webinar_hls_base}/{stream_key}/index.m3u8"


def parse_evreg_payload(payload: str) -> Optional[tuple[int, Optional[int]]]:
    """Разбирает deeplink `evreg_<event_id>[_ct<contact_id>]` → (event_id, contact_id).
    Кнопка «Регистрация на событие» из вебинара для тех, кого ещё нет в боте.
    contact_id опционален (None, если хвоста _ct нет). Не тот формат → None."""
    import re
    m = re.match(r"^evreg_(\d+)(?:_ct(\d+))?$", (payload or "").strip())
    if not m:
        return None
    return int(m.group(1)), (int(m.group(2)) if m.group(2) else None)


async def register_event_from_deeplink(
    db, *, client_id: int, event_id: int, contact_id_hint: Optional[int],
    platform: str, platform_user_id, username: Optional[str] = None,
    first_name: Optional[str] = None,
) -> dict:
    """ЕДИНАЯ точка для 3 ботов: человек пришёл по deeplink «Регистрация на событие»
    (evreg_<eid>_ct<cid>). Привязывает РЕАЛЬНУЮ идентичность бота (числовой
    platform_user_id по факту захода) к его контакту и регистрирует на событие.

    contact_id_hint (из ссылки) передаётся как known_contact_id — новая идентичность
    цепляется к ЭТОМУ контакту, не плодя дубль (важно: ник из формы уже неважен,
    решает реальный bot user_id). Возвращает {contact_id, event_title, event_slug}.
    """
    from app.services.contact_merge import upsert_contact_with_identity
    cid, _puid, _new = await upsert_contact_with_identity(
        db, client_id=client_id, platform_slug=platform,
        platform_user_id=str(platform_user_id), username=username,
        first_name=first_name, known_contact_id=contact_id_hint,
    )
    from app.services.event_participant import upsert_event_participant
    await upsert_event_participant(
        db, event_id=event_id, contact_id=cid, is_registered=True)
    ev = await db.fetchrow("SELECT title, slug FROM events WHERE id=$1", event_id)
    return {"contact_id": cid,
            "event_title": ev["title"] if ev else "",
            "event_slug": ev["slug"] if ev else ""}
