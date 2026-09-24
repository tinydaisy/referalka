"""Вебинарная комната — публичный API зрителя + WebSocket.

Зритель на pluson.ru/webinar/{slug}/{day}. Идентификация: contact_id (известный,
из query/Mini App) ИЛИ анонимный session_key (генерит фронт). Всё пишется в
webinar_activity/presence с contact_id — база аналитики по зрителю.

Роутеры:
- router    — /api/v1/public/webinar/{slug}/{day}/...   (REST зрителя)
- ws_router — /ws/webinar/{slug}/{day}                  (WebSocket realtime)
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.database import get_pool
from app.services import webinar_service as ws
from app.services import webinar_hub as hub
from app.services.contact_merge import find_or_create_contact

router = APIRouter(prefix="/api/v1/public/webinar", tags=["Вебинар — зритель"])
ws_router = APIRouter()


# ── Один голос на человека ──────────────────────────────────────────────────

async def _remember_vote(conn, room: dict, target_kind: str, target_id: int,
                         contact_id: Optional[int], session_key: Optional[str],
                         reaction_key: str) -> bool:
    """Записать голос. False — этот человек уже голосовал за этот объект.

    ⚠️ Проверяем ВСТАВКОЙ с `ON CONFLICT DO NOTHING`, а не «сначала SELECT,
    потом INSERT»: между двумя запросами помещается второе нажатие (двойной
    клик, дрожащая сеть), и проверка пропустила бы оба голоса. Здесь решает
    уникальный индекс — гонки не существует в принципе.

    ⚠️ Голос привязан к ЗАПУСКУ эфира (`session_id`): после «Начать заново»
    голосование чистое, иначе вчерашние голоса блокировали бы сегодняшний.

    ⚠️ Ограничение считается ПО ОБЪЕКТУ (спикеру/игроку), а не по реакции:
    иначе один человек поставил бы и 👍, и 👎 одному и тому же спикеру.
    """
    if not contact_id and not session_key:
        # Опознать некого — пропускаем, иначе запрет ударил бы по всем сразу.
        return True
    res = await conn.execute(
        "INSERT INTO webinar_votes (room_id, target_kind, target_id, contact_id, "
        "                           session_key, reaction_key, session_id) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        room["id"], target_kind, target_id,
        contact_id, None if contact_id else session_key,
        reaction_key, room.get("current_session_id"),
    )
    # asyncpg возвращает «INSERT 0 1» при вставке и «INSERT 0 0» при конфликте.
    return not (res or "").endswith(" 0")


# ── Запрет ссылок в чате ────────────────────────────────────────────────────

# ⚠️ Ловим ссылку ШИРЕ, чем «http://»: запрет обходят голым доменом
# («канал t.me/name», «пиши мне в вк vk.com/id1»), и именно так его и обходят.
#
# ⚠️⚠️ ЗОНА ЛЮБАЯ, а не из списка (23.09.2026). Раньше тут был перечень
# популярных зон — и всё, чего в нём нет, проходило мимо запрета: `example.gg`,
# `mysite.xyz`, даже `youtu.be/abc`. Перечисление зон обречено: их больше
# полутора тысяч, и новые появляются. Берём любую зону из 2–24 латинских букв.
#
# ⚠️ От ложных срабатываний защищаемся иначе — НЕ списком зон:
#   • зона только латиницей → «спасибо.мне понравилось» не ссылка;
#   • перед точкой запрещены цифры в конце → «1.5» и «версия 2.0» проходят;
#   • зона не короче двух букв → сокращения вроде «т.е» не ловятся.
_LINK_RE = re.compile(
    r"(?:(?:https?|ftp)://\S+)"
    r"|(?:www\.\S+)"
    r"|(?:\b[a-zA-Zа-яА-Я][-a-zA-Zа-яА-Я0-9]*"
    r"\.[a-zA-Z]{2,24}"
    r"(?:/\S*)?\b)",
    re.IGNORECASE,
)

# ⚠️ Маскировка точки: «site(.)ru», «site . ru», «site[dot]ru» — тот же адрес,
# написанный так, чтобы проскочить проверку. Приводим текст к обычному виду
# ПЕРЕД поиском, иначе запрет обходится одним лишним символом.
_DOT_MASK_RE = re.compile(
    r"\s*(?:\(\s*\.\s*\)|\[\s*\.\s*\]|\{\s*\.\s*\}"
    r"|\(\s*(?:dot|точка)\s*\)|\[\s*(?:dot|точка)\s*\]"
    r"|\s\.\s)\s*",
    re.IGNORECASE,
)

# Telegram/VK-хендлы: «@my_channel» — такая же ссылка по смыслу.
_HANDLE_RE = re.compile(r"(?<![\w@])@[A-Za-z][A-Za-z0-9_]{3,}\b")


def _unmask_dots(text: str) -> str:
    """«site(.)ru» → «site.ru». Только для ПРОВЕРКИ, не для показа."""
    return _DOT_MASK_RE.sub(".", text or "")


LINK_HIDDEN = "<ссылка скрыта>"


def has_link(text: str) -> bool:
    """Есть ли в тексте ссылка (в широком смысле: схема, домен, @хендл).

    ⚠️ Ищем в ТЕКСТЕ БЕЗ МАСКИРОВКИ точки: «site(.)ru» — та же ссылка.
    """
    t = _unmask_dots(text or "")
    return bool(_LINK_RE.search(t) or _HANDLE_RE.search(t))


def strip_links(text: str) -> str:
    """Заменяет каждую ссылку и @хендл на «<ссылка скрыта>».

    ⚠️⚠️ ЗАМЕНЯЕМ, А НЕ ОТКЛОНЯЕМ СООБЩЕНИЕ (23.09.2026). Раньше сообщение со
    ссылкой отвергалось целиком — человек писал вопрос со ссылкой на свой
    пример и не понимал, почему чат «не работает», и слал снова. Теперь мысль
    доходит до эфира, а адрес — нет.

    ⚠️ Маскировку («site(.)ru») снимаем ДО замены: иначе в чат уйдёт рабочий
    адрес, просто записанный хитрее.
    """
    t = _unmask_dots(text or "")
    t = _LINK_RE.sub(LINK_HIDDEN, t)
    t = _HANDLE_RE.sub(LINK_HIDDEN, t)
    # Несколько ссылок подряд схлопываем в одну пометку — «<ссылка скрыта>
    # <ссылка скрыта> <ссылка скрыта>» читается как мусор.
    t = re.sub(r"(?:" + re.escape(LINK_HIDDEN) + r"[\s,;]*){2,}",
               LINK_HIDDEN + " ", t)
    return t.strip()


async def _is_room_moderator(conn, room: dict, token: Optional[str]) -> bool:
    """Организатор события (владелец или соорганизатор) — ему запрет не писан.

    ⚠️ Опознаём по токену КАБИНЕТА, а не по contact_id из ссылки: contact_id
    приходит из адресной строки и подделывается тривиально — на нём нельзя
    строить право обходить запрет.

    ⚠️ Любая ошибка разбора токена = «не модератор», без исключения наверх:
    у обычного зрителя токена нет вовсе, и падать на этом нельзя.
    """
    if not token:
        return False
    try:
        from app.auth import decode_token
        payload = decode_token(token)
        client_id = int(payload.get("sub"))
    except Exception:
        return False
    ev = room.get("_event") or {}
    if not ev.get("id"):
        return False
    # Все организаторы события равноправны ([[feedback_collab_owners_are_equal]]).
    if await conn.fetchval(
        "SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2 "
        "  AND status='accepted'",
        ev["id"], client_id,
    ):
        return True
    # ⚠️ ПОМОЩНИК организатора — тоже свой (23.09.2026). Он ведёт эфир вместо
    # клиента и раздаёт в чате ссылки на оплату и материалы; запрет на него не
    # писан. Вход у помощника — токен КЛИЕНТА, к которому он приставлен
    # (`sub` = client_id), плюс `grant_id` в токене: отдельного «своего»
    # client_id у него нет вовсе, поэтому проверка выше его уже покрывает.
    # Явная ветка — на случай пропуска, выданного не владельцем события.
    try:
        if payload.get("grant_id"):
            return bool(await conn.fetchval(
                "SELECT 1 FROM assistant_grants g "
                " JOIN event_owners eo ON eo.client_id = g.client_id "
                "WHERE g.id = $1 AND eo.event_id = $2 AND eo.status = 'accepted'",
                int(payload["grant_id"]), ev["id"],
            ))
    except Exception:
        return False
    return False


async def _load_room(conn, slug: str, day: int) -> dict:
    ev = await ws.resolve_event_by_slug(conn, slug)
    if not ev:
        raise HTTPException(404, "Событие не найдено")
    room = await conn.fetchrow(
        "SELECT * FROM webinar_rooms WHERE event_id=$1 AND day_number=$2", ev["id"], day)
    if not room:
        raise HTTPException(404, "Вебинарная комната не найдена")
    r = dict(room)

    # ⚠️⚠️ СТРАХОВКА: у комнаты ВСЕГДА должен быть ключ потока. Комнаты,
    # созданные копированием события, оставались без него — публичная страница
    # падала с «Application error», а эфир было не запустить (прод, событие 89,
    # 23.09.2026). Источник починен в events.py, но уже созданные комнаты так
    # и остались бы битыми: чиним их здесь, при первом же открытии.
    #
    # ⚠️ Только для своей комнаты (`encoder`): у сторонней потока нет вовсе.
    if r.get("stream_type") == "encoder" and not (r.get("stream_key") or "").strip():
        key = ws.make_stream_key()
        await conn.execute(
            "UPDATE webinar_rooms SET stream_key=$1, hls_url=$2, updated_at=NOW() WHERE id=$3",
            key, ws.hls_url(key), r["id"])
        r["stream_key"], r["hls_url"] = key, ws.hls_url(key)

    r["_event"] = ev
    return r


async def _resolve_ref_placeholders(conn, room_id: int, contact_id: Optional[int], url: Optional[str]) -> Optional[str]:
    """Раскрывает {plsn_ref}/{ext_ref} в URL кнопки — реф-кодами РЕФОВОДА зрителя
    на ЭТОМ СОБЫТИИ (event_participants.referrer_ref_code, единый источник). Как в
    лид-магнитах. Нет рефовода → плейсхолдеры пустеют."""
    if not url or ("{plsn_ref}" not in url and "{ext_ref}" not in url):
        return url
    plsn, ext = "", ""
    if contact_id:
        row = await conn.fetchrow(
            "SELECT rc.ref_code, rc.external_ref_param "
            "FROM webinar_rooms wroom "
            "JOIN event_participants ep ON ep.event_id = wroom.event_id AND ep.contact_id = $2 "
            "JOIN contacts rc ON (rc.ref_code = ep.referrer_ref_code OR rc.merged_ref_codes ? ep.referrer_ref_code) "
            "WHERE wroom.id=$1 AND ep.referrer_ref_code IS NOT NULL AND ep.referrer_ref_code <> '' LIMIT 1",
            room_id, contact_id)
        if row:
            plsn = row["ref_code"] or ""
            ext = row["external_ref_param"] or ""
    return url.replace("{plsn_ref}", plsn).replace("{ext_ref}", ext)


async def _fill_tariff_block(conn, d: dict, event_id: int) -> dict:
    """Блок «Повысить тариф»: подставляет название, цену и ссылку на оплату.

    ⚠️ Цена и название берутся ИЗ БАЗЫ в момент показа, а не сохраняются в
    блоке. Клиент меняет цену тарифа перед эфиром — и кнопка обязана показать
    новую; замороженная в блоке копия разошлась бы с кассой молча.

    ⚠️ Тариф выключили (`is_active=FALSE`) или удалили — блок НЕ показываем:
    `_skip` гасит его. Кнопка «купить» на недоступный тариф ведёт зрителя в
    тупик, и он решит, что сломался сайт.
    """
    row = await conn.fetchrow(
        "SELECT t.id, t.title, t.price, t.is_active, e.slug "
        "  FROM event_tariffs t JOIN events e ON e.id = t.event_id "
        " WHERE t.id=$1 AND t.event_id=$2",
        d["tariff_id"], event_id)
    if not row or not row["is_active"]:
        d["_skip"] = True
        return d
    d["tariff_title"] = row["title"]
    d["tariff_price"] = row["price"]
    if not (d.get("title") or "").strip():
        d["title"] = f"Повысить тариф — {row['title']}"
    # Страница заказа тарифа: она сама узнаёт контакт и подставляет данные.
    d["url"] = await ws._event_public_link(
        conn, event_id, f"e/{row['slug']}/order/{row['id']}")
    return d


async def _fill_product_block(conn, d: dict, event_id: int, contact_id: Optional[int]) -> dict:
    """Блок «Лендинг продукта»: подставляет название и адрес витрины /pr/{slug}.

    ⚠️ Показываем только ОПУБЛИКОВАННЫЙ продукт. Черновик и архив по ссылке
    отдают «страница не найдена» — привести туда зрителя прямо в эфире хуже,
    чем не показать кнопку вовсе. Ровно так же поступают Instagram-воронки с
    событиями.
    """
    row = await conn.fetchrow(
        "SELECT id, title, slug, status, client_id FROM products WHERE id=$1",
        d["product_id"])
    if not row or row["status"] != "published" or not row["slug"]:
        d["_skip"] = True
        return d
    d["product_title"] = row["title"]
    if not (d.get("title") or "").strip():
        d["title"] = row["title"]
    # ⚠️ Домен берём по событию (как у остальных ссылок комнаты), а не по
    # владельцу продукта: в коллабе зритель пришёл из базы конкретного
    # организатора, и уводить его на чужой домен нельзя.
    d["url"] = await ws._event_public_link(conn, event_id, f"pr/{row['slug']}", contact_id)
    return d


async def _is_banned(conn, room_id: int, contact_id: Optional[int], session_key: Optional[str]) -> bool:
    row = await conn.fetchrow(
        "SELECT 1 FROM webinar_banned WHERE room_id=$1 AND "
        "((contact_id IS NOT NULL AND contact_id=$2) OR (session_key IS NOT NULL AND session_key=$3)) LIMIT 1",
        room_id, contact_id, session_key,
    )
    return bool(row)


# ─────────────────────────── данные комнаты ───────────────────────────

async def _auto_payload(conn, room: dict, contact_id: int | None) -> dict:
    """Данные автовебинара для зрителя: ссылка на запись и текущая секунда.

    ⚠️ Стартовую секунду считает СЕРВЕР, а не браузер: иначе зритель просто
    перезагрузил бы страницу и начал сначала, и продающие блоки по таймингу
    потеряли бы смысл.

    Два режима:
      schedule  — общий старт по расписанию, все смотрят синхронно (как эфир);
      on_signup — свой старт у каждого, через auto_delay_min после захода.
    """
    from datetime import datetime, timezone, timedelta

    rec = None
    if room.get("auto_recording_id"):
        rec = await conn.fetchrow(
            "SELECT url, duration_sec FROM webinar_recordings "
            " WHERE id=$1 AND status='ready'", room["auto_recording_id"])
    if not rec or not rec["url"]:
        return {"auto": {"ready": False,
                         "reason": "Запись для автовебинара не выбрана"}}

    now = datetime.now(timezone.utc)
    mode = room.get("auto_mode") or "schedule"
    started_at = None

    if mode == "on_signup":
        # у каждого зрителя свой запуск; без contact_id опознать некого
        if contact_id:
            row = await conn.fetchrow(
                "SELECT starts_at FROM webinar_auto_runs "
                " WHERE room_id=$1 AND contact_id=$2 ORDER BY id DESC LIMIT 1",
                room["id"], contact_id)
            if row:
                started_at = row["starts_at"]
            else:
                started_at = now + timedelta(minutes=room.get("auto_delay_min") or 0)
                await conn.execute(
                    "INSERT INTO webinar_auto_runs (room_id, contact_id, starts_at) "
                    "VALUES ($1,$2,$3)", room["id"], contact_id, started_at)
    else:
        started_at = await _nearest_schedule_start(conn, room["id"], now)

    if not started_at:
        return {"auto": {"ready": False, "reason": "Ближайший запуск не назначен"}}

    elapsed = int((now - started_at).total_seconds())
    dur = rec["duration_sec"] or 0
    if elapsed < 0:
        state = "waiting"
    elif dur and elapsed >= dur:
        state = "ended"
    else:
        state = "live"

    return {"auto": {
        "ready": True,
        "url": rec["url"],
        "duration_sec": dur,
        "state": state,
        "position_sec": max(0, elapsed),
        "starts_at": started_at.isoformat(),
        # ⚠️ перемотка вперёд по умолчанию запрещена: она обесценивает
        # продающие блоки, выстреливающие по таймингу
        "allow_seek": bool(room.get("auto_allow_seek")),
    }}


async def _nearest_schedule_start(conn, room_id: int, now):
    """Момент старта текущего/ближайшего запуска по расписанию (МСК).

    ⚠️ Время в расписании — строка "HH:MM" по МСК (как в программе
    конференции). Считаем в московском времени и возвращаем UTC.
    """
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    msk = ZoneInfo("Europe/Moscow")
    now_msk = now.astimezone(msk)
    rows = await conn.fetch(
        "SELECT kind, weekdays, at_time, once_date FROM webinar_auto_schedule "
        " WHERE room_id=$1 AND is_active", room_id)
    if not rows:
        return None

    best = None
    for r in rows:
        try:
            hh, mm = (r["at_time"] or "").split(":")
            hh, mm = int(hh), int(mm)
        except Exception:
            continue
        # смотрим сегодня и вчера: запуск мог начаться до полуночи и идти сейчас
        for delta in (0, -1):
            d = (now_msk + timedelta(days=delta)).date()
            if r["kind"] == "once":
                if r["once_date"] != d:
                    continue
            elif r["kind"] == "weekly":
                if (d.isoweekday()) not in (r["weekdays"] or []):
                    continue
            start_msk = datetime(d.year, d.month, d.day, hh, mm, tzinfo=msk)
            if start_msk <= now_msk and (best is None or start_msk > best):
                best = start_msk
    return best.astimezone(now.tzinfo) if best else None


@router.get("/{slug}/{day}", summary="Данные комнаты дня для зрителя")
async def room_view(slug: str, day: int, c: Optional[int] = Query(None),
                    pid: Optional[str] = Query(None),
                    token: Optional[str] = Query(None)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid, ev = room["id"], room["_event"]
        # Организатор? От этого зависят кнопки модерации и право слать ссылки
        # при включённом запрете. Токен необязателен — у зрителя его нет.
        is_mod = await _is_room_moderator(conn, room, token)

        # ⚠️ Номер контакта из ссылки СВЕРЯЕМ С КЛИЕНТОМ события (2026-09-03).
        # Раньше `c` брался из адреса как есть. Ссылку на эфир пересылают в чаты
        # вместе с хвостом `?c=142` — и все, кто по ней зашёл, записывались
        # контактом №142 (а организатор, скопировав ссылку из адресной строки,
        # рассылал свой собственный номер). Чужой номер → просто не опознан.
        # Та же проверка стоит в форме ниже (chosen_contact_id).
        if c:
            c = await conn.fetchval(
                "SELECT id FROM contacts WHERE id=$1 AND client_id=$2 AND is_active=TRUE",
                c, ev["client_id"])

        # Заход по куке (?c=): опознанный зритель попадает в зрители (без формы) —
        # но ТОЛЬКО когда комната ОТКРЫТА (room_state='open'). В created (ждёт эфир,
        # афиша+отсчёт) и closed (завершён) — не пишем: смотреть ещё/уже нечего.
        # Рефовод из ?pid= пишем в event_participants (единый источник реф-кода), если пуст.
        if c and (room.get("room_state") or "created") == "open":
            try:
                await conn.execute(
                    "INSERT INTO webinar_registrations (room_id, contact_id) VALUES ($1,$2) "
                    "ON CONFLICT (room_id, contact_id) DO NOTHING", rid, c)
                _pid = (pid or "").strip() or None
                if _pid:
                    # ⚠️ Реф-код РЕЗОЛВИМ, а не пишем сырым из адреса: у слитых
                    # контактов старый код живёт в merged_ref_codes, и без
                    # резолва привлечение не засчитывалось. Вебинар был
                    # единственным местом, где этот шаг пропускали.
                    from app.services.contact_merge import resolve_ref_code
                    _ref, _ = await resolve_ref_code(
                        conn, _pid, client_id=ev["client_id"])
                    from app.services.event_participant import upsert_event_participant
                    await upsert_event_participant(
                        conn, event_id=ev["id"], contact_id=c,
                        referrer_ref_code=(_ref or _pid), finalize=False)
            except Exception:
                pass

        # Блоки зрителю: показываем только те, что менеджер включил вручную (is_pinned),
        # либо те, у кого задан тайминг и текущая минута эфира в него попала.
        # Блок без тайминга и не включённый вручную — зрителю не виден (лежит заготовкой).
        all_blocks = await conn.fetch(
            "SELECT id, kind, title, url, body, form_fields, form_tag, follow_mode, speaker_id, "
            "       is_pinned, show_at_min, hide_at_min, sort_order, reg_event_id, "
            "       tariff_id, product_id "
            "FROM webinar_blocks WHERE room_id=$1 AND is_active=TRUE ORDER BY sort_order, id", rid)

        elapsed_min = None
        if room.get("status") == "live" and room.get("started_at"):
            elapsed_min = (datetime.now(timezone.utc) - room["started_at"]).total_seconds() / 60

        def _visible(b) -> bool:
            if b["is_pinned"]:
                return True
            if elapsed_min is None or b["show_at_min"] is None:
                return False
            if elapsed_min < b["show_at_min"]:
                return False
            if b["hide_at_min"] is not None and elapsed_min > b["hide_at_min"]:
                return False
            return True

        blocks_raw = [b for b in all_blocks if _visible(b)]
        # Раскрываем {plsn_ref}/{ext_ref} в ссылках кнопок — реф-кодом рефовода зрителя.
        blocks = []
        for b in blocks_raw:
            d = dict(b)
            # ⚠️ Ссылку и подпись для блоков «тариф» и «лендинг продукта» собирает
            # БЭКЕНД, а не фронт. Иначе адрес страницы заказа и правило «домен
            # организатора» пришлось бы держать в двух местах, и при смене домена
            # клиента кнопка в эфире молча вела бы не туда.
            if d.get("kind") == "tariff_upgrade":
                if not d.get("tariff_id"):
                    continue          # тариф не выбран или удалён (ON DELETE SET NULL)
                d = await _fill_tariff_block(conn, d, ev["id"])
            elif d.get("kind") == "product_landing":
                if not d.get("product_id"):
                    continue
                d = await _fill_product_block(conn, d, ev["id"], c)
            # ⚠️ Тариф выключен / продукт не опубликован → блок не показываем
            # вовсе: кнопка вела бы зрителя на «страница не найдена» прямо
            # посреди эфира.
            if d.pop("_skip", False):
                continue
            if d.get("url"):
                d["url"] = await _resolve_ref_placeholders(conn, rid, c, d["url"])
            blocks.append(d)

        # текущий спикер по слоту (для авто-кнопки/подарка)
        # Текущий спикер: manual → выбранный ведущим; auto → по таймингу программы.
        if room.get("speaker_mode") == "manual":
            cur_ec = room.get("manual_speaker_ec_id")
        else:
            cur_ec = await ws.current_speaker_ec_id(conn, ev["id"], day)
        follow = await ws.speaker_follow_card(conn, ev["id"], cur_ec)
        gift = await ws.speaker_gift_card(conn, ev["id"], cur_ec)

        # активный опрос / батл
        poll = await conn.fetchrow(
            "SELECT * FROM webinar_polls WHERE room_id=$1 AND status='open' ORDER BY id DESC LIMIT 1", rid)
        poll_out = None
        if poll:
            opts = await conn.fetch("SELECT id, text, votes FROM webinar_poll_options WHERE poll_id=$1 ORDER BY sort_order", poll["id"])
            poll_out = {**dict(poll), "options": [dict(o) for o in opts]}

        battle = await conn.fetchrow(
            "SELECT * FROM webinar_battles WHERE room_id=$1 AND status='live' ORDER BY id DESC LIMIT 1", rid)
        battle_out = None
        if battle:
            pls = await conn.fetch("SELECT id, speaker_id, name, up_count, down_count FROM webinar_battle_players WHERE battle_id=$1 ORDER BY sort_order", battle["id"])
            battle_out = {**dict(battle), "players": [dict(p) for p in pls]}

        # реакции спикерам (счётчики)
        rx = await conn.fetch(
            "SELECT speaker_id, reaction_key, count FROM webinar_speaker_reactions WHERE room_id=$1", rid)

        # ⚠️ HLS отдаём зрителю ТОЛЬКО когда ведущий начал эфир (status='live')
        # И комната открыта. Пока 'ready' — спикер настраивается в Zoom, не показываем.
        room_state = room.get("room_state") or "created"
        is_live = room.get("status") == "live" and room_state == "open"

        # ── Следующий день программы (для экрана «эфир завершён») ──
        # Считаем ТОЙ ЖЕ логикой, что {next_day_mention} в рассылках: следующий
        # НОМЕР дня (day+1), а «завтра/дата» — по разнице дат с текущим днём.
        # Так формулировка на странице и в письме совпадают.
        next_day_info = None
        try:
            _nd = await conn.fetchrow(
                """SELECT d.day_number, d.day_date, d.title,
                          (SELECT cs.start_time FROM conf_sessions cs
                            WHERE cs.event_id = d.event_id AND cs.day = d.day_number
                              AND cs.start_time IS NOT NULL
                            ORDER BY cs.sort_order, cs.start_time LIMIT 1) AS start_time
                     FROM conf_days d
                    WHERE d.event_id = $1 AND d.day_number = $2""",
                ev["id"], day + 1)
            if _nd and _nd["day_date"]:
                _cur = await conn.fetchval(
                    "SELECT day_date FROM conf_days WHERE event_id=$1 AND day_number=$2",
                    ev["id"], day)
                _diff = (_nd["day_date"] - _cur).days if _cur else 999
                _MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
                           "июля", "августа", "сентября", "октября", "ноября", "декабря"]
                _when = "завтра" if _diff == 1 else f"{_nd['day_date'].day} {_MONTHS[_nd['day_date'].month - 1]}"
                _time = str(_nd["start_time"])[:5] if _nd["start_time"] else ""
                next_day_info = {
                    "day_number": _nd["day_number"],
                    "title": _nd["title"],
                    "when": _when,
                    "time": _time,
                    # Готовая фраза — чтобы фронт не собирал её второй раз и
                    # формулировка не разъехалась с рассылками.
                    "mention": (f"Встречаемся {_when} в {_time} МСК на День {_nd['day_number']}."
                                if _time else f"Встречаемся {_when} на День {_nd['day_number']}."),
                }
        except Exception:
            # Нет программы по дням (обычное мероприятие) — просто без блока.
            next_day_info = None

        # Время старта для обратного отсчёта: явное opens_at, иначе старт дня программы
        # (conf_days.day_date + open_time), трактуем как МСК.
        opens_at_iso = room["opens_at"].isoformat() if room.get("opens_at") else None
        if not opens_at_iso:
            drow = await conn.fetchrow(
                "SELECT day_date, open_time FROM conf_days WHERE event_id=$1 AND day_number=$2",
                ev["id"], day)
            if drow and drow["day_date"]:
                # Время старта = начало ПЕРВОГО слота дня (conf_sessions.start_time),
                # иначе open_time дня, иначе 10:00. Всё трактуем как МСК.
                first_slot = await conn.fetchval(
                    "SELECT start_time FROM conf_sessions WHERE event_id=$1 AND day=$2 "
                    "AND start_time IS NOT NULL AND start_time <> '' "
                    "ORDER BY start_time, sort_order, id LIMIT 1", ev["id"], day)
                t = ((first_slot or drow["open_time"] or "10:00") or "10:00")[:5]
                try:
                    hh, mm = t.split(":")
                    opens_at_iso = f"{drow['day_date'].isoformat()}T{int(hh):02d}:{int(mm):02d}:00+03:00"
                except Exception:
                    opens_at_iso = f"{drow['day_date'].isoformat()}T10:00:00+03:00"

        # бренд клиента для шапки комнаты (как в Mini App: логотип + название)
        # ⚠️ `timezone` берём здесь же: время сообщений чата показываем в
        # поясе ОРГАНИЗАТОРА (23.09.2026), а не зрителя. Эфир идёт по его
        # расписанию — «в 19:00» в анонсе и время в чате должны совпадать,
        # иначе зритель из другого пояса видит разнобой.
        brand = await conn.fetchrow(
            "SELECT COALESCE(NULLIF(brand_name,''), name) AS brand_name, brand_logo_url, "
            "       NULLIF(TRIM(timezone), '') AS timezone "
            "FROM clients WHERE id=$1", ev["client_id"])

        # Афиша-заставка до эфира: сначала афиша ЭТОГО дня, иначе общая афиша
        # события (горизонтальная в приоритете) — правило проекта (миграция 215).
        poster = await conn.fetchval(
            "SELECT url FROM event_posters WHERE event_id=$1 AND day=$2 "
            " ORDER BY CASE orientation WHEN 'horizontal' THEN 1 WHEN 'square' THEN 2 "
            "                           WHEN 'vertical' THEN 3 ELSE 4 END, sort, id LIMIT 1",
            ev["id"], day,
        )
        if not poster:
            poster = await conn.fetchval(
                "SELECT url FROM event_posters WHERE event_id=$1 AND day IS NULL "
                " ORDER BY CASE orientation WHEN 'horizontal' THEN 1 WHEN 'square' THEN 2 "
                "                           WHEN 'vertical' THEN 3 ELSE 4 END, sort, id LIMIT 1",
                ev["id"],
            )

        # Есть ли регистрация у опознанного (по куке ?c=) зрителя на этот вебинар.
        # Если статистику обнулили — регистрации нет → фронт покажет форму заново
        # (иначе кука пускала бы «фантома», которого нет в списке зрителей).
        has_registration = False
        if c:
            has_registration = bool(await conn.fetchval(
                "SELECT 1 FROM webinar_registrations WHERE room_id=$1 AND contact_id=$2 LIMIT 1", rid, c))

        return {
            "event": {"id": ev["id"], "title": ev["title"], "slug": ev["slug"], "client_id": ev["client_id"]},
            "brand": {
                "name": brand["brand_name"] if brand else None,
                "logo_url": brand["brand_logo_url"] if brand else None,
                # Пояс организатора для показа времени в чате.
                # Не задан → фронт возьмёт московское.
                "timezone": (brand["timezone"] if brand else None) or "Europe/Moscow",
            },
            "has_registration": has_registration,
            "poster_url": poster,   # заставка до начала эфира
            "room": {
                "id": rid,
                "title": room.get("title"),
                "status": room.get("status"),
                "stream_type": room.get("stream_type"),
                "hls_url": room.get("hls_url") if is_live else None,
                "external_url": room.get("external_url"),
                # автовебинар: запись + с какой секунды её включить зрителю
                **(await _auto_payload(conn, room, c) if room.get("stream_type") == "auto" else {}),
                "hide_viewer_count": room.get("hide_viewer_count"),
                "chat_enabled": room.get("chat_enabled"),
                # Зрителю нужен, чтобы предупредить о запрете ДО отправки,
                # а не отказом после набранного сообщения.
                "block_links": room.get("block_links"),
                "chat_input_on_top": room.get("chat_input_on_top"),
                "one_vote_per_person": room.get("one_vote_per_person"),
                # Организатор, открывший комнату в браузере с залогиненным
                # кабинетом, получает кнопки модерации прямо в чате.
                "is_moderator": is_mod,
                "premoderation": room.get("premoderation"),
                "redirect_url": (room.get("redirect_url") or "").strip() or None,
                # Экран «эфир завершён» (миграция 441). Кнопка и автопереход
                # ведут на тот же redirect_url.
                "outro_offer_text": (room.get("outro_offer_text") or "").strip() or None,
                "outro_button_label": (room.get("outro_button_label") or "").strip() or None,
                "outro_redirect_sec": room.get("outro_redirect_sec"),
                # Следующий день программы — чтобы пришедший после эфира узнал,
                # когда встречаемся снова. Нет следующего дня → None, блок скрыт.
                "next_day": next_day_info,
                "reaction_up_label": room.get("reaction_up_label"),
                "reaction_down_label": room.get("reaction_down_label"),
                "show_up_reaction": room.get("show_up_reaction"),
                "show_down_reaction": room.get("show_down_reaction"),
                "intro_text": room.get("intro_text"),
                "buttons_per_row": room.get("buttons_per_row") or 1,
                "auth_mode": room.get("auth_mode") or "auto",
                "auth_require_name": room.get("auth_require_name"),
                "auth_require_email": room.get("auth_require_email"),
                "auth_require_phone": room.get("auth_require_phone"),
                "auth_require_tg": room.get("auth_require_tg"),
                "auth_intro_text": room.get("auth_intro_text"),
                "room_state": room_state,        # created | open | closed
                "opens_at": opens_at_iso,         # для обратного отсчёта на странице
            },
            "blocks": blocks,
            "current_speaker": follow,
            "current_gift": gift,
            "poll": poll_out,
            "battle": battle_out,
            "speaker_reactions": [dict(r) for r in rx],
            # ⚠️ ОРГАНИЗАТОРУ И ЕГО ПОМОЩНИКУ число зрителей видно ВСЕГДА
            # (24.09.2026). «Скрывать число зрителей» — настройка про
            # ЗРИТЕЛЕЙ: пустой зал не должен смущать пришедших. Ведущему же
            # эта цифра нужна именно в эфире, и прятать её от него — значит
            # лишать его единственного способа понять, сколько людей в зале.
            # ⚠️ Считаем ВСЕГДА, независимо от настройки: данные пишутся в
            # webinar_presence в любом случае, скрывается только показ.
            "online": (await _online_now(conn, rid)
                       if (is_mod or not room.get("hide_viewer_count")) else None),
        }


async def _online_now(conn, room_id: int) -> int:
    """Сколько зрителей онлайн СЕЙЧАС — по heartbeat за последние 2 минуты.
    Надёжнее числа живых сокетов: переживает переподключения и разные процессы."""
    n = await conn.fetchval(
        "SELECT COUNT(DISTINCT COALESCE(contact_id::text, session_key)) "
        "FROM webinar_presence WHERE room_id=$1 AND bucket_at >= NOW() - INTERVAL '2 minutes'",
        room_id,
    )
    return n or 0


# ─────────────────────────── heartbeat присутствия ───────────────────────────
class Heartbeat(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    device: Optional[str] = None


@router.post("/{slug}/{day}/heartbeat", summary="Пинг присутствия (раз в минуту)")
async def heartbeat(slug: str, day: int, body: Heartbeat):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        # ⚠️ Присутствие пишем ТОЛЬКО: (1) опознанного зрителя (contact_id — анонимов
        # нет) И (2) когда комната ОТКРЫТА (room_state='open'). До открытия (created)
        # и после закрытия (closed) heartbeat не пишем — иначе аналитика «уникальных»
        # расходится со списком зрителей (тот пишется тоже только при open).
        if body.contact_id and (room.get("room_state") or "created") == "open":
            await conn.execute(
                "INSERT INTO webinar_presence (room_id, contact_id, session_key, bucket_at, device, session_id) "
                "VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
                rid, body.contact_id, body.session_key, now, body.device, room.get("current_session_id"),
            )
        online = await _online_now(conn, rid)
    # живой счётчик всем в комнате (если не скрыт)
    if not room.get("hide_viewer_count"):
        await hub.publish(rid, {"type": "online", "count": online})
    return {"ok": True, "online": online}


# ─────────────────────────── чат ───────────────────────────
class ChatIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    author_name: Optional[str] = None
    text: str
    # Токен кабинета, если комнату открыл организатор: он один может слать
    # ссылки при включённом запрете. Необязателен — у зрителя его нет.
    token: Optional[str] = None


@router.post("/{slug}/{day}/chat", summary="Отправить сообщение в чат")
async def chat_send(slug: str, day: int, body: ChatIn):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        if not room.get("chat_enabled"):
            raise HTTPException(403, "Чат отключён")
        if await _is_banned(conn, rid, body.contact_id, body.session_key):
            raise HTTPException(403, "Вы удалены из чата")
        text = (body.text or "").strip()
        if not text:
            raise HTTPException(400, "Пустое сообщение")

        # ⚠️ Запрет ссылок НЕ действует на организаторов и их помощников: их
        # ссылки — часть эфира (оплата, материалы).
        #
        # ⚠️⚠️ ССЫЛКУ ВЫРЕЗАЕМ, А НЕ ОТКЛОНЯЕМ ВСЁ СООБЩЕНИЕ (23.09.2026).
        # Раньше сообщение отвергалось целиком: человек писал вопрос, в котором
        # мимоходом упомянул адрес, получал отказ и решал, что чат сломан —
        # и слал снова. Теперь мысль доходит до эфира, а адрес заменяется на
        # «<ссылка скрыта>»: и правило соблюдено, и разговор не оборван.
        if room.get("block_links") and has_link(text):
            if not await _is_room_moderator(conn, room, body.token):
                text = strip_links(text)
                # Осталась одна пометка и ничего больше — сообщение было
                # голой ссылкой. Такое в эфир не пускаем: смысла в нём нет.
                if text.replace(LINK_HIDDEN, "").strip() == "":
                    who = (body.author_name or "").strip()
                    if not who and body.contact_id:
                        who = await conn.fetchval(
                            "SELECT NULLIF(TRIM(name), '') FROM contacts WHERE id = $1",
                            body.contact_id) or ""
                    prefix = f"{who}! " if who else ""
                    raise HTTPException(
                        403, f"{prefix}Ссылки в чате запрещены правилами вебинара")

        status = "premod" if room.get("premoderation") else "visible"
        # Имя автора: из формы; если пусто, но зритель опознан — берём имя контакта из БД
        # (иначе авторизованный человек светился бы «Гостём»).
        author_name = (body.author_name or "").strip() or None
        if not author_name and body.contact_id:
            author_name = await conn.fetchval(
                "SELECT NULLIF(TRIM(name), '') FROM contacts WHERE id = $1", body.contact_id
            )
        # session_id — чат привязан к текущему запуску эфира: после перезапуска
        # чат новый, а история каждого запуска остаётся с записью этой сессии.
        row = await conn.fetchrow(
            "INSERT INTO webinar_chat_messages (room_id, contact_id, author_name, text, status, session_id) "
            "VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, at",
            rid, body.contact_id, author_name, text, status, room.get("current_session_id"),
        )
        # активность по зрителю
        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, session_id) VALUES ($1,$2,$3,'chat_msg',$4)",
            rid, body.contact_id, body.session_key, room.get("current_session_id"),
        )
    msg = {
        "type": "chat", "id": row["id"], "text": text, "author_name": author_name,
        "contact_id": body.contact_id, "at": row["at"].isoformat(), "status": status,
    }
    if status == "visible":
        await hub.publish(rid, msg)
    return {"ok": True, "id": row["id"], "status": status}


@router.get("/{slug}/{day}/chat", summary="История чата (только текущего запуска)")
async def chat_history(slug: str, day: int, limit: int = Query(100, le=300)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        cur_sid = room.get("current_session_id")
        cleared = room.get("chat_cleared_at")
        if cur_sid:
            # Эфир идёт — сообщения текущего запуска ПЛЮС те, что написали до
            # его старта (они лежат с session_id IS NULL: в момент отправки
            # запуска ещё не было, и проставить его было нечем).
            #
            # ⚠️ Без второй половины условия сообщения, написанные до кнопки
            # «Начать эфир», пропадали у ВСЕХ, кто открыл страницу после старта
            # (19.09.2026, живой эфир iViSiON-9): автор видел их у себя, потому
            # что они пришли ему по WebSocket и остались в памяти вкладки, — а
            # новая вкладка грузит историю с нуля и получала пустой чат. Люди
            # успевают написать до начала почти всегда: ссылку открывают заранее.
            #
            # ⚠️ Отсекаем по `chat_cleared_at` ровно как в ветке «эфир не идёт»:
            # иначе «Начать заново» очищал бы чат только до старта эфира, а
            # после старта сброшенные сообщения возвращались бы.
            rows = await conn.fetch(
                "SELECT id, contact_id, author_name, text, at FROM webinar_chat_messages "
                "WHERE room_id=$1 AND status='visible' "
                "  AND (session_id=$2 OR (session_id IS NULL "
                "       AND ($4::timestamptz IS NULL OR at > $4))) "
                "ORDER BY at DESC LIMIT $3", room["id"], cur_sid, limit, cleared)
        else:
            # эфир не идёт (состояние b/created) — живой чат = сообщения без session_id,
            # но только НОВЕЕ момента последнего сброса (reset/close). После «Начать
            # заново» chat_cleared_at=NOW() → старый чат исчезает, история цела в БД.
            rows = await conn.fetch(
                "SELECT id, contact_id, author_name, text, at FROM webinar_chat_messages "
                "WHERE room_id=$1 AND status='visible' AND session_id IS NULL "
                "  AND ($3::timestamptz IS NULL OR at > $3) "
                "ORDER BY at DESC LIMIT $2", room["id"], limit, cleared)
        items = [dict(r) for r in reversed(rows)]
    return {"messages": items}


# ─────────────────────────── реакции по спикерам ───────────────────────────
class ReactIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    speaker_id: int                      # event_collaborators.id
    reaction: str                        # up | down


@router.post("/{slug}/{day}/react", summary="👍/👎 спикеру")
async def react(slug: str, day: int, body: ReactIn):
    if body.reaction not in ("up", "down"):
        raise HTTPException(400, "reaction: up|down")
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        # ⚠️ Проверка на СЕРВЕРЕ, а не только скрытой кнопкой: запрос
        # повторяется мимо интерфейса, и выключенная реакция всё равно
        # накручивалась бы. Для «Огня» такой проверки не было вовсе
        # (23.09.2026) — выключателя у него тоже не было.
        if body.reaction == "down" and not room.get("show_down_reaction"):
            raise HTTPException(403, "Отрицательная реакция отключена")
        if body.reaction == "up" and room.get("show_up_reaction") is False:
            raise HTTPException(403, "Положительная реакция отключена")
        if await _is_banned(conn, rid, body.contact_id, body.session_key):
            raise HTTPException(403, "Вы удалены из эфира")

        # Один голос на человека, если включена настройка (миграция 471).
        if room.get("one_vote_per_person"):
            ok = await _remember_vote(conn, room, "speaker", body.speaker_id,
                                      body.contact_id, body.session_key, body.reaction)
            if not ok:
                # ⚠️ Отдаём текущий счёт, а не голый отказ: фронт рисует цифру
                # из ответа, и без неё она «прыгнула» бы у нажавшего повторно.
                cur = await conn.fetchval(
                    "SELECT count FROM webinar_speaker_reactions "
                    " WHERE room_id=$1 AND speaker_id=$2 AND reaction_key=$3",
                    rid, body.speaker_id, body.reaction) or 0
                return {"ok": False, "already": True, "count": cur,
                        "message": "Вы уже голосовали"}

        cnt = await conn.fetchval(
            "INSERT INTO webinar_speaker_reactions (room_id, speaker_id, reaction_key, count) "
            "VALUES ($1,$2,$3,1) ON CONFLICT (room_id, speaker_id, reaction_key) "
            "DO UPDATE SET count = webinar_speaker_reactions.count + 1 RETURNING count",
            rid, body.speaker_id, body.reaction,
        )
        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, value, session_id) "
            "VALUES ($1,$2,$3,'reaction','speaker',$4,$5,$6)",
            rid, body.contact_id, body.session_key, body.speaker_id, body.reaction, room.get("current_session_id"),
        )
    await hub.publish(rid, {"type": "reaction", "speaker_id": body.speaker_id, "reaction": body.reaction, "count": cnt})
    return {"ok": True, "count": cnt}


# ─────────────────────────── батл-голос ───────────────────────────
class BattleVoteIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    player_id: int
    reaction: str                        # up | down


@router.post("/{slug}/{day}/battle/{battle_id}/vote", summary="Голос в батле")
async def battle_vote(slug: str, day: int, battle_id: int, body: BattleVoteIn):
    if body.reaction not in ("up", "down"):
        raise HTTPException(400, "reaction: up|down")
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        b = await conn.fetchrow("SELECT show_up_reaction, show_down_reaction FROM webinar_battles WHERE id=$1 AND room_id=$2 AND status='live'", battle_id, rid)
        if not b:
            raise HTTPException(404, "Батл не активен")
        if body.reaction == "down" and not b["show_down_reaction"]:
            raise HTTPException(403, "Отрицательная реакция отключена")
        if body.reaction == "up" and b["show_up_reaction"] is False:
            raise HTTPException(403, "Положительная реакция отключена")
        # ⚠️ Батлы от накрутки защищены ВСЕГДА, независимо от настройки
        # `one_vote_per_person`: голоса лежат строками в webinar_battle_votes
        # с уникальностью по (игрок, зритель), а счётчики пересчитываются
        # подсчётом строк — прибавления «+1 на нажатие» здесь нет в принципе.
        # Повторное нажатие МЕНЯЕТ свой голос, а не добавляет новый.
        # Накрутка была только у реакций спикерам (там был count+1) — чинится
        # настройкой выше.
        await conn.execute(
            "INSERT INTO webinar_battle_votes (battle_id, player_id, contact_id, session_key, reaction_key) "
            "VALUES ($1,$2,$3,$4,$5) ON CONFLICT (player_id, COALESCE(contact_id,0), COALESCE(session_key,'')) "
            "DO UPDATE SET reaction_key=EXCLUDED.reaction_key, at=NOW()",
            battle_id, body.player_id, body.contact_id, body.session_key, body.reaction,
        )
        # пересчёт счётчиков игрока
        up = await conn.fetchval("SELECT COUNT(*) FROM webinar_battle_votes WHERE player_id=$1 AND reaction_key='up'", body.player_id)
        down = await conn.fetchval("SELECT COUNT(*) FROM webinar_battle_votes WHERE player_id=$1 AND reaction_key='down'", body.player_id)
        await conn.execute("UPDATE webinar_battle_players SET up_count=$1, down_count=$2 WHERE id=$3", up, down, body.player_id)
        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, value, session_id) "
            "VALUES ($1,$2,$3,'reaction','battle_player',$4,$5,$6)",
            rid, body.contact_id, body.session_key, body.player_id, body.reaction, room.get("current_session_id"),
        )
    await hub.publish(rid, {"type": "battle_vote", "player_id": body.player_id, "up": up, "down": down})
    return {"ok": True, "up": up, "down": down}


# ─────────────────────────── опрос-голос ───────────────────────────
class PollVoteIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    option_id: int


@router.post("/{slug}/{day}/poll/{poll_id}/vote", summary="Голос в опросе")
async def poll_vote(slug: str, day: int, poll_id: int, body: PollVoteIn):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        poll = await conn.fetchrow("SELECT 1 FROM webinar_polls WHERE id=$1 AND room_id=$2 AND status='open'", poll_id, rid)
        if not poll:
            raise HTTPException(404, "Опрос не активен")
        inserted = await conn.fetchrow(
            "INSERT INTO webinar_poll_votes (poll_id, option_id, contact_id, session_key) "
            "VALUES ($1,$2,$3,$4) ON CONFLICT (poll_id, COALESCE(contact_id,0), COALESCE(session_key,'')) "
            "DO NOTHING RETURNING id",
            poll_id, body.option_id, body.contact_id, body.session_key,
        )
        if inserted:
            await conn.execute("UPDATE webinar_poll_options SET votes=votes+1 WHERE id=$1", body.option_id)
            await conn.execute(
                "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, session_id) "
                "VALUES ($1,$2,$3,'poll_vote','poll_option',$4,$5)",
                rid, body.contact_id, body.session_key, body.option_id, room.get("current_session_id"),
            )
        opts = await conn.fetch("SELECT id, text, votes FROM webinar_poll_options WHERE poll_id=$1 ORDER BY sort_order", poll_id)
    await hub.publish(rid, {"type": "poll_update", "poll_id": poll_id, "options": [dict(o) for o in opts]})
    return {"ok": True, "options": [dict(o) for o in opts]}


# ─────────────────────────── клик по продающей кнопке ───────────────────────────
class TrackIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    block_id: Optional[int] = None
    kind: str = "click"                  # click | order | payment


@router.post("/{slug}/{day}/track", summary="Клик/заказ/оплата по продающему блоку")
async def track(slug: str, day: int, body: TrackIn):
    if body.kind not in ("click", "order", "payment"):
        raise HTTPException(400, "kind: click|order|payment")
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, session_id) "
            "VALUES ($1,$2,$3,$4,'block',$5,$6)",
            room["id"], body.contact_id, body.session_key, body.kind, body.block_id, room.get("current_session_id"),
        )
    return {"ok": True}


# ─────────────────────────── умная форма заявки / регистрация ───────────────────────────
class FormIn(BaseModel):
    contact_id: Optional[int] = None     # известный зритель → заявка в один тап
    session_key: Optional[str] = None
    # поля для нового контакта (неизвестный зритель):
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None


@router.post("/{slug}/{day}/form/{block_id}", summary="Умная форма заявки (известный → 1 тап, новый → контакт)")
async def form_submit(slug: str, day: int, block_id: int, body: FormIn):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid, ev = room["id"], room["_event"]
        client_id = ev["client_id"]
        block = await conn.fetchrow("SELECT form_tag FROM webinar_blocks WHERE id=$1 AND room_id=$2", block_id, rid)
        if not block:
            raise HTTPException(404, "Блок не найден")

        contact_id = body.contact_id
        if not contact_id:
            # неизвестный — создаём/находим контакт по данным формы
            if not (body.name or body.email or body.phone or body.telegram_username):
                raise HTTPException(400, "Заполните имя и хотя бы один контакт")
            contact_id, _ = await find_or_create_contact(
                conn, client_id=client_id,
                name=body.name, email=body.email, phone=body.phone,
                lookup_telegram_username=body.telegram_username,
            )
        if not contact_id:
            raise HTTPException(400, "Не удалось определить контакт")

        # тег формы = «группа» GetCourse
        if block["form_tag"]:
            await ws.tag_contact(conn, client_id, contact_id, block["form_tag"])

        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, session_id) "
            "VALUES ($1,$2,$3,'form_submit','block',$4,$5)",
            rid, contact_id, body.session_key, block_id, room.get("current_session_id"),
        )
    return {"ok": True, "contact_id": contact_id}


class RegisterIn(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None
    tg_id: Optional[int] = None            # из Mini App/бота — опознание без формы
    pid: Optional[str] = None              # реф-код рефовода (как в реф-программе)
    utm_source: Optional[str] = None
    chosen_contact_id: Optional[int] = None  # зритель выбрал контакт на экране «Это вы?»
    force_new: Optional[bool] = None         # зритель нажал «Это новый человек»
    consent_pd: Optional[bool] = None        # согласие на обработку ПД (обязательно)
    consent_marketing: Optional[bool] = None # согласие на рекламу (опционально)
    policy_version: Optional[int] = None


# ⚠️ Поиск кандидатов «Это вы?» и маскировка живут в contact_merge — общем
# доме всего, что касается опознания человека. Здесь только псевдонимы, чтобы
# не переписывать вызовы ниже.
from app.services.contact_merge import (  # noqa: E402
    find_contact_candidates as _find_contact_candidates,
    mask_email as _mask_email,
    mask_phone as _mask_phone,
)


@router.post("/{slug}/{day}/register", summary="Авторизация зрителя (форма перед эфиром)")
async def register(slug: str, day: int, body: RegisterIn):
    """Форма авторизации: находит/создаёт контакт по tg_id/email/phone/нику.
    При нескольких совпадениях — возвращает список на выбор («Это вы?»).
    Учитывает реф-код (pid) и UTM. Помечает контакт «был в эфире»."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid, ev = room["id"], room["_event"]
        client_id = ev["client_id"]

        contact_id = None
        # 0) зритель уже выбрал контакт на экране «Это вы?»
        if body.chosen_contact_id:
            chk = await conn.fetchval(
                "SELECT id FROM contacts WHERE id=$1 AND client_id=$2 AND is_active=TRUE",
                body.chosen_contact_id, client_id)
            contact_id = chk
        # 1) известный tg_id (Mini App/бот) — доказанная идентичность
        entry_contact_id = None
        if not contact_id and body.tg_id:
            from app.services.contact_merge import upsert_contact_with_identity
            res = await upsert_contact_with_identity(
                conn, client_id=client_id, platform_slug="telegram",
                platform_user_id=str(body.tg_id), username=body.telegram_username,
                first_name=body.name, utm_source=body.utm_source,
            )
            entry_contact_id = res[0] if isinstance(res, (tuple, list)) else res
        # 1.5) если не форсим новый и не выбран — проверяем неоднозначность
        if not contact_id and not body.force_new:
            # ⚠️ Общее правило — resolve_or_ask в contact_merge. Email и ники
            # площадок уникальны, поэтому по ним берём контакт сразу; спор
            # возникает, только если они указывают на разных людей или
            # совпал один телефон (он не уникален).
            #
            # ⚠️ Проверка идёт И при известном tg_id: зашедший из Mini App мог
            # вписать почту или ник ДРУГОГО своего аккаунта. Контакт входа
            # передаём кандидатом — тогда человек видит в списке и себя
            # нынешнего, а не только то, что набрал руками.
            from app.services.contact_merge import resolve_or_ask
            found, cands, can_new = await resolve_or_ask(
                conn, client_id, body.email, body.phone, body.telegram_username,
                known_contact_id=entry_contact_id)
            if cands:
                return {"ok": False, "need_choice": True,
                        "candidates": cands, "can_create_new": can_new}
            if found:
                contact_id = found
        # Ничего спорного — остаёмся на контакте входа.
        if not contact_id:
            contact_id = entry_contact_id
        # 2) иначе — по данным формы (0 или 1 совпадение → авто)
        if not contact_id:
            # ⚠️ БЕЗ КЛЮЧА КОНТАКТ НЕ ЗАВОДИМ (2026-09-03). Раньше хватало одного
            # имени — и каждый заход «Ивана» плодил новый контакт, который потом
            # не найти ничем: ни почты, ни телефона, ни аккаунта площадки.
            # Человек без единого способа связи в базе не нужен; смотреть эфир
            # это ему не мешает (комната открывается и без опознания).
            if not (body.email or body.phone or body.telegram_username):
                raise HTTPException(
                    400, "Оставьте почту, телефон или ник в Telegram — "
                         "иначе мы не сможем прислать вам запись и материалы")
            if body.force_new:
                # ⚠️ «Это новый участник»: зритель посмотрел найденные записи
                # и сказал, что это не он. find_or_create_contact снова нашёл
                # бы старый контакт по email — его выбор был бы проигнорирован.
                from app.services.contact_merge import create_new_contact
                contact_id = await create_new_contact(
                    conn, client_id=client_id, name=body.name,
                    email=body.email, phone=body.phone,
                    utm_source=body.utm_source,
                )
            else:
                contact_id, _ = await find_or_create_contact(
                    conn, client_id=client_id,
                    name=body.name, email=body.email, phone=body.phone,
                    utm_source=body.utm_source,
                    lookup_telegram_username=body.telegram_username,
                )
        if not contact_id:
            raise HTTPException(400, "Заполните имя и хотя бы один контакт")

        # TG-ник из формы → сохраняем идентичность (иначе ник терялся). Единый механизм
        # коллабов (_upsert_personal_identity): резолвит @ник→числовой id через getChat
        # ботом клиента; не вышло (в бот не заходил) → псевдо-запись platform_user_id='@ник',
        # которая дорастёт до реального id при первом заходе в бот. contact_id есть всегда.
        _tgun = (body.telegram_username or "").strip().lstrip("@")
        if _tgun and not body.tg_id:
            try:
                has_tg = await conn.fetchval(
                    "SELECT 1 FROM platform_users WHERE contact_id=$1 AND platform_slug='telegram' LIMIT 1",
                    contact_id)
                if not has_tg:
                    from app.api.collaborators import _upsert_personal_identity
                    await _upsert_personal_identity(conn, client_id, contact_id, "telegram", None, _tgun)
            except Exception:
                pass

        # Согласия (152-ФЗ) — фиксируем дату/версию политики на контакте.
        # consent_pd обязательна на фронте; тут просто пишем факт, если пришла.
        if body.consent_pd is True:
            await conn.execute(
                "UPDATE contacts SET consent_pd_at = COALESCE(consent_pd_at, NOW()), "
                "consent_pd_policy_ver = COALESCE(consent_pd_policy_ver, $2) WHERE id=$1",
                contact_id, body.policy_version or 0)
        if body.consent_marketing is True:
            await conn.execute(
                "UPDATE contacts SET consent_marketing_at = COALESCE(consent_marketing_at, NOW()), "
                "consent_marketing_policy_ver = COALESCE(consent_marketing_policy_ver, $2) WHERE id=$1",
                contact_id, body.policy_version or 0)

        # реф-код рефовода (как в реф-программе события) — привязываем, если ещё не задан
        if body.pid:
            try:
                await conn.execute(
                    "UPDATE contacts SET first_referrer_contact_id = COALESCE(first_referrer_contact_id, "
                    "(SELECT id FROM contacts WHERE ref_code=$2 AND client_id=$3 LIMIT 1)) "
                    "WHERE id=$1 AND id <> (SELECT id FROM contacts WHERE ref_code=$2 AND client_id=$3 LIMIT 1)",
                    contact_id, body.pid, client_id)
            except Exception:
                pass

        # Зритель = участник события. Заводим/обновляем event_participants (там живёт
        # реф-код рефовода). pid → referrer_ref_code участия, если ещё не задан.
        # ⚠️ Реф-код резолвим, а не пишем сырым (merged_ref_codes у слитых).
        _ref = None
        if body.pid:
            from app.services.contact_merge import resolve_ref_code
            _ref, _ = await resolve_ref_code(conn, body.pid, client_id=client_id)
        from app.services.event_participant import upsert_event_participant
        await upsert_event_participant(
            conn, event_id=ev["id"], contact_id=contact_id,
            referrer_ref_code=(_ref or body.pid or None), finalize=False)
        # Связка зритель × комната дня (без реф-кода — он в event_participants).
        await conn.execute(
            "INSERT INTO webinar_registrations (room_id, contact_id) VALUES ($1,$2) "
            "ON CONFLICT (room_id, contact_id) DO NOTHING",
            rid, contact_id)
        await conn.execute("UPDATE contacts SET was_in_webinar=TRUE WHERE id=$1", contact_id)
        await ws.tag_contact(conn, client_id, contact_id, f"webinar:{ev['slug']}:{day}")
    return {"ok": True, "contact_id": contact_id}


class RegEventIn(BaseModel):
    contact_id: int
    block_id: int


@router.post("/{slug}/{day}/register-event", summary="Кнопка «Регистрация на событие» в вебинаре")
async def register_event(slug: str, day: int, body: RegEventIn):
    """Продающий блок `event_reg`: зритель (у него уже есть contact_id) жмёт кнопку →
    СРАЗУ регистрируем его на выбранное блоком событие (reg_event_id). Дальше:
      • есть реальная идентичность в боте клиента (числовой platform_user_id) →
        бот шлёт «вы зарегистрированы» + меню; ответ {delivered:'bot', platform}.
      • нет ни одной → страница «Выберите удобный мессенджер» с deeplink-кнопками
        площадок клиента (evreg_<event_id>_ct<contact_id>) — бот при заходе доцепит
        platform_users по РЕАЛЬНОМУ bot user_id и подтвердит; ответ {delivered:'choose'}.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid, ev = room["id"], room["_event"]
        client_id = ev["client_id"]

        # блок и его reg_event_id
        blk = await conn.fetchrow(
            "SELECT reg_event_id FROM webinar_blocks WHERE id=$1 AND room_id=$2 AND kind='event_reg'",
            body.block_id, rid)
        if not blk or not blk["reg_event_id"]:
            raise HTTPException(400, "Блок регистрации не настроен")
        target_event_id = blk["reg_event_id"]

        # контакт принадлежит клиенту события
        chk = await conn.fetchval(
            "SELECT id FROM contacts WHERE id=$1 AND client_id=$2 AND is_active=TRUE",
            body.contact_id, client_id)
        if not chk:
            raise HTTPException(400, "Контакт не найден")
        contact_id = body.contact_id

        # целевое событие — название для сообщений
        tgt = await conn.fetchrow(
            "SELECT id, title, slug FROM events WHERE id=$1", target_event_id)
        if not tgt:
            raise HTTPException(404, "Событие не найдено")

        # РЕГИСТРАЦИЯ сразу (контакты есть — форма не нужна)
        from app.services.event_participant import upsert_event_participant
        await upsert_event_participant(
            conn, event_id=target_event_id, contact_id=contact_id,
            is_registered=True)

        # есть ли реальная (числовая) идентичность в боте клиента? Порядок TG→MAX→VK.
        ident = await conn.fetchrow(
            """SELECT pu.platform_slug, pu.platform_user_id
                 FROM platform_users pu
                 JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE pu.contact_id=$1 AND c_own.client_id=$2
                  AND pu.platform_slug IN ('telegram','max','vk')
                  AND pu.platform_user_id ~ '^[0-9]+$'
                ORDER BY CASE pu.platform_slug WHEN 'telegram' THEN 1 WHEN 'max' THEN 2 ELSE 3 END
                LIMIT 1""",
            contact_id, client_id)

        # Сразу пушим в бот, если есть реальный TG-аккаунт (у нас polling-бот TG).
        if ident and ident["platform_slug"] == "telegram":
            try:
                from app.services.channels import get_client_telegram_token
                token = await get_client_telegram_token(client_id, conn)
                if token:
                    import httpx
                    from app.services.message_builder import send_telegram_message
                    from app.services.share_links import get_client_bot_handles
                    handles = await get_client_bot_handles(conn, client_id)
                    tg_handle = (handles.get("telegram") or "").lstrip('@')
                    menu_url = f"https://t.me/{tg_handle}?start=menu{target_event_id}" if tg_handle else None
                    txt = (f"✅ Вы зарегистрированы на «{tgt['title']}»!\n\n"
                           "Мы сохранили ваше участие. Ниже — меню события: программа, "
                           "подарки и ссылка на эфир.")
                    btns = [{"text": "Открыть событие", "url": menu_url}] if menu_url else None
                    async with httpx.AsyncClient(timeout=15) as _hc:
                        await send_telegram_message(
                            _hc, token, ident["platform_user_id"], txt,
                            buttons=btns)
                    return {"ok": True, "delivered": "bot", "platform": "telegram",
                            "event_title": tgt["title"]}
            except Exception as e:
                import logging; logging.getLogger(__name__).warning(f"reg-event bot send failed: {e}")

        # Нет реального TG (или отправка не удалась) — страница «Выберите мессенджер».
        # ⚠️ Кнопки площадок строит ОБЩИЙ хелпер (2026-08-28) — тот же, что на
        # экране после веб-регистрации. Своя копия здесь уже была и жила
        # отдельно: домен TG зашит литералом мимо TG_DOMAIN, площадки события
        # (disabled_platforms) не учитывались.
        from app.services.share_links import build_event_reg_bot_links
        from app.services.event_platforms import enabled_platforms
        platforms = await build_event_reg_bot_links(
            conn, client_ids=client_id, event_id=target_event_id,
            contact_id=contact_id,
            enabled=await enabled_platforms(conn, target_event_id),
        )
        return {"ok": True, "delivered": "choose", "event_title": tgt["title"],
                "platforms": platforms}


# ─────────────────────────── WebSocket ───────────────────────────
@ws_router.websocket("/ws/webinar/{slug}/{day}")
async def webinar_ws(websocket: WebSocket, slug: str, day: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            room = await _load_room(conn, slug, day)
        except HTTPException:
            await websocket.close(code=4404)
            return
    rid = room["id"]
    await websocket.accept()
    await hub.connect(rid, websocket)
    try:
        # держим соединение; клиент только слушает (пинги для keepalive)
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(rid, websocket)
