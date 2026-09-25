"""Плагинный адаптер для СОБСТВЕННОЙ нейросети пользователя (REST API).

Ожидаемый контракт (настраивается в .env):
    POST <CUSTOM_API_URL>
    Заголовки: Authorization: Bearer <CUSTOM_API_KEY>
    Multipart:
        image   -> file (png/jpeg)
        target_lang -> str
        source_lang -> str
        return_boxes -> bool (необязательно)
    Ответ JSON:
        { "translation": "...", "source_text": "...", "boxes": [...] }
        (translation/source_text можно опустить, если их уже делает ваша модель)
"""
from __future__ import annotations

import logging
import time

import httpx

from app.models.base import ModelResult
from app.schemas.translate import TranslateRequest, TranslateResult

log = logging.getLogger("translate-ext")


class CustomResult(ModelResult):
    def __init__(self, source_text, translation, detected_language, boxes, latency_ms):
        self.source_text = source_text
        self.translation = translation
        self.detected_language = detected_language
        self.boxes = boxes
        self._latency = latency_ms

    def to_translate_result(self, model_name: str, latency_ms: int) -> TranslateResult:
        return TranslateResult(
            source_text=self.source_text,
            translation=self.translation,
            model=model_name,
            detected_language=self.detected_language,
            boxes=self.boxes,
            latency_ms=latency_ms,
        )


class CustomAdapter:
    name = "custom"

    def __init__(self, settings):
        self.url = settings.custom_api_url
        self.api_key = settings.custom_api_key
        self.model_name = settings.custom_model_name
        self.timeout = max(settings.ocr_timeout_seconds, settings.translate_timeout_seconds) + 10

    @classmethod
    def from_settings(cls, settings):
        return cls(settings)

    async def process(self, image_bytes: bytes, request: TranslateRequest) -> ModelResult:
        t0 = time.perf_counter()

        if not self.url:
            raise RuntimeError("CUSTOM_API_URL is not configured")

        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        files = {"image": ("region.png", image_bytes, "image/png")}
        data = {
            "target_lang": request.target_lang,
            "source_lang": request.source_lang,
            "return_boxes": "true",
        }
        async with httpx.AsyncClient() as client:
            resp = await client.post(self.url, headers=headers, files=files, data=data, timeout=self.timeout)
        resp.raise_for_status()
        payload = resp.json()

        latency = int((time.perf_counter() - t0) * 1000)
        return CustomResult(
            source_text=payload.get("source_text", ""),
            translation=payload.get("translation", ""),
            detected_language=payload.get("detected_language"),
            boxes=payload.get("boxes", []),
            latency_ms=latency,
        )
