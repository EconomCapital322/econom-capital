"""Restore the original run-history revision, verified against the legacy demo schema.

Downgrade removes provenance/idempotency metadata and the view. It is tested only
on disposable databases; never downgrade an existing history without approval.
"""

from alembic import op

revision = "0003_run_history"
down_revision = "0002_rate_column_names"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE curve_run ADD COLUMN run_origin text NOT NULL DEFAULT 'manual', "
        "ADD COLUMN automatic_key text, "
        "ADD CONSTRAINT ck_run_origin CHECK (run_origin IN ('manual','automatic')), "
        "ADD CONSTRAINT ck_automatic_key CHECK "
        "((run_origin='manual' AND automatic_key IS NULL) OR "
        "(run_origin='automatic' AND automatic_key ~ '^[0-9a-f]{64}$' "
        "AND automatic_key IS NOT NULL))"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_run_automatic_key ON curve_run(automatic_key) "
        "WHERE automatic_key IS NOT NULL"
    )
    op.execute(
        "CREATE VIEW curve_result AS SELECT r.id AS run_id,r.report_date,r.source,"
        "r.run_origin,r.status,r.stage,r.created_at,r.completed_at,r.parent_run_id,"
        "r.scenario_parameters,r.calculation_spec,c.curve_code,p.bucket_label,"
        "p.tenor_years,p.rate,p.is_interpolated,p.is_extrapolated "
        "FROM curve_run r JOIN curve c ON c.run_id=r.id "
        "JOIN curve_point p ON p.curve_id=c.id"
    )


def downgrade() -> None:
    op.execute("DROP VIEW curve_result")
    op.execute("DROP INDEX uq_run_automatic_key")
    op.execute(
        "ALTER TABLE curve_run DROP CONSTRAINT ck_automatic_key, "
        "DROP CONSTRAINT ck_run_origin, DROP COLUMN automatic_key, DROP COLUMN run_origin"
    )
