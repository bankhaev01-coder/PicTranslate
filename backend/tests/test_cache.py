"""Тесты модуля кеша (путь Redis пропускается, если недоступен; файловый кеш тестируется)."""
from __future__ import annotations

import tempfile
import os
from pathlib import Path

from app.cache import FileCache, image_hash


def test_image_hash_is_stable(png_bytes):
    h1 = image_hash(png_bytes)
    h2 = image_hash(png_bytes)
    assert h1 == h2
    assert len(h1) == 64  # sha256 hex


def test_file_cache_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        c = FileCache(d, ttl=3600)
        c.set("abc", {"k": "v"})
        assert c.get("abc") == {"k": "v"}


def test_file_cache_key_with_colons_is_filesystem_safe():
    """Реальные ключи вида 'full:custom:ru:auto:<sha256>'; ':' недопустим в Windows."""
    key = "full:custom:ru:auto:" + "0" * 64
    with tempfile.TemporaryDirectory() as d:
        c = FileCache(d, ttl=3600)
        c.set(key, {"translation": "привет", "model": "custom"})
        assert c.get(key) == {"translation": "привет", "model": "custom"}

        stored = list(Path(d).rglob("*.json"))
        assert stored, "cache file must be written"
        assert ":" not in stored[0].name, "file name must not contain Windows-invalid characters"


def test_file_cache_miss():
    with tempfile.TemporaryDirectory() as d:
        c = FileCache(d)
        assert c.get("nope") is None
