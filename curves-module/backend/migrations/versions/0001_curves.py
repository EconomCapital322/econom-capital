"""Four business tables, durable run state and exact numeric data."""

from alembic import op

revision = "0001_curves"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE curve_run (
            id uuid PRIMARY KEY,
            report_date date NOT NULL,
            source text NOT NULL CHECK (source = 'moex'),
            currency text NOT NULL CHECK (currency = 'RUB'),
            scenario_parameters jsonb NOT NULL,
            calculation_spec jsonb NOT NULL CHECK (jsonb_typeof(calculation_spec) = 'object'),
            status text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'ready', 'failed')),
            stage text NOT NULL DEFAULT 'base' CHECK (stage IN ('base', 'stress')),
            created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            started_at timestamptz,
            stage_started_at timestamptz,
            completed_at timestamptz,
            error jsonb,
            worker_id uuid,
            claim_token uuid,
            heartbeat_at timestamptz,
            lease_expires_at timestamptz,
            source_as_of timestamptz NOT NULL,
            input_loaded_at timestamptz NOT NULL,
            parent_run_id uuid REFERENCES curve_run(id) ON DELETE RESTRICT,
            CONSTRAINT ck_run_parameters CHECK (
                CASE WHEN jsonb_typeof(scenario_parameters) = 'object'
                    AND scenario_parameters ?& ARRAY['mode','p','k','d']
                    AND scenario_parameters - ARRAY['mode','p','k','d'] = '{}'::jsonb
                    AND jsonb_typeof(scenario_parameters->'mode') = 'string'
                    AND jsonb_typeof(scenario_parameters->'p') = 'number'
                    AND jsonb_typeof(scenario_parameters->'k') = 'number'
                    AND jsonb_typeof(scenario_parameters->'d') = 'number'
                THEN (
                    scenario_parameters->>'mode' IN ('standard','custom')
                    AND (scenario_parameters->>'p')::numeric > 0
                    AND (scenario_parameters->>'p')::numeric <= 25
                    AND (scenario_parameters->>'k')::numeric > 0
                    AND (scenario_parameters->>'k')::numeric <= 25
                    AND (scenario_parameters->>'d')::numeric > 0
                    AND (scenario_parameters->>'d')::numeric <= 25
                    AND (scenario_parameters->>'mode' <> 'standard' OR
                        ((scenario_parameters->>'p')::numeric = 4
                         AND (scenario_parameters->>'k')::numeric = 5
                         AND (scenario_parameters->>'d')::numeric = 3))
                ) ELSE false END
            ),
            CONSTRAINT ck_run_error CHECK (error IS NULL OR (
                jsonb_typeof(error) = 'object'
                AND error ?& ARRAY['code','message','details']
                AND jsonb_typeof(error->'code') = 'string'
                AND btrim(error->>'code') <> ''
                AND jsonb_typeof(error->'message') = 'string'
                AND btrim(error->>'message') <> ''
                AND jsonb_typeof(error->'details') = 'array'
                AND (NOT error ? 'curveCode' OR error->>'curveCode' IN (
                    'base', 'parallel_up', 'parallel_down', 'steepener', 'flattener',
                    'short_rate_up', 'short_rate_down'))
            ) IS TRUE),
            CONSTRAINT ck_run_lifecycle CHECK (
                (status <> 'ready' OR stage = 'stress')
                AND ((status = 'failed') = (error IS NOT NULL))
                AND ((status IN ('ready','failed')) = (completed_at IS NOT NULL))
                AND (status <> 'ready' OR started_at IS NOT NULL)
                AND ((status = 'running' AND started_at IS NOT NULL
                    AND stage_started_at IS NOT NULL AND worker_id IS NOT NULL
                    AND claim_token IS NOT NULL AND heartbeat_at IS NOT NULL
                    AND lease_expires_at IS NOT NULL)
                  OR (status <> 'running' AND worker_id IS NULL AND claim_token IS NULL
                    AND heartbeat_at IS NULL AND lease_expires_at IS NULL))
            ),
            CONSTRAINT ck_run_times CHECK (
                updated_at >= created_at
                AND (started_at IS NULL OR started_at >= created_at)
                AND (completed_at IS NULL OR completed_at >= created_at)
                AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
                AND (stage_started_at IS NULL OR
                    (started_at IS NOT NULL AND stage_started_at >= started_at))
                AND (heartbeat_at IS NULL OR heartbeat_at >= stage_started_at)
                AND (lease_expires_at IS NULL OR lease_expires_at > heartbeat_at)
            ),
            CHECK (parent_run_id IS NULL OR parent_run_id <> id)
        )
    """)
    op.execute("""
        CREATE TABLE input_rate (
            id uuid PRIMARY KEY,
            run_id uuid REFERENCES curve_run(id) ON DELETE RESTRICT,
            report_date date NOT NULL,
            source text NOT NULL CHECK (source = 'moex'),
            source_as_of timestamptz NOT NULL,
            loaded_at timestamptz NOT NULL,
            tenor_years numeric NOT NULL CHECK (tenor_years > 0 AND
                tenor_years NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
            rate_percent numeric NOT NULL CHECK (
                rate_percent NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric))
        )
    """)
    op.execute("""
        CREATE TABLE curve (
            id uuid PRIMARY KEY,
            run_id uuid NOT NULL REFERENCES curve_run(id) ON DELETE RESTRICT,
            curve_code text NOT NULL CHECK (curve_code IN (
                'base','parallel_up','parallel_down','steepener','flattener',
                'short_rate_up','short_rate_down')),
            created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT uq_curve_run_code UNIQUE (run_id, curve_code)
        )
    """)
    op.execute("""
        CREATE TABLE curve_point (
            id uuid PRIMARY KEY,
            curve_id uuid NOT NULL REFERENCES curve(id) ON DELETE RESTRICT,
            tenor_years numeric NOT NULL CHECK (tenor_years > 0 AND
                tenor_years NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
            rate_percent numeric NOT NULL CHECK (
                rate_percent NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
            bucket_label text NOT NULL CHECK (btrim(bucket_label) <> ''),
            is_interpolated boolean,
            is_extrapolated boolean,
            CONSTRAINT uq_point_tenor UNIQUE (curve_id, tenor_years),
            CONSTRAINT uq_point_label UNIQUE (curve_id, bucket_label),
            CONSTRAINT ck_point_flags CHECK (
                (is_interpolated IS NULL AND is_extrapolated IS NULL)
                OR (is_interpolated IS NOT NULL AND is_extrapolated IS NOT NULL
                    AND NOT (is_interpolated AND is_extrapolated)))
        )
    """)
    for statement in (
        "CREATE INDEX ix_run_date ON curve_run(report_date, created_at DESC, id DESC)",
        "CREATE INDEX ix_run_queue ON curve_run(created_at,id) WHERE status='queued'",
        "CREATE INDEX ix_run_lease ON curve_run(lease_expires_at,id) WHERE status='running'",
        "CREATE INDEX ix_run_parent ON curve_run(parent_run_id)",
        "CREATE UNIQUE INDEX uq_input_current ON input_rate(report_date,source,tenor_years) "
        "WHERE run_id IS NULL",
        "CREATE UNIQUE INDEX uq_input_snapshot ON input_rate(run_id,tenor_years) "
        "WHERE run_id IS NOT NULL",
    ):
        op.execute(statement)


def downgrade() -> None:
    # Explicit operator action, never called by app startup. Tests use newly created databases.
    for table in ("curve_point", "curve", "input_rate", "curve_run"):
        op.execute(f"DROP TABLE {table}")
