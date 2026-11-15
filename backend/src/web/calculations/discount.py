from decimal import Decimal, DecimalException, localcontext

from web.repositories.models import Curve, postgres_numeric


def discount_factor(rate_percent: Decimal, tenor_years: Decimal) -> Decimal:
    try:
        with localcontext() as context:
            context.prec = 34
            value = (-(rate_percent / 100) * tenor_years).exp()
    except DecimalException as exc:
        raise ValueError("Discount factor cannot be calculated") from exc
    if not value.is_finite() or value <= 0:
        raise ValueError("Discount factor must be positive and finite")
    return postgres_numeric(value)


def with_discount_factors(curve: Curve) -> Curve:
    return Curve.model_validate(
        curve.model_copy(
            update={
                "points": tuple(
                    point.model_copy(
                        update={
                            "discount_factor": discount_factor(
                                point.rate_percent, point.tenor_years
                            )
                        }
                    )
                    for point in curve.points
                )
            }
        )
    )
