"""Health-check: проверяет, сможет ли бэкенд локально запустить Tesseract (в local-режиме)."""
from __future__ import annotations

import shutil

from fastapi import APIRouter

from app.config import get_settings

router = APIRouter()


@router.get("/health")
async def health():
    s = get_settings()
    info = {
        "ok": True,
        "default_mode": s.default_mode,
        "models": {"tesseract": shutil.which("tesseract") is not None},
        "openai_configured": bool(s.openai_api_key),
        "gemini_configured": bool(s.gemini_api_key),
        "custom_configured": bool(s.custom_api_url),
    }
    info["ok"] = info["models"]["tesseract"] or info["openai_configured"] or info["gemini_configured"] or info["custom_configured"]
    return info
