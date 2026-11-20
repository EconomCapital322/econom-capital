"""External MOEX ISS response structures, independent of the public API."""

from decimal import Decimal

from pydantic import BaseModel, ConfigDict


class IssTable(BaseModel):
    model_config = ConfigDict(strict=True)
    columns: list[str]
    data: list[list[str | Decimal | None]]


class IssResponse(BaseModel):
    yearyields: IssTable
