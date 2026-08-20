"""Предупреждение о заполнении файлового хранилища платформы.

⚠️ Зачем. Бесплатный уровень Cloud.ru — 15 ГБ. Когда он кончится, файлы просто
перестанут загружаться: афиши не сохранятся, записи эфиров пропадут. Узнать об
этом постфактум — значит потерять эфир, который уже не переснять.

Предупреждаем ЗАРАНЕЕ, на 12 ГБ (80% от лимита) — остаётся 3 ГБ запаса,
то есть примерно одна запись эфира на реакцию.
"""
import logging

import asyncio

import asyncpg

from app.celery_app import celery
from app.config import settings
from app.services.channels import notify_organizer_all_channels
from app.services.email_sender import EmailSender

logger = logging.getLogger(__name__)

# Порог и шаг напоминаний. ⚠️ Второй порог нужен: с 12 до 15 ГБ можно проскочить
# за один эфир, и одного предупреждения человек может не заметить.
THRESHOLDS_GB = [12, 14]
LIMIT_GB = 15
OWNER_CLIENT_ID = 1          # кому шлём — владельцу платформы


def _run_async(coro):
    """Запуск async-кода из синхронной Celery-задачи.

    ⚠️ set_event_loop обязателен: без него библиотеки внутри получают закрытый
    цикл предыдущей задачи того же воркера — правило проекта.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@celery.task(name="app.tasks.storage_alerts.check_platform_storage")
def check_platform_storage():
    return _run_async(_check())


async def _check():
    import boto3
    from botocore.client import Config as BotoConfig

    def _size():
        s3 = boto3.client(
            "s3", endpoint_url=f"https://{settings.cf_account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=settings.cf_r2_access_key_id,
            aws_secret_access_key=settings.cf_r2_secret_access_key,
            region_name="auto", config=BotoConfig(signature_version="s3v4"))
        total = 0
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=settings.cf_r2_bucket_name):
            for o in page.get("Contents", []):
                total += o["Size"]
        return total

    try:
        used = await asyncio.get_event_loop().run_in_executor(None, _size)
    except Exception:
        logger.exception("не удалось прочитать объём хранилища")
        return

    used_gb = used / 1024 ** 3
    # Берём самый высокий пройденный порог — чтобы на 14 ГБ пришло второе письмо.
    passed = [t for t in THRESHOLDS_GB if used_gb >= t]
    if not passed:
        return
    level = max(passed)

    db = await asyncpg.connect(settings.database_url)
    try:
        # ⚠️ Отметка о последнем отправленном пороге — иначе письмо уходило бы
        # каждый час, пока место не освободят.
        last = await db.fetchval(
            "SELECT storage_alert_level FROM clients WHERE id = $1", OWNER_CLIENT_ID)
        if last and int(last) >= level:
            return

        left = LIMIT_GB - used_gb
        text = (
            f"⚠️ <b>Файловое хранилище заполнено на {used_gb:.1f} ГБ из {LIMIT_GB} ГБ</b>\n\n"
            f"Осталось примерно {left:.1f} ГБ. Когда место кончится, файлы перестанут "
            f"загружаться: афиши не сохранятся, записи эфиров пропадут.\n\n"
            f"Что можно сделать:\n"
            f"• удалить старые записи эфиров — они занимают больше всего;\n"
            f"• проверить раздел «Файловое хранилище» в настройках;\n"
            f"• увеличить объём в кабинете Cloud.ru."
        )
        try:
            await notify_organizer_all_channels(OWNER_CLIENT_ID, text, db)
        except Exception:
            logger.exception("не удалось отправить уведомление в каналы")

        # Почта — обязательно: уведомление в мессенджере легко пролистать.
        try:
            email = await db.fetchval("SELECT email FROM clients WHERE id = $1", OWNER_CLIENT_ID)
            if email:
                plain = text.replace("<b>", "").replace("</b>", "")
                await EmailSender().send(
                    to_email=email,
                    subject=f"ПЛЮСОН: хранилище заполнено на {used_gb:.1f} ГБ из {LIMIT_GB}",
                    html=plain.replace("\n", "<br>"),
                    text=plain,
                )
        except Exception:
            logger.exception("не удалось отправить письмо о хранилище")

        await db.execute(
            "UPDATE clients SET storage_alert_level = $2 WHERE id = $1", OWNER_CLIENT_ID, level)
        logger.warning("хранилище: %.1f ГБ, отправлено предупреждение (порог %s)", used_gb, level)
    finally:
        await db.close()
