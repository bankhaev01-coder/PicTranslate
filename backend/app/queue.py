"""Лёгкая in-process очередь с ограниченной параллельностью для задач перевода.

Для MVP работает в одном FastAPI-воркере. Для масштабирования на несколько
воркеров замените на Celery / RQ + Redis-брокер (интерфейс адаптера не меняется).
"""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger("translate-ext")


class TaskQueue:
    def __init__(self, max_concurrent: int = 4):
        self._sem = asyncio.Semaphore(max_concurrent)

    async def submit(self, coro):
        """Выполнить awaitable с ограниченной параллельностью; вернуть результат."""
        async with self._sem:
            return await coro
