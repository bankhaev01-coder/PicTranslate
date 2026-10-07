"""Точка входа FastAPI — монтируется как `uvicorn app.main:app`."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.api.models import router as models_router
from app.api.translate import router as translate_router
from app.config import cors_rules, get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("translate-ext")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    log.info("backend starting: default_mode=%s models=%s", s.default_mode, s.openai_api_key and "openai+ok" or "")
    yield
    log.info("backend shutdown")


def create_app() -> FastAPI:
    app = FastAPI(title="Translate-Image Backend", version="0.1.0", lifespan=lifespan)
    s = get_settings()

    origins, origin_regex = cors_rules(s.allowed_origins)
    if origins == ["*"]:
        log.warning("CORS: ALLOWED_ORIGINS='*' — бэкенд доступен любому сайту")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=origin_regex,
        # Куки/авторизация браузера бэкенду не нужны — не разрешаем их никогда.
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(models_router)
    app.include_router(translate_router)
    return app


app = create_app()
