"""Pytest-фикстуры для тестов бэкенда."""
from __future__ import annotations

import io

import pytest
from PIL import Image


@pytest.fixture
def png_bytes() -> bytes:
    """Маленький детерминированный красный PNG 8×8 для тестов."""
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (220, 20, 20)).save(buf, format="PNG")
    return buf.getvalue()


class FakeResult:
    def __init__(self):
        self.source_text = "hello"
        self.translation = "привет"
        self.detected_language = "en"
        self.boxes = []
        self._latency = 1

    def to_translate_result(self, model_name: str, latency_ms: int):
        from app.schemas.translate import TranslateResult
        return TranslateResult(
            source_text=self.source_text,
            translation=self.translation,
            model=model_name,
            detected_language=self.detected_language,
            boxes=self.boxes,
            latency_ms=latency_ms,
        )


class FakeAdapter:
    name = "fake"

    def __init__(self, settings=None):
        self.s = settings

    @classmethod
    def from_settings(cls, settings=None):
        return cls(settings)

    async def process(self, image_bytes: bytes, request):
        return FakeResult()


class FakeCache:
    def __init__(self):
        self.store: dict[str, object] = {}

    def get(self, key: str):
        return self.store.get(key)

    def set(self, key: str, value, ttl: int = 86400):
        self.store[key] = value


@pytest.fixture
def fake_cache():
    return FakeCache()


@pytest.fixture(autouse=True)
def _patch_make_cache(monkeypatch):
    """По умолчанию отключить кеш в юнит-тестах, чтобы не трогать FS/Redis."""
    import app.api.translate as t
    monkeypatch.setattr(t, "make_cache", lambda settings: None)


@pytest.fixture
def use_fake_cache(monkeypatch):
    """Вызвать эту фикстуру, чтобы включить in-memory кеш для теста кеша."""
    import app.api.translate as t
    fake = FakeCache()
    monkeypatch.setattr(t, "make_cache", lambda settings: fake)
    return fake


@pytest.fixture(autouse=True)
def _patch_adapter(monkeypatch):
    """Провести /translate через FakeAdapter (без сети и без OCR)."""
    import app.api.translate as t
    monkeypatch.setattr(t, "get_adapter", lambda *a, **k: FakeAdapter())

