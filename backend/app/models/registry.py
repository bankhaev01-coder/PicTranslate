"""Подобрать нужный адаптер для заданного имени модели / режима."""
from __future__ import annotations

from app.config import Settings, get_settings
from app.models.openai_adapter import OpenAIAdapter
from app.models.gemini_adapter import GeminiAdapter
from app.models.tesseract_adapter import TesseractAdapter
from app.models.custom_adapter import CustomAdapter

# Словарь ключ провайдера -> класс адаптера (у каждого есть .from_settings(s))
_ADAPTERS: dict[str, type] = {
    "openai": OpenAIAdapter,
    "gemini": GeminiAdapter,
    "tesseract": TesseractAdapter,
    "custom": CustomAdapter,
}


def get_adapter(model_name: str | None, settings: Settings | None = None) -> "object":
    """Разрешить экземпляр адаптера.

    Приоритет model_name:
      1. Явный request.model
      2. settings.default_mode (cloud|local|custom или имя провайдера)
      3. 'tesseract' как офлайн-безопасный fallback
    """
    s = settings or get_settings()
    key = model_name or s.default_mode or "tesseract"

    # Принять дружелюбные алиасы, которые шлёт расширение.
    if key in ("cloud", "vision"):
        key = "openai"
    if key in ("local", "ocr", "offline"):
        key = "tesseract"

    if key not in _ADAPTERS:
        if key == "custom" and not s.custom_api_url:
            raise ValueError("custom model requested but CUSTOM_API_URL is not set")
        raise ValueError(f"unknown model: {key!r}; known: {list(_ADAPTERS)}")

    cls = _ADAPTERS[key]
    # облачным адаптерам нужен настроенный ключ
    if cls in (OpenAIAdapter, GeminiAdapter):
        required_key = {"openai": s.openai_api_key, "gemini": s.gemini_api_key}[key]
        if not required_key:
            raise ValueError(f"{key} API key is not configured")
    if cls is CustomAdapter and not s.custom_api_url:
        raise ValueError("custom model requested but CUSTOM_API_URL is not set")

    return cls.from_settings(s)


def list_models() -> list[str]:
    return list(_ADAPTERS.keys())

