"""Адаптер OpenAI Vision: OCR + перевод одним вызовом модели."""
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

log = logging.getLogger("translate-ext")


TRANSLATE_IMAGE_PROMPT = """You are an expert manga and comic OCR and translation assistant.
Analyze the image carefully. It is a cropped region of a comic page or manga panel.
Extract ALL visible text verbatim, in reading order (top to bottom, right to left for vertical Japanese manga).
Keep sound effects (SFX) on their own lines prefixed with "SFX:".
Then translate each text segment faithfully and naturally into {target_lang}, preserving tone.
Return your answer STRICTLY as a JSON object (no markdown, no code fences):
{{"source_text": "...", "translation": "...", "detected_language": "xx"}}
Rules:
- source_text = every line/region of text you read, joined with newlines.
- translation = faithful translation.
- detected_language = ISO 639-1 code of source text, or "auto".
"""


class OpenAIResult(ModelResult):
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


class OpenAIAdapter:
    name = "openai"

    def __init__(self, settings):
        self.base_url = settings.openai_base_url
        self.api_key = settings.openai_api_key
        self.model = settings.openai_model
        self.timeout = settings.ocr_timeout_seconds + 10
        self.image_max_dim = 1024  # OpenAI vision уменьшает большие изображения

    @classmethod
    def from_settings(cls, settings):
        return cls(settings)

    async def process(self, image_bytes: bytes, request: TranslateRequest) -> ModelResult:
        t0 = time.perf_counter()
        b64 = self._encode(image_bytes)
        prompt = TRANSLATE_IMAGE_PROMPT.format(target_lang=request.target_lang)

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": "You are an expert OCR and translation assistant."},
                {"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ]},
            ],
            "max_tokens": 2000,
            "temperature": 0.2,
        }
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=payload,
                timeout=self.timeout,
            )
        resp.raise_for_status()
        data = resp.json()
        raw = data["choices"][0]["message"]["content"]

        parsed = _extract_json(raw)
        boxes = parsed.pop("boxes", [])
        latency = int((time.perf_counter() - t0) * 1000)
        return OpenAIResult(
            source_text=parsed.get("source_text", ""),
            translation=parsed.get("translation", ""),
            detected_language=parsed.get("detected_language"),
            boxes=boxes,
            latency_ms=latency,
        )

    def _encode(self, image_bytes: bytes) -> str:
        """Уменьшить до ≤1024px, чтобы держать число токенов разумным, и пересобрать PNG."""
        with Image.open(io.BytesIO(image_bytes)) as im:
            im = im.convert("RGB")
            if max(im.width, im.height) > self.image_max_dim:
                ratio = self.image_max_dim / max(im.width, im.height)
                im = im.resize((int(im.width * ratio), int(im.height * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="PNG")
            return base64.b64encode(buf.getvalue()).decode("utf-8")


def _extract_json(raw: str) -> dict:
    """Best-effort извлечение JSON (модели иногда оборачивают в ```json)."""
    try:
        return json.loads(raw)
    except Exception:
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1:
            return json.loads(raw[start:end+1])
        return {}
