"""Текстовый хелпер перевода для локального OCR-пути.

Вынесен отдельно, чтобы TesseractAdapter мог сделать OCR и делегировать
перевод любому облачному провайдеру без циклических импортов.
"""
from __future__ import annotations

import json
import logging

import httpx

from app.config import Settings, get_settings

log = logging.getLogger("translate-ext")


async def translate_text(
    text: str,
    target_lang: str,
    source_lang: str = "auto",
    provider: str | None = None,
) -> str:
    """Перевести простую строку. Возвращает только переведённый текст.

    `provider` ∈ {"openai","gemini","none"} (кастомные модели — vision/изображения
    и обрабатываются своим адаптером; этот хелпер намеренно best-effort).
    """
    if not text.strip():
        return ""

    if provider in (None, "none"):
        return text

    s: Settings = get_settings()
    prompt = (
        f"Translate the following text into {target_lang} "
        f"(source language: {source_lang}). Output ONLY the translation, no code fences, no commentary.\n\n"
        f"Text:\n{text}"
    )

    if provider == "openai" and s.openai_api_key:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{s.openai_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {s.openai_api_key}"},
                json={
                    "model": s.openai_model,
                    "messages": [
                        {"role": "system", "content": "You are an excellent translator."},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.2,
                },
                timeout=s.translate_timeout_seconds + 10,
            )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()

    if provider == "gemini" and s.gemini_api_key:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{s.gemini_model}:generateContent",
                headers={"x-goog-api-key": s.gemini_api_key},
                json={
                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": 0.2,
                        "maxOutputTokens": 2048,
                        "thinkingConfig": {"thinkingBudget": 0},
                    },
                },
                timeout=s.translate_timeout_seconds + 10,
            )
        resp.raise_for_status()
        data = resp.json()
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        content_parts = [p.get("text", "") for p in parts if not p.get("thought")]
        return "".join(content_parts if content_parts else [p.get("text", "") for p in parts]).strip()

    log.warning("translate_text: provider=%s not configured", provider)
    return text
