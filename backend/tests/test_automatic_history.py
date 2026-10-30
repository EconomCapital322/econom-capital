from __future__ import annotations

import asyncio
from datetime import date
from decimal import Decimal

import asyncpg
import pytest

from core.config import LoaderSettings, Settings
from core.database import Database, DBConnection
from tests.conftest import migrate
from tests.test_storage import fake_curve, seed_run, simulate_owner
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import STRESS_CODES, CalculationSpec, MarketRates, ScenarioParameters
from web.services.loading import load_rates


async def test_loader_preserves_legacy_history_and_never_queues(
    api_settings: Settings,
    rates: MarketRates,
    spec: CalculationSpec,
) -> None:
    config = LoaderSettings(
        max_attempts=1,
        backoff_base_seconds=1,
        backoff_cap_seconds=1,
        request_timeout_seconds=2,
    )

    async def fetch(report_date: date) -> MarketRates:
        return rates

    async with Database.open(api_settings.database) as database:
        await asyncio.gather(
            *(load_rates(database, rates.report_date, fetch, config) for _ in range(3))
        )
        async with database.connection() as connection:
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
            parameters = ScenarioParameters(
                mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3)
            )
            # Explicit fixture for legacy automatic history, never called by Loader.
            old_id = await CurveRunsRepository.create_run(
                connection,
                report_date=rates.report_date,
                parameters=parameters,
                spec=spec,
                run_origin="automatic",
            )
            manual_id = await CurveRunsRepository.create_run(
                connection,
                report_date=rates.report_date,
                parameters=parameters,
                spec=spec,
            )
            old_rows = [
                await CurveRunsRepository.get_run(connection, run_id)
                for run_id in (old_id, manual_id)
            ]
            snapshots = [
                await InputRatesRepository.read_snapshot(connection, run_id)
                for run_id in (old_id, manual_id)
            ]
        changed_rates = rates.model_copy(
            update={
                "points": tuple(
                    p.model_copy(update={"rate_percent": Decimal(99)}) for p in rates.points
                )
            }
        )

        async def changed(report_date: date) -> MarketRates:
            return changed_rates

        assert await load_rates(database, rates.report_date, changed, config) == "saved"
        assert await load_rates(database, rates.report_date, changed, config) == "unchanged"
        async with database.connection() as connection:
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 2
            assert [
                await CurveRunsRepository.get_run(connection, run_id)
                for run_id in (old_id, manual_id)
            ] == old_rows
            assert [
                await InputRatesRepository.read_snapshot(connection, run_id)
                for run_id in (old_id, manual_id)
            ] == snapshots
            saved = await InputRatesRepository.read_current(connection, rates.report_date)
            assert saved is not None and saved.points == changed_rates.points


async def test_history_migrations_preserve_existing_results(
    connection: DBConnection,
    database_dsn: str,
    rates: MarketRates,
    spec: CalculationSpec,
    parameters: ScenarioParameters,
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, run_id)
    await CurvesRepository.publish_stage(
        connection, run_id=run_id, claim_token=token, curves=(fake_curve(spec),)
    )
    token = await simulate_owner(connection, run_id)
    await CurvesRepository.publish_stage(
        connection,
        run_id=run_id,
        claim_token=token,
        curves=tuple(fake_curve(spec, code) for code in sorted(STRESS_CODES)),
    )
    before = await CurvesRepository.read_curves(connection, run_id)
    assert len(before) == 7
    await migrate(database_dsn, "0003_run_history", downgrade=True)
    assert (
        await connection.fetchval("SELECT count(*) FROM curve_result WHERE run_id=$1", run_id) == 14
    )
    assert not await connection.fetchval(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns "
        "WHERE table_name='curve_result' AND column_name='p')"
    )
    await migrate(database_dsn, "0002_rate_column_names", downgrade=True)
    assert await connection.fetchval("SELECT status FROM curve_run WHERE id=$1", run_id) == "ready"
    await migrate(database_dsn)
    assert await CurvesRepository.read_curves(connection, run_id) == before
    row = await connection.fetchrow(
        "SELECT run_origin,mode,p,k,d FROM curve_result WHERE run_id=$1 LIMIT 1", run_id
    )
    assert row is not None and tuple(row) == (
        "manual",
        "standard",
        Decimal(4),
        Decimal(5),
        Decimal(3),
    )
    assert (
        len(await connection.fetch("SELECT tablename FROM pg_tables WHERE schemaname='public'"))
        == 5
    )


async def test_origin_constraints(
    connection: DBConnection,
    rates: MarketRates,
    spec: CalculationSpec,
    parameters: ScenarioParameters,
) -> None:
    first = await seed_run(connection, rates, parameters, spec)
    second = await CurveRunsRepository.create_run(
        connection, report_date=rates.report_date, parameters=parameters, spec=spec
    )
    for origin, key in (
        ("unknown", None),
        ("automatic", None),
        ("manual", "a" * 64),
        ("automatic", "not-a-fingerprint"),
    ):
        with pytest.raises(asyncpg.CheckViolationError):
            async with connection.transaction():
                await connection.execute(
                    "UPDATE curve_run SET run_origin=$2,automatic_key=$3 WHERE id=$1",
                    first,
                    origin,
                    key,
                )
    await connection.execute(
        "UPDATE curve_run SET run_origin='automatic',automatic_key=$2 WHERE id=$1", first, "a" * 64
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with connection.transaction():
            await connection.execute(
                "UPDATE curve_run SET run_origin='automatic',automatic_key=$2 WHERE id=$1",
                second,
                "a" * 64,
            )


async def test_loader_rejects_legacy_automatic_enablement(
    database_dsn: str,
    connection: DBConnection,
) -> None:
    import os
    import sys

    from tests.conftest import ROOT

    env = {
        **os.environ,
        "DATABASE__DSN": database_dsn,
        "LOADER__ENQUEUE_AUTOMATIC": "true",
        "LOADER__MAX_ATTEMPTS": "1",
        "LOADER__BACKOFF_BASE_SECONDS": "1",
        "LOADER__BACKOFF_CAP_SECONDS": "1",
        "LOADER__REQUEST_TIMEOUT_SECONDS": "1",
        "INTEGRATIONS__FETCH_FUNCTION": "tests.fakes.implementations:fetch",
    }
    env.pop("CALCULATION__SPEC_FILE", None)
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "web.processes.moex_loader",
        "--report-date",
        "2026-07-31",
        cwd=ROOT,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    assert process.returncode == 1 and b"MOEX load failed" in stderr
    assert b"postgresql://" not in stdout + stderr
    assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
    assert await connection.fetchval("SELECT count(*) FROM input_rate") == 0
