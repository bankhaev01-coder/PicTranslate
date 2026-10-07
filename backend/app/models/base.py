"""Абстрактный контракт, который реализует каждый адаптер модели."""
from __future__ import annotations

import abc

from app.schemas.translate import TranslateRequest


class ModelResult(abc.ABC):
    """Результат, который возвращает адаптер."""

    @property
    def latency_ms(self) -> int:
        """Время работы адаптера, мс (публичный доступ вместо чтения _latency снаружи)."""
        return int(getattr(self, "_latency", 0) or 0)

    @abc.abstractmethod
    def to_translate_result(self, model_name: str, latency_ms: int) -> TranslateResult: ...


# Переэкспорт имён схем, чтобы вызывающие могли делать короткие импорты.
__all__ = ["ModelResult", "TranslateRequest"]
