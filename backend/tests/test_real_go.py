import asyncio
from decimal import Decimal

import pytest

from core.config import IntegrationSettings
from tests.test_base_curve import source, specification
from web.calculations.base_curve import build_base_curve
from web.integrations.adapters import SlavaAdapter
from web.repositories.models import STRESS_CODES, ScenarioParameters


@pytest.mark.usefixtures("base_binary_on_path")
async def test_real_base_cli_to_real_stress_http(stress_url: str) -> None:
    spec = specification("0.25", "1", "2", "3", "4")
    base = await asyncio.to_thread(build_base_curve, source(("1", "2"), ("3", "6")), spec)
    parameters = ScenarioParameters(mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3))
    adapter = SlavaAdapter(
        IntegrationSettings.model_validate(
            {
                "stress_http_url": stress_url,
                "stress_http_version": spec.stress_version,
            }
        )
    )
    curves = await asyncio.to_thread(adapter.stress, base, parameters, spec.stress_version)
    assert len(curves) == 6 and {c.curve_code for c in curves} == STRESS_CODES
    for curve in curves:
        assert [(p.bucket_label, p.tenor_years) for p in curve.points] == [
            (p.bucket_label, p.tenor_years) for p in base.points
        ]
        assert all(p.rate_percent.is_finite() for p in curve.points)
    up = next(c for c in curves if c.curve_code == "parallel_up")
    # These integer/half inputs and the parallel shift are exactly representable in float64.
    assert [p.rate_percent for p in up.points] == [p.rate_percent + 4 for p in base.points]
