"""Контакты поддержки для блока «Есть вопросы?» — ОДНА сборка на все лендинги.

⚠️ Была написана дважды и разъехалась: у события ключи `telegram/vk/max` с
готовыми ссылками, у продукта — `tg/vk/max` с сырыми никами. Фронт (общий!)
читает `telegram`, поэтому на лендинге продукта Telegram просто пропадал, а
остальные ссылки вели в никуда. Отсюда единая функция: добавится третий
владелец страницы — контакты соберутся так же.

⚠️ Домен Telegram — `telegram.me`, а не `t.me` (правило проекта).
"""
from typing import Optional


def _link(val: Optional[str], base: str) -> Optional[str]:
    """Ник или готовая ссылка → ссылка.

    В поля контактов клиент вписывает и голый ник, и целый адрес — без
    нормализации получалось «https://telegram.me/https://…».
    """
    v = (val or "").strip()
    if not v:
        return None
    if v.startswith("http://") or v.startswith("https://"):
        return v
    return base + v.lstrip("@")


def support_links(row) -> dict:
    """`{telegram, vk, max}` из полей клиента (`work_tg_username` и т.д.)."""
    get = row.get if isinstance(row, dict) else row.__getitem__
    return {
        "telegram": _link(get("work_tg_username"), "https://telegram.me/"),
        "vk": _link(get("work_vk"), "https://vk.com/"),
        "max": _link(get("work_max"), "https://max.ru/"),
    }
