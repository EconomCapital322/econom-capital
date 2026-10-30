import importlib
from collections.abc import Callable
from datetime import date
from typing import Any, cast

from core.config import IntegrationSettings
from web.exceptions.curve_run import ImplementationUnavailable
from web.integrations.contracts import BuildBase, BuildStress, FetchRates
from web.integrations.slava_http import build_stress_http
from web.repositories.models import (
    CalculationSpec,
    Curve,
    MarketRates,
    RatePoint,
    ScenarioParameters,
)


def load_function(path: str | None) -> Callable[..., Any]:
    if not path:
        raise ImplementationUnavailable("Implementation is not configured")
    module, separator, name = path.partition(":")
    if not separator or not module or not name:
        raise ImplementationUnavailable("Expected module:function integration path")
    try:
        function = getattr(importlib.import_module(module), name)
    except (ImportError, AttributeError) as exc:
        raise ImplementationUnavailable("Configured implementation cannot be imported") from exc
    if not callable(function):
        raise ImplementationUnavailable("Configured implementation is not callable")
    return cast(Callable[..., Any], function)


class EgorAdapter:
    def __init__(self, settings: IntegrationSettings) -> None:
        self.settings = settings

    async def fetch(self, report_date: date) -> MarketRates:
        function = cast(FetchRates, load_function(self.settings.fetch_function))
        result = MarketRates.model_validate(await function(report_date))
        if result.report_date != report_date:
            raise ValueError("Source returned another report date")
        return result

    def base(self, points: tuple[RatePoint, ...], spec: CalculationSpec) -> Curve:
        function = cast(BuildBase, load_function(self.settings.base_function))
        return Curve.model_validate(function(points, spec))


class SlavaAdapter:
    def __init__(self, settings: IntegrationSettings) -> None:
        self.settings = settings

    def stress(
        self, base: Curve, parameters: ScenarioParameters, algorithm_version: str
    ) -> tuple[Curve, ...]:
        if self.settings.stress_http_url is not None:
            return build_stress_http(self.settings, base, parameters, algorithm_version)
        function = cast(BuildStress, load_function(self.settings.stress_function))
        return tuple(Curve.model_validate(c) for c in function(base, parameters, algorithm_version))
