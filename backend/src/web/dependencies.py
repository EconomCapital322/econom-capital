from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, TypeVar, cast

import asyncpg
import simplejson
from fastapi import Request
from pydantic import BaseModel, ValidationError

from core.config import Settings
from core.database import Database
from web.exceptions.http import ApiError

M = TypeVar("M", bound=BaseModel)


def settings_dependency(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


def database_dependency(request: Request) -> Database:
    return cast(Database, request.app.state.database)


def pool_dependency(request: Request) -> asyncpg.Pool[Any]:
    return cast(asyncpg.Pool[Any], request.app.state.pool)


def invalid_constant(value: str) -> Any:
    raise ApiError(422, "VALIDATION_ERROR", "JSON numbers must be finite")


async def request_body(request: Request, model: type[M]) -> M:
    media = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media != "application/json":
        raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json")
    limit = settings_dependency(request).app.max_request_body_bytes
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise ApiError(
                422, "VALIDATION_ERROR", "Request body exceeds the configured size limit"
            )
        body.extend(chunk)
    try:
        data = simplejson.loads(
            bytes(body), use_decimal=True, parse_int=Decimal, parse_constant=invalid_constant
        )
    except (ValueError, InvalidOperation, RecursionError):
        raise ApiError(400, "INVALID_JSON", "Malformed JSON") from None
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        details = [
            {
                "field": ".".join(str(p) for p in e["loc"] if p not in ("standard", "custom")),
                "reason": e["msg"],
            }
            for e in exc.errors(include_input=False, include_context=False)
        ]
        raise ApiError(422, "VALIDATION_ERROR", "Invalid request parameters", details) from None
