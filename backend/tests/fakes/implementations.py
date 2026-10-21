import time
from datetime import UTC, date, datetime
from decimal import Decimal

from web.exceptions.curve_run import StressCurveError
from web.repositories.models import (
    STRESS_CODES,
    CalculationSpec,
    Curve,
    CurvePoint,
    MarketRates,
    RatePoint,
    ScenarioParameters,
)


async def fetch(report_date: date) -> MarketRates:
    return MarketRates(
        report_date=report_date,
        source_as_of=datetime(2026, 7, 31, 16, tzinfo=UTC),
        points=(
            RatePoint(tenor_years=Decimal(".01"), rate_percent=Decimal("-1")),
            RatePoint(tenor_years=Decimal("3"), rate_percent=Decimal("2")),
        ),
    )


def base(points: tuple[RatePoint, ...], spec: CalculationSpec) -> Curve:
    assert points and spec.base_version.startswith("test-only")
    return Curve(
        curve_code="base",
        points=tuple(
            CurvePoint(
                bucket_label=b.bucket_label,
                tenor_years=b.tenor_years,
                rate_percent=Decimal("100.12345678901234567890123456789"),
                is_interpolated=False,
                is_extrapolated=False,
            )
            for b in spec.grid
        ),
    )


def stress(
    base: Curve, parameters: ScenarioParameters, algorithm_version: str
) -> tuple[Curve, ...]:
    assert parameters.mode in ("standard", "custom") and algorithm_version.startswith("test-only")
    # Marker values, NOT IRRBB formulas.
    return tuple(
        Curve.model_validate(
            {
                "curve_code": code,
                "points": [
                    CurvePoint(
                        bucket_label=p.bucket_label,
                        tenor_years=p.tenor_years,
                        rate_percent=Decimal(-7),
                    )
                    for p in base.points
                ],
            }
        )
        for code in sorted(STRESS_CODES)
    )


def slow_base(points: tuple[RatePoint, ...], spec: CalculationSpec) -> Curve:
    time.sleep(30)
    return base(points, spec)


def failing_base(points: tuple[RatePoint, ...], spec: CalculationSpec) -> Curve:
    raise ValueError("Synthetic base failure")


def failing_stress(
    base: Curve, parameters: ScenarioParameters, algorithm_version: str
) -> tuple[Curve, ...]:
    raise StressCurveError("Synthetic stress failure", curve_code="parallel_up")
