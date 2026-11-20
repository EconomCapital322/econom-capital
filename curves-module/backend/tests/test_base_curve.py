import json
import subprocess
from decimal import ROUND_DOWN, Decimal, Inexact, localcontext
from pathlib import Path
from typing import NoReturn

import pytest

from core.config import IntegrationSettings
from web.calculations.base_curve import BASE_VERSION, METHOD, build_base_curve
from web.exceptions.curve_run import BaseCurveError, ImplementationUnavailable
from web.integrations.adapters import EgorAdapter
from web.repositories.models import Bucket, CalculationSpec, Curve, RatePoint, ScenarioParameters

EXAMPLES = Path(__file__).resolve().parents[2] / "base" / "examples"
pytestmark = pytest.mark.usefixtures("base_binary_on_path")


def source(*values: tuple[str, str]) -> tuple[RatePoint, ...]:
    return tuple(
        RatePoint(tenor_years=Decimal(tenor), rate_percent=Decimal(rate)) for tenor, rate in values
    )


def specification(*tenors: str) -> CalculationSpec:
    return CalculationSpec(
        base_version=BASE_VERSION,
        stress_version="example-stress-v1",
        method=METHOD,
        day_count="ACT/365F",
        grid=tuple(
            Bucket(bucket_label=f"bucket-{i}", tenor_years=Decimal(tenor))
            for i, tenor in enumerate(tenors)
        ),
    )


def test_neighbours_end_slopes_and_provenance() -> None:
    points = source(("3", "1"), ("0.5", "2"), ("1.5", "4"))
    spec = specification("0.25", "0.5", "1", "1.5", "2", "3", "4")
    curve = build_base_curve(points, spec)
    assert curve.curve_code == "base"
    assert [(p.bucket_label, p.tenor_years) for p in curve.points] == [
        (b.bucket_label, b.tenor_years) for b in spec.grid
    ]
    assert [p.rate_percent for p in curve.points] == [
        Decimal("1.5"),
        Decimal(2),
        Decimal(3),
        Decimal(4),
        Decimal(3),
        Decimal(1),
        Decimal(-1),
    ]
    assert [(p.is_interpolated, p.is_extrapolated) for p in curve.points] == [
        (False, True),
        (False, False),
        (True, False),
        (False, False),
        (True, False),
        (False, False),
        (False, True),
    ]
    assert points == source(("3", "1"), ("0.5", "2"), ("1.5", "4"))
    assert spec == specification("0.25", "0.5", "1", "1.5", "2", "3", "4")
    assert build_base_curve(tuple(reversed(points)), spec) == curve


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("-2", "-2", ("-2", "-2", "-2")),
        ("-2", "2", ("-3", "0", "4")),
        ("2", "-2", ("3", "0", "-4")),
        ("0", "0", ("0", "0", "0")),
    ],
)
def test_two_sources_flat_negative_and_zero_rates(
    left: str, right: str, expected: tuple[str, ...]
) -> None:
    curve = build_base_curve(source(("1", left), ("3", right)), specification("0.5", "2", "4"))
    # At 0.5, 2, 4 the same line covers left extrapolation, interpolation and right extrapolation.
    assert [p.rate_percent for p in curve.points] == [Decimal(rate) for rate in expected]


def test_grid_may_have_one_bucket_or_no_source_nodes() -> None:
    curve = build_base_curve(source(("1", "2"), ("3", "6")), specification("2"))
    assert len(curve.points) == 1
    assert curve.points[0].rate_percent == Decimal(4)
    assert curve.points[0].is_interpolated is True


def test_exact_source_nodes_preserve_all_digits() -> None:
    rate = "14.123456789012345678901234567890123456789"
    points = source(("1", rate), ("2", "-1"))
    with localcontext() as context:
        context.prec = 2
        curve = build_base_curve(points, specification("1", "2"))
    assert curve.points[0].rate_percent == Decimal(rate)
    assert [(p.is_interpolated, p.is_extrapolated) for p in curve.points] == [
        (False, False),
        (False, False),
    ]


def test_recurring_decimal_is_independent_of_callers_context() -> None:
    points = source(("1", "0"), ("4", "1"))
    spec = specification("2")
    with localcontext() as context:
        context.prec = 2
        context.rounding = ROUND_DOWN
        context.traps[Inexact] = True
        curve = build_base_curve(points, spec)
    assert curve.points[0].rate_percent == Decimal("0." + "3" * 34)


@pytest.mark.parametrize(("suffix", "rounded"), [("25", "2"), ("35", "4")])
def test_calculated_rates_round_half_to_even(suffix: str, rounded: str) -> None:
    rate = "1." + "0" * 32 + suffix
    curve = build_base_curve(source(("1", rate), ("3", rate)), specification("2"))
    assert curve.points[0].rate_percent == Decimal("1." + "0" * 32 + rounded)


def test_very_close_tenors_do_not_collapse_during_subtraction() -> None:
    prefix = "1." + "0" * 39
    curve = build_base_curve(
        source((prefix + "1", "0"), (prefix + "3", "2")),
        specification(prefix + "2"),
    )
    assert curve.points[0].rate_percent == Decimal(1)


@pytest.mark.parametrize("points", [(), source(("1", "2"))])
def test_insufficient_sources_are_rejected(points: tuple[RatePoint, ...]) -> None:
    with pytest.raises(BaseCurveError, match="At least two"):
        build_base_curve(points, specification("1"))


@pytest.mark.parametrize("second_rate", ["2", "3"])
def test_duplicate_source_tenors_are_rejected(second_rate: str) -> None:
    with pytest.raises(BaseCurveError, match="unique"):
        build_base_curve(source(("1", "2"), ("1.00", second_rate)), specification("1"))


@pytest.mark.parametrize("field", ["base_version", "method"])
def test_unknown_algorithm_settings_are_rejected(field: str) -> None:
    spec = specification("1").model_copy(update={field: "unsupported"})
    with pytest.raises(BaseCurveError, match="Unsupported"):
        build_base_curve(source(("1", "2"), ("2", "3")), spec)


def test_real_function_can_be_loaded_by_existing_adapter() -> None:
    points, spec = source(("1", "2"), ("3", "6")), specification("2")
    adapter = EgorAdapter(
        IntegrationSettings(base_function="web.calculations.base_curve:build_base_curve")
    )
    assert adapter.base(points, spec) == build_base_curve(points, spec)


def test_documented_payload_is_actual_builder_output() -> None:
    example = json.loads((EXAMPLES / "base-curve-input.json").read_text(encoding="utf-8"))
    spec = CalculationSpec.model_validate_json(
        (EXAMPLES / "linear-calculation-spec.json").read_text(encoding="utf-8")
    )
    curve = build_base_curve(tuple(RatePoint.model_validate(p) for p in example["points"]), spec)
    parameters = ScenarioParameters(mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3))
    payload = {
        "base": curve.model_dump(mode="json", exclude_none=True),
        "parameters": parameters.model_dump(mode="json"),
    }
    expected = json.loads((EXAMPLES / "stress-request.json").read_text(encoding="utf-8"))
    assert payload == expected
    assert Curve.model_validate(payload["base"]) == curve


def test_missing_go_executable_is_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", "")
    with pytest.raises(ImplementationUnavailable, match="not on PATH"):
        build_base_curve(source(("1", "2"), ("3", "6")), specification("2"))


def test_go_subprocess_timeout_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    def timeout(*args: object, **kwargs: object) -> NoReturn:
        raise subprocess.TimeoutExpired("base-curve", 30)

    monkeypatch.setattr("web.calculations.base_curve.subprocess.run", timeout)
    with pytest.raises(BaseCurveError, match="timeout"):
        build_base_curve(source(("1", "2"), ("3", "6")), specification("2"))


@pytest.mark.parametrize("wrong_curve", [False, True])
def test_go_result_must_match_requested_grid_and_code(
    monkeypatch: pytest.MonkeyPatch, wrong_curve: bool
) -> None:
    payload = {
        "curve_code": "parallel_up" if wrong_curve else "base",
        "points": [
            {
                "bucket_label": "another-bucket",
                "tenor_years": "3",
                "rate_percent": "1",
                **({} if wrong_curve else {"is_interpolated": False, "is_extrapolated": False}),
            }
        ],
    }

    def run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess("base-curve", 0, json.dumps(payload), "")

    monkeypatch.setattr("web.calculations.base_curve.subprocess.run", run)
    with pytest.raises(BaseCurveError, match="another curve or bucket grid"):
        build_base_curve(source(("1", "2"), ("3", "6")), specification("2"))
