"""Обнаружение чужого вебхука на боте клиента.

Telegram отдаёт сообщения ТОЛЬКО ОДНОМУ получателю. Если клиент подключил
своего бота ещё и к стороннему сервису (BotHelp, merexo…), тот ставит
вебхук — и наш polling перестаёт получать что-либо. У клиента молча
отваливаются воронки, подарки, проверка подписки и регистрация на события,
а он об этом не знает.

⚠️ Вебхук САМИ НЕ СНИМАЕМ — это сломает клиенту работу в его сервисе.
Наше дело: обнаружить, внятно сказать и дать два пути (отвязать бота либо
завести отдельного). Решение за клиентом.
"""
from __future__ import annotations

import logging
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

# Знакомые сервисы — пишем человеческое имя. Незнакомый → показываем домен
# в скобках (решение владельца): клиент должен понимать, что отвязывать,
# даже если сервис нам неизвестен.
_KNOWN_SERVICES: dict[str, str] = {
    "bothelp.io": "BotHelp",
    "merexo.ru": "merexo",
    "salebot.ai": "Salebot",
    "salebot.pro": "Salebot",
    "smartsender.com": "SmartSender",
    "manychat.com": "ManyChat",
    "chatfuel.com": "Chatfuel",
    "puzzlebot.top": "PuzzleBot",
    "botmother.com": "BotMother",
    "leadconverter.io": "LeadConverter",
    "textback.ru": "TextBack",
    "senler.ru": "Senler",
}


def service_label(webhook_url: str) -> str:
    """Как назвать сервис в тексте для клиента.

    Знакомый домен → имя («BotHelp»), незнакомый → сам домен в скобках.
    Домен разобрать не удалось → нейтральное «стороннему сервису».
    """
    host = ""
    try:
        host = (urlparse(webhook_url).hostname or "").lower()
    except Exception:                                   # noqa: BLE001
        host = ""
    if not host:
        return ""
    for domain, name in _KNOWN_SERVICES.items():
        if host == domain or host.endswith("." + domain):
            return name
    return host


def service_suffix(webhook_url: str) -> str:
    """Кусок текста « (BotHelp)» — или пусто, если сервис не опознан."""
    label = service_label(webhook_url)
    return f" ({label})" if label else ""


async def fetch_webhook_url(token: str, timeout: float = 10.0) -> Optional[str]:
    """Адрес вебхука бота: '' — вебхука нет, None — спросить не удалось.

    ⚠️ Пустая строка и None — РАЗНЫЕ вещи. Сетевой сбой (None) не должен
    выглядеть как «клиент починил» и гасить плашку.
    """
    url = f"https://api.telegram.org/bot{token}/getWebhookInfo"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            data = r.json()
    except Exception as e:                              # noqa: BLE001
        logger.warning("getWebhookInfo не удался: %s", e)
        return None
    if not isinstance(data, dict) or not data.get("ok"):
        return None
    return (data.get("result") or {}).get("url") or ""


# ── Тексты (согласованы с владельцем) ─────────────────────────────────────

_BROKEN = (
    "воронки лид-магнитов, выдача подарков, проверка подписки, "
    "приветствия и регистрация на события"
)


def banner_text(handle: str, webhook_url: str) -> str:
    """Плашка в кабинете (HTML)."""
    return (
        f"⚠️ <b>Внимание!</b> Мы обнаружили, что бот <b>{handle}</b> не работает "
        f"с ПЛЮСОНом — он подключён к стороннему сервису{service_suffix(webhook_url)}."
    )


def email_subject(handle: str) -> str:
    return f"Бот {handle} не работает с ПЛЮСОНом"


def email_body_html(handle: str, webhook_url: str, help_url: str) -> str:
    label = service_label(webhook_url)
    who = label or "стороннему сервису"
    takes = label or "сторонний сервис"
    return f"""
<p>Здравствуйте!</p>
<p>Мы обнаружили, что ваш бот <b>{handle}</b> подключён к {who}.</p>
<p>Telegram устроен так, что сообщения бота получает только один сервис.
Сейчас их забирает {takes} — значит в ПЛЮСОНе через этого бота
<b>не работают</b>:</p>
<ul>
  <li>воронки лид-магнитов и выдача подарков</li>
  <li>проверка подписки на каналы</li>
  <li>приветствия и регистрация на события</li>
</ul>
<p><b>Как исправить — на выбор:</b></p>
<ol>
  <li>Отвязать бота от стороннего сервиса</li>
  <li>Создать отдельного бота для ПЛЮСОНа и подключить его в разделе
      «Каналы» — инструкция: <a href="{help_url}">{help_url}</a></li>
</ol>
<p>Если бот используется в другом сервисе намеренно — отключите его в
«Каналах», чтобы это сообщение больше не приходило.</p>
<p>С уважением,<br>команда iViSiON: ПЛЮСОН</p>
""".strip()


def email_body_text(handle: str, webhook_url: str, help_url: str) -> str:
    """Текстовая версия письма — обязательна, её видят почтовики без HTML."""
    label = service_label(webhook_url)
    who = label or "стороннему сервису"
    takes = label or "сторонний сервис"
    return (
        f"Здравствуйте!\n\n"
        f"Мы обнаружили, что ваш бот {handle} подключён к {who}.\n\n"
        f"Telegram устроен так, что сообщения бота получает только один "
        f"сервис. Сейчас их забирает {takes} — значит в ПЛЮСОНе через этого "
        f"бота не работают:\n"
        f"• воронки лид-магнитов и выдача подарков\n"
        f"• проверка подписки на каналы\n"
        f"• приветствия и регистрация на события\n\n"
        f"Как исправить — на выбор:\n"
        f"1. Отвязать бота от стороннего сервиса\n"
        f"2. Создать отдельного бота для ПЛЮСОНа и подключить его в разделе "
        f"«Каналы» — инструкция: {help_url}\n\n"
        f"Если бот используется в другом сервисе намеренно — отключите его в "
        f"«Каналах», чтобы это сообщение больше не приходило.\n\n"
        f"— Команда iViSiON: ПЛЮСОН"
    )


def bot_message_html(handle: str, webhook_url: str) -> str:
    """Сообщение в бот ПЛЮСОНа."""
    return (
        f"⚠️ <b>Внимание!</b> Мы обнаружили, что бот <b>{handle}</b> не работает "
        f"с ПЛЮСОНом — он подключён к стороннему сервису"
        f"{service_suffix(webhook_url)}.\n\n"
        f"Через него сейчас не работают {_BROKEN}. Отвяжите бота от стороннего "
        f"сервиса либо создайте отдельного бота для ПЛЮСОНа."
    )


async def broken_bots_for_client(db, client_id: int) -> list[dict[str, Any]]:
    """Боты клиента с чужим вебхуком — для плашки в кабинете.

    Читаем СОХРАНЁННЫЙ результат проверки, в Telegram не ходим: кабинет не
    должен ждать сорок ответов сети на каждом заходе.
    """
    rows = await db.fetch(
        """SELECT ch.id, ch.handle, ch.webhook_url
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
              AND COALESCE(ch.webhook_url, '') <> ''
            ORDER BY ch.id""",
        client_id,
    )
    return [
        {
            "channel_id": r["id"],
            "handle": r["handle"] or "бот",
            "service": service_label(r["webhook_url"]),
        }
        for r in rows
    ]
