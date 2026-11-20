"""HTTP error boundary and request tracing; registered in order by the app factory."""

import logging
import re
import time
from uuid import uuid4

from fastapi import Request
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from web.exceptions.handlers import handle_internal

logger = logging.getLogger(__name__)


async def catch_unexpected(request: Request, call_next: RequestResponseEndpoint) -> Response:
    try:
        return await call_next(request)
    except Exception as error:
        return await handle_internal(request, error)


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
