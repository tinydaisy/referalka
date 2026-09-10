from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_key: str = ""
    supabase_service_key: str = ""
    database_url: str = ""

    jwt_secret: str = "dev-secret-please-change-in-production-min-32"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 10080  # 7 дней

    telegram_bot_token: str = ""
    plusson_bot_username: str = "pluson_bot"  # @username общего бота PLUSON для не-VIP клиентов
    salebot_secret: str = ""        # секретный токен для вебхуков от Salebot
    redis_url: str = "redis://localhost:6379"

    app_url: str = "http://localhost:8000"
    frontend_url: str = "http://localhost:3000"
    mini_app_url: str = "http://localhost:5173"

    cf_account_id: str = ""
    cf_r2_access_key_id: str = ""
    cf_r2_secret_access_key: str = ""
    cf_r2_bucket_name: str = "referalka"
    # ⚠️ Публичный адрес файлового хранилища. С 2026-08-21 — Cloud.ru; дефолт
    # оставлен пустым намеренно: молчаливый фолбэк на чужое хранилище опаснее
    # явной ошибки при старте.
    cf_r2_public_url: str = ""
    # Адрес S3-совместимого хранилища и регион. Пусто → собирается старый
    # адрес Cloudflare (для совместимости со старыми окружениями).
    cf_s3_endpoint: str = ""
    cf_s3_region: str = ""

    vk_app_id: str = ""
    vk_app_secure_key: str = ""
    vk_app_service_token: str = ""
    # Отдельный VK-app ПЛЮСОНа для OAuth (VK ID 2.0, Code Flow + PKCE).
    # Используется чтобы запросить у админа VK-сообщества клиента user-токен
    # со scope=video для нативной загрузки видео в воронках лид-магнитов.
    # Создаётся в VK ID Console как Web-приложение.
    vk_oauth_standalone_app_id: str = ""
    vk_oauth_client_secret: str = ""
    # Redirect URI должен быть точно прописан в настройках VK ID приложения
    vk_oauth_redirect_uri: str = "https://pluson.ru/api/v1/channels/vk/oauth-callback"
    vk_system_channel_id: int = 0
    vk_system_group_id: int = 0
    vk_system_group_token: str = ""

    max_system_bot_token: str = ""
    max_system_bot_username: str = "id890306512862_1_bot"
    max_api_base: str = "https://botapi.max.ru"

    # ⚠️ Устарело (с 2026-07-28). Общий рубильник клиентских email-рассылок
    # заменён на фичу `email_broadcasts` (гейт в tasks/broadcast.py). Значение
    # больше нигде не читается — оставлено, чтобы EMAIL_BROADCASTS_ENABLED в .env
    # на серверах не ронял старт приложения (pydantic-settings ругается на
    # неизвестные поля). Удалить, когда переменная уйдёт из окружений.
    email_broadcasts_enabled: bool = False

    # WhatsApp-мост (whatsapp-web.js, отдельный Node-сервис на 127.0.0.1).
    # Клиент привязывает свой WhatsApp по QR — сессия на client_id живёт на мосту.
    wa_bridge_url: str = "http://127.0.0.1:8790"
    wa_bridge_token: str = ""  # общий секрет с мостом (заголовок X-Bridge-Token)

    # Автонастройка Telegram «под ключ» (услуга): работа от лица живого
    # аккаунта через Telethon — только так можно говорить с @BotFather.
    # ⚠️ Это ключи ПРИЛОЖЕНИЯ Telegram (my.telegram.org), общие на все
    # сервисные аккаунты. Телефон, пароль двухфакторки и прокси у каждого
    # аккаунта свои и лежат в таблице tg_setup_accounts (их правит админ
    # в панели, а не в конфиге — аккаунты меняются, конфиг ради этого
    # перевыпускать не надо).
    tg_setup_api_id: int = 0
    tg_setup_api_hash: str = ""
    # Куда класть файлы сессий Telethon на сервере.
    tg_setup_sessions_dir: str = "/var/lib/plusson/tg_sessions"

    # ⚠️ Подсказки адреса (DaData) — ключ ОДИН на платформу, не у клиента.
    # Тариф бесплатный: 10 000 подсказок в сутки, а адрес вписывают раз при
    # создании события — лимит не выбрать. Ключ держим на сервере и ходим в
    # DaData через свой эндпоинт: положить его в браузер значит отдать любому,
    # кто откроет кабинет, и защищаться пришлось бы настройкой домена в чужом
    # личном кабинете — то есть местом, о котором никто не вспомнит.
    # Пусто → подсказок нет, поле адреса работает как обычное текстовое.
    dadata_api_key: str = ""

    # Media-сервер вебинарных комнат (MediaMTX, RTMP→HLS, отдельный процесс).
    # RTMP-адрес клиенту: rtmp://{webinar_rtmp_host}/live/{stream_key}
    # HLS зрителю:        https://{домен}/hls/{stream_key}/index.m3u8
    webinar_bridge_token: str = ""            # общий секрет с MediaMTX-хуком (X-Bridge-Token)
    webinar_rtmp_host: str = "pluson.ru:1935" # что показываем клиенту как RTMP-адрес
    # HLS отдаём НАПРЯМУЮ через /live/ (без /hls/-rewrite): MediaMTX v1.19 ставит
    # cookie cookieCheck на путь /live/{key}/ и туда же редиректит (302). Если тянуть
    # через /hls/, cookie окажется на /live/, а сегменты клиент грузит с /hls/ → путь
    # cookie не совпадает → на мобильных (Safari/webview режут SameSite=None) плеер не
    # получает плейлист. На /live/ путь cookie и запросов совпадает → работает везде.
    webinar_hls_base: str = "https://pluson.ru/live"  # база HLS-плейлистов для плеера

    # ─── Instagram (Meta Graph API) ─────────────────────────────────────────
    # Приложение Meta типа Business с продуктами Instagram + Facebook Login.
    # Ключи берутся в кабинете разработчика: Настройки → Основное.
    #
    # ⚠️⚠️ ТОЛЬКО домен graph.facebook.com. Проверено на прод-сервере
    # 2026-09-03: graph.instagram.com и api.instagram.com оттуда НЕ отвечают
    # (таймаут). Новый способ «Instagram API with Instagram Login» живёт как раз
    # на них — то есть у нас он не заработает без зарубежного прокси.
    #
    # ⚠️ Пусто → раздел подключения молча не работает. Это осознанно: у клиента
    # без ключей в окружении подключать нечего, и падать при старте незачем.
    ig_app_id: str = ""
    ig_app_secret: str = ""
    # ⚠️⚠️ Идентификатор КОНФИГУРАЦИИ «Входа через Facebook для компаний»
    # (Вход через Facebook → Конфигурации). В этом режиме разрешения задаются
    # там один раз, а `scope` в ссылке передавать НЕЛЬЗЯ — Meta ответит
    # «Invalid Scopes» и перечислит все переданные разрешения как
    # недействительные, хотя дело в способе передачи, а не в именах.
    # Пусто → окно Facebook откроется без разрешений и подключение не пройдёт.
    ig_config_id: str = ""
    # Адрес возврата после входа через Facebook. ДОЛЖЕН совпадать с тем, что
    # вписан в приложении Meta (Вход через Facebook → Настройки → Valid OAuth
    # Redirect URIs) — Meta сверяет строку буквально, до последнего слэша.
    ig_oauth_redirect_uri: str = "https://pluson.ru/api/v1/channels/instagram/oauth-callback"
    ig_graph_version: str = "v21.0"

    # ─── Промо своего файлового хранилища ───────────────────────────────────
    # Реферальная ссылка на Cloud.ru в блоке «Подключите бесплатно N ГБ»
    # (Настройки → Файловое хранилище). В переменных окружения, а не в коде:
    # партнёрская ссылка меняется, и ради неё не должен выкладываться фронт.
    # Пусто → блок в интерфейсе не показывается вовсе.
    storage_promo_url: str = ""
    storage_promo_free_gb: int = 15

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
