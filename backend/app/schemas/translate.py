"""Общие Pydantic-схемы эндпоинта перевода (единый источник истины,
переиспользуется бэкендом и концептуально зеркалятся в типах расширения)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class TranslateRequest(BaseModel):
    """Тело запроса, которое шлёт расширение через multipart/form-data (или JSON).

    `image` — это либо:
      * сырые байты изображения (PNG/JPEG) целиком, либо
      * байты *обрезанной* области для режима исправления.
    `target_lang` — BCP-47 тег, например 'ru', 'en', 'ja'.
    `source_lang` = 'auto' позволяет определить язык модели перевода/зрения.
    """

    target_lang: str = Field(..., min_length=2, max_length=8, examples=["ru"])
    source_lang: str = Field(default="auto", min_length=2, max_length=8, examples=["en"])
    model: Optional[str] = Field(default=None, examples=["openai", "gemini", "tesseract", "custom"])
    region_only: bool = Field(default=False, description="true → OCR/переводить только эту область")


class BoundingBox(BaseModel):
    x: int
    y: int
    width: int
    height: int
    text: Optional[str] = None
    translation: Optional[str] = None


class TranslateResult(BaseModel):
    source_text: str = Field(default="", description="распознанный исходный текст")
    translation: str = Field(default="", description="переведённый текст")
    confidence: Optional[float] = None
    model: str
    detected_language: Optional[str] = None
    boxes: list[BoundingBox] = Field(default_factory=list)
    latency_ms: int


class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None
