from __future__ import annotations

import asyncio
from datetime import timedelta
from decimal import Decimal
from typing import Any, TypeAlias
from uuid import UUID, uuid4

import asyncpg
import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from pydantic import ValidationError

from core.config import DatabaseSettings, Settings
from core.database import Database, DBConnection
from tests.conftest import AS_OF, REPORT_DATE, ROOT, migrate
from web.calculations.discount import discount_factor
from web.exceptions.curve_run import InputDataNotReady, StaleClaim
from web.repositories import curve_runs, curves, input_rates
from web.repositories.models import (
    STRESS_CODES,
    Bucket,
    CalculationSpec,
    Curve,
    CurvePoint,
    MarketRates,
    RatePoint,
    ScenarioParameters,
)

Conn = DBConnection
Pool: TypeAlias = "asyncpg.Pool[Any]"


async def seed_run(
    conn: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> UUID:
    await input_rates.InputRatesRepository.replace_current(conn, rates, loaded_at=AS_OF)
    return await curve_runs.CurveRunsRepository.create_run(
        conn, report_date=rates.report_date, parameters=parameters, spec=spec
    )


async def simulate_owner(conn: Conn, run_id: UUID) -> UUID:
    """Use the storage state transition; no worker process is involved."""
    token = await curve_runs.CurveRunsRepository.start_stage(
        conn,
        run_id=run_id,
        worker_id=uuid4(),
        lease_duration=timedelta(minutes=1),
    )
    assert token is not None
    return token


def fake_curve(spec: CalculationSpec, code: str = "base") -> Curve:
    return Curve.model_validate(
        {
            "curve_code": code,
            "points": [
                CurvePoint(
                    bucket_label=p.bucket_label,
                    tenor_years=p.tenor_years,
                    rate_percent=Decimal("-1.234"),
                    discount_factor=discount_factor(Decimal("-1.234"), p.tenor_years),
                    is_interpolated=False if code == "base" else None,
                    is_extrapolated=False if code == "base" else None,
                )
                for p in spec.grid
            ],
        }
    )


async def test_migrations_roundtrip(connection: Conn, database_dsn: str) -> None:
    tables = await connection.fetch("SELECT tablename FROM pg_tables WHERE schemaname='public'")
    assert {r[0] for r in tables} == {
        "curve_run",
        "input_rate",
        "curve",
        "curve_point",
        "alembic_version",
        "curve_preparation",
    }
    columns = await connection.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_name='curve_run'"
    )
    assert "scenario_parameters" in {r[0] for r in columns}
    assert not {"requested_parameters", "parameter_mode", "p", "k", "d"} & {r[0] for r in columns}
    indexes = await connection.fetch("SELECT indexdef FROM pg_indexes WHERE tablename='input_rate'")
    assert sum("WHERE" in r[0] and "UNIQUE" in r[0] for r in indexes) == 2
    await migrate(database_dsn, "base", downgrade=True)
    assert await connection.fetchval("SELECT to_regclass('public.curve_run')") is None
    await migrate(database_dsn)
    head = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini"))).get_current_head()
    assert await connection.fetchval("SELECT version_num FROM alembic_version") == head


async def test_discount_factor_migration_backfills_saved_points(
    connection: Conn,
    database_dsn: str,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, run_id)
    await curves.CurvesRepository.publish_stage(
        connection, run_id=run_id, claim_token=token, curves=(fake_curve(spec),)
    )
    await migrate(database_dsn, "0007_curve_preparation", downgrade=True)
    await connection.execute("UPDATE curve_point SET rate=0 WHERE bucket_label='synthetic-short'")
    await migrate(database_dsn)
    points = await connection.fetch(
        "SELECT bucket_label,rate,tenor_years,discount_factor FROM curve_point ORDER BY tenor_years"
    )
    assert len(points) == 2
    assert points[0]["rate"] == 0 and points[0]["discount_factor"] == 1
    assert points[1]["discount_factor"] == discount_factor(
        points[1]["rate"], points[1]["tenor_years"]
    )


async def test_snapshot_and_exact_json(
    connection: Conn, rates: MarketRates, spec: CalculationSpec
) -> None:
    p = Decimal("4.12345678901234567890123456789")
    params = ScenarioParameters(mode="custom", p=p, k=Decimal(5), d=Decimal(3))
    run_id = await seed_run(connection, rates, params, spec)
    second_id = await curve_runs.CurveRunsRepository.create_run(
        connection, report_date=REPORT_DATE, parameters=params, spec=spec
    )
    assert second_id != run_id
    row = await curve_runs.CurveRunsRepository.get_run(connection, run_id)
    assert row is not None and row.status == "queued" and (row.stage == "base")
    assert row.scenario_parameters == params
    assert row.scenario_parameters.p == p
    assert row.calculation_spec == spec
    snapshot = await input_rates.InputRatesRepository.read_snapshot(connection, run_id)
    assert snapshot is not None and snapshot.points == rates.points
    later = MarketRates(
        report_date=REPORT_DATE,
        source_as_of=AS_OF + timedelta(hours=1),
        points=(
            RatePoint(tenor_years=Decimal(1), rate_percent=Decimal(99)),
            RatePoint(tenor_years=Decimal(2), rate_percent=Decimal(100)),
        ),
    )
    await input_rates.InputRatesRepository.replace_current(
        connection, later, loaded_at=AS_OF + timedelta(hours=2)
    )
    assert await input_rates.InputRatesRepository.read_snapshot(connection, run_id) == snapshot
    assert not await input_rates.InputRatesRepository.replace_current(
        connection, rates, loaded_at=AS_OF
    )
    assert (
        await input_rates.InputRatesRepository.read_current(
            connection, REPORT_DATE + timedelta(days=1)
        )
        is None
    )
    assert len(await curve_runs.CurveRunsRepository.list_runs(connection, REPORT_DATE)) == 2


async def test_missing_inputs(
    connection: Conn, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    with pytest.raises(InputDataNotReady):
        await curve_runs.CurveRunsRepository.create_run(
            connection, report_date=REPORT_DATE, parameters=parameters, spec=spec
        )
    assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0


async def test_atomic_rollback(
    connection: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    await input_rates.InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    original = await input_rates.InputRatesRepository.read_current(connection, REPORT_DATE)
    await connection.execute(
        "\n        CREATE FUNCTION reject_insert() RETURNS trigger LANGUAGE plpgsql "
        "AS $$\n        BEGIN RAISE EXCEPTION 'injected persistence failure'; END "
        "$$;\n        CREATE TRIGGER reject_input BEFORE INSERT ON input_rate\n      "
        "  FOR EACH ROW EXECUTE FUNCTION reject_insert();\n    "
    )
    newer = rates.model_copy(update={"source_as_of": AS_OF + timedelta(hours=1)})
    with pytest.raises(asyncpg.RaiseError):
        await input_rates.InputRatesRepository.replace_current(connection, newer, loaded_at=AS_OF)
    assert await input_rates.InputRatesRepository.read_current(connection, REPORT_DATE) == original
    with pytest.raises(asyncpg.RaiseError):
        await curve_runs.CurveRunsRepository.create_run(
            connection, report_date=REPORT_DATE, parameters=parameters, spec=spec
        )
    assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"mode": "standard", "p": 3, "k": 5, "d": 3},
        {"mode": "custom", "p": 0, "k": 5, "d": 3},
        {"mode": "custom", "p": 51, "k": 5, "d": 3},
        {"mode": "custom", "p": 4, "k": 51, "d": 3},
        {"mode": "custom", "p": 4, "k": 5, "d": 51},
        {"mode": "custom", "p": "NaN", "k": 5, "d": 3},
        {"mode": "custom", "p": 4, "k": None, "d": 3},
        {"mode": "custom", "p": 4, "k": 5, "d": 3, "extra": 1},
    ],
)
async def test_database_parameters(
    connection: Conn,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
    payload: dict[str, Any],
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    with pytest.raises(asyncpg.CheckViolationError):
        await connection.execute(
            "UPDATE curve_run SET scenario_parameters=$2 WHERE id=$1", run_id, payload
        )


async def test_database_accepts_parameter_upper_boundary(
    connection: Conn, rates: MarketRates, spec: CalculationSpec
) -> None:
    parameters = ScenarioParameters(mode="custom", p=Decimal(50), k=Decimal(50), d=Decimal(50))
    run_id = await seed_run(connection, rates, parameters, spec)
    row = await curve_runs.CurveRunsRepository.get_run(connection, run_id)
    assert row is not None and row.scenario_parameters == parameters


@pytest.mark.parametrize("value", [Decimal("NaN"), Decimal("Infinity"), Decimal("-Infinity")])
async def test_database_finite(connection: Conn, rates: MarketRates, value: Decimal) -> None:
    await input_rates.InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    with pytest.raises(asyncpg.CheckViolationError):
        await connection.execute("UPDATE input_rate SET rate=$1", value)
    with pytest.raises(asyncpg.CheckViolationError):
        await connection.execute("UPDATE input_rate SET tenor_years=$1", value)


async def test_constraints(
    connection: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    for sql in (
        "UPDATE curve_run SET status='ready' WHERE id=$1",
        "UPDATE curve_run SET status='running' WHERE id=$1",
        "UPDATE curve_run SET status='failed' WHERE id=$1",
    ):
        with pytest.raises(asyncpg.CheckViolationError):
            await connection.execute(sql, run_id)
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await connection.execute("DELETE FROM curve_run WHERE id=$1", run_id)
    with pytest.raises(asyncpg.UniqueViolationError):
        await connection.execute(
            (
                "INSERT INTO input_rate SELECT "
                "$1,run_id,report_date,source,source_as_of,loaded_at,tenor_years,rate"
                " FROM input_rate WHERE run_id=$2 LIMIT 1"
            ),
            uuid4(),
            run_id,
        )


async def test_publish_and_fencing(
    connection: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, run_id)
    base = fake_curve(spec)
    with pytest.raises(StaleClaim):
        await curves.CurvesRepository.publish_stage(
            connection, run_id=run_id, claim_token=uuid4(), curves=(base,)
        )
    await curves.CurvesRepository.publish_stage(
        connection, run_id=run_id, claim_token=token, curves=(base,)
    )
    state = await curves.CurvesRepository.read_state(connection, run_id)
    assert state is not None and state[0].status == "queued" and (state[0].stage == "stress")
    assert state[1] == (base,)
    with pytest.raises(StaleClaim):
        await curves.CurvesRepository.publish_stage(
            connection, run_id=run_id, claim_token=token, curves=(base,)
        )
    new_token = await simulate_owner(connection, run_id)
    stresses = tuple(fake_curve(spec, code) for code in sorted(STRESS_CODES))
    with pytest.raises(ValueError):
        await curves.CurvesRepository.publish_stage(
            connection, run_id=run_id, claim_token=new_token, curves=stresses[:5]
        )
    assert await curves.CurvesRepository.read_curves(connection, run_id) == (base,)
    await curves.CurvesRepository.publish_stage(
        connection, run_id=run_id, claim_token=new_token, curves=stresses
    )
    ready = await curves.CurvesRepository.read_state(connection, run_id)
    assert ready is not None and ready[0].status == "ready" and (len(ready[1]) == 7)
    assert ready[0].completed_at is not None
    with pytest.raises(StaleClaim):
        await curves.CurvesRepository.publish_stage(
            connection, run_id=run_id, claim_token=new_token, curves=stresses
        )


async def test_variable_grids(
    connection: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    for size in (1, 3, 23):
        different = spec.model_copy(
            update={
                "grid": tuple(
                    Bucket(bucket_label=f"test-{i}", tenor_years=Decimal(i + 1))
                    for i in range(size)
                )
            }
        )
        run_id = await seed_run(connection, rates, parameters, different)
        token = await simulate_owner(connection, run_id)
        with pytest.raises(ValueError):
            await curves.CurvesRepository.publish_stage(
                connection, run_id=run_id, claim_token=token, curves=(fake_curve(spec),)
            )
        await curves.CurvesRepository.publish_stage(
            connection, run_id=run_id, claim_token=token, curves=(fake_curve(different),)
        )
        stored = await curves.CurvesRepository.read_curves(connection, run_id)
        assert len(stored[0].points) == size


async def test_loader_snapshot_lock(
    db_pool: Pool, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    newer = rates.model_copy(update={"source_as_of": AS_OF + timedelta(hours=1)})
    async with db_pool.acquire() as first, db_pool.acquire() as second:
        await input_rates.InputRatesRepository.replace_current(first, rates, loaded_at=AS_OF)
        async with first.transaction():
            await input_rates.InputRatesRepository.replace_current(
                first, newer, loaded_at=AS_OF + timedelta(hours=2)
            )
            task = asyncio.create_task(
                curve_runs.CurveRunsRepository.create_run(
                    second, report_date=REPORT_DATE, parameters=parameters, spec=spec
                )
            )
            try:
                async with asyncio.timeout(3):
                    while not await first.fetchval(  # noqa: ASYNC110 -- observe external DB lock
                        "SELECT cardinality(pg_blocking_pids($1)) > 0", second.get_server_pid()
                    ):
                        await asyncio.sleep(0.01)
                assert not task.done()
            except BaseException:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise
        run_id = await task
        snapshot = await input_rates.InputRatesRepository.read_snapshot(first, run_id)
        assert snapshot is not None and snapshot.source_as_of == newer.source_as_of


async def test_pool_release(database_dsn: str) -> None:
    config = DatabaseSettings(dsn=database_dsn, max_pool_size=1)
    async with Database.open(config) as database:
        pool = database.pool
        with pytest.raises(RuntimeError):
            async with pool.acquire():
                raise RuntimeError("test failure")
        async with pool.acquire() as conn:
            assert await conn.fetchval("SELECT 1") == 1
        entered = asyncio.Event()

        async def borrower() -> None:
            async with pool.acquire():
                entered.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(borrower())
        await entered.wait()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        async with pool.acquire() as conn:
            assert await conn.fetchval("SELECT 1") == 1
    assert pool.is_closing()


def test_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE__DSN", "postgresql://test:secret@localhost/test")
    assert "secret" not in repr(Settings())
    with pytest.raises(ValidationError):
        DatabaseSettings(dsn="postgresql://localhost/test", min_pool_size=2, max_pool_size=1)


async def expire_owner(conn: Conn, run_id: UUID) -> None:
    await conn.execute(
        (
            "WITH t AS (SELECT clock_timestamp() ts) UPDATE curve_run SET "
            "created_at=t.ts-interval '2 minutes',started_at=t.ts-interval '1 "
            "minute',stage_started_at=t.ts-interval '1 "
            "minute',heartbeat_at=t.ts-interval '30 "
            "seconds',lease_expires_at=t.ts-interval '1 second' FROM t WHERE id=$1"
        ),
        run_id,
    )


async def test_expired_claim(
    connection: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, run_id)
    await expire_owner(connection, run_id)
    with pytest.raises(StaleClaim):
        await curves.CurvesRepository.publish_stage(
            connection, run_id=run_id, claim_token=token, curves=(fake_curve(spec),)
        )
    assert await curves.CurvesRepository.read_curves(connection, run_id) == ()


async def test_expiry_during_publication(
    connection: Conn,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, run_id)
    insert = curves.CurvesRepository._insert

    async def expire_after_insert(conn: Conn, run: UUID, curve: Curve) -> None:
        await insert(conn, run, curve)
        await expire_owner(conn, run)

    monkeypatch.setattr(curves.CurvesRepository, "_insert", staticmethod(expire_after_insert))
    with pytest.raises(StaleClaim):
        await curves.CurvesRepository.publish_stage(
            connection, run_id=run_id, claim_token=token, curves=(fake_curve(spec),)
        )
    assert await curves.CurvesRepository.read_curves(connection, run_id) == ()
    row = await curve_runs.CurveRunsRepository.get_run(connection, run_id)
    assert row is not None and row.status == "running" and (row.claim_token == token)


async def test_concurrent_publication(
    db_pool: Pool, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    async with db_pool.acquire() as first, db_pool.acquire() as second:
        run_id = await seed_run(first, rates, parameters, spec)
        token = await simulate_owner(first, run_id)
        results = await asyncio.gather(
            curves.CurvesRepository.publish_stage(
                first, run_id=run_id, claim_token=token, curves=(fake_curve(spec),)
            ),
            curves.CurvesRepository.publish_stage(
                second, run_id=run_id, claim_token=token, curves=(fake_curve(spec),)
            ),
            return_exceptions=True,
        )
        assert sum(result is None for result in results) == 1
        assert sum(isinstance(result, StaleClaim) for result in results) == 1
        assert len(await curves.CurvesRepository.read_curves(first, run_id)) == 1


async def test_partial_stress_rollback(
    connection: Conn,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, run_id)
    base = fake_curve(spec)
    await curves.CurvesRepository.publish_stage(
        connection, run_id=run_id, claim_token=token, curves=(base,)
    )
    token = await simulate_owner(connection, run_id)
    insert = curves.CurvesRepository._insert
    calls = 0

    async def fail_second(conn: Conn, run: UUID, curve: Curve) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("injected write failure")
        await insert(conn, run, curve)

    monkeypatch.setattr(curves.CurvesRepository, "_insert", staticmethod(fail_second))
    with pytest.raises(RuntimeError, match="injected"):
        await curves.CurvesRepository.publish_stage(
            connection,
            run_id=run_id,
            claim_token=token,
            curves=tuple(fake_curve(spec, code) for code in STRESS_CODES),
        )
    assert await curves.CurvesRepository.read_curves(connection, run_id) == (base,)
    row = await curve_runs.CurveRunsRepository.get_run(connection, run_id)
    assert row is not None and row.stage == "stress" and (row.status == "running")


async def test_current_uniqueness_and_savepoint(
    connection: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    await input_rates.InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    with pytest.raises(asyncpg.UniqueViolationError):
        await connection.execute(
            (
                "INSERT INTO input_rate SELECT "
                "$1,run_id,report_date,source,source_as_of,loaded_at,tenor_years,rate"
                " FROM input_rate WHERE run_id IS NULL LIMIT 1"
            ),
            uuid4(),
        )
    async with connection.transaction():
        with pytest.raises(ValidationError):
            MarketRates(
                report_date=REPORT_DATE,
                source_as_of=AS_OF,
                points=(rates.points[0], rates.points[0]),
            )
        assert not await input_rates.InputRatesRepository.replace_current(
            connection, rates, loaded_at=AS_OF
        )
    async with connection.transaction(isolation="repeatable_read"):
        with pytest.raises(RuntimeError, match="READ COMMITTED"):
            await curve_runs.CurveRunsRepository.create_run(
                connection, report_date=REPORT_DATE, parameters=parameters, spec=spec
            )
    assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0


async def test_saved_failure_preserves_base(
    connection: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    from web.repositories.models import CalculationError

    run_id = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, run_id)
    base = fake_curve(spec)
    await curves.CurvesRepository.publish_stage(
        connection, run_id=run_id, claim_token=token, curves=(base,)
    )
    token = await simulate_owner(connection, run_id)
    error = CalculationError(
        code="CALCULATION_FAILED", message="Synthetic test failure", curve_code="parallel_up"
    )
    await curve_runs.CurveRunsRepository.save_failure(
        connection, run_id=run_id, claim_token=token, error=error
    )
    state = await curves.CurvesRepository.read_state(connection, run_id)
    assert state is not None and state[0].status == "failed" and (state[0].stage == "stress")
    assert state[0].error is not None
    assert state[0].error.model_dump(mode="json", by_alias=True, exclude_none=True) == {
        "code": "CALCULATION_FAILED",
        "message": "Synthetic test failure",
        "details": [],
        "curveCode": "parallel_up",
    }
    assert state[1] == (base,)
    with pytest.raises(StaleClaim):
        await curve_runs.CurveRunsRepository.save_failure(
            connection, run_id=run_id, claim_token=token, error=error
        )


async def test_durable_queue_after_pool_close(
    database_dsn: str, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    async with Database.open(DatabaseSettings(dsn=database_dsn)) as first_database:
        first_pool = first_database.pool
        async with first_pool.acquire() as first:
            run_id = await seed_run(first, rates, parameters, spec)
    async with Database.open(DatabaseSettings(dsn=database_dsn)) as second_database:
        second_pool = second_database.pool
        async with second_pool.acquire() as second:
            row = await curve_runs.CurveRunsRepository.get_run(second, run_id)
            assert row is not None and row.status == "queued"
            assert row.scenario_parameters == parameters
            assert await input_rates.InputRatesRepository.read_snapshot(second, run_id) is not None


async def test_replacement_revalidates_model_before_deleting_current(
    connection: Conn, rates: MarketRates
) -> None:
    await input_rates.InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    before = await input_rates.InputRatesRepository.read_current(connection, rates.report_date)
    invalid = rates.model_copy(
        update={"source_as_of": AS_OF + timedelta(hours=1), "points": (rates.points[0],)}
    )
    with pytest.raises(ValidationError):
        await input_rates.InputRatesRepository.replace_current(connection, invalid, loaded_at=AS_OF)
    assert (
        await input_rates.InputRatesRepository.read_current(connection, rates.report_date) == before
    )


async def test_publication_revalidates_nested_decimal_before_writing(
    connection: Conn, rates: MarketRates, parameters: ScenarioParameters, spec: CalculationSpec
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, run_id)
    valid = fake_curve(spec)
    invalid = valid.model_copy(
        update={
            "points": (
                valid.points[0].model_copy(update={"rate_percent": Decimal("1e-16384")}),
                *valid.points[1:],
            )
        }
    )
    with pytest.raises(ValidationError):
        await curves.CurvesRepository.publish_stage(
            connection, run_id=run_id, claim_token=token, curves=(invalid,)
        )
    assert await curves.CurvesRepository.read_curves(connection, run_id) == ()
    run = await curve_runs.CurveRunsRepository.get_run(connection, run_id)
    assert run is not None and run.status == "running" and run.claim_token == token
