"""Tesseract adapter unit test — mocks pytesseract so no binary needed."""
from __future__ import annotations

import asyncio

import pytest

from app.models.tesseract_adapter import TesseractAdapter
from app.schemas.translate import TranslateRequest


class _FakePytesseract:
    class Output:
        DICT = "dict"

    def __init__(self, words):
        # слова: список (text, left, top)
        self._words = words

    def image_to_data(self, img, lang=None, output_type=None, **kw):
        return {
            "level": ["5"] * len(self._words),
            "text": [w[0] for w in self._words],
            "left": [w[1] for w in self._words],
            "top": [w[2] for w in self._words],
            "width": [10] * len(self._words),
            "height": [5] * len(self._words),
        }

    def image_to_osd(self, *a, **k):
        return ""


@pytest.fixture
def settings():
    from app.config import get_settings
    return get_settings()


def test_tesseract_ocr_assembles_text_and_boxes(monkeypatch, settings, png_bytes):
    fake = _FakePytesseract([("Hello", 0, 0), ("World", 30, 0)])
    monkeypatch.setattr("app.models.tesseract_adapter.pytesseract", fake)

    adapter = TesseractAdapter.from_settings(settings)
    req = TranslateRequest(target_lang="ru", source_lang="auto")

    res = asyncio.run(adapter.process(png_bytes, req))

    assert res.source_text == "Hello World"
    assert len(res.boxes) == 2
    assert res.boxes[0]["x"] == 0
    assert res._latency >= 0


def test_tesseract_echo_when_provider_none(monkeypatch, settings, png_bytes):
    fake = _FakePytesseract([("Hello", 0, 0)])
    monkeypatch.setattr("app.models.tesseract_adapter.pytesseract", fake)
    monkeypatch.setattr(settings, "local_translation_provider", "none")

    adapter = TesseractAdapter.from_settings(settings)
    req = TranslateRequest(target_lang="ru")
    res = asyncio.run(adapter.process(png_bytes, req))
    assert res.translation == res.source_text  # no translation provider -> echo

