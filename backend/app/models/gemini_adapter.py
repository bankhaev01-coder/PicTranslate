"""Адаптер Gemini Vision (OCR + перевод через REST-эндпоинт)."""
from __future__ import annotations

import base64
import io
import json
import logging
import time

import httpx
from PIL import Image

from app.models.base import ModelResult
from app.schemas.translate import TranslateRequest, TranslateResult
from app.models.openai_adapter import _extract_json

log = logging.getLogger("translate-ext")


GEMINI_PROMPT = """You are an expert OCR and translation assistant.
Extract ALL visible text from the image verbatim.
Then translate it into {target_lang}.
Return ONLY a strict JSON object (no markdown, no code fences):
{{"source_text": "...", "translation": "...", "detected_language": "xx"}}
"""


class GeminiResult(ModelResult):
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


class GeminiAdapter:
    name = "gemini"

    def __init__(self, settings):
        self.api_key = settings.gemini_api_key
        self.model = settings.gemini_model
        self.timeout = settings.ocr_timeout_seconds + 10
        self.image_max_dim = 1024

    @classmethod
    def from_settings(cls, settings):
        return cls(settings)

    async def process(self, image_bytes: bytes, request: TranslateRequest) -> ModelResult:
        t0 = time.perf_counter()
        b64 = _encode_b64(image_bytes, self.image_max_dim)
        prompt = GEMINI_PROMPT.format(target_lang=request.target_lang)

        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {
                            "mime_type": "image/png",
                            "data": b64,
                        }},
                    ],
                }
            ],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
        }
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent"
        )
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                headers={"x-goog-api-key": self.api_key},
                json=payload,
                timeout=self.timeout,
            )
        resp.raise_for_status()
        data = resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = _extract_json(text)

        latency = int((time.perf_counter() - t0) * 1000)
        return GeminiResult(
            source_text=parsed.get("source_text", ""),
            translation=parsed.get("translation", ""),
            detected_language=parsed.get("detected_language"),
            boxes=parsed.get("boxes", []),
            latency_ms=latency,
        )


def _encode_b64(image_bytes: bytes, max_dim: int = 1024) -> str:
    with Image.open(io.BytesIO(image_bytes)) as im:
        im = im.convert("RGB")
        if max(im.width, im.height) > max_dim:
            ratio = max_dim / max(im.width, im.height)
            im = im.resize((int(im.width * ratio), int(im.height * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")
