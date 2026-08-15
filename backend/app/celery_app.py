from celery import Celery
from celery.schedules import crontab
from app.config import settings

celery = Celery(
    "plusson",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.tasks.plusson_bonus_reminders", "app.tasks.broadcast", "app.tasks.funnel", "app.tasks.subscriptions", "app.tasks.nurture", "app.tasks.nurture_reg", "app.tasks.email_bounce", "app.tasks.dialog_retention",
        "app.tasks.client_domains", "app.tasks.addon_expiry", "app.tasks.webinar_recording",
        "app.tasks.collab_finish", "app.tasks.bot_webhook_check"]
)

celery.conf.update(
    timezone="Europe/Moscow",
    enable_utc=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    beat_schedule={
        # Каждую минуту проверяем расписание рассылок
        # Напоминания о неактивированном бонусе ПЛЮСОНа (мигр. 308).
        # Раз в час: график считается в днях, чаще незачем.
        "plusson-bonus-reminders": {
            "task": "app.tasks.plusson_bonus_reminders.send_reminders",
            "schedule": 3600.0,
        },
        "check-broadcasts": {
            "task": "app.tasks.broadcast.check_and_send_broadcasts",
            "schedule": 60.0,
        },
        # Раз в час — помечаем истёкшие подписки + паузим их будущие рассылки
        "expire-overdue-subscriptions": {
            "task": "app.tasks.subscriptions.expire_overdue",
            "schedule": 3600.0,
        },
        # Раз в час — уведомления за 7/3/1 день до истечения подписки
        "notify-expiring-subscriptions": {
            "task": "app.tasks.subscriptions.notify_expiring",
            "schedule": 3600.0,
        },
        # Раз в час — автозавершение коллаб-событий после последнего эфира
        # программы. Без него рейтинг за коллабу не начисляется вовсе: вклад
        # пишется только при переходе в 'ended', а руками статус переключают
        # далеко не всегда.
        "finish-ended-collabs": {
            "task": "app.tasks.collab_finish.finish_ended_collabs",
            "schedule": 3600.0,
        },
        # Раз в час — предупреждения за 7/3/1 день об истечении КУПЛЕННОГО МОДУЛЯ
        # (Конференции, Премии/Турниры, Коллабораторная). Миграция 276.
        "notify-expiring-addons": {
            "task": "app.tasks.addon_expiry.notify_expiring_addons",
            "schedule": 3600.0,
        },
        # Раз в час — не увели ли бота клиента в сторонний сервис. Чужой
        # вебхук забирает ВСЕ сообщения, и у клиента молча отваливаются
        # воронки, подарки и регистрация. Миграция 288.
        "check-bot-webhooks": {
            "task": "app.tasks.bot_webhook_check.check_bot_webhooks",
            "schedule": 3600.0,
        },
        # Каждые 5 минут — удаление временных broadcast_photo:
        #  - после отправки рассылки (done/cancelled) с задержкой 10 мин;
        #  - орфанов (загружено, нигде не использовано, > 1 ч).
        "cleanup-broadcast-photos": {
            "task": "app.tasks.broadcast.cleanup_broadcast_photos",
            "schedule": 300.0,
        },
        # Раз в 5 минут — отправка очередных шагов воронки догрева событий
        "nurture-tick": {
            "task": "app.tasks.nurture.tick",
            "schedule": 300.0,
        },
        # Раз в 5 минут — воронка догрева ЗАРЕГИСТРИРОВАННЫХ участников (миграция 129)
        "nurture-reg-tick": {
            "task": "app.tasks.nurture_reg.tick",
            "schedule": 300.0,
        },
        # Раз в час — парсинг bounce-возвратов из mail.log,
        # автоматическое отписывание битых адресов (миграция 098)
        "process-email-bounces": {
            "task": "app.tasks.email_bounce.process_bounces",
            "schedule": 3600.0,
        },
        # Раз в сутки в 04:10 МСК — архивирование старых личных переписок в R2
        # (чтобы Postgres на маленьком сервере не раздувался). Миграция 160.
        "archive-old-dialogs": {
            "task": "app.tasks.dialog_retention.archive_old_dialogs",
            "schedule": crontab(hour=4, minute=10),
        },
        # Раз в сутки в 05:20 МСК — сроки сертификатов своих доменов клиентов
        # и предупреждения за 14/7/3/1 день (миграция 270).
        "check-client-domains": {
            "task": "app.tasks.client_domains.check_domains",
            "schedule": crontab(hour=5, minute=20),
        },
    }
)
