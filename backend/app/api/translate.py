"""Эндпоинт перевода: принимает изображение, маршрутизирует в адаптер, кеширует."""
from __future__ import annotations

import hashlib
import logging

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from app.cache import image_hash, make_cache
from app.config import get_settings
from app.models.registry import get_adapter
from app.queue import TaskQueue
from app.schemas.translate import ErrorResponse, TranslateRequest, TranslateResult
from app.translator import TranslationNotConfigured

router = APIRouter()
log = logging.getLogger("translate-ext")

_queue: TaskQueue | None = None

# Кеш создаётся один раз (раньше — на каждый запрос: новое подключение к Redis и
# mkdir на каждый POST). Фабрику запоминаем вместе с объектом, чтобы
# подмена make_cache в тестах сразу давала новый кеш.
_cache_state: tuple[object, object] | None = None  # (factory, cache)

_READ_CHUNK = 64 * 1024

_TRANSLATION_PROVIDERS = ("openai", "gemini", "custom")


def _get_queue() -> TaskQueue:
    global _queue
    if _queue is None:
        _queue = TaskQueue(get_settings().max_concurrent_tasks)
    return _queue


def _get_cache(settings):
    global _cache_state
    if _cache_state is None or _cache_state[0] is not make_cache:
        _cache_state = (make_cache, make_cache(settings))
    return _cache_state[1]


def _setting(settings, name: str) -> str:
    return str(getattr(settings, name, "") or "")


def _model_fingerprint(mode: str, settings) -> str:
    """Конфигурация моделей, от которой зависит результат режима.

    Входит в ключ кеша: после смены модели/провайдера в .env бэкенд не должен
    весь TTL отдавать перевод, сделанный старой моделью.
    """
    if mode == "openai":
        return f"openai|{_setting(settings, 'openai_base_url')}|{_setting(settings, 'openai_model')}"
    if mode == "gemini":
        return f"gemini|{_setting(settings, 'gemini_model')}"
    if mode == "custom":
        return f"custom|{_setting(settings, 'custom_api_url')}|{_setting(settings, 'custom_model_name')}"
    if mode == "cloud":
        return f"{_model_fingerprint('openai', settings)}#{_model_fingerprint('gemini', settings)}"
    if mode in ("local", "tesseract"):
        provider = _setting(settings, "local_translation_provider") or "none"
        nested = _model_fingerprint(provider, settings) if provider in _TRANSLATION_PROVIDERS else ""
        return f"tesseract|{_setting(settings, 'tesseract_lang')}|{provider}|{nested}"
    return mode


async def _read_limited(file: UploadFile, limit: int) -> bytes:
    """Прочитать загрузку, но не больше limit байт (иначе 413).

    Раньше файл читался целиком в память и только потом сравнивался с лимитом.
    """
    size = getattr(file, "size", None)
    if isinstance(size, int) and size > limit:
        raise HTTPException(413, "image too large")
    buf = bytearray()
    while True:
        chunk = await file.read(_READ_CHUNK)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > limit:
            raise HTTPException(413, "image too large")
    return bytes(buf)


@router.post(
    "/translate",
    response_model=TranslateResult,
    responses={400: {"model": ErrorResponse}, 413: {"model": ErrorResponse}},
)
async def translate(
    file: UploadFile = File(...),
    target_lang: str = Form(..., min_length=2, max_length=8),
    source_lang: str = Form(default="auto", min_length=2, max_length=8),
    model: str = Form(default=None),
    region_only: str = Form(default="false"),
):
    """Перевести текст на изображении.

    `model`: openai | gemini | tesseract | custom | (None → DEFAULT_MODE)
    `region_only=true` помечает запрос на исправление (его шлёт инструмент выделения).
    """
    settings = get_settings()
    raw = await _read_limited(file, settings.max_image_bytes)

    req = TranslateRequest(
        target_lang=target_lang,
        source_lang=source_lang,
        model=model,
        region_only=region_only.lower() == "true",
    )

    # ── Поиск в кеше (ключ включает режим/модель/область/языки) ──
    cache = _get_cache(settings)
    mode = req.model or settings.default_mode
    model_tag = hashlib.sha1(_model_fingerprint(mode, settings).encode("utf-8")).hexdigest()[:12]
    cache_key = (
        f"{'reg' if req.region_only else 'full'}:{mode}:{model_tag}:{req.target_lang}:"
        f"{req.source_lang}:{image_hash(raw)}"
    )
    if cache is not None:
        cached = cache.get(cache_key)
        if cached:
            log.info("cache HIT %s", cache_key[:24])
            return JSONResponse(cached)

    # ── Маршрутизация в адаптер ──
    try:
        adapter = get_adapter(mode, settings)
    except ValueError as e:
        raise HTTPException(400, str(e))
    adapter_name = getattr(adapter, "name", "unknown")

    # ── Запуск (ограниченная параллельность) ──
    try:
        result = await _get_queue().submit(adapter.process(raw, req))
        # Внутри try: невалидный ответ модели (ValidationError) — это ошибка
        # провайдера (502), а не необработанный 500.
        out = result.to_translate_result(adapter_name, result._latency)
    except TranslationNotConfigured as e:
        raise HTTPException(503, f"translation provider not configured: {e}")
    except httpx.HTTPStatusError as e:
        upstream = e.response.status_code if e.response is not None else None
        log.warning("upstream %s returned HTTP %s", adapter_name, upstream)
        # 401/403 провайдера не пробрасываем как есть: клиент принял бы их за
        # отказ авторизации самого бэкенда. 429 оставляем — его можно повторить.
        status = 429 if upstream == 429 else 502
        raise HTTPException(status, f"upstream {adapter_name} returned HTTP {upstream}")
    except httpx.TimeoutException:
        log.warning("upstream %s timed out", adapter_name)
        raise HTTPException(504, f"upstream {adapter_name} timed out")
    except Exception as e:  # noqa: BLE001 — отдать клиенту как 502
        # Полный текст исключения (может содержать URL, тело ответа и т.п.)
        # остаётся в логе сервера; клиенту — только тип ошибки.
        log.exception("translation failed")
        raise HTTPException(502, f"translation failed: {type(e).__name__} (see server log)")

    payload = out.model_dump(exclude_none=True)
    if cache is not None:
        cache.set(cache_key, payload, settings.cache_ttl_seconds)

    return JSONResponse(payload)
