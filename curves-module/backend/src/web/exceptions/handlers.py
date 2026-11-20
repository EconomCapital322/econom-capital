"""Convert application and framework errors into the public API contract."""

import logging
from collections.abc import Mapping

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from web.exceptions.http import ApiError
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
