"""Allow scenario parameters through 50 percentage points."""

from alembic import op

revision = "0005_parameter_limit"
down_revision = "0004_result_parameters"
branch_labels = None
depends_on = None


def _set_parameter_limit(maximum: int) -> None:
    op.execute("ALTER TABLE curve_run DROP CONSTRAINT ck_run_parameters")
    op.execute(f"""
        ALTER TABLE curve_run ADD CONSTRAINT ck_run_parameters CHECK (
            CASE WHEN jsonb_typeof(scenario_parameters) = 'object'
                AND scenario_parameters ?& ARRAY['mode','p','k','d']
                AND scenario_parameters - ARRAY['mode','p','k','d'] = '{{}}'::jsonb
                AND jsonb_typeof(scenario_parameters->'mode') = 'string'
                AND jsonb_typeof(scenario_parameters->'p') = 'number'
                AND jsonb_typeof(scenario_parameters->'k') = 'number'
                AND jsonb_typeof(scenario_parameters->'d') = 'number'
            THEN (
                scenario_parameters->>'mode' IN ('standard','custom')
                AND (scenario_parameters->>'p')::numeric > 0
                AND (scenario_parameters->>'p')::numeric <= {maximum}
                AND (scenario_parameters->>'k')::numeric > 0
                AND (scenario_parameters->>'k')::numeric <= {maximum}
                AND (scenario_parameters->>'d')::numeric > 0
                AND (scenario_parameters->>'d')::numeric <= {maximum}
                AND (scenario_parameters->>'mode' <> 'standard' OR
                    ((scenario_parameters->>'p')::numeric = 4
                     AND (scenario_parameters->>'k')::numeric = 5
                     AND (scenario_parameters->>'d')::numeric = 3))
            ) ELSE false END
        )
    """)


def upgrade() -> None:
    _set_parameter_limit(50)


def downgrade() -> None:
    # PostgreSQL rejects this if rows with parameters above 25 remain.
    _set_parameter_limit(25)
