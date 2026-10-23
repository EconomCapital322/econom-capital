from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import simplejson
from pydantic import BaseModel
from starlette.responses import Response


def encode_other(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, (date, UUID)):
        return str(value)
    raise TypeError("Unsupported JSON type")


class DecimalJSONResponse(Response):
    media_type = "application/json"

    @classmethod
    def from_model(
        cls,
        model: type[BaseModel],
        content: object,
        *,
        status_code: int = 200,
        headers: Mapping[str, str] | None = None,
    ) -> "DecimalJSONResponse":
        validated = model.model_validate(content)
        return cls(
            validated.model_dump(mode="python", by_alias=True, exclude_unset=True),
            status_code=status_code,
            headers=headers,
        )

    def render(self, content: Any) -> bytes:
        return simplejson.dumps(
            content, use_decimal=True, allow_nan=False, default=encode_other, ensure_ascii=False
        ).encode("utf-8")
