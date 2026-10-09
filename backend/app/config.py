from typing import List, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    PROJECT_NAME: str = "SplitMate Sync Backend"
    VERSION: str = "3.0.0"
    HOST: str = "0.0.0.0"
    PORT: int = 8080
    DEBUG: bool = False

    # Database URL: defaults to local sqlite database, or postgresql://user:pass@host:5432/db
    DATABASE_URL: str = "sqlite+aiosqlite:///./splitmate.db"

    # Optional Admin API key for administrative operations
    ADMIN_API_KEY: Optional[str] = None

    # Expo Push Notifications
    EXPO_ACCESS_TOKEN: Optional[str] = None

    # CORS configuration
    CORS_ORIGINS: List[str] = ["*"]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
