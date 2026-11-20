from decimal import Decimal
from math import exp, isclose
from pathlib import Path

import pytest
import simplejson

from tests.conftest import ROOT
from web.calculations.discount import discount_factor
from web.exceptions.curve_run import ImplementationUnavailable
from web.integrations.specification import load_specification


def test_discount_factor_uses_percent_rate_and_handles_zero_and_negative() -> None:
    assert discount_factor(Decimal(0), Decimal(2)) == 1
    positive = discount_factor(Decimal(10), Decimal(2))
    negative = discount_factor(Decimal(-10), Decimal(2))
    assert isclose(float(positive), exp(-0.2), rel_tol=1e-15)
    assert isclose(float(negative), exp(0.2), rel_tol=1e-15)
    assert positive < 1 < negative


def test_market_specification_requires_project_midpoints(tmp_path: Path) -> None:
    source = ROOT / "examples/moex-excel-grid-spec.json"
    path = tmp_path / "spec.json"
    spec = simplejson.loads(source.read_text(), use_decimal=True)
    path.write_text(simplejson.dumps(spec, use_decimal=True))
    assert load_specification(path).data_provenance == "market"

    spec["grid"][0]["tenor_years"] = "0.0014"
    path.write_text(simplejson.dumps(spec, use_decimal=True))
    with pytest.raises(ImplementationUnavailable):
        load_specification(path)

    spec["data_provenance"] = "synthetic"
    path.write_text(simplejson.dumps(spec, use_decimal=True))
    assert load_specification(path).data_provenance == "synthetic"
