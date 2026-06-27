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
  • MAX — `https://max.ru/{username}` (публичный ник) или `https://max.ru/u/{user_id}`
    (числовой id): ник в MAX некликабелен, ссылка открывает профиль/диалог.
    Формат повторяет уже принятый в проекте (speaker_cabinet / participants).

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
        # Публичный ник → max.ru/{username}; числовой id → max.ru/u/{user_id}
        # (как в speaker_cabinet.py / participants.py).
        if uname:
            return f"https://max.ru/{uname}"
        if uid:
            return f"https://max.ru/u/{uid}"
        return None

    return None


def nick_html(platform: str, *, user_id: Optional[str | int] = None,
              username: Optional[str] = None) -> str:
    """Готовая HTML-строка для поля «Никнейм» в уведомлении.

    Возвращает кликабельную ссылку:
      • с ником  → <a href=URL>@nick</a>
      • без ника → <a href=URL>Открыть профиль</a>
      • совсем нет данных → «—»
    """
    uname = (username or "").lstrip("@").strip() or None
    url = profile_url(platform, user_id=user_id, username=username)
    if not url:
        return f"@{_esc(uname)}" if uname else "—"
    label = f"@{uname}" if uname else "Открыть профиль"
    return f'<a href="{_esc(url)}">{_esc(label)}</a>'


def link_html(platform: str, *, user_id: Optional[str | int] = None,
              username: Optional[str] = None) -> Optional[str]:
    """Готовая HTML-строка для ОТДЕЛЬНОЙ строки «Ссылка» (для TG/VK — помимо ника).

    None если ссылку построить не из чего.
    """
    url = profile_url(platform, user_id=user_id, username=username)
    if not url:
        return None
    return f'<a href="{_esc(url)}">{_esc(url)}</a>'
