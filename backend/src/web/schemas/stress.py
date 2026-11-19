"""External Go stress response; public API schemas remain in responses.py."""

from pydantic import BaseModel, ConfigDict, Field

from web.repositories.models import Curve


class StressResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    curves: tuple[Curve, ...] = Field(min_length=6, max_length=6)
