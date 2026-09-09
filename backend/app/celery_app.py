from celery import Celery
from celery.schedules import crontab
from app.config import settings

celery = Celery(
    "plusson",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.tasks.plusson_bonus_reminders", "app.tasks.broadcast", "app.tasks.funnel", "app.tasks.subscriptions", "app.tasks.nurture", "app.tasks.nurture_reg", "app.tasks.email_bounce", "app.tasks.dialog_retention",
        "app.tasks.client_domains", "app.tasks.addon_expiry",
        "app.tasks.tech_fix", "app.tasks.webinar_recording",
        "app.tasks.webinar_chunks", "app.tasks.webinar_stuck", "app.tasks.webinar_cut",
        "app.tasks.collab_finish", "app.tasks.bot_webhook_check", "app.tasks.calls",
        "app.tasks.instagram",
        "app.tasks.product_access_expiry",
        "app.tasks.platform_news",
        "app.tasks.tg_setup"]
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
        # Раз в минуту — запуск автообзвонов (миграция 359). Тем же тактом, что
        # рассылки: клиент нажал «Запустить» и ждёт, что звонки пойдут сейчас.
        "check-call-campaigns": {
            "task": "app.tasks.calls.check_and_run_campaigns",
            "schedule": 60.0,
        },
        # Раз в минуту — двигаем очередь автонастройки Telegram (миграция 364).
        # Клиент оплатил и смотрит на экран с живым статусом: реже — и он
        # решит, что услуга не работает.
        "tg-setup-tick": {
            "task": "app.tasks.tg_setup.tick",
            "schedule": 60.0,
        },
        # Раз в час — напоминаем забрать бота и гасим просроченные заказы.
        # ⚠️ Не чаще: непереданный бот занимает слот и держит очередь, но
        # долбить человека уведомлениями каждые пять минут нельзя.
        "tg-setup-remind": {
            "task": "app.tasks.tg_setup.remind",
            "schedule": 3600.0,
        },
        # Раз в 6 часов — спрашиваем у @SpamBot, живы ли сервисные аккаунты.
        # ⚠️ Аккаунт под спам-блоком НЕ создаёт ботов вовсе, но внешне выглядит
        # рабочим — без этой проверки очередь молча падала бы на клиентах.
        "tg-setup-health": {
            "task": "app.tasks.tg_setup.health_check",
            "schedule": 6 * 3600.0,
        },
        # Раз в минуту — заливаем дописанные куски эфира в хранилище и стираем
        # их с диска. Реже нельзя: диск копит гигабайты, а несколько
        # параллельных эфиров забили бы его целиком и положили ВСЮ платформу.
        "upload-webinar-chunks": {
            "task": "app.tasks.webinar_chunks.upload_ready_chunks",
            "schedule": 60.0,
        },
        # Раз в 10 минут — закрываем эфиры, которые ведущий не завершил кнопкой
        # (оборвался интернет, закрыл вкладку). Иначе сессия висит открытой
        # вечно: статистика не считается, запись не собирается, а деплой
        # заблокирован — он не начинается, пока идёт эфир.
        "close-stuck-webinars": {
            "task": "app.tasks.webinar_stuck.close_stuck_sessions",
            "schedule": 600.0,
        },
        # ⚠️⚠️ ОПРОС КОММЕНТАРИЙ ОТКЛЮЧЁН 2026-09-08 — работают ВЕБХУКИ.
        #
        # Он был временной заменой: до публикации приложения Meta не слала
        # события `changes` (комментарии), и мы забирали их сами раз в минуту.
        # После публикации вебхуки заработали — проверено живым комментарием,
        # события приходят за секунды.
        #
        # Держать оба инструмента вредно: одно событие обрабатывалось дважды
        # (вебхуком и опросом), и человек получал сообщение по два раза.
        #
        # ⚠️ Код задачи НЕ удалён (app/tasks/instagram.py::poll_comments) —
        # если Meta отзовёт доступ или вебхуки замолчат, достаточно вернуть
        # эти четыре строки. Задача самодостаточна и ничего не ломает.
        # "poll-instagram-comments": {
        #     "task": "app.tasks.instagram.poll_comments",
        #     "schedule": 60.0,
        # },
        # Раз в сутки — продление токенов Instagram.
        # ⚠️⚠️ Токен живёт 60 дней. Без этой задачи воронка через два месяца
        # молча перестаёт отвечать людям: не ломается заметно, а просто
        # затихает — и клиент узнаёт об этом от подписчиков, а не от нас.
        "refresh-instagram-tokens": {
            "task": "app.tasks.instagram.refresh_tokens",
            "schedule": 24 * 3600.0,
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
        # Фикс тех-специалистам за обслуживание (миграция 391).
    # ⚠️ РАЗ В СУТКИ, не раз в месяц: не отработала в свой день — фикс потерян
    # до следующего месяца. Повторный прогон безопасен (уникальный индекс).
    "tech-monthly-fix": {
        "task": "app.tasks.tech_fix.accrue_monthly_fix",
        "schedule": 86400.0,
    },
    # Квартальная премия за долю доживших. ⚠️ Ежедневно: задача сама решает,
    # закрыт ли квартал (считается через месяц после конца). Повторный прогон
    # безопасен — уникальный индекс не даст второй строки.
    "tech-quarter-bonus": {
        "task": "app.tasks.tech_fix.accrue_quarter_bonus",
        "schedule": 86400.0,
    },
    "notify-expiring-addons": {
            "task": "app.tasks.addon_expiry.notify_expiring_addons",
            "schedule": 3600.0,
        },
        # Раз в час — письмо покупателю за 3 дня до окончания доступа к
        # продукту (миграция 369). Иначе доступ пропадает молча, и человек
        # читает это как поломку кабинета.
        "notify-expiring-product-access": {
            "task": "app.tasks.product_access_expiry.notify_expiring_access",
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
        # ⚠️ Раз в сутки в 06:30 МСК — объём файлового хранилища платформы.
        # Бесплатный уровень Cloud.ru — 15 ГБ; когда он кончится, файлы просто
        # перестанут загружаться, а узнать об этом постфактум = потерять эфир.
        # Не чаще: опись бакета на 750+ файлов небыстрая, а объём растёт медленно.
        "check-platform-storage": {
            "task": "app.tasks.storage_alerts.check_platform_storage",
            "schedule": crontab(hour=6, minute=30),
        },
        # Раз в сутки в 05:20 МСК — сроки сертификатов своих доменов клиентов
        # и предупреждения за 14/7/3/1 день (миграция 270).
        "check-client-domains": {
            "task": "app.tasks.client_domains.check_domains",
            "schedule": crontab(hour=5, minute=20),
        },
    }
)
