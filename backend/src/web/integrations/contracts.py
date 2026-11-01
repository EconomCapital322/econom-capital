"""Pure Python contracts: no HTTP, pool, SQL or algorithm implementation."""

from datetime import date
from typing import Protocol

from web.repositories.models import (
    CalculationSpec,
    Curve,
    MarketRates,
    RatePoint,
    ScenarioParameters,
)


class FetchRates(Protocol):
    async def __call__(self, report_date: date, /) -> MarketRates: ...


class BuildBase(Protocol):
    def __call__(self, points: tuple[RatePoint, ...], spec: CalculationSpec) -> Curve: ...


class BuildStress(Protocol):
    def __call__(
        self, base: Curve, parameters: ScenarioParameters, algorithm_version: str
    ) -> tuple[Curve, ...]: ...
