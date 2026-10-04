"""Contract tests only: fake OCR and HTTP transport, no model downloads/GPU."""
import asyncio
import io
import json
import threading
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from experiments.teleocr_service.app import CropOcr, ModelUnavailable, Settings, create_app


@pytest.fixture
def image_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (8, 6), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def post(client, raw, route="/ocr", **kwargs):
    return client.post(route, files={"image": ("crop.png", raw, "image/png")}, **kwargs)


def provider_response(request):
    assert request.url == "http://mt.test/v1/chat/completions"
    payload = json.loads(request.content)
    assert payload["model"] == "test-mt"
    assert payload["messages"][1]["content"].endswith("Text:\nhello")
    return httpx.Response(200, json={"choices": [{"message": {"content": "привет"}}]})


def configured(**kwargs):
    return Settings(mt_base_url="http://mt.test/v1", mt_model="test-mt", **kwargs)


def test_ocr_only_returns_source_without_translation(image_bytes):
    recognizer = Mock(return_value=" hello ")
    with TestClient(create_app(Settings(), recognizer)) as client:
        result = post(client, image_bytes)
    assert result.status_code == 200
    assert result.json()["source_text"] == "hello"
    assert result.json()["translation"] == ""
    assert result.json()["boxes"] == []
    assert result.json()["latency_ms"] >= 0
    assert recognizer.call_count == 1
    assert recognizer.call_args.args[0].size == (8, 6)


def test_translate_crop_calls_separate_mt(image_bytes):
    with TestClient(create_app(configured(), lambda image: "hello",
                              httpx.MockTransport(provider_response))) as client:
        result = post(client, image_bytes, "/translate", data={"target_lang": "ru", "return_boxes": "true"})
    assert result.status_code == 200
    assert result.json()["source_text"] == "hello"
    assert result.json()["translation"] == "привет"
    assert result.json()["boxes"] == []
    assert result.json()["model"] == "teleocr:crop"


def test_translate_without_mt_fails_before_ocr(image_bytes):
    recognizer = Mock()
    with TestClient(create_app(Settings(), recognizer)) as client:
        result = post(client, image_bytes, "/translate", data={"target_lang": "ru"})
    assert result.status_code == 503
    assert "MT_BASE_URL" in result.json()["detail"]
    recognizer.assert_not_called()


def test_empty_ocr_does_not_call_mt(image_bytes):
    transport = Mock(side_effect=AssertionError("MT must not be called"))
    with TestClient(create_app(configured(), lambda image: " ", httpx.MockTransport(transport))) as client:
        result = post(client, image_bytes, "/translate", data={"target_lang": "ru"})
    assert result.status_code == 200
    assert result.json()["source_text"] == result.json()["translation"] == ""
    transport.assert_not_called()


@pytest.mark.parametrize("token,status", [(None, 401), ("Bearer wrong", 401), ("Bearer test-token", 200)])
def test_service_authentication(image_bytes, token, status):
    recognizer = Mock(return_value="hello")
    with TestClient(create_app(Settings(service_token="test-token"), recognizer)) as client:
        result = post(client, image_bytes, headers={"Authorization": token} if token else {})
    assert result.status_code == status
    assert recognizer.call_count == (1 if status == 200 else 0)


def test_invalid_image_rejected_before_ocr():
    recognizer = Mock()
    with TestClient(create_app(Settings(), recognizer)) as client:
        result = post(client, b"not an image")
    assert result.status_code == 400
    recognizer.assert_not_called()


def test_unsupported_format_rejected():
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2)).save(buffer, format="BMP")
    with TestClient(create_app(Settings(), lambda image: "hello")) as client:
        assert post(client, buffer.getvalue()).status_code == 415


@pytest.mark.parametrize("delta,status", [(0, 200), (-1, 413)])
def test_byte_limit_boundary(image_bytes, delta, status):
    recognizer = Mock(return_value="hello")
    with TestClient(create_app(Settings(max_image_bytes=len(image_bytes) + delta), recognizer)) as client:
        result = post(client, image_bytes)
    assert result.status_code == status
    assert recognizer.call_count == (1 if status == 200 else 0)


@pytest.mark.parametrize("limit,status", [(48, 200), (47, 413)])
def test_pixel_limit_boundary(image_bytes, limit, status):
    recognizer = Mock(return_value="hello")
    with TestClient(create_app(Settings(max_image_pixels=limit), recognizer)) as client:
        result = post(client, image_bytes)
    assert result.status_code == status
    assert recognizer.call_count == (1 if status == 200 else 0)


def test_animated_image_rejected():
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), "white").save(buffer, format="PNG", save_all=True,
        append_images=[Image.new("RGB", (2, 2), "black")], duration=100)
    with TestClient(create_app(Settings(), lambda image: "hello")) as client:
        assert post(client, buffer.getvalue()).status_code == 415


@pytest.mark.parametrize("target", ["r", "ru\nignore", "language-too-long"])
def test_language_validation(image_bytes, target):
    recognizer = Mock()
    with TestClient(create_app(configured(), recognizer)) as client:
        assert post(client, image_bytes, "/translate", data={"target_lang": target}).status_code == 422
    recognizer.assert_not_called()


def test_upstream_error_is_sanitized(image_bytes):
    def fail(request):
        return httpx.Response(401, json={"error": {"message": "private upstream details"}})
    with TestClient(create_app(configured(), lambda image: "hello", httpx.MockTransport(fail))) as client:
        result = post(client, image_bytes, "/translate", data={"target_lang": "ru"})
    assert result.status_code == 502
    assert result.json()["detail"] == "Translation provider returned HTTP 401"
    assert "private" not in result.text


@pytest.mark.parametrize("payload", [{}, {"choices": []}, {"choices": [{"message": {"content": ""}}]}, {"choices": [{"message": {"content": 42}}]}])
def test_malformed_mt_response_rejected(image_bytes, payload):
    with TestClient(create_app(configured(), lambda image: "hello",
                              httpx.MockTransport(lambda request: httpx.Response(200, json=payload)))) as client:
        result = post(client, image_bytes, "/translate", data={"target_lang": "ru"})
    assert result.status_code == 502
    assert result.json()["detail"] == "Invalid translation provider response"


def test_mt_timeout_has_distinct_status(image_bytes):
    def timeout(request):
        raise httpx.ReadTimeout("private", request=request)
    with TestClient(create_app(configured(), lambda image: "hello", httpx.MockTransport(timeout))) as client:
        result = post(client, image_bytes, "/translate", data={"target_lang": "ru"})
    assert result.status_code == 504
    assert result.json()["detail"] == "Translation provider timed out"


def test_model_missing_returns_503_without_download(image_bytes):
    with TestClient(create_app(Settings())) as client:
        result = post(client, image_bytes)
    assert result.status_code == 503
    assert "local model snapshot" in result.json()["detail"]


def test_health_is_liveness_not_model_readiness():
    with TestClient(create_app(Settings())) as client:
        result = client.get("/health")
    assert result.status_code == 200
    assert result.json() == {"ok": True, "experimental": True, "model_loaded": False, "translation_configured": False}


def test_ocr_failure_is_sanitized(image_bytes):
    def fail(image):
        raise RuntimeError("private details")
    with TestClient(create_app(Settings(), fail)) as client:
        result = post(client, image_bytes)
    assert result.status_code == 502
    assert result.json()["detail"] == "OCR inference failed"
    assert "private" not in result.text


@pytest.mark.asyncio
async def test_busy_ocr_rejects_second_request(image_bytes):
    started, release = threading.Event(), threading.Event()
    def slow(image):
        started.set()
        assert release.wait(5)
        return "hello"
    app = create_app(Settings(queue_wait_seconds=0.02), slow)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://service.test") as client:
        first = asyncio.create_task(client.post("/ocr", files={"image": ("crop.png", image_bytes)}))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            second = await client.post("/ocr", files={"image": ("crop.png", image_bytes)})
            assert second.status_code == 503
            assert second.headers["Retry-After"] == "2"
        finally:
            release.set()
            assert (await first).status_code == 200


@pytest.mark.asyncio
async def test_custom_adapter_contract(image_bytes, monkeypatch):
    from app.config import Settings as BackendSettings
    from app.models.custom_adapter import CustomAdapter
    from app.schemas.translate import TranslateRequest
    service = create_app(configured(service_token="test-token"), lambda image: "hello",
                         httpx.MockTransport(provider_response))
    real_client = httpx.AsyncClient
    def client_factory(**kwargs):
        kwargs.setdefault("transport", httpx.ASGITransport(app=service))
        return real_client(**kwargs)
    monkeypatch.setattr(httpx, "AsyncClient", client_factory)
    adapter = CustomAdapter(BackendSettings(custom_api_url="http://service.test/translate", custom_api_key="test-token"))
    result = await adapter.process(image_bytes, TranslateRequest(target_lang="ru", source_lang="en", region_only=True))
    payload = result.to_translate_result("custom", result._latency)
    assert payload.source_text == "hello"
    assert payload.translation == "привет"
    assert payload.boxes == []
    assert payload.model == "custom"


def test_crop_loader_uses_local_model_and_text_task(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    client = Mock()
    client.block_parse.return_value = " hello "
    service = Mock()
    service.get_model.return_value = client
    monkeypatch.setitem(sys.modules, "TeleOCR.vlm_utils.TeleOCR_model",
                        SimpleNamespace(TeleOCRMODEL_SERVICE=service))
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "0")
    ocr = CropOcr(Settings(model_path=str(tmp_path)))
    with Image.new("RGB", (2, 2)) as image:
        assert ocr(image) == "hello"
        assert ocr(image) == "hello"
        client.block_parse.assert_called_with(image, task="text")
    service.get_model.assert_called_once_with(backend="transformers", model_path=str(tmp_path.resolve()), server_url=None)
    import os
    assert os.environ["HF_HUB_OFFLINE"] == os.environ["TRANSFORMERS_OFFLINE"] == "1"


@pytest.mark.parametrize("value", [0, -1, float("nan"), float("inf")])
def test_invalid_limits_rejected(value):
    with pytest.raises(ValueError, match="finite and positive"):
        Settings(queue_wait_seconds=value)


@pytest.mark.parametrize("url", ["ftp://host", "http://user:password@host", "https://host/v1?key=bad", "https://host/v1#fragment"])
def test_invalid_mt_url_rejected(url):
    with pytest.raises(ValueError):
        Settings(mt_base_url=url)


def test_mt_credentials_and_language_forwarding(image_bytes):
    def respond(request):
        assert request.headers["Authorization"] == "Bearer test-mt-key"
        prompt = json.loads(request.content)["messages"][1]["content"]
        assert prompt.startswith("Target language: ru\nSource language: en\n")
        return httpx.Response(200, json={"choices": [{"message": {"content": "привет"}}]})
    with TestClient(create_app(configured(mt_api_key="test-mt-key"), lambda image: "hello",
                              httpx.MockTransport(respond))) as client:
        result = post(client, image_bytes, "/translate", data={"target_lang": "ru", "source_lang": "en"})
    assert result.status_code == 200
    assert result.json()["translation"] == "привет"


@pytest.mark.asyncio
async def test_cancelled_request_keeps_model_locked(image_bytes):
    started, release = threading.Event(), threading.Event()
    def slow(image):
        started.set()
        assert release.wait(5)
        return "hello"
    app = create_app(Settings(queue_wait_seconds=0.02), slow)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://service.test") as client:
        first = asyncio.create_task(client.post("/ocr", files={"image": ("crop.png", image_bytes)}))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            first.cancel()
            second = await client.post("/ocr", files={"image": ("crop.png", image_bytes)})
            assert second.status_code == 503
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await first
        third = await client.post("/ocr", files={"image": ("crop.png", image_bytes)})
        assert third.status_code == 200
