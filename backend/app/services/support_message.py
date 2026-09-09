"""
Единое сообщение службы поддержки клиента.

Используется ВЕЗДЕ, где раньше подставлялся одиночный work_tg_username:
команда /support во всех ботах (TG/VK/MAX), кнопка «Тех. поддержка» в меню
события и на странице регистрации, ответы ботов на свободный текст.

Поля клиента (clients):
  work_tg_username — Telegram. Вводится ССЫЛКОЙ (https://t.me/...), но старые
                     значения-ники (@name / name) тоже поддерживаются.
  work_vk          — ВКонтакте (ссылка).
  work_max         — MAX (ссылка).

Формат сообщения (только заполненные строки, между ними пустая строка):

  Возникли вопросы? Напишите нам в любой удобный вам мессенджер:

  ВКонтакте: <ссылка>

  Телеграм: <ссылка>

  MAX: <ссылка>
"""
import html as _html
import re
from app.services.share_links import TG_DOMAIN

SUPPORT_INTRO = "Возникли вопросы? Напишите нам в любой удобный вам мессенджер:"


def tg_support_link(raw):
    """work_tg_username → ссылка https://t.me/... Принимает уже-ссылку, @ник, ник."""
    s = (raw or "").strip()
    if not s:
        return ""
    if s.startswith("http://") or s.startswith("https://"):
        return s
    if "t.me/" in s:
        return "https://" + s[s.index("t.me/"):]
    handle = s.lstrip("@").strip()
    return f"https://{TG_DOMAIN}/{handle}" if handle else ""


def _norm_url(raw):
    """ВК/MAX — берём как ссылку. Голый домен без схемы → добавляем https://."""
    s = (raw or "").strip()
    if not s:
        return ""
    if s.startswith("http://") or s.startswith("https://"):
        return s
    # vk.com/... / max.ru/... без схемы
    if re.match(r"^[\w.-]+\.\w", s):
        return "https://" + s
    return s


def _lines(work_tg, work_vk, work_max) -> list[tuple[str, str]]:
    """[(label, url), ...] только для заполненных каналов. Порядок: ВК, ТГ, MAX."""
    out: list[tuple[str, str]] = []
    vk = _norm_url(work_vk)
    if vk:
        out.append(("ВКонтакте", vk))
    tg = tg_support_link(work_tg)
    if tg:
        out.append(("Телеграм", tg))
    mx = _norm_url(work_max)
    if mx:
        out.append(("MAX", mx))
    return out


def has_support(work_tg=None, work_vk=None, work_max=None) -> bool:
    return bool(_lines(work_tg, work_vk, work_max))


async def support_block_for_event(conn, event_id) -> str:
    """Значение {support_link} для ПРЕВЬЮ / ТЕСТА рассылки события.

    Платформа там неизвестна (текст один на все площадки), поэтому показываем все
    каналы поддержки клиента-владельца события блоком. В реальной отправке контакт
    подставляет Celery — свой для каждой площадки (см. support_url_for_platform).
    """
    if not event_id:
        return ""
    row = await conn.fetchrow(
        """SELECT cl.work_tg_username, cl.work_vk, cl.work_max
             FROM events e
             JOIN clients cl ON cl.id = (SELECT eo.client_id FROM event_owners eo
                                          WHERE eo.event_id = e.id AND eo.status = 'accepted'
                                          ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1)
            WHERE e.id = $1""",
        event_id,
    )
    if not row:
        return ""
    return build_support_inline_html(row["work_tg_username"], row["work_vk"], row["work_max"])


def support_url_for_platform(platform: str, work_tg=None, work_vk=None, work_max=None) -> str:
    """Ссылка на поддержку ТОЙ площадки, куда уходит сообщение.

    Рассылка собирается один раз на все платформы, но контакт поддержки должен
    быть «свой»: в Telegram — телеграм-поддержка, в VK — VK, в MAX — MAX.
    Подставляется на этапе отправки в каждой платформенной ветке (как {first_name}).
    Нет контакта на этой площадке — пусто (плейсхолдер просто исчезает)."""
    p = (platform or "").lower()
    if p == "telegram":
        return tg_support_link(work_tg)
    if p == "vk":
        return _norm_url(work_vk)
    if p == "max":
        return _norm_url(work_max)
    if p == "email":
        # В письме кликабельны любые ссылки — отдаём первый заполненный канал.
        rows = _lines(work_tg, work_vk, work_max)
        return rows[0][1] if rows else ""
    return ""


def support_links_block(work_tg=None, work_vk=None, work_max=None) -> str:
    """Плейсхолдер {support_links} — ВСЕ каналы поддержки списком (ВК/ТГ/MAX),
    по строке на каждый, БЕЗ интро. Единая функция для рассылок/воронок.
    Пусто → ''. (В отличие от support_url_for_platform — тот даёт ОДИН по площадке.)"""
    rows = _lines(work_tg, work_vk, work_max)
    return "\n".join(f"{label}: {url}" for label, url in rows)


def build_support_message_plain(work_tg=None, work_vk=None, work_max=None) -> str:
    """Plain-текст (VK / MAX — там разметка не нужна, ссылки кликабельны как есть).
    Пустая строка → возвращаем дефолт без каналов."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return "Возникли вопросы? Напишите организатору события."
    body = "\n\n".join(f"{label}: {url}" for label, url in rows)
    return f"{SUPPORT_INTRO}\n\n{body}"


def build_support_message_html(work_tg=None, work_vk=None, work_max=None) -> str:
    """HTML-вариант (Telegram parse_mode=HTML / страница события).
    Ссылка оборачивается в <a href>."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return "Возникли вопросы? Напишите организатору события."
    body = "\n\n".join(
        f'{_html.escape(label)}: <a href="{_html.escape(url)}">{_html.escape(url)}</a>'
        for label, url in rows
    )
    return f"{_html.escape(SUPPORT_INTRO)}\n\n{body}"


def organizer_title(name: str | None, brand_name: str | None) -> str:
    """Подпись организатора: «Имя Фамилия (бренд)».

    Бренд в скобках — чтобы человек узнал и самого организатора, и проект,
    под которым он ему знаком. Бренда нет или он совпадает с именем → только
    имя (скобки с тем же текстом выглядели бы ошибкой).
    """
    person = (name or "").strip()
    brand = (brand_name or "").strip()
    if brand and brand.casefold() != person.casefold():
        return f"{person} ({brand})" if person else brand
    return person or brand


async def support_text_for_event(db, event_id: int, *, html: bool,
                                 client_id: int | None = None) -> str:
    """Готовое сообщение поддержки по событию — ОДНА точка для всех ботов.

    ⚠️ У КОЛЛАБЫ отвечает ТОТ ОРГАНИЗАТОР, В ЧЬЁМ БОТЕ человек — его и отдаём
    (`client_id`). Раньше слались контакты всех сразу, и получалось, что за
    доведение чужой аудитории отвечает партнёр: человек пришёл по ссылке Нурии,
    а писал в поддержку Лилии (решение владельца, 2026-08-18).

    Контакты ВСЕХ организаторов остаются запасным вариантом — когда неизвестно,
    чей бот (`client_id` не передан): лучше дать все контакты, чем ни одного.
    """
    is_collab = await db.fetchval("SELECT is_collab FROM events WHERE id = $1", event_id)
    rows = await db.fetch(
        """SELECT c.id, btrim(CASE WHEN COALESCE(btrim(c.last_name), '') = '' THEN COALESCE(c.name, '') ELSE COALESCE(c.name, '') || ' ' || COALESCE(c.last_name, '') END) AS name, c.brand_name,
                  c.work_tg_username, c.work_vk, c.work_max
             FROM events e
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status='accepted'
             JOIN clients c ON c.id = eo.client_id
            WHERE e.id = $1
            ORDER BY (eo.role='owner') DESC, eo.id""",
        event_id,
    )
    # Бот известен и его владелец — организатор события: отвечает он один.
    if client_id:
        mine = [r for r in rows if r["id"] == client_id]
        if mine:
            rows = mine
            is_collab = False
    if is_collab and len(rows) > 1:
        items = [(organizer_title(r["name"], r["brand_name"]),
                  r["work_tg_username"], r["work_vk"], r["work_max"]) for r in rows]
        return (build_support_message_html_multi(items) if html
                else build_support_message_plain_multi(items))
    row = rows[0] if rows else None
    fn = build_support_message_html if html else build_support_message_plain
    return fn(
        work_tg=row["work_tg_username"] if row else "",
        work_vk=row["work_vk"] if row else "",
        work_max=row["work_max"] if row else "",
    )


def build_support_message_plain_multi(organizers) -> str:
    """Plain-версия `build_support_message_html_multi` — для VK и MAX."""
    blocks: list[str] = []
    for name, work_tg, work_vk, work_max in organizers:
        rows = _lines(work_tg, work_vk, work_max)
        if not rows:
            continue
        body = "\n".join(f"{label}: {url}" for label, url in rows)
        title = (name or "").strip()
        head = f"Организатор: {title}\n" if title else ""
        blocks.append(f"{head}{body}")
    if not blocks:
        return "Возникли вопросы? Напишите организаторам события."
    return f"{SUPPORT_INTRO}\n\n" + "\n\n".join(blocks)


def build_support_message_html_multi(organizers) -> str:
    """Сообщение поддержки КОЛЛАБ-события — контакты ВСЕХ организаторов.

    ⚠️ У коллабы организаторы равноправны, и человек не знает, к кому из них
    обращаться: показывать контакты одного «первого владельца» неверно —
    второй остаётся недоступен. Поэтому блок на каждого:

        Организатор Имя
        Телеграм: ссылка
        ВКонтакте: ссылка

        Организатор Имя2
        ...

    `organizers` — [(подпись, work_tg, work_vk, work_max), ...] в порядке
    event_owners; подпись собирает `organizer_title` («Имя Фамилия (бренд)»).
    Организаторы без единого заполненного канала пропускаются: заголовок без
    контактов бесполезен.
    """
    blocks: list[str] = []
    for name, work_tg, work_vk, work_max in organizers:
        rows = _lines(work_tg, work_vk, work_max)
        if not rows:
            continue
        body = "\n".join(
            f'{_html.escape(label)}: <a href="{_html.escape(url)}">{_html.escape(url)}</a>'
            for label, url in rows
        )
        title = _html.escape((name or "").strip())
        head = f"<b>Организатор: {title}</b>\n" if title else ""
        blocks.append(f"{head}{body}")
    if not blocks:
        return "Возникли вопросы? Напишите организаторам события."
    # Два переноса между организаторами — блоки читаются раздельно.
    return f"{_html.escape(SUPPORT_INTRO)}\n\n" + "\n\n".join(blocks)


_REPLY_INTRO = "Спасибо, видим ваше сообщение и скоро вам ответим 💛"
_REPLY_BRIDGE = "Так же вы можете связаться с тех поддержкой напрямую — напишите по этим контактам:"


def build_user_reply_plain(work_tg=None, work_vk=None, work_max=None) -> str:
    """Авто-ответ бота на свободное сообщение пользователя (VK / MAX, plain).
    Приветствие + готовые контакты поддержки по всем заполненным площадкам.
    Если контактов нет — только приветствие."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return _REPLY_INTRO
    body = "\n".join(f"{label}: {url}" for label, url in rows)
    return f"{_REPLY_INTRO}\n\n{_REPLY_BRIDGE}\n\n{body}"


def build_user_reply_html(work_tg=None, work_vk=None, work_max=None) -> str:
    """Авто-ответ бота на свободное сообщение пользователя (Telegram HTML)."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return _REPLY_INTRO
    body = "\n".join(
        f'{_html.escape(label)}: <a href="{_html.escape(url)}">{_html.escape(url)}</a>'
        for label, url in rows
    )
    return f"{_REPLY_INTRO}\n\n{_html.escape(_REPLY_BRIDGE)}\n\n{body}"


def build_support_inline_html(work_tg=None, work_vk=None, work_max=None) -> str:
    """Блок контактов поддержки для подстановки в плейсхолдер {support_link}
    воронок (Telegram HTML). Начинается с переноса строки, далее каждый канал
    с новой строки: <b>Название</b>: ссылка (название площадки жирным).
    Если каналов нет — нейтральный fallback «в этом боте»."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return "в этом боте"
    return "\n" + "\n".join(
        f'<b>{_html.escape(label)}</b>: <a href="{_html.escape(url)}">{_html.escape(url)}</a>'
        for label, url in rows
    )
