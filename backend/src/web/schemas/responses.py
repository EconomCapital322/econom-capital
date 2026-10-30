from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, WithJsonSchema, model_validator
from pydantic.alias_generators import to_camel

from web.repositories.models import (
    MAX_SCENARIO_PARAMETER,
    STRESS_CODES,
    CurveCode,
    RunOrigin,
    RunStage,
    RunStatus,
)

Number = Annotated[Decimal, Field(allow_inf_nan=False), WithJsonSchema({"type": "number"})]
PositiveNumber = Annotated[Number, Field(gt=0)]
Parameter = Annotated[PositiveNumber, Field(le=MAX_SCENARIO_PARAMETER)]


class OutputModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        validate_assignment=True,
        revalidate_instances="always",
    )


class UsedParameters(OutputModel):
    mode: Literal["standard", "custom"]
    p: Parameter
    k: Parameter
    d: Parameter


class InputPoint(OutputModel):
    tenor_years: PositiveNumber
    rate_percent: Number


class InputRatesResponse(OutputModel):
    data_provenance: Literal["market", "synthetic"] = "market"
    report_date: date
    available: bool
    source: Literal["moex"]
    source_as_of: AwareDatetime | None
    loaded_at: AwareDatetime | None
    points: list[InputPoint]


class BucketPoint(InputPoint):
    bucket_label: str


class CurveResponse(OutputModel):
    curve_code: CurveCode
    points: list[BucketPoint] = Field(min_length=1)

    @model_validator(mode="after")
    def ordered_unique_points(self) -> "CurveResponse":
        tenors = [p.tenor_years for p in self.points]
        labels = [p.bucket_label for p in self.points]
        if tenors != sorted(set(tenors)) or len(set(labels)) != len(labels):
            raise ValueError("Curve points require increasing tenors and unique labels")
        return self


class ErrorDetail(OutputModel):
    field: str
    reason: str


class ErrorInfo(OutputModel):
    code: str
    message: str
    details: list[ErrorDetail]
    curve_code: str | None = None


class ErrorResponse(OutputModel):
    error: ErrorInfo


class AcceptedResponse(OutputModel):
    run_id: UUID
    status: Literal["queued", "running", "ready"]


class StateResponse(OutputModel):
    run_origin: RunOrigin = "manual"
    data_provenance: Literal["market", "synthetic"] = "market"
    run_id: UUID
    report_date: date
    status: RunStatus
    stage: RunStage
    used_parameters: UsedParameters
    base_curve: CurveResponse | None = None
    error: ErrorInfo | None = None


class RunListItem(OutputModel):
    run_origin: RunOrigin = "manual"
    data_provenance: Literal["market", "synthetic"] = "market"
    run_id: UUID
    created_at: AwareDatetime
    status: RunStatus
    stage: RunStage
    used_parameters: UsedParameters


class RunListResponse(OutputModel):
    report_date: date
    runs: list[RunListItem]


class ResultResponse(OutputModel):
    run_origin: RunOrigin = "manual"
    data_provenance: Literal["market", "synthetic"] = "market"
    run_id: UUID
    report_date: date
    source: Literal["moex"]
    completed_at: AwareDatetime
    used_parameters: UsedParameters
    curves: list[CurveResponse]

    @model_validator(mode="after")
    def complete_curves(self) -> "ResultResponse":
        if len(self.curves) != 7 or {c.curve_code for c in self.curves} != STRESS_CODES | {"base"}:
            raise ValueError("Result requires the base and all six unique stress curves")
        grid = [(p.bucket_label, p.tenor_years) for p in self.curves[0].points]
        if not grid or any(
            [(p.bucket_label, p.tenor_years) for p in c.points] != grid for c in self.curves
        ):
            raise ValueError("All result curves must have the same nonempty grid")
        return self
