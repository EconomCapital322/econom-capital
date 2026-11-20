from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from decimal import Decimal, localcontext
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID

import pytest
import simplejson
from pydantic import ValidationError

from core.config import DatabaseSettings, Settings
from core.database import Database, DBConnection
from core.logging import RedactingFormatter
from core.process_lock import process_lock
from tests.conftest import AS_OF, REPORT_DATE, ROOT
from tests.fakes.implementations import base, stress
from tests.test_api_worker import client_context, worker_environment
from tests.test_regressions import wait_for_running
from tests.test_storage import seed_run
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import CalculationSpec, MarketRates, RatePoint, ScenarioParameters
from web.services.calculations import CalculationWorker


def alias_dsn(dsn: str) -> str:
    url = urlsplit(dsn)
    options = dict(parse_qsl(url.query))
    options["application_name"] = "subagent-review-equivalent-connection"
    return urlunsplit(url._replace(scheme="postgres", query=urlencode(options)))


async def test_numeric_limits_and_exact_normalization_in_create_and_recalculate(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    async with client_context(api_settings) as (client, app):
        created = await client.post(
            "/api/v1/curve-runs",
            json={"reportDate": str(REPORT_DATE), "scenarioParameters": {"mode": "standard"}},
        )
        assert created.status_code == 202
        parent_id = UUID(created.json()["runId"])
        assert api_settings.worker is not None
        worker = CalculationWorker(app.state.database, api_settings.worker, base, stress)
        await worker.run_once()
        await worker.run_once()
        before = await client.get(f"/api/v1/curve-runs/{parent_id}/result")
        assert before.status_code == 200
        for endpoint in ("/api/v1/curve-runs", f"/api/v1/curve-runs/{parent_id}/recalculations"):
            for field in ("p", "k", "d"):
                for token in ("1e-16384", "1e-20000"):
                    params: dict[str, str | Decimal] = {
                        "mode": "custom",
                        "p": Decimal(4),
                        "k": Decimal(5),
                        "d": Decimal(3),
                    }
                    params[field] = Decimal(token)
                    body: dict[str, object] = {"scenarioParameters": params}
                    if endpoint == "/api/v1/curve-runs":
                        body["reportDate"] = str(REPORT_DATE)
                    response = await client.post(
                        endpoint,
                        content=simplejson.dumps(body, use_decimal=True),
                        headers={"Content-Type": "application/json"},
                    )
                    assert response.status_code == 422, response.text
                    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
                    assert (
                        response.json()["error"]["details"][0]["field"]
                        == f"scenarioParameters.{field}"
                    )
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 1
            assert (
                await client.get(f"/api/v1/curve-runs/{parent_id}/result")
            ).content == before.content

        for token in ("1e-16383", "1.000e-16383", "4.1234567890123456789012345678901234567890"):
            value = Decimal(token)
            for endpoint in (
                "/api/v1/curve-runs",
                f"/api/v1/curve-runs/{parent_id}/recalculations",
            ):
                body = {"scenarioParameters": {"mode": "custom", "p": value, "k": 5, "d": 3}}
                if endpoint == "/api/v1/curve-runs":
                    body["reportDate"] = str(REPORT_DATE)
                response = await client.post(
                    endpoint,
                    content=simplejson.dumps(body, use_decimal=True),
                    headers={"Content-Type": "application/json"},
                )
                assert response.status_code == 202, response.text
                run = await CurveRunsRepository.get_run(connection, UUID(response.json()["runId"]))
                assert run is not None and run.scenario_parameters.p == value
                state = await client.get(response.headers["Location"])
                used = simplejson.loads(state.content, use_decimal=True)["usedParameters"]
                assert used["p"] == value
                assert await InputRatesRepository.read_snapshot(connection, run.id) is not None
        assert (
            await client.get(f"/api/v1/curve-runs/{parent_id}/result")
        ).content == before.content


def test_numeric_guard_preserves_precision_and_rejects_unstorable_values() -> None:
    original = Decimal("4.1234567890123456789012345678901234567890")
    with localcontext() as context:
        context.prec = 3
        parameters = ScenarioParameters(mode="custom", p=original, k=Decimal(5), d=Decimal(3))
    assert parameters.p == original
    for value in ("1e-16384", "1e131072"):
        with pytest.raises(ValidationError, match="represented exactly"):
            RatePoint(tenor_years=Decimal(1), rate_percent=Decimal(value))
    point = RatePoint(tenor_years=Decimal("1.000e-16383"), rate_percent=Decimal("-0.25000"))
    assert point.tenor_years == Decimal("1e-16383")
    assert point.tenor_years.as_tuple().exponent == -16383
    assert point.rate_percent == Decimal("-0.25")


@pytest.mark.parametrize("password", ["alpha'beta", 'alpha"beta', "alpha beta", "alpha%20beta"])
def test_redaction_does_not_leave_credential_suffixes(password: str) -> None:
    formatter = RedactingFormatter("%(levelname)s %(message)s")
    for scheme in ("postgresql", "postgres", "postgresql+asyncpg"):
        url = f"{scheme}://review-user:{password}@localhost/review-only"
        if scheme != "postgresql+asyncpg":
            DatabaseSettings(dsn=url)
        record = logging.LogRecord(
            "review", logging.INFO, __file__, 1, "Connecting: %s", (url,), None
        )
        rendered = formatter.format(record)
        assert "[database URL redacted]" in rendered
        assert "alpha" not in rendered and "beta" not in rendered and "localhost" not in rendered
        try:
            raise RuntimeError(url)
        except RuntimeError:
            record.exc_info = sys.exc_info()
        rendered = formatter.format(record)
        assert "Traceback" in rendered
        assert "alpha" not in rendered and "beta" not in rendered and "localhost" not in rendered
    with pytest.raises(ValidationError) as error:
        DatabaseSettings(dsn="postgresql://review-user:alpha\nbeta@localhost/review-only")
    assert "alpha" not in str(error.value) and "beta" not in str(error.value)


async def test_database_identity_ignores_dsn_spelling_and_releases_connection(
    database_dsn: str,
) -> None:
    async with Database.open(DatabaseSettings(dsn=database_dsn, max_pool_size=1)) as first:
        identity = await first.identity()
        assert first.pool.get_idle_size() == first.pool.get_size()
    async with Database.open(DatabaseSettings(dsn=alias_dsn(database_dsn))) as second:
        assert await second.identity() == identity
    assert database_dsn not in identity and "local-test-only" not in identity


async def test_equivalent_dsn_cannot_start_second_worker(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    environment = worker_environment(api_settings)
    command = [sys.executable, "-m", "web.processes.calculation_worker", "--once"]
    first = await asyncio.create_subprocess_exec(
        *command,
        cwd=ROOT,
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        await wait_for_running(connection, run_id)
        other = {**environment, "DATABASE__DSN": alias_dsn(environment["DATABASE__DSN"])}
        second = await asyncio.create_subprocess_exec(
            *command,
            cwd=ROOT,
            env=other,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(second.communicate(), 5)
            assert second.returncode == 2 and b"already running" in stderr, (
                stdout + stderr
            ).decode()
            assert b"pool closed" in stdout
            run = await CurveRunsRepository.get_run(connection, run_id)
            assert run is not None and run.status == "running"
        finally:
            if second.returncode is None:
                second.kill()
                await second.communicate()
    finally:
        if first.returncode is None:
            first.send_signal(signal.SIGTERM)
            await asyncio.wait_for(first.communicate(), 5)


async def test_equivalent_dsn_cannot_start_second_loader(database_dsn: str) -> None:
    async with Database.open(DatabaseSettings(dsn=database_dsn)) as database:
        identity = await database.identity()
        key = f"loader:{identity}:{REPORT_DATE.isoformat()}"
        environment = {
            **os.environ,
            "DATABASE__DSN": alias_dsn(database_dsn),
            "LOADER__MAX_ATTEMPTS": "1",
            "LOADER__BACKOFF_BASE_SECONDS": ".01",
            "LOADER__BACKOFF_CAP_SECONDS": ".02",
            "LOADER__REQUEST_TIMEOUT_SECONDS": "1",
            "INTEGRATIONS__FETCH_FUNCTION": "tests.fakes.implementations:fetch",
        }
        with process_lock(key) as acquired:
            assert acquired
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "web.processes.moex_loader",
                "--report-date",
                str(REPORT_DATE),
                cwd=ROOT,
                env=environment,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), 5)
                assert process.returncode == 2 and b"already runs" in stderr, (
                    stdout + stderr
                ).decode()
                assert b"pool closed" in stdout
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.communicate()
        async with database.connection() as connection:
            assert await InputRatesRepository.read_current(connection, REPORT_DATE) is None
