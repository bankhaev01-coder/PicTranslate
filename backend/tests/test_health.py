"""Health endpoint tests (deterministic — uses fake settings)."""
from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.main import app


def test_health(monkeypatch):
    fake = SimpleNamespace(
        default_mode="local",
        openai_api_key="",
        gemini_api_key="",
        custom_api_url="",
        redis_url="",
    )
    # патчим имя, импортированное в модуль health
    import app.api.health as h
    monkeypatch.setattr(h, "get_settings", lambda: fake)

    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert "models" in body
    assert isinstance(body["ok"], bool)
