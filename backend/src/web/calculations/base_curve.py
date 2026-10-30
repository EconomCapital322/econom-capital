"""BuildBase adapter for the Go base-curve executable (no Python curve math)."""

import json
import subprocess

from web.exceptions.curve_run import BaseCurveError, ImplementationUnavailable
from web.repositories.models import CalculationSpec, Curve, RatePoint

BASE_VERSION = "linear-v1"
METHOD = "linear"


def build_base_curve(points: tuple[RatePoint, ...], spec: CalculationSpec) -> Curve:
    """Pass exact decimal strings to Go and validate its complete result.

    Build base/bin/base-curve and put that directory on PATH before starting
    the Worker. Only immutable data reaches the child; it has no DB resources.
    The subprocess timeout bounds its lifetime even if the worker abandons it.
    """
    payload = {
        "points": [point.model_dump(mode="json") for point in points],
        "spec": spec.model_dump(mode="json", exclude={"data_provenance"}),
    }
    try:
        completed = subprocess.run(
            ["base-curve"],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ImplementationUnavailable("Go base-curve executable is not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise BaseCurveError("Go base-curve exceeded its 30 second timeout") from exc
    if completed.returncode != 0:
        raise BaseCurveError(completed.stderr.strip() or "Go base-curve failed")
    curve = Curve.model_validate_json(completed.stdout)
    if curve.curve_code != "base" or [(p.bucket_label, p.tenor_years) for p in curve.points] != [
        (b.bucket_label, b.tenor_years) for b in spec.grid
    ]:
        raise BaseCurveError("Go base-curve returned another curve or bucket grid")
    return curve
