"""Эндпоинт перевода: принимает изображение, маршрутизирует в адаптер, кеширует."""
from __future__ import annotations

import io
import logging

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from app.cache import image_hash, make_cache
from app.config import get_settings
from app.models.registry import get_adapter
from app.queue import TaskQueue
from app.schemas.translate import ErrorResponse, TranslateRequest, TranslateResult

router = APIRouter()
log = logging.getLogger("translate-ext")

_queue: TaskQueue | None = None


def _get_queue() -> TaskQueue:
    global _queue
    if _queue is None:
        _queue = TaskQueue(get_settings().max_concurrent_tasks)
    return _queue


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
    raw = await file.read()
    if len(raw) > settings.max_image_bytes:
        raise HTTPException(413, "image too large")

    req = TranslateRequest(
        target_lang=target_lang,
        source_lang=source_lang,
        model=model,
        region_only=region_only.lower() == "true",
    )

    # ── Поиск в кеше (ключ включает режим/область/языки, чтобы исправления различались) ──
    cache = make_cache(settings)
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
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response else 502
        raise HTTPException(status, f"upstream error from {adapter.name}: {e}")
    except Exception as e:  # noqa: BLE001 — отдать клиенту как 502
        log.exception("translation failed")
        raise HTTPException(502, f"translation failed: {e}")

    out = result.to_translate_result(getattr(adapter, "name", "unknown"), result._latency)
    payload = out.model_dump(exclude_none=True)
    if cache is not None:
        cache.set(cache_key, payload, settings.cache_ttl_seconds)

    return JSONResponse(payload)

