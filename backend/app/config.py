"""Настройки приложения, загружаемые из окружения (.env)."""
from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ── Общее ──
    default_mode: str = "local"  # local | cloud | custom

    # ── OpenAI ──
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o"

    # ── Gemini ──
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.8-flash"

    # ── Custom (ваша собственная модель) ──
    custom_api_url: str = ""
    custom_api_key: str = ""
    custom_model_name: str = "custom"

    # ── Локальный OCR (Tesseract) ──
    tesseract_lang: str = "rus+eng"
    ocr_dpi: int = 300

    # ── Провайдер перевода для локального OCR-пути ──
    local_translation_provider: str = "openai"  # none | openai | gemini | custom

    # ── Кеш ──
    redis_url: str = ""
    use_file_cache_if_no_redis: bool = True
    cache_ttl_seconds: int = 86400

    # ── CORS ── (NoDecode: pydantic-settings не должен JSON-декодить эту
    # переменную окружения; валидатор ниже сам разбивает список по запятым)
    allowed_origins: Annotated[list[str], NoDecode] = ["*"]

    # ── Лимиты ──
    max_image_bytes: int = 5 * 1024 * 1024
    ocr_timeout_seconds: int = 60
    translate_timeout_seconds: int = 60

    # ── Параллелизм ──
    max_concurrent_tasks: int = 4

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _parse_origins(cls, v: object) -> list[str]:
        if isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
        return list(v) if isinstance(v, (list, tuple)) else ["*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
