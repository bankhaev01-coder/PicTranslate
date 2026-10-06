"""CORS: шаблоны вида chrome-extension://* должны реально совпадать с расширениями."""
from __future__ import annotations

import re

from app.config import DEFAULT_ALLOWED_ORIGINS, Settings, cors_rules


def test_wildcard_entries_become_regex():
    exact, regex = cors_rules(["chrome-extension://*", "http://localhost:5173"])
    assert exact == ["http://localhost:5173"]
    assert regex is not None
    assert re.fullmatch(regex, "chrome-extension://abcdefghijklmnop")
    assert not re.fullmatch(regex, "https://evil.example")
    assert not re.fullmatch(regex, "chrome-extension://abc/../x")


def test_lone_star_allows_everything():
    assert cors_rules(["*", "chrome-extension://*"]) == (["*"], None)


def test_default_is_extensions_only(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    s = Settings(_env_file=None)
    assert s.allowed_origins == DEFAULT_ALLOWED_ORIGINS
    exact, regex = cors_rules(s.allowed_origins)
    assert exact == []
    assert re.fullmatch(regex, "moz-extension://1234-abcd")


def test_env_list_is_split(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://a.test, chrome-extension://*")
    s = Settings(_env_file=None)
    assert s.allowed_origins == ["http://a.test", "chrome-extension://*"]
