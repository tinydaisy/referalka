"""Перезапуск plusson-bot.service после изменений в активных Telegram-каналах.

Список ботов в polling читается из БД один раз при старте процесса
(`bot/main.py:_load_vip_tokens`). Чтобы новый/переключённый VIP-бот начал
слушать /start и callback'и сразу после изменения в дашборде «Каналы»
без ручного вмешательства администратора, мы дёргаем `systemctl restart`.

Безопасно вызывать после любого write-эндпоинта `channels`:
- create_channel (telegram + is_active + bot_token)
- update_channel (смена is_active или bot_token у telegram-канала)
- connect_telegram_bot (VIP-онбординг)
- delete_channel (удалён telegram-канал с токеном)

Если плата не нужна (handle/display_name) — не зовём, чтобы не дёргать сервис зря.

Сервисы plusson-api и plusson-bot работают под `User=root`, так что
sudo не требуется. Локально (где systemctl нет) — тихий no-op.
"""
import asyncio
import logging

logger = logging.getLogger(__name__)


async def _restart_service(service: str) -> None:
    """Fire-and-forget рестарт systemd-сервиса. Не падает при любой ошибке."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "restart", "--no-block", service,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("systemctl restart %s — таймаут 5с (--no-block повис)", service)
            return
        if proc.returncode != 0:
            logger.warning(
                "systemctl restart %s rc=%s stderr=%s",
                service, proc.returncode, (stderr or b"").decode(errors="replace").strip()
            )
        else:
            logger.info("%s перезапущен", service)
    except FileNotFoundError:
        logger.info("systemctl не найден — рестарт %s пропущен (локальная среда)", service)
    except Exception as e:
        logger.warning("Не удалось перезапустить %s: %s", service, e)


async def reload_bot_polling() -> None:
    """Рестарт plusson-bot (TG-боты VIP-клиентов)."""
    await _restart_service("plusson-bot")


async def reload_vk_polling() -> None:
    """Рестарт plusson-vk-bot (VK-сообщества VIP-клиентов).

    Вызывается после connect-vk-community / редактирования VK-канала —
    Long Poll consumer перечитывает список групп при старте.
    """
    await _restart_service("plusson-vk-bot")
