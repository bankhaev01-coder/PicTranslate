"""Список доступных провайдеров моделей."""
from fastapi import APIRouter

from app.models.registry import list_models


router = APIRouter()


@router.get("/models")
async def models() -> dict:
    return {"models": list_models()}
