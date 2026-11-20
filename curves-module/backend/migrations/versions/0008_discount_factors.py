"""Store discount factors for every saved curve point."""

from decimal import Decimal, DecimalException, localcontext

from alembic import op
from sqlalchemy import text

revision = "0008_discount_factors"
down_revision = "0007_curve_preparation"
branch_labels = None
depends_on = None


def _discount_factor(rate_percent: Decimal, tenor_years: Decimal) -> Decimal:
    try:
        with localcontext() as context:
            context.prec = 34
            value = (-(rate_percent / 100) * tenor_years).exp()
    except DecimalException as exc:
        raise ValueError("Historical discount factor cannot be calculated") from exc
    if not value.is_finite() or value <= 0:
        raise ValueError("Historical discount factor must be positive and finite")
    return value


def upgrade() -> None:
    op.execute("ALTER TABLE curve_point ADD COLUMN discount_factor numeric")
    connection = op.get_bind()
    rows = connection.execute(text("SELECT id, rate, tenor_years FROM curve_point"))
    update = text("UPDATE curve_point SET discount_factor=:factor WHERE id=:id")
    for row in rows.mappings():
        try:
            factor = _discount_factor(row["rate"], row["tenor_years"])
            connection.execute(update, {"id": row["id"], "factor": factor})
        except (ValueError, OverflowError) as exc:
            raise ValueError(f"Cannot backfill curve point {row['id']}") from exc
    op.execute("ALTER TABLE curve_point ALTER COLUMN discount_factor SET NOT NULL")
    op.execute(
        "ALTER TABLE curve_point ADD CONSTRAINT ck_point_discount_factor "
        "CHECK (discount_factor > 0 AND discount_factor NOT IN "
        "('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric))"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE curve_point DROP COLUMN discount_factor")
