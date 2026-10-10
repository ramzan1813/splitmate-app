import os
from pathlib import Path
from typing import List, Optional
from dotenv import load_dotenv
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent

# Candidate locations for .env:
env_candidates = [
    BACKEND_DIR / ".env",
    ROOT_DIR / ".env",
    Path.cwd() / "backend" / ".env",
    Path.cwd() / ".env",
]

# Ensure variables from .env are available in os.environ immediately
for candidate in env_candidates:
    if candidate.is_file():
        load_dotenv(dotenv_path=candidate, override=False)

# Sync PORT and HOST to UVICORN_PORT and UVICORN_HOST for CLI compatibility
port_env = os.environ.get("PORT")
if port_env and port_env.strip():
    os.environ.setdefault("UVICORN_PORT", port_env.strip())

host_env = os.environ.get("HOST")
if host_env and host_env.strip():
    os.environ.setdefault("UVICORN_HOST", host_env.strip())


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

    @field_validator("PORT", mode="before")
    @classmethod
    def validate_port(cls, v):
        """Ensures that PORT set in .env is used, or falls back to default 8080 if empty or invalid."""
        if v is None:
            return 8080
        if isinstance(v, str):
            v_str = v.strip()
            if not v_str:
                return 8080
            try:
                return int(v_str)
            except ValueError:
                return 8080
        if isinstance(v, (int, float)):
            return int(v)
        return 8080

    model_config = SettingsConfigDict(
        env_file=tuple(str(p) for p in env_candidates if p.is_file()) or ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
