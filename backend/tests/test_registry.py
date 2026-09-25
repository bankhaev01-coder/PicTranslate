"""Тесты реестра (маршрутизации адаптеров)."""
from __future__ import annotations

import pytest

from app.models.registry import get_adapter, list_models
from app.models.tesseract_adapter import TesseractAdapter
from app.config import get_settings


def test_list_models():
    m = list_models()
    assert "openai" in m and "gemini" in m and "tesseract" in m and "custom" in m


def test_tesseract_works_without_key():
    settings = get_settings()
    adapter = get_adapter("tesseract", settings)
    assert isinstance(adapter, TesseractAdapter)


def test_openai_needs_key():
    settings = get_settings()
    if settings.openai_api_key:
        pytest.skip("set OPENAI_API_KEY? skipping")
    with pytest.raises(ValueError, match="not configured"):
        get_adapter("openai", settings)


def test_custom_needs_url():
    settings = get_settings()
    if settings.custom_api_url:
        pytest.skip("CUSTOM_API_URL set")
    with pytest.raises(ValueError, match="CUSTOM_API_URL is not set"):
        get_adapter("custom", settings)


def test_unknown_model():
    with pytest.raises(ValueError, match="unknown model"):
        get_adapter("does-not-exist", get_settings())
