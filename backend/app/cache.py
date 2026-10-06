"""Кеш результатов: Redis (предпочтительно) или локальный файловый кеш как fallback."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path

log = logging.getLogger("translate-ext")

DEFAULT_TTL = 86400

# Ключ конверта файлового кеша: {"__expires_at": <unix-ts>, "value": ...}.
_EXPIRES = "__expires_at"

# Символы, недопустимые в именах файлов Windows (':', '?', ...) + управляющие.
_UNSAFE_FS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _fs_safe(key: str) -> str:
    """Превратить ключ кеша в кроссплатформенное безопасное имя файла.

    Ключи вида ``full:custom:ru:auto:<sha256>`` — разделитель ':' недопустим
    в Windows, поэтому его нужно заменить до работы с файловой системой.
    """
    return _UNSAFE_FS.sub("_", key)


def image_hash(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


class RedisCache:
    def __init__(self, url: str, ttl: int = DEFAULT_TTL):
        import redis
        self._r = redis.from_url(url, decode_responses=True)
        self._ttl = ttl

    def get(self, key: str):
        raw = self._r.get(key)
        return json.loads(raw) if raw else None

    def set(self, key: str, value, ttl: int | None = None):
        self._r.setex(key, ttl or self._ttl, json.dumps(value))


class FileCache:
    def __init__(self, directory: str, ttl: int = DEFAULT_TTL):
        self._dir = Path(directory)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._ttl = ttl

    def _path(self, key: str) -> Path:
        safe = _fs_safe(key)
        return self._dir / safe[:2] / f"{safe}.json"

    def get(self, key: str):
        p = self._path(key)
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:  # pragma: no cover
            log.warning("cache read error: %s", e)
            return None
        if isinstance(data, dict) and _EXPIRES in data:
            if float(data[_EXPIRES]) < time.time():
                return None
            return data.get("value")
        # Старый формат без конверта: срок считаем от mtime и TTL кеша.
        if (p.stat().st_mtime + self._ttl) < time.time():
            return None
        return data

    def set(self, key: str, value, ttl: int | None = None):
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        expires_at = time.time() + (ttl or self._ttl)
        p.write_text(json.dumps({_EXPIRES: expires_at, "value": value}), encoding="utf-8")


def make_cache(settings) -> "object":
    """Вернуть объект кеша с get(key)/set(key, value, ttl)."""
    url = settings.redis_url
    if url:
        try:
            import redis  # noqa: F401
            return RedisCache(url, settings.cache_ttl_seconds)
        except Exception as e:  # pragma: no cover
            log.warning("Redis unavailable (%s); falling back to file cache", e)
    if settings.use_file_cache_if_no_redis:
        cache_dir = os.environ.get("FILE_CACHE_DIR", "./cache")
        return FileCache(cache_dir, settings.cache_ttl_seconds)
    return None
