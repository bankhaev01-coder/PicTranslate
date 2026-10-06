"""Тесты текстового переводчика (без сети)."""
from __future__ import annotations

import asyncio

import pytest

from app import translator
from app.config import Settings


def test_gemini_url_has_no_literal_braces():
    url = translator.gemini_generate_url("gemini-x")
    assert url == "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent"
    assert "{" not in url and "}" not in url


def test_gemini_empty_candidates_is_clear_error():
    with pytest.raises(RuntimeError, match="no candidates.*SAFETY"):
        translator._gemini_text({"candidates": [], "promptFeedback": {"blockReason": "SAFETY"}})


def test_gemini_skips_thought_parts():
    data = {"candidates": [{"content": {"parts": [{"text": "hmm", "thought": True}, {"text": " привет "}]}}]}
    assert translator._gemini_text(data) == "привет"


def test_none_provider_echoes_text():
    assert asyncio.run(translator.translate_text("hi", "ru", provider="none")) == "hi"


@pytest.mark.parametrize("provider", ["openai", "gemini", "custom"])
def test_unconfigured_provider_raises(monkeypatch, provider):
    monkeypatch.setattr(translator, "get_settings", lambda: Settings(_env_file=None, openai_api_key="", gemini_api_key=""))
    with pytest.raises(translator.TranslationNotConfigured):
        asyncio.run(translator.translate_text("hi", "ru", provider=provider))
