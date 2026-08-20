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
