import logging
import re
import time
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import asyncpg
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from core.config import Settings, get_settings
from web.exceptions.http import ApiError
from web.lifespans import lifespan
from web.routes.curve_runs import router
from web.schemas.responses import ErrorResponse
from web.serialization import DecimalJSONResponse

logger = logging.getLogger(__name__)


def error_response(
    request: Request, error: ApiError, *, headers: Mapping[str, str] | None = None
) -> DecimalJSONResponse:
    return DecimalJSONResponse.from_model(
        ErrorResponse,
        ErrorResponse(error=error.error),
        status_code=error.status,
        headers={**(headers or {}), "X-Request-ID": getattr(request.state, "request_id", "")},
    )


async def handle_api_error(request: Request, error: Exception) -> DecimalJSONResponse:
    assert isinstance(error, ApiError)
    return error_response(request, error)


async def handle_validation(request: Request, error: Exception) -> DecimalJSONResponse:
    assert isinstance(error, RequestValidationError)
    details = [
        {
            "field": ".".join(str(p) for p in e["loc"] if p not in ("query", "path", "body")),
            "reason": "Invalid value",
        }
        for e in error.errors()
    ]
    return error_response(request, ApiError(422, "VALIDATION_ERROR", "Invalid request", details))


async def handle_unavailable(request: Request, error: Exception) -> DecimalJSONResponse:
    logger.warning("Database unavailable requestId=%s", getattr(request.state, "request_id", ""))
    return error_response(request, ApiError(503, "SERVICE_UNAVAILABLE", "Database is unavailable"))


async def handle_internal(request: Request, error: Exception) -> DecimalJSONResponse:
    logger.error(
        "Internal HTTP error requestId=%s",
        getattr(request.state, "request_id", ""),
        exc_info=(type(error), error, error.__traceback__),
    )
    return error_response(request, ApiError(500, "INTERNAL_ERROR", "Internal backend error"))


async def handle_http(request: Request, error: Exception) -> DecimalJSONResponse:
    assert isinstance(error, HTTPException)
    return error_response(
        request,
        ApiError(
            error.status_code,
            "RUN_NOT_FOUND"
            if error.status_code == 404
            else ("VALIDATION_ERROR" if error.status_code < 500 else "INTERNAL_ERROR"),
            "HTTP request failed",
        ),
        headers=error.headers,
    )


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

    @app.middleware("http")
    async def catch_unexpected(request: Request, call_next: RequestResponseEndpoint) -> Response:
        try:
            return await call_next(request)
        except Exception as error:
            return await handle_internal(request, error)

    # CORS wraps error conversion; request logging wraps both, including preflights.
    if settings.app.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.app.cors_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type", "X-Request-ID"],
            expose_headers=["Location", "X-Request-ID"],
        )

    @app.middleware("http")
    async def log_request(request: Request, call_next: RequestResponseEndpoint) -> Response:
        supplied = request.headers.get("X-Request-ID", "")
        request.state.request_id = (
            supplied if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", supplied) else uuid4().hex
        )
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        logger.info(
            "HTTP requestId=%s method=%s path=%s status=%s durationMs=%.1f",
            request.state.request_id,
            request.method,
            request.url.path,
            response.status_code,
            (time.perf_counter() - started) * 1000,
        )
        return response

    return app
