"""Use the requested rate column name while preserving numeric values and constraints."""

from alembic import op

revision = "0002_rate_column_names"
down_revision = "0001_curves"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE input_rate RENAME COLUMN rate_percent TO rate")
    op.execute("ALTER TABLE curve_point RENAME COLUMN rate_percent TO rate")


def downgrade() -> None:
    op.execute("ALTER TABLE curve_point RENAME COLUMN rate TO rate_percent")
    op.execute("ALTER TABLE input_rate RENAME COLUMN rate TO rate_percent")
