"""Permit an explicit retry after an automatic calculation has failed."""

from alembic import op

revision = "0006_retryable_automatic_runs"
down_revision = "0005_parameter_limit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX uq_run_automatic_key")
    op.execute(
        "CREATE UNIQUE INDEX uq_run_automatic_key ON curve_run(automatic_key) "
        "WHERE automatic_key IS NOT NULL AND status<>'failed'"
    )


def downgrade() -> None:
    # A database containing two attempts with the same key cannot restore the old index.
    op.execute("DROP INDEX uq_run_automatic_key")
    op.execute(
        "CREATE UNIQUE INDEX uq_run_automatic_key ON curve_run(automatic_key) "
        "WHERE automatic_key IS NOT NULL"
    )
