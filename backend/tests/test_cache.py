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


def test_file_cache_respects_per_item_ttl(monkeypatch):
    """ttl из set() раньше игнорировался."""
    import app.cache as cache_mod

    now = [1_000_000.0]
    monkeypatch.setattr(cache_mod.time, "time", lambda: now[0])
    with tempfile.TemporaryDirectory() as d:
        c = FileCache(d, ttl=3600)
        c.set("short", {"k": 1}, ttl=10)
        c.set("long", {"k": 2})
        now[0] += 11
        assert c.get("short") is None
        assert c.get("long") == {"k": 2}
        now[0] += 3600
        assert c.get("long") is None


def test_file_cache_reads_legacy_entries_without_envelope():
    import json

    with tempfile.TemporaryDirectory() as d:
        c = FileCache(d, ttl=3600)
        p = c._path("legacy")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"translation": "old"}), encoding="utf-8")
        assert c.get("legacy") == {"translation": "old"}
        old = p.stat().st_mtime - 7200
        os.utime(p, (old, old))
        assert c.get("legacy") is None


def test_file_cache_zero_ttl_is_not_stored():
    """ttl=0 раньше превращался в TTL по умолчанию (`ttl or self._ttl`)."""
    with tempfile.TemporaryDirectory() as d:
        c = FileCache(d, ttl=3600)
        c.set("zero", {"k": 1}, ttl=0)
        assert c.get("zero") is None
        assert not list(Path(d).rglob("*.json"))
        z = FileCache(d, ttl=0)
        z.set("cfg-zero", {"k": 2})
        assert z.get("cfg-zero") is None


def test_redis_cache_zero_ttl_skips_setex():
    from app.cache import RedisCache

    calls = []
    c = RedisCache.__new__(RedisCache)
    c._r = type("R", (), {"setex": lambda self, *a: calls.append(a)})()
    c._ttl = 0
    c.set("k", {"v": 1})
    c.set("k", {"v": 1}, ttl=0)
    assert calls == []
    c.set("k", {"v": 1}, ttl=5)
    assert calls and calls[0][1] == 5
