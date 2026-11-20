"""Expose derived parameter columns without duplicating stored JSONB parameters."""

from alembic import op

revision = "0004_result_parameters"
down_revision = "0003_run_history"
branch_labels = None
depends_on = None

_COLUMNS = (
    "SELECT r.id AS run_id,r.report_date,r.source,r.run_origin,r.status,r.stage,"
    "r.created_at,r.completed_at,r.parent_run_id,r.scenario_parameters,"
    "r.calculation_spec,c.curve_code,p.bucket_label,p.tenor_years,p.rate,"
    "p.is_interpolated,p.is_extrapolated"
)
_FROM = " FROM curve_run r JOIN curve c ON c.run_id=r.id JOIN curve_point p ON p.curve_id=c.id"


def upgrade() -> None:
    op.execute(
        "CREATE OR REPLACE VIEW curve_result AS " + _COLUMNS + ","
        "r.scenario_parameters->>'mode' AS mode,"
        "(r.scenario_parameters->>'p')::numeric AS p,"
        "(r.scenario_parameters->>'k')::numeric AS k,"
        "(r.scenario_parameters->>'d')::numeric AS d" + _FROM
    )


def downgrade() -> None:
    # PostgreSQL cannot remove view columns with CREATE OR REPLACE VIEW.
    # No table data is removed, but dependent custom views must be handled explicitly.
    op.execute("DROP VIEW curve_result")
    op.execute("CREATE VIEW curve_result AS " + _COLUMNS + _FROM)
