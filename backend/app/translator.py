"""Текстовый хелпер перевода для локального OCR-пути.

Вынесен отдельно, чтобы TesseractAdapter мог сделать OCR и делегировать
перевод любому облачному провайдеру без циклических импортов.
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from app.config import Settings, get_settings

log = logging.getLogger("translate-ext")

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class TranslationNotConfigured(RuntimeError):
    """Провайдер перевода выбран, но не настроен (нет ключа) или не поддерживается.

    Раньше в этом случае молча возвращался исходный текст, и пользователь видел
    «перевод», совпадающий с оригиналом, без объяснения причины.
    """


# Общий HTTP-клиент: раньше на каждый перевод создавался новый AsyncClient
# (новое TCP/TLS-соединение). Клиент привязан к event loop, в котором создан:
# для другого loop (например, asyncio.run в тестах) создаётся новый.
_client: httpx.AsyncClient | None = None
_client_loop: asyncio.AbstractEventLoop | None = None


def _get_client() -> httpx.AsyncClient:
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client.is_closed or _client_loop is not loop:
        _client = httpx.AsyncClient()
        _client_loop = loop
    return _client


async def aclose_client() -> None:
    """Закрыть общий клиент (вызывается из lifespan при остановке приложения)."""
    global _client, _client_loop
    client, _client, _client_loop = _client, None, None
    if client is not None and not client.is_closed:
        await client.aclose()


def gemini_generate_url(model: str) -> str:
    """URL generateContent для модели Gemini (без лишних фигурных скобок)."""
    return f"{GEMINI_BASE_URL}/models/{model}:generateContent"


def _gemini_text(data: dict) -> str:
    """Достать текст из ответа Gemini; пустой/заблокированный ответ — ошибка, а не IndexError."""
    candidates = data.get("candidates") or []
    if not candidates:
        reason = (data.get("promptFeedback") or {}).get("blockReason")
        raise RuntimeError(f"Gemini returned no candidates{f' (blockReason={reason})' if reason else ''}")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    content_parts = [p.get("text", "") for p in parts if not p.get("thought")]
    return "".join(content_parts if content_parts else [p.get("text", "") for p in parts]).strip()


async def translate_text(
    text: str,
    target_lang: str,
    source_lang: str = "auto",
    provider: str | None = None,
) -> str:
    """Перевести простую строку. Возвращает только переведённый текст.

    `provider` ∈ {"openai","gemini","none"}. "none" (или None) — осознанный
    режим «только OCR»: возвращается исходный текст. Для любого другого
    провайдера без ключа (или неподдерживаемого, например "custom" — кастомные
    модели работают с изображениями через свой адаптер) бросается
    TranslationNotConfigured.
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

    if provider == "openai":
        if not s.openai_api_key:
            raise TranslationNotConfigured("OPENAI_API_KEY is not set")
        client = _get_client()
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
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("OpenAI returned no choices")
        # content бывает null (refusal / tool_calls) — раньше это давало AttributeError.
        return ((choices[0].get("message") or {}).get("content") or "").strip()

    if provider == "gemini":
        if not s.gemini_api_key:
            raise TranslationNotConfigured("GEMINI_API_KEY is not set")
        client = _get_client()
        resp = await client.post(
            gemini_generate_url(s.gemini_model),
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
        return _gemini_text(resp.json())

    raise TranslationNotConfigured(
        f"text translation provider '{provider}' is not supported (use openai, gemini or none)"
    )
