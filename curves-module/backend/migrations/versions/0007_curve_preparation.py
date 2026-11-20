"""Durable date preparation queue shared by UI, scheduler and worker."""

from alembic import op

revision = "0007_curve_preparation"
down_revision = "0006_retryable_automatic_runs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE curve_preparation (
            report_date date PRIMARY KEY,
            status varchar(20) NOT NULL CHECK (status IN
                ('queued','running','ready','no_data','failed')),
            run_id uuid REFERENCES curve_run(id) ON DELETE SET NULL,
            requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            priority integer NOT NULL DEFAULT 0,
            claim_token uuid,
            lease_until timestamptz,
            last_scheduled_on date,
            error_code varchar(40),
            CHECK ((status='running') = (claim_token IS NOT NULL AND lease_until IS NOT NULL))
        )
    """)
    op.execute(
        "CREATE INDEX ix_preparation_queue ON curve_preparation(priority DESC, requested_at) "
        "WHERE status IN ('queued','running')"
    )


def downgrade() -> None:
    op.execute("DROP TABLE curve_preparation")
