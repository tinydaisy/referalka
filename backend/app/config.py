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
    cf_r2_public_url: str = "https://pub-519fc43b54e1489384397c9cea0c0ded.r2.dev"

    vk_app_id: str = ""
    vk_app_secure_key: str = ""
    vk_app_service_token: str = ""
    # Отдельный standalone-app ПЛЮСОНа для OAuth (scope=video). Mini App-тип
    # приложений в OAuth не пускает scope=video — нужен Standalone. Если не
    # задан — fallback на channel.platform_meta.vk_app_id (Mini App клиента),
    # OAuth даст «invalid scope».
    vk_oauth_standalone_app_id: str = ""
    vk_system_channel_id: int = 0
    vk_system_group_id: int = 0
    vk_system_group_token: str = ""

    max_system_bot_token: str = ""
    max_system_bot_username: str = "id890306512862_1_bot"
    max_api_base: str = "https://botapi.max.ru"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
