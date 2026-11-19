from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, timedelta
from threading import Event
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import httpx
import pytest
import simplejson
from fastapi import FastAPI

from core.config import (
    IntegrationSettings,
    Settings,
)
from core.database import Database, DBConnection
from tests.conftest import AS_OF, REPORT_DATE, ROOT
from tests.fakes.implementations import base, failing_base, failing_stress, stress
from web.app import create_app
from web.exceptions.curve_run import ImplementationUnavailable
from web.integrations.adapters import EgorAdapter, SlavaAdapter
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import (
    CalculationSpec,
    Curve,
    MarketRates,
    RatePoint,
    ScenarioParameters,
)
from web.services.calculations import CalculationWorker


@asynccontextmanager
async def client_context(settings: Settings) -> AsyncIterator[tuple[httpx.AsyncClient, FastAPI]]:
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    app = create_app(settings)
    try:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://test",
            ) as client:
                yield client, app
    finally:
        for h in root.handlers:
            h.close()
        root.handlers, root.level = handlers, level


async def create(client: httpx.AsyncClient, report_date: date = REPORT_DATE) -> UUID:
    response = await client.post(
        "/api/v1/curve-runs",
        json={"reportDate": str(report_date), "scenarioParameters": {"mode": "standard"}},
    )
    assert response.status_code == 202, response.text
    value = UUID(response.json()["runId"])
    assert response.headers["Location"] == f"/api/v1/curve-runs/{value}"
    return value


async def test_http_and_complete_fake_flow(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    async with client_context(api_settings) as (client, app):
        raw = await client.get(
            "/api/v1/input-rates",
            params={"reportDate": str(REPORT_DATE)},
            headers={"X-Request-ID": "test-request"},
        )
        assert raw.status_code == 200 and raw.headers["X-Request-ID"] == "test-request"
        data = simplejson.loads(raw.content, use_decimal=True)
        assert data["points"][1]["ratePercent"] == rates.points[1].rate_percent
        assert data["points"][0]["tenorYears"] == rates.points[0].tenor_years
        absent = await client.get("/api/v1/input-rates?reportDate=2026-08-01")
        assert absent.json() == {
            "reportDate": "2026-08-01",
            "available": False,
            "source": "moex",
            "sourceAsOf": None,
            "loadedAt": None,
            "points": [],
        }
        run_id = await create(client)
        later_date = REPORT_DATE + timedelta(days=1)
        await InputRatesRepository.replace_current(
            connection, rates.model_copy(update={"report_date": later_date}), loaded_at=AS_OF
        )
        other = await create(client, later_date)
        queued = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
        assert queued["status"] == "queued" and queued["stage"] == "base"
        assert queued["usedParameters"] == {"mode": "standard", "p": 4, "k": 5, "d": 3}
        assert "baseCurve" not in queued and "error" not in queued
        result = await client.get(f"/api/v1/curve-runs/{run_id}/result")
        assert result.status_code == 409 and result.json()["error"]["code"] == "RESULT_NOT_READY"
        assert api_settings.worker is not None
        worker = CalculationWorker(app.state.database, api_settings.worker, base, stress)
        assert await worker.run_once()
        state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
        assert state["stage"] == "stress" and state["status"] == "queued" and "baseCurve" in state
        # Queue is FIFO: drain both runs' stages, not only the first run.
        for _ in range(3):
            assert await worker.run_once()
        assert not await worker.run_once()
        result = await client.get(f"/api/v1/curve-runs/{run_id}/result")
        assert result.status_code == 200 and len(result.json()["curves"]) == 7
        assert len(result.json()["curves"][0]["points"]) == 2
        listing = (await client.get("/api/v1/curve-runs?reportDate=2026-07-31")).json()
        assert [r["runId"] for r in listing["runs"]] == [str(run_id)]
        other_listing = (await client.get(f"/api/v1/curve-runs?reportDate={later_date}")).json()
        assert [r["runId"] for r in other_listing["runs"]] == [str(other)]
        updated = rates.model_copy(
            update={
                "source_as_of": AS_OF + timedelta(hours=1),
                "points": tuple(
                    p.model_copy(update={"rate_percent": p.rate_percent + 1}) for p in rates.points
                ),
            }
        )
        await InputRatesRepository.replace_current(
            connection, updated, loaded_at=AS_OF + timedelta(hours=2)
        )
        recalculated = await client.post(
            f"/api/v1/curve-runs/{run_id}/recalculations",
            json={"scenarioParameters": {"mode": "custom", "p": 1, "k": 2, "d": 3}},
        )
        assert recalculated.status_code == 202
        child = UUID(recalculated.json()["runId"])
        assert await worker.run_once()
        child_result = await client.get(f"/api/v1/curve-runs/{child}/result")
        assert child_result.status_code == 200
        assert child_result.json()["usedParameters"]["p"] == 1
        assert (await client.get(f"/api/v1/curve-runs/{run_id}/result")).content == result.content
        async with app.state.database.connection() as conn:
            assert await InputRatesRepository.read_snapshot(
                conn, child
            ) == await InputRatesRepository.read_snapshot(conn, run_id)
        assert (await client.get("/docs")).status_code == 200
        schema = (await client.get("/openapi.json")).json()
        assert sum(len(path) for path in schema["paths"].values()) == 9
        request_schema = schema["paths"]["/api/v1/curve-runs"]["post"]["requestBody"]["content"][
            "application/json"
        ]["schema"]
        assert request_schema["additionalProperties"] is False
        alternatives = request_schema["properties"]["scenarioParameters"]["oneOf"]
        assert alternatives[1]["properties"]["p"]["type"] == "number"


async def test_http_validation_and_no_partial_runs(
    api_settings: Settings, connection: DBConnection
) -> None:
    async with client_context(api_settings) as (client, app):
        schema = (await client.get("/openapi.json")).json()
        request_schema = schema["paths"]["/api/v1/curve-runs"]["post"]["requestBody"]["content"][
            "application/json"
        ]["schema"]
        alternatives = request_schema["properties"]["scenarioParameters"]["oneOf"]
        assert alternatives[1]["properties"]["p"]["maximum"] == 50
        assert (
            await client.post(
                "/api/v1/curve-runs",
                json={"reportDate": "2026-07-31", "scenarioParameters": {"mode": "standard"}},
            )
        ).status_code == 409
        invalid = [
            {},
            {"mode": "standard", "p": 4},
            {"mode": "other"},
            {"mode": "custom", "p": 0, "k": 1, "d": 1},
            {"mode": "custom", "p": 51, "k": 1, "d": 1},
            {"mode": "custom", "p": True, "k": 1, "d": 1},
            {"mode": "custom", "p": "4", "k": 1, "d": 1},
            {"mode": "custom", "p": None, "k": 1, "d": 1},
            {"mode": "custom", "p": 1, "k": 1},
            {"mode": "custom", "p": -1, "k": 1, "d": 1},
        ]
        for parameters in invalid:
            response = await client.post(
                "/api/v1/curve-runs",
                json={"reportDate": "2026-07-31", "scenarioParameters": parameters},
            )
            assert response.status_code == 422, response.text
            assert response.json()["error"]["code"] == "VALIDATION_ERROR"
        for report_date in ("2026-02-30", "20260731", "2026-07-31T00:00:00Z", 123):
            r = await client.post(
                "/api/v1/curve-runs",
                json={"reportDate": report_date, "scenarioParameters": {"mode": "standard"}},
            )
            assert r.status_code == 422
        r = await client.post(
            "/api/v1/curve-runs",
            json={
                "reportDate": "2026-07-31",
                "scenarioParameters": {"mode": "standard"},
                "points": [],
            },
        )
        assert r.status_code == 422
        for value in ("NaN", "Infinity", "-Infinity"):
            r = await client.post(
                "/api/v1/curve-runs",
                content='{"reportDate":"2026-07-31",'
                '"scenarioParameters":{"mode":"custom","p":' + value + ',"k":1,"d":1}}',
                headers={"Content-Type": "application/json"},
            )
            assert r.status_code == 422
        r = await client.post(
            "/api/v1/curve-runs", content="{", headers={"Content-Type": "application/json"}
        )
        assert r.status_code == 400 and r.json()["error"]["code"] == "INVALID_JSON"
        assert (await client.post("/api/v1/curve-runs", content="{}")).status_code == 415
        assert (await client.get("/api/v1/curve-runs/not-a-uuid")).status_code == 422
        assert (await client.get(f"/api/v1/curve-runs/{uuid4()}")).status_code == 404
        assert (await client.get("/api/v1/input-rates?reportDate=2026-02-30")).status_code == 422
        assert (await client.get("/api/v1/input-rates")).status_code == 422
        assert (await client.get("/api/v1/curve-runs?reportDate=2026-08-01")).json()["runs"] == []
        async with app.state.database.connection() as conn:
            assert await conn.fetchval("SELECT count(*) FROM curve_run") == 0


async def test_failures_and_unconfigured_integrations(
    api_settings: Settings, connection: DBConnection, rates: MarketRates, spec: CalculationSpec
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    assert api_settings.worker is not None
    async with client_context(api_settings) as (client, app):
        for base_fn, stress_fn, stage, code in (
            (failing_base, stress, "base", "BASE_CURVE_FAILED"),
            (base, failing_stress, "stress", "CALCULATION_FAILED"),
            (
                EgorAdapter(IntegrationSettings()).base,
                SlavaAdapter(IntegrationSettings()).stress,
                "base",
                "BASE_CURVE_FAILED",
            ),
        ):
            run_id = await create(client)
            worker = CalculationWorker(app.state.database, api_settings.worker, base_fn, stress_fn)
            await worker.run_once()
            if stage == "stress":
                await worker.run_once()
            state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
            assert state["status"] == "failed" and state["stage"] == stage
            assert state["error"]["code"] == code and state["error"]["details"] == []
            assert ("baseCurve" in state) == (stage == "stress")
            assert (await client.get(f"/api/v1/curve-runs/{run_id}/result")).status_code == 409
            if stage == "base":
                assert (
                    await client.post(
                        f"/api/v1/curve-runs/{run_id}/recalculations",
                        json={"scenarioParameters": {"mode": "standard"}},
                    )
                ).status_code == 409
        with pytest.raises(ImplementationUnavailable):
            EgorAdapter(IntegrationSettings()).base(rates.points, spec)


async def test_custom_decimal_and_missing_spec(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    async with client_context(api_settings) as (client, app):
        r = await client.post(
            "/api/v1/curve-runs",
            content='{"reportDate":"2026-07-31",'
            '"scenarioParameters":{"mode":"custom","p":4.12345678901234567890123456789,"k":50,"d":0.5}}',
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        assert r.status_code == 202
        state = await client.get(r.headers["Location"])
        data = simplejson.loads(state.content, use_decimal=True)
        assert str(data["usedParameters"]["p"]) == "4.12345678901234567890123456789"
        assert data["usedParameters"]["k"] == 50
        app.state.settings.calculation.spec_file = None
        missing = await client.post(
            "/api/v1/curve-runs",
            json={"reportDate": "2026-07-31", "scenarioParameters": {"mode": "standard"}},
        )
        assert missing.status_code == 503


async def wait_for(predicate: Any, seconds: float = 5) -> Any:
    async with asyncio.timeout(seconds):
        while True:
            value = await predicate()
            if value:
                return value
            await asyncio.sleep(0.02)


async def test_api_restart_and_no_connection_during_math(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    entered, release = Event(), Event()

    def controlled(points: tuple[RatePoint, ...], spec: CalculationSpec) -> Curve:
        entered.set()
        release.wait(5)
        return base(points, spec)

    assert api_settings.worker is not None
    # Worker owns a separate pool from both API lifespans.
    async with Database.open(api_settings.database) as database:
        worker = CalculationWorker(database, api_settings.worker, controlled, stress)
        task = None
        try:
            async with client_context(api_settings) as (client, first):
                run_id = await create(client)
                task = asyncio.create_task(worker.run_once())
                assert await asyncio.to_thread(entered.wait, 3)
                async with asyncio.timeout(0.5), worker.database.connection() as conn:
                    assert await conn.fetchval("SELECT 1") == 1
                first_pool = first.state.pool
            assert first_pool.is_closing()
            assert not task.done()
            async with client_context(api_settings) as (client, second):
                state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
                assert state["status"] == "running" and state["stage"] == "base"
                release.set()
                await task
                state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
                assert state["status"] == "queued" and state["stage"] == "stress"
        finally:
            release.set()
            if task is not None:
                await asyncio.gather(task, return_exceptions=True)


async def test_timeout_and_graceful_interruption(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    assert api_settings.worker is not None
    async with client_context(api_settings) as (client, app):
        for interrupt in (False, True):
            entered, release = Event(), Event()
            stop = asyncio.Event()

            def controlled(
                points: tuple[RatePoint, ...],
                spec: CalculationSpec,
                entered: Event = entered,
                release: Event = release,
            ) -> Curve:
                entered.set()
                release.wait(5)
                return base(points, spec)

            settings = api_settings.worker.model_copy(
                update={"stage_timeout_seconds": 0.1 if not interrupt else 5}
            )
            worker = CalculationWorker(app.state.database, settings, controlled, stress)
            run_id = await create(client)
            task = asyncio.create_task(worker.run_once(stop))
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                if interrupt:
                    stop.set()
                values = await asyncio.gather(task, return_exceptions=True)
                assert not values or not isinstance(values[0], Exception)
                state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
                assert state["status"] == "failed"
                assert state["error"]["code"] == (
                    "CALCULATION_INTERRUPTED" if interrupt else "CALCULATION_TIMEOUT"
                )
                assert worker.must_exit
            finally:
                release.set()


def worker_environment(settings: Settings) -> dict[str, str]:
    return {
        **os.environ,
        "DATABASE__DSN": settings.database.dsn.get_secret_value(),
        "WORKER__POLL_SECONDS": ".02",
        "WORKER__LEASE_SECONDS": ".8",
        "WORKER__HEARTBEAT_SECONDS": ".05",
        "WORKER__STAGE_TIMEOUT_SECONDS": "30",
        "INTEGRATIONS__BASE_FUNCTION": "tests.fakes.implementations:slow_base",
        "INTEGRATIONS__STRESS_FUNCTION": "tests.fakes.implementations:stress",
    }


async def test_killed_worker_recovery_and_second_process_guard(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    async with client_context(api_settings) as (client, app):
        run_id = await create(client)
        later_date = REPORT_DATE + timedelta(days=1)
        await InputRatesRepository.replace_current(
            connection, rates.model_copy(update={"report_date": later_date}), loaded_at=AS_OF
        )
        other = await create(client, later_date)
        env = worker_environment(api_settings)
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "web.processes.calculation_worker",
            "--once",
            cwd=ROOT,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        async def running() -> bool:
            row = await CurveRunsRepository.get_run(connection, run_id)
            return row is not None and row.status == "running"

        try:
            await wait_for(running)
            second = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "web.processes.calculation_worker",
                "--once",
                cwd=ROOT,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await asyncio.wait_for(second.communicate(), 5)
            assert second.returncode == 2 and b"already running" in err
            process.send_signal(signal.SIGKILL)
            await process.communicate()
        finally:
            if process.returncode is None:
                process.kill()
                await process.communicate()
        # API reads preserve interrupted running until lease expiration/recovery by a worker.
        assert (await client.get(f"/api/v1/curve-runs/{run_id}")).json()["status"] == "running"

        async def expired() -> bool:
            value = await connection.fetchval(
                "SELECT lease_expires_at<=clock_timestamp() FROM curve_run WHERE id=$1", run_id
            )
            return bool(value)

        await wait_for(expired)
        env["INTEGRATIONS__BASE_FUNCTION"] = "tests.fakes.implementations:base"
        recovered = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "web.processes.calculation_worker",
            "--once",
            cwd=ROOT,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        output, error = await asyncio.wait_for(recovered.communicate(), 10)
        assert recovered.returncode == 0, (output + error).decode()
        state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
        assert state["status"] == "failed" and state["error"]["code"] == "CALCULATION_INTERRUPTED"
        assert await InputRatesRepository.read_snapshot(connection, run_id) is not None
        state = (await client.get(f"/api/v1/curve-runs/{other}")).json()
        assert state["status"] == "queued" and state["stage"] == "stress"


async def test_atomic_claim_and_live_lease(
    db_pool: asyncpg.Pool[Any], api_settings: Settings, rates: MarketRates, spec: CalculationSpec
) -> None:
    from decimal import Decimal

    from tests.test_storage import seed_run
    from web.repositories.models import ScenarioParameters

    async with db_pool.acquire() as first, db_pool.acquire() as second:
        params = ScenarioParameters(mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3))
        run_id = await seed_run(first, rates, params, spec)
        await seed_run(first, rates, params, spec)
        values = await asyncio.gather(
            CurveRunsRepository.claim_next(
                first, worker_id=uuid4(), lease_duration=timedelta(seconds=3)
            ),
            CurveRunsRepository.claim_next(
                second, worker_id=uuid4(), lease_duration=timedelta(seconds=3)
            ),
        )
        rows = [r for r in values if r is not None]
        assert len(rows) == 1 and rows[0].id == run_id
        assert await CurveRunsRepository.interrupt_expired(first) == 0
        row = await CurveRunsRepository.get_run(first, run_id)
        assert row is not None and row.status == "running"


async def test_http_internal_and_database_errors(
    api_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    from web.services.curve_runs import RunService

    async with client_context(api_settings) as (client, app):

        async def internal(self: RunService, report_date: Any) -> Any:
            raise RuntimeError("postgresql://test:must-not-leak@localhost/private")

        monkeypatch.setattr(RunService, "input_rates", internal)
        response = await client.get("/api/v1/input-rates?reportDate=2026-07-31")
        assert response.status_code == 500 and response.json()["error"]["code"] == "INTERNAL_ERROR"
        assert "must-not-leak" not in response.text and response.headers["X-Request-ID"]

        async def unavailable(self: RunService, report_date: Any) -> Any:
            raise OSError("database unavailable")

        monkeypatch.setattr(RunService, "input_rates", unavailable)
        response = await client.get("/api/v1/input-rates?reportDate=2026-07-31")
        assert (
            response.status_code == 503
            and response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
        )


async def test_http_creation_failure_rolls_back(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    await connection.execute("""
        CREATE FUNCTION reject_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected snapshot failure'; END $$;
        CREATE TRIGGER reject_snapshot BEFORE INSERT ON input_rate
        FOR EACH ROW WHEN (NEW.run_id IS NOT NULL) EXECUTE FUNCTION reject_snapshot();
    """)
    async with client_context(api_settings) as (client, app):
        response = await client.post(
            "/api/v1/curve-runs",
            json={"reportDate": str(REPORT_DATE), "scenarioParameters": {"mode": "standard"}},
        )
        assert response.status_code == 500 and "runId" not in response.json()
        assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
        assert await InputRatesRepository.read_current(connection, REPORT_DATE) is not None


async def test_worker_rejects_incomplete_stress_grid(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)

    def incomplete(
        base: Curve, parameters: ScenarioParameters, algorithm_version: str
    ) -> tuple[Curve, ...]:
        return stress(base, parameters, algorithm_version)[:5]

    async with client_context(api_settings) as (client, app):
        assert api_settings.worker is not None
        run_id = await create(client)
        worker = CalculationWorker(app.state.database, api_settings.worker, base, incomplete)
        await worker.run_once()
        await worker.run_once()
        state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
        assert state["status"] == "failed" and state["stage"] == "stress" and "baseCurve" in state
        assert state["error"]["code"] == "CALCULATION_FAILED"
        assert await connection.fetchval("SELECT count(*) FROM curve WHERE run_id=$1", run_id) == 1
