"""Локальный OCR-адаптер на Tesseract (сам по себе без внешних API-вызовов)."""
from __future__ import annotations

import asyncio
import io
import logging
import time

import pytesseract
from PIL import Image

from app.models.base import ModelResult
from app.schemas.translate import TranslateRequest, TranslateResult
from app.translator import translate_text

log = logging.getLogger("translate-ext")


class TesseractResult(ModelResult):
    def __init__(self, source_text: str, translation: str, detected_language: str | None,
                 boxes: list, latency_ms: int):
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


def _preprocess(image_bytes: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    # оттенки серого + порог часто помогают tesseract на скриншотах/манге
    gray = img.convert("L")
    return gray


class TesseractAdapter:
    """
    имя модели: 'tesseract'
    Язык берётся из конфига (tesseract_lang, например 'rus+eng').
    После OCR при желании переводит через настроенный local_translation_provider.
    """

    name = "tesseract"

    def __init__(self, settings):
        self.lang = settings.tesseract_lang
        self._settings = settings

    @classmethod
    def from_settings(cls, settings):
        return cls(settings)

    async def process(self, image_bytes: bytes, request: TranslateRequest) -> ModelResult:
        t0 = time.perf_counter()
        img = await asyncio.to_thread(_preprocess, image_bytes)

        data = await asyncio.to_thread(
            pytesseract.image_to_data,
            img,
            lang=self.lang,
            output_type=pytesseract.Output.DICT,
        )

        # Склеить пословный текст в строки.
        words = [w for w in data.get("text", []) if w.strip()]
        source_text = " ".join(words)

        boxes: list = []
        n = len(data.get("level", []))
        for i in range(n):
            if data["text"][i].strip():
                boxes.append({
                    "x": int(data["left"][i]),
                    "y": int(data["top"][i]),
                    "width": int(data["width"][i]),
                    "height": int(data["height"][i]),
                    "text": data["text"][i],
                })

        detected_language = pytesseract.image_to_osd(img, lang=self.lang) if False else None
        # ^ OSD по умолчанию выключен; определение языка при необходимости — на стороне вызывающего.

        translation = ""
        provider = request.model  # переопределение: 'tesseract' делает только OCR
        if self._settings.local_translation_provider not in (None, "none"):
            translation = await translate_text(
                source_text,
                request.target_lang,
                request.source_lang,
                self._settings.local_translation_provider,
            )
        else:
            translation = source_text

        latency = int((time.perf_counter() - t0) * 1000)
        return TesseractResult(
            source_text=source_text,
            translation=translation,
            detected_language=detected_language,
            boxes=boxes,
            latency_ms=latency,
        )
