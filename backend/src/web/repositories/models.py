from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    AliasChoices,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    model_validator,
)


def postgres_numeric(value: Decimal) -> Decimal:
    """Reject values NUMERIC/JSONB cannot store; remove only insignificant zeros.

    Unconstrained PostgreSQL NUMERIC supports 131072 integer digits and 16383
    fractional digits. Decimal.normalize() would depend on the active precision
    and could round a calculation, so construct the exact coefficient instead.
    """
    if not value.is_finite():
        raise ValueError("Expected a finite number")
    if value.is_zero():
        return Decimal(0)
    sign, digits, exponent = value.as_tuple()
    assert isinstance(exponent, int)
    significant = len(digits)
    while significant > 1 and digits[significant - 1] == 0:
        significant -= 1
        exponent += 1
    if exponent < -16383 or significant + exponent > 131072:
        raise ValueError("Number cannot be represented exactly by PostgreSQL NUMERIC")
    return Decimal((sign, digits[:significant], exponent))


Finite = Annotated[Decimal, Field(allow_inf_nan=False), AfterValidator(postgres_numeric)]
Tenor = Annotated[Finite, Field(gt=0)]
Parameter = Annotated[Finite, Field(gt=0, le=25)]
Label = Annotated[str, Field(min_length=1, pattern=r"\S")]
CurveCode = Literal[
    "base",
    "parallel_up",
    "parallel_down",
    "steepener",
    "flattener",
    "short_rate_up",
    "short_rate_down",
]
STRESS_CODES = frozenset(
    {"parallel_up", "parallel_down", "steepener", "flattener", "short_rate_up", "short_rate_down"}
)
RunStatus = Literal["queued", "running", "ready", "failed"]
RunStage = Literal["base", "stress"]
RunOrigin = Literal["manual", "automatic"]
CalculationErrorCode = Literal[
    "BASE_CURVE_FAILED", "CALCULATION_FAILED", "CALCULATION_TIMEOUT", "CALCULATION_INTERRUPTED"
]


class StorageModel(BaseModel):
    # model_copy() bypasses validation; integration results must be checked again,
    # including nested points, even when already represented by a model instance.
    model_config = ConfigDict(frozen=True, extra="forbid", revalidate_instances="always")


class ScenarioParameters(StorageModel):
    mode: Literal["standard", "custom"]
    p: Parameter
    k: Parameter
    d: Parameter

    @model_validator(mode="after")
    def standard_values(self) -> "ScenarioParameters":
        if self.mode == "standard" and (self.p, self.k, self.d) != tuple(
            Decimal(v) for v in (4, 5, 3)
        ):
            raise ValueError("standard requires p=4, k=5, d=3")
        return self


class ErrorDetail(StorageModel):
    field: Label
    reason: Label


class CalculationError(StorageModel):
    code: CalculationErrorCode
    message: Label
    details: tuple[ErrorDetail, ...] = ()
    curve_code: CurveCode | None = Field(
        default=None,
        validation_alias=AliasChoices("curve_code", "curveCode"),
        serialization_alias="curveCode",
    )


class RatePoint(StorageModel):
    tenor_years: Tenor
    rate_percent: Finite


class MarketRates(StorageModel):
    report_date: date
    source_as_of: AwareDatetime
    points: tuple[RatePoint, ...] = Field(min_length=2)

    @model_validator(mode="after")
    def unique_tenors(self) -> "MarketRates":
        if len({p.tenor_years for p in self.points}) != len(self.points):
            raise ValueError("Input tenors must be unique")
        return self


class StoredRates(MarketRates):
    loaded_at: AwareDatetime


class Bucket(StorageModel):
    bucket_label: Label
    tenor_years: Tenor


def validate_unique_grid(grid: tuple[Bucket, ...]) -> None:
    tenors = [p.tenor_years for p in grid]
    labels = [p.bucket_label for p in grid]
    if tenors != sorted(set(tenors)) or len(set(labels)) != len(labels):
        raise ValueError("Grid requires increasing unique tenors and unique labels")


class CalculationSpec(StorageModel):
    "Explicit integration input. No production grid, method or versions are assumed."

    data_provenance: Literal["market", "synthetic"] = "market"
    base_version: Label
    stress_version: Label
    method: Label
    day_count: Label
    grid: tuple[Bucket, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_grid(self) -> "CalculationSpec":
        validate_unique_grid(self.grid)
        return self


class StoredRun(StorageModel):
    """Validated SQL row passed from repositories to services and the worker."""

    id: UUID
    report_date: date
    source: Literal["moex"]
    currency: Literal["RUB"]
    scenario_parameters: ScenarioParameters
    calculation_spec: CalculationSpec
    status: RunStatus
    stage: RunStage
    created_at: AwareDatetime
    updated_at: AwareDatetime
    started_at: AwareDatetime | None
    stage_started_at: AwareDatetime | None
    completed_at: AwareDatetime | None
    error: CalculationError | None
    worker_id: UUID | None
    claim_token: UUID | None
    heartbeat_at: AwareDatetime | None
    lease_expires_at: AwareDatetime | None
    source_as_of: AwareDatetime
    input_loaded_at: AwareDatetime
    run_origin: RunOrigin = "manual"
    automatic_key: str | None = None
    parent_run_id: UUID | None


class CurvePoint(Bucket):
    rate_percent: Finite
    is_interpolated: bool | None = None
    is_extrapolated: bool | None = None


class Curve(StorageModel):
    curve_code: CurveCode
    points: tuple[CurvePoint, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def valid_points(self) -> "Curve":
        validate_unique_grid(self.points)
        for point in self.points:
            flags = (point.is_interpolated, point.is_extrapolated)
            if self.curve_code == "base":
                if None in flags or flags == (True, True):
                    raise ValueError("Base points require valid provenance flags")
            elif flags != (None, None):
                raise ValueError("Stress points have no provenance flags")
        return self


def require_aware(value: datetime) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Timezone-aware timestamp required")
