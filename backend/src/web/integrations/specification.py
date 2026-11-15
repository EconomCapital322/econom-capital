"""Read the operator-supplied specification, shared by API, Loader and demo CLI."""

from pathlib import Path

import simplejson

from web.calculations.market_grid import validate_market_midpoints
from web.exceptions.curve_run import ImplementationUnavailable
from web.repositories.models import CalculationSpec


def load_specification(path: Path | None) -> CalculationSpec:
    if path is None:
        raise ImplementationUnavailable("Calculation specification is not configured")
    try:
        return validate_market_midpoints(
            CalculationSpec.model_validate(
                simplejson.loads(path.read_text(encoding="utf-8"), use_decimal=True)
            )
        )
    except (OSError, ValueError):
        raise ImplementationUnavailable("Calculation specification is unavailable") from None
