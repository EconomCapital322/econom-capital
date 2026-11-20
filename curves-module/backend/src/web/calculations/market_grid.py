from decimal import Decimal

from web.repositories.models import CalculationSpec

MARKET_MIDPOINTS = (
    ("1d", "0.0028"),
    ("1m", "0.0417"),
    ("3m", "0.1667"),
    ("6m", "0.375"),
    ("9m", "0.625"),
    ("1y", "0.875"),
    ("1,5y", "1.25"),
    ("2y", "1.75"),
    ("3y", "2.5"),
    ("4y", "3.5"),
    ("5y", "4.5"),
    ("6y", "5.5"),
    ("7y", "6.5"),
    ("8y", "7.5"),
    ("9y", "8.5"),
    ("10y", "9.5"),
    ("15y", "12.5"),
    ("20y", "17.5"),
    ("30y", "25"),
    ("35y", "32.5"),
    ("40y", "37.5"),
    ("45y", "42.5"),
    ("50y", "47.5"),
)


def validate_market_midpoints(spec: CalculationSpec) -> CalculationSpec:
    if spec.data_provenance != "market":
        return spec
    actual = tuple((point.bucket_label, point.tenor_years) for point in spec.grid)
    expected = tuple((label, Decimal(tenor)) for label, tenor in MARKET_MIDPOINTS)
    if actual != expected:
        raise ValueError("Market calculation requires the project bucket midpoint grid")
    return spec
