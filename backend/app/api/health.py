"""Health-check: сможет ли бэкенд обработать запрос в режиме по умолчанию."""
from __future__ import annotations

import shutil

from fastapi import APIRouter

from app.config import get_settings

router = APIRouter()


def _local_translation_ready(s, configured: dict[str, bool]) -> bool:
    """Готов ли провайдер перевода для локального (tesseract) пути."""
    provider = str(getattr(s, "local_translation_provider", "openai") or "none")
    if provider == "none":
        return True  # режим «только OCR» — перевод не нужен
    return configured.get(provider, False)


@router.get("/health")
async def health():
    s = get_settings()
    tesseract = shutil.which("tesseract") is not None
    configured = {
        "openai": bool(getattr(s, "openai_api_key", "")),
        "gemini": bool(getattr(s, "gemini_api_key", "")),
        "custom": bool(getattr(s, "custom_api_url", "")),
    }
    local_translation = _local_translation_ready(s, configured)
    info = {
        "ok": True,
        "default_mode": s.default_mode,
        "models": {"tesseract": tesseract},
        "openai_configured": configured["openai"],
        "gemini_configured": configured["gemini"],
        "custom_configured": configured["custom"],
        "local_translation_configured": local_translation,
    }
    if s.default_mode in ("local", "tesseract"):
        # Раньше хватало наличия tesseract: индикатор был зелёным, а перевод
        # падал из-за ненастроенного LOCAL_TRANSLATION_PROVIDER.
        info["ok"] = tesseract and local_translation
    else:
        info["ok"] = tesseract or any(configured.values())
    return info
