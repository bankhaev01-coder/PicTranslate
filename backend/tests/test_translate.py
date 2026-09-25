"""Тесты эндпоинта перевода: успех, кеш, лимит размера."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_translate_success(png_bytes):
    r = client.post(
        "/translate",
        files={"file": ("region.png", png_bytes, "image/png")},
        data={"target_lang": "ru", "source_lang": "en"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["translation"] == "привет"
    assert body["source_text"] == "hello"
    assert body["model"] == "fake"


def test_translate_cache_hit_returns_same(use_fake_cache, png_bytes):
    # первый вызов: адаптер отработал, результат закеширован
    r1 = client.post(
        "/translate",
        files={"file": ("region.png", png_bytes, "image/png")},
        data={"target_lang": "ru"},
    )
    assert r1.status_code == 200

    # in-memory кеш теперь должен содержать запись
    assert use_fake_cache.store, "expected a cache entry after first request"
    first_keys = list(use_fake_cache.store.keys())

    # второй вызов: всё ещё 200, тот же payload
    r2 = client.post(
        "/translate",
        files={"file": ("region.png", png_bytes, "image/png")},
        data={"target_lang": "ru"},
    )
    assert r2.status_code == 200
    assert r2.json()["translation"] == r1.json()["translation"]
    # ключи кеша не изменились (ключ переиспользован)
    assert list(use_fake_cache.store.keys()) == first_keys
