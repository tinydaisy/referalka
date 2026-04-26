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

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
