from __future__ import annotations

import logging
from datetime import timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import asyncpg
import pytest
from pydantic import ValidationError

from core.config import DatabaseSettings, LoggingSettings, Settings
from core.database import Database
from core.logging import configure_logging
from tests.conftest import AS_OF, REPORT_DATE, migrate
from tests.test_storage import fake_curve, seed_run, simulate_owner
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import CalculationSpec, MarketRates, ScenarioParameters


def test_dotenv_nested_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "DATABASE__DSN=postgresql://test:sample-secret@localhost/test\n"
        "DATABASE__MAX_POOL_SIZE=2\nLOGGING__LEVEL=DEBUG\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("DATABASE__DSN", raising=False)
    monkeypatch.setenv("DATABASE__MAX_POOL_SIZE", "7")
    settings = Settings(_env_file=dotenv)
    assert settings.database.max_pool_size == 7
    assert settings.logging.level == "DEBUG"
    assert "sample-secret" not in repr(settings)
    with pytest.raises(ValidationError) as error:
        DatabaseSettings(
            dsn="postgresql://test:sample-secret@localhost/test", min_pool_size=3, max_pool_size=1
        )
    assert "sample-secret" not in str(error.value)


def test_logging_redacts_message_and_traceback(capsys: pytest.CaptureFixture[str]) -> None:
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    try:
        configure_logging(LoggingSettings(level="DEBUG"))
        logger = logging.getLogger("irrbb.test")
        logger.info("Connecting to %s", "postgresql://test:sample-secret@localhost/test")
        try:
            raise ValueError("postgresql+asyncpg://test:sample-secret@localhost/test")
        except ValueError:
            logger.exception("Synthetic connection failure")
        output = capsys.readouterr().out
        assert "sample-secret" not in output
        assert "localhost/test" not in output
        assert "[database URL redacted]" in output
        assert "Traceback" in output and "INFO" in output and "ERROR" in output
    finally:
        for handler in root.handlers:
            handler.close()
        root.handlers, root.level = handlers, level


async def test_database_shared_transaction(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    database = Database(db_pool, DatabaseSettings(dsn="postgresql://unused/test"))
    with pytest.raises(RuntimeError, match="rollback"):
        async with database.transaction() as conn:
            await InputRatesRepository.replace_current(conn, rates, loaded_at=AS_OF)
            await CurveRunsRepository.create_run(
                conn,
                report_date=REPORT_DATE,
                parameters=parameters,
                spec=spec,
            )
            raise RuntimeError("rollback all repositories together")
    async with database.connection() as conn:
        assert await InputRatesRepository.read_current(conn, REPORT_DATE) is None
        assert await conn.fetchval("SELECT count(*) FROM curve_run") == 0


async def test_pool_acquire_and_query_timeouts(database_dsn: str) -> None:
    settings = DatabaseSettings(
        dsn=database_dsn, max_pool_size=1, acquire_timeout=0.03, command_timeout=0.03
    )
    async with Database.open(settings) as database:
        async with database.connection() as conn:
            pid = conn.get_server_pid()
            with pytest.raises(TimeoutError):
                async with database.connection():
                    pytest.fail("Pool must be exhausted")
            with pytest.raises(TimeoutError):
                await conn.execute("SELECT pg_sleep(1)")
            assert await conn.fetchval("SELECT 1") == 1
        async with database.connection() as conn:
            assert conn.get_server_pid() == pid


async def test_close_timeout_terminates_pool(database_dsn: str) -> None:
    settings = DatabaseSettings(dsn=database_dsn, max_pool_size=1, close_timeout=0.03)
    pool: asyncpg.Pool[Any] | None = None
    with pytest.raises(TimeoutError):
        async with Database.open(settings) as database:
            pool = database.pool
            await pool.acquire()
    assert pool is not None and pool.is_closing()


async def test_process_context_closes_on_exception(
    database_dsn: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    database = None
    try:
        with pytest.raises(RuntimeError, match="process shutdown"):
            configure_logging(LoggingSettings())
            async with Database.open(DatabaseSettings(dsn=database_dsn)) as db:
                database = db
                async with db.connection() as conn:
                    assert await conn.fetchval("SELECT 1") == 1
                raise RuntimeError("process shutdown")
        assert database is not None and database.pool.is_closing()
        output = capsys.readouterr().out
        assert "pool opened" in output and "pool closed" in output
        assert database_dsn not in output
    finally:
        for handler in root.handlers:
            handler.close()
        root.handlers, root.level = handlers, level


async def test_current_set_visibility_and_timezones(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
) -> None:
    newer = rates.model_copy(
        update={
            "source_as_of": (AS_OF + timedelta(hours=1)).astimezone(timezone(timedelta(hours=3))),
        }
    )
    async with db_pool.acquire() as writer, db_pool.acquire() as reader:
        await InputRatesRepository.replace_current(writer, rates, loaded_at=AS_OF)
        original = await InputRatesRepository.read_current(reader, REPORT_DATE)
        async with writer.transaction():
            await InputRatesRepository.replace_current(
                writer, newer, loaded_at=AS_OF + timedelta(hours=2)
            )
            assert await InputRatesRepository.read_current(reader, REPORT_DATE) == original
        updated = await InputRatesRepository.read_current(reader, REPORT_DATE)
        assert updated is not None and updated.source_as_of == newer.source_as_of
        assert updated.points == rates.points
        assert await InputRatesRepository.read_snapshot(reader, uuid4()) is None
        assert await CurveRunsRepository.get_run(reader, uuid4()) is None
        assert await CurvesRepository.read_state(reader, uuid4()) is None
        assert await CurvesRepository.read_curves(reader, uuid4()) == ()


async def test_rename_migration_preserves_populated_tables(
    db_pool: asyncpg.Pool[Any],
    database_dsn: str,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    async with db_pool.acquire() as conn:
        run_id = await seed_run(conn, rates, parameters, spec)
        token = await simulate_owner(conn, run_id)
        await CurvesRepository.publish_stage(
            conn, run_id=run_id, claim_token=token, curves=(fake_curve(spec),)
        )
        before = await conn.fetch("SELECT id,rate FROM input_rate ORDER BY id")
        points = await conn.fetch("SELECT id,rate FROM curve_point ORDER BY id")
        await migrate(database_dsn, "0001_curves", downgrade=True)
        assert [tuple(r) for r in before] == [
            tuple(r) for r in await conn.fetch("SELECT id,rate_percent FROM input_rate ORDER BY id")
        ]
        assert [tuple(r) for r in points] == [
            tuple(r)
            for r in await conn.fetch("SELECT id,rate_percent FROM curve_point ORDER BY id")
        ]
        await migrate(database_dsn)
        assert before == await conn.fetch("SELECT id,rate FROM input_rate ORDER BY id")
        assert points == await conn.fetch("SELECT id,rate FROM curve_point ORDER BY id")


async def test_concurrent_start_stage(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    import asyncio

    async with db_pool.acquire() as first, db_pool.acquire() as second:
        run_id = await seed_run(first, rates, parameters, spec)
        results = await asyncio.gather(
            CurveRunsRepository.start_stage(
                first, run_id=run_id, worker_id=uuid4(), lease_duration=timedelta(seconds=15)
            ),
            CurveRunsRepository.start_stage(
                second, run_id=run_id, worker_id=uuid4(), lease_duration=timedelta(seconds=15)
            ),
        )
        assert sum(token is not None for token in results) == 1
        row = await CurveRunsRepository.get_run(first, run_id)
        assert row is not None and row.status == "running"
        assert row.claim_token in results and row.claim_token is not None
        assert row.heartbeat_at is not None and row.lease_expires_at is not None
        assert row.heartbeat_at < row.lease_expires_at
        assert (
            await CurveRunsRepository.start_stage(
                first,
                run_id=uuid4(),
                worker_id=uuid4(),
                lease_duration=timedelta(seconds=15),
            )
            is None
        )
        with pytest.raises(ValueError, match="positive"):
            await CurveRunsRepository.start_stage(
                first,
                run_id=run_id,
                worker_id=uuid4(),
                lease_duration=timedelta(0),
            )


async def test_curve_and_point_constraints(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    async with db_pool.acquire() as conn:
        run_id = await seed_run(conn, rates, parameters, spec)
        token = await simulate_owner(conn, run_id)
        await CurvesRepository.publish_stage(
            conn,
            run_id=run_id,
            claim_token=token,
            curves=(fake_curve(spec),),
        )
        with pytest.raises(asyncpg.UniqueViolationError):
            await conn.execute(
                "INSERT INTO curve(id,run_id,curve_code) VALUES ($1,$2,'base')", uuid4(), run_id
            )
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await conn.execute(
                "INSERT INTO curve(id,run_id,curve_code) VALUES ($1,$2,'base')", uuid4(), uuid4()
            )
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await conn.execute(
                "INSERT INTO curve_point"
                "(id,curve_id,bucket_label,tenor_years,rate,discount_factor) "
                "VALUES ($1,$2,'test-orphan',1,-5,1)",
                uuid4(),
                uuid4(),
            )
        curve_id = await conn.fetchval("SELECT id FROM curve WHERE run_id=$1", run_id)
        with pytest.raises(asyncpg.UniqueViolationError):
            await conn.execute(
                "INSERT INTO curve_point "
                "SELECT $1,curve_id,tenor_years,rate,'different-label',"
                "is_interpolated,is_extrapolated,discount_factor "
                "FROM curve_point WHERE curve_id=$2 LIMIT 1",
                uuid4(),
                curve_id,
            )
        with pytest.raises(asyncpg.UniqueViolationError):
            await conn.execute(
                "INSERT INTO curve_point "
                "SELECT $1,curve_id,999,rate,bucket_label,is_interpolated,is_extrapolated,"
                "discount_factor "
                "FROM curve_point WHERE curve_id=$2 LIMIT 1",
                uuid4(),
                curve_id,
            )
        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute("UPDATE curve_point SET is_interpolated=true,is_extrapolated=true")
        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute("UPDATE curve_point SET tenor_years=0")
        assert len(await CurvesRepository.read_curves(conn, run_id)) == 1


async def test_state_read_in_service_transaction(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    async with db_pool.acquire() as conn:
        run_id = await seed_run(conn, rates, parameters, spec)
    database = Database(db_pool, DatabaseSettings(dsn="postgresql://unused/test"))
    for isolation in ("repeatable_read", "serializable"):
        # The service owns one transaction and can combine multiple repositories.
        async with database.transaction(isolation=isolation, readonly=True) as conn:
            assert await CurveRunsRepository.get_run(conn, run_id) is not None
            state = await CurvesRepository.read_state(conn, run_id)
            assert state is not None and state[0].status == "queued" and state[1] == ()
    async with database.transaction() as conn:
        with pytest.raises(RuntimeError, match="REPEATABLE READ"):
            await CurvesRepository.read_state(conn, run_id)
