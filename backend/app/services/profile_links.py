"""Кликабельные ссылки на профиль человека для уведомлений организатору.

Уведомления #user_message / «Новый интерес» приходят организатору в TG-канал.
Чтобы из Telegram можно было ОДНИМ КЛИКОМ попасть в диалог с человеком на ЛЮБОЙ
платформе (TG / VK / MAX), формируем прямую ссылку на его аккаунт:

  • Telegram — `tg://user?id={tg_id}` (открывает диалог даже без @username) либо
    `https://t.me/{username}` если ник есть. Внутри TG @username и так кликабелен,
    но прямую ссылку всё равно добавляем — чтобы был единый формат.
  • ВКонтакте — `https://vk.com/id{vk_id}` (или `https://vk.com/{screen_name}`):
    @screen_name НЕ кликабелен из Telegram, а ссылка — да, ведёт на страницу,
    откуда можно написать человеку.
  • MAX — `https://max.ru/{username}` (ПУБЛИЧНЫЙ ник пользователя — тот же
    неймспейс, что у ботов/каналов, ссылка реально открывает чат). По ЧИСЛОВОМУ
    user_id публичной https-ссылки НЕТ: личная ссылка профиля имеет вид
    `max.ru/u/{приватный_хеш}`, а хеш Bot API не отдаёт — поэтому `max.ru/u/{id}`
    НЕ РАБОТАЕТ (ведёт в никуда). Для случая «есть только id» отдаём deep-link
    `max://user/{id}` — он откроет профиль в самом приложении MAX (упоминание
    пользователя из официальной доки dev.max.ru). Из Telegram такой клик
    запустит MAX-приложение; из обычного браузера — нет (схемы max://).

Все ссылки отдаются как HTML `<a href=...>` — уведомления уходят с parse_mode=HTML.
"""
from __future__ import annotations

import html as _html
from typing import Optional
from app.services.share_links import TG_DOMAIN


def _esc(s: str) -> str:
    return _html.escape(str(s))


def profile_url(platform: str, *, user_id: Optional[str | int] = None,
                username: Optional[str] = None) -> Optional[str]:
    """Прямой URL на профиль/диалог человека на платформе. None если данных нет."""
    platform = (platform or "").lower()
    uname = (username or "").lstrip("@").strip() or None
    uid = str(user_id).strip() if user_id not in (None, "") else None

    if platform == "telegram":
        # @username (если есть) — публичная ссылка; иначе deep-link по id.
        if uname:
            return f"https://{TG_DOMAIN}/{uname}"
        if uid and uid.isdigit():
            return f"tg://user?id={uid}"
        return None

    if platform == "vk":
        # screen_name приоритетнее (vk.com/durov), иначе числовой id (vk.com/id123).
        if uname:
            return f"https://vk.com/{uname}"
        if uid:
            return f"https://vk.com/id{uid}"
        return None

    if platform == "max":
        # ⚠️ У ЛЮДЕЙ В MAX НЕТ НИКНЕЙМОВ (проверено по справке max.ru/help/account:
        # в профиле настраиваются только фото, имя и телефон). Поле username в
        # Bot API описано как «никнейм БОТА или уникальное публичное имя» и у
        # обычного человека приходит null — ветка max.ru/{ник} почти всегда мимо.
        #
        # ⚠️ Ссылки на человека по НОМЕРУ ТЕЛЕФОНА у MAX нет (аналога wa.me).
        # Проверено живыми запросами: max.ru/{номер}, max.ru/+{номер},
        # max.ru/u/{номер}, max.ru/p/{номер} — все отдают 404.
        #
        # Единственный рабочий способ попасть в диалог — УПОМИНАНИЕ вида
        # <a href="max://user/{id}">Имя Фамилия</a>, и работает оно ТОЛЬКО
        # внутри самого MAX (см. max_mention_html ниже). В Telegram схема
        # max:// не линкуется — там ссылку не отдаём вовсе.
        if uname:
            return f"https://max.ru/{uname}"
        if uid:
            return f"max://user/{uid}"
        return None

    return None


def max_mention_html(user_id: Optional[str | int], display_name: Optional[str]) -> Optional[str]:
    """Кликабельное УПОМИНАНИЕ человека для сообщения, отправляемого В САМ MAX.

    Формат из официальной документации (dev.max.ru → «Форматирование текста»):
        {"text": "<a href=\\"max://user/{id}\\">Имя Фамилия</a>", "format": "html"}

    ⚠️ Работает ТОЛЬКО внутри MAX. В Telegram схема max:// не кликается — туда
    такую ссылку класть бессмысленно (была мёртвым текстом в уведомлениях).

    ⚠️ В тексте ссылки должно стоять ПОЛНОЕ ИМЯ ИЗ ПРОФИЛЯ MAX (имя + фамилия,
    если она есть) — так требует документация. Подставлять «написать в MAX»
    или ник нельзя: упоминание не сработает.

    ⚠️ В КОММЕНТАРИЯХ упоминания и гиперссылки MAX не поддерживает — только в
    обычных сообщениях.
    """
    uid = str(user_id).strip() if user_id not in (None, "") else None
    name = (display_name or "").strip()
    if not uid or not uid.isdigit() or not name:
        return None
    return f'<a href="max://user/{uid}">{_esc(name)}</a>'


def _is_tg_clickable(url: str) -> bool:
    """Telegram делает <a href> кликабельным только для http(s):// и tg://.
    Прочие схемы (max://) Telegram НЕ линкует — их отдаём как копируемый текст.
    """
    return url.startswith(("http://", "https://", "tg://"))


def nick_html(platform: str, *, user_id: Optional[str | int] = None,
              username: Optional[str] = None) -> str:
    """Готовая HTML-строка для поля «Никнейм» в уведомлении.

      • кликабельный URL + ник  → <a href=URL>@nick</a>
      • кликабельный URL без ника → <a href=URL>Открыть профиль</a>
      • НЕкликабельная схема (max://user/...) → ник/«—» (ссылка уйдёт строкой «Ссылка»)
      • совсем нет данных → «—»
    """
    uname = (username or "").lstrip("@").strip() or None
    url = profile_url(platform, user_id=user_id, username=username)
    if url and _is_tg_clickable(url):
        label = f"@{uname}" if uname else "Открыть профиль"
        return f'<a href="{_esc(url)}">{_esc(label)}</a>'
    # Ссылка не кликабельна в Telegram (или её нет) — показываем просто ник.
    return f"@{_esc(uname)}" if uname else "—"


def link_html(platform: str, *, user_id: Optional[str | int] = None,
              username: Optional[str] = None) -> Optional[str]:
    """Готовая HTML-строка для ОТДЕЛЬНОЙ строки «Ссылка» в уведомлении.

      • кликабельный URL → <a href=URL>URL</a>
      • НЕкликабельная схема (max://user/...) → <code>URL</code> + подсказка
        «(скопируйте и откройте в MAX)» — единственный способ попасть в диалог
        по числовому MAX-id, публичной https-ссылки по id у MAX нет.
      • нет данных → None
    """
    url = profile_url(platform, user_id=user_id, username=username)
    if not url:
        return None
    if _is_tg_clickable(url):
        return f'<a href="{_esc(url)}">{_esc(url)}</a>'
    # max://user/... — Telegram не сделает кликом, но из MAX откроется.
    return f"<code>{_esc(url)}</code> (скопируйте и откройте в MAX)"
