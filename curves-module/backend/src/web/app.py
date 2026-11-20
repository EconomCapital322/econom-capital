from typing import Any

import asyncpg
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException

from core.config import Settings, get_settings
from web.exceptions.handlers import (
    handle_api_error,
    handle_http,
    handle_internal,
    handle_unavailable,
    handle_validation,
)
from web.exceptions.http import ApiError
from web.lifespans import lifespan
from web.middleware import catch_unexpected, log_request
from web.routes.curve_runs import router
from web.schemas.responses import ErrorResponse
from web.serialization import DecimalJSONResponse


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else get_settings()
    errors: dict[int | str, dict[str, Any]] = {
        status: {"model": ErrorResponse} for status in (400, 404, 409, 415, 422, 500, 503)
    }
    app = FastAPI(
        title=settings.app.title,
        lifespan=lifespan,
        default_response_class=DecimalJSONResponse,
        responses=errors,
    )
    app.state.settings = settings
    app.include_router(router)
    app.add_exception_handler(ApiError, handle_api_error)
    app.add_exception_handler(RequestValidationError, handle_validation)
    app.add_exception_handler(HTTPException, handle_http)
    for kind in (asyncpg.PostgresConnectionError, OSError, TimeoutError):
        app.add_exception_handler(kind, handle_unavailable)
    app.add_exception_handler(Exception, handle_internal)

    app.middleware("http")(catch_unexpected)

    # CORS wraps error conversion; request logging wraps both, including preflights.
    if settings.app.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.app.cors_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type", "X-Request-ID"],
            expose_headers=["Location", "X-Request-ID"],
        )

    app.middleware("http")(log_request)

    return app
