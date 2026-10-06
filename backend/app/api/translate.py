"""Эндпоинт перевода: принимает изображение, маршрутизирует в адаптер, кеширует."""
from __future__ import annotations

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

    # ── Поиск в кеше (ключ включает режим/область/языки, чтобы исправления различались) ──
    cache = _get_cache(settings)
    mode = req.model or settings.default_mode
    cache_key = (
        f"{'reg' if req.region_only else 'full'}:{mode}:{req.target_lang}:"
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

    # ── Запуск (ограниченная параллельность) ──
    try:
        result = await _get_queue().submit(adapter.process(raw, req))
    except TranslationNotConfigured as e:
        raise HTTPException(503, f"translation provider not configured: {e}")
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response is not None else 502
        raise HTTPException(status, f"upstream error from {adapter.name}: {e}")
    except Exception as e:  # noqa: BLE001 — отдать клиенту как 502
        log.exception("translation failed")
        raise HTTPException(502, f"translation failed: {e}")

    out = result.to_translate_result(getattr(adapter, "name", "unknown"), result._latency)
    payload = out.model_dump(exclude_none=True)
    if cache is not None:
        cache.set(cache_key, payload, settings.cache_ttl_seconds)

    return JSONResponse(payload)
