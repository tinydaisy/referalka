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
            return f"https://t.me/{uname}"
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
        # Публичный ник → рабочая https-ссылка max.ru/{username}.
        # Только числовой id → max://user/{id} (deep-link, открывает профиль в
        # приложении MAX). https://max.ru/u/{id} НЕ строим — по числовому id
        # такая ссылка битая (нужен приватный хеш, его Bot API не отдаёт).
        if uname:
            return f"https://max.ru/{uname}"
        if uid:
            return f"max://user/{uid}"
        return None

    return None


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
