"""OpenAI Vision adapter unit test — uses httpx.MockTransport (no network/key)."""
from __future__ import annotations

import asyncio
import io
import json

import httpx
import pytest
from PIL import Image

from app.models.openai_adapter import OpenAIAdapter, _extract_json
from app.schemas.translate import TranslateRequest


@pytest.fixture
def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (10, 10, 10)).save(buf, format="PNG")
    return buf.getvalue()


def test_openai_adapter_parses_vision_response(monkeypatch, png_bytes):
    from app.config import get_settings

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        assert b"image/png" in request.content
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "source_text": "Hello",
                                    "translation": "Привет",
                                    "detected_language": "en",
                                }
                            )
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    # Сохраняем настоящий класс ДО патча (один и тот же объект модуля!), затем патчим.
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        "app.models.openai_adapter.httpx.AsyncClient",
        lambda *a, **k: real_async_client(transport=transport),
    )

    adapter = OpenAIAdapter.from_settings(get_settings())
    req = TranslateRequest(target_lang="ru", source_lang="auto", model="openai")

    result = asyncio.run(adapter.process(png_bytes, req))

    assert "chat/completions" in captured["url"]
    assert result.source_text == "Hello"
    assert result.translation == "Привет"
    assert result.detected_language == "en"


def test_extract_json_strips_fences():
    assert _extract_json("```json\n{\"a\": 1}\n```") == {"a": 1}
    assert _extract_json('no fences {"a": 2} end') == {"a": 2}
    assert _extract_json("garbage no json here") == {}

