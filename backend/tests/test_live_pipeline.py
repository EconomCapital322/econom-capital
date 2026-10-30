from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

import httpx
import pytest

from core.config import IntegrationSettings, LoaderSettings, Settings, WorkerSettings
from core.database import Database, DBConnection
from tests.conftest import AS_OF, REPORT_DATE, ROOT
from tests.test_api_worker import client_context
from tests.test_base_curve import source, specification
from web.calculations.base_curve import build_base_curve
from web.integrations.adapters import SlavaAdapter
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import CalculationSpec, MarketRates, ScenarioParameters
from web.services.calculations import CalculationWorker
from web.services.loading import load_rates


def environment(settings: Settings, stress_url: str) -> dict[str, str]:
    assert settings.calculation.spec_file is not None
    env = {
        **os.environ,
        "DATABASE__DSN": settings.database.dsn.get_secret_value(),
        "DATABASE__CONNECT_TIMEOUT": "0.5",
        "CALCULATION__SPEC_FILE": str(settings.calculation.spec_file),
        "INTEGRATIONS__BASE_FUNCTION": "web.calculations.base_curve:build_base_curve",
        "INTEGRATIONS__STRESS_HTTP_URL": stress_url,
        "INTEGRATIONS__STRESS_HTTP_VERSION": "test-real-go-stress",
        "INTEGRATIONS__STRESS_HTTP_TIMEOUT_SECONDS": "1",
        "WORKER__POLL_SECONDS": ".02",
        "WORKER__LEASE_SECONDS": "3",
        "WORKER__HEARTBEAT_SECONDS": ".2",
        "WORKER__STAGE_TIMEOUT_SECONDS": "5",
    }
    env.pop("INTEGRATIONS__STRESS_FUNCTION", None)
    return env


async def stop(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except TimeoutError:
            process.kill()
            await process.wait()


@asynccontextmanager
async def live_api(env: dict[str, str], port: int) -> AsyncIterator[httpx.AsyncClient]:
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "uvicorn",
        "web.app:create_app",
        "--factory",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        cwd=ROOT,
        env=env,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}", timeout=2, trust_env=False
        ) as client:
            for _ in range(150):
                if process.returncode is not None:
                    pytest.fail("Real FastAPI process failed to start")
                try:
                    response = await client.get("/openapi.json")
                    if response.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.03)
            else:
                pytest.fail("Real FastAPI did not become ready")
            yield client
    finally:
        await stop(process)


@asynccontextmanager
async def live_worker(env: dict[str, str]) -> AsyncIterator[asyncio.subprocess.Process]:
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "web.processes.calculation_worker",
        cwd=ROOT,
        env=env,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        yield process
    finally:
        await stop(process)


async def ready(client: httpx.AsyncClient, run_id: str) -> dict[str, object]:
    for _ in range(200):
        response = await client.get(f"/api/v1/curve-runs/{run_id}")
        assert response.status_code == 200, response.text
        state = response.json()
        assert state["status"] != "failed", state
        if state["status"] == "ready":
            result = await client.get(f"/api/v1/curve-runs/{run_id}/result")
            assert result.status_code == 200, result.text
            payload: dict[str, object] = result.json()
            assert len(payload["curves"]) == 7  # type: ignore[arg-type]
            return payload
        await asyncio.sleep(0.03)
    pytest.fail("Real Worker did not produce a ready result")


@pytest.mark.usefixtures("base_binary_on_path")
async def test_live_user_calculation_recalculation_and_api_restart(
    api_settings: Settings,
    connection: DBConnection,
    stress_url: str,
    unused_tcp_port: int,
) -> None:
    spec = specification("0.25", "1", "3", "10").model_copy(
        update={"stress_version": "test-real-go-stress", "data_provenance": "synthetic"}
    )
    assert api_settings.calculation.spec_file is not None
    api_settings.calculation.spec_file.write_text(spec.model_dump_json())
    rates = MarketRates(
        report_date=REPORT_DATE, source_as_of=AS_OF, points=source(("0.25", "10"), ("10", "12"))
    )
    await InputRatesRepository.replace_current(connection, rates, loaded_at=datetime.now(UTC))
    env = environment(api_settings, stress_url)
    async with AsyncExitStack() as stack:
        async with live_api(env, unused_tcp_port) as client:
            assert (await client.get("/api/v1/input-rates?reportDate=2026-07-31")).json()[
                "available"
            ]
            absent = (await client.get("/api/v1/input-rates?reportDate=2026-08-01")).json()
            assert not absent["available"] and absent["points"] == []
            response = await client.post(
                "/api/v1/curve-runs",
                json={
                    "reportDate": str(REPORT_DATE),
                    "scenarioParameters": {"mode": "custom", "p": 2, "k": 3, "d": 4},
                },
            )
            assert response.status_code == 202
            manual = response.json()["runId"]
            assert response.headers["Location"] == f"/api/v1/curve-runs/{manual}"
            assert (await client.get(response.headers["Location"])).json()["status"] == "queued"
            worker = await stack.enter_async_context(live_worker(env))
            original = await ready(client, manual)
            assert original["runOrigin"] == "manual"
            recalc = await client.post(
                f"/api/v1/curve-runs/{manual}/recalculations",
                json={"scenarioParameters": {"mode": "custom", "p": 6, "k": 7, "d": 8}},
            )
            assert recalc.status_code == 202
            child = recalc.json()["runId"]
            assert child != manual
            new_result = await ready(client, child)
            assert new_result["usedParameters"] == {"mode": "custom", "p": 6, "k": 7, "d": 8}
            assert (await client.get(f"/api/v1/curve-runs/{manual}/result")).json() == original

            async def fetch(report_date: date) -> MarketRates:
                return rates

            loader = LoaderSettings(
                max_attempts=1,
                backoff_base_seconds=1,
                backoff_cap_seconds=1,
                request_timeout_seconds=1,
            )
            async with Database.open(api_settings.database) as database:
                await load_rates(database, REPORT_DATE, fetch, loader)
            history = (await client.get("/api/v1/curve-runs?reportDate=2026-07-31")).json()["runs"]
            assert len(history) == 2
            response = await client.post(
                "/api/v1/curve-runs",
                json={"reportDate": str(REPORT_DATE), "scenarioParameters": {"mode": "standard"}},
            )
            assert response.status_code == 202
            assert (await ready(client, response.json()["runId"]))["usedParameters"] == {
                "mode": "standard",
                "p": 4,
                "k": 5,
                "d": 3,
            }
            standard_id = response.json()["runId"]
            reused = await client.post(
                "/api/v1/curve-runs",
                json={"reportDate": str(REPORT_DATE), "scenarioParameters": {"mode": "standard"}},
            )
            assert reused.status_code == 200
            assert reused.json() == {"runId": standard_id, "status": "ready"}

            later_date = REPORT_DATE + timedelta(days=1)
            later_rates = rates.model_copy(update={"report_date": later_date})
            await InputRatesRepository.replace_current(
                connection, later_rates, loaded_at=datetime.now(UTC)
            )
            # Commit through POST, then close the client AND API while Worker is alive.
            queued_response = await client.post(
                "/api/v1/curve-runs",
                json={"reportDate": str(later_date), "scenarioParameters": {"mode": "standard"}},
            )
            assert queued_response.status_code == 202
            queued = UUID(queued_response.json()["runId"])

        # API is now stopped. The independent Worker must process a new job anyway.
        for _ in range(200):
            run = await CurveRunsRepository.get_run(connection, queued)
            assert run is not None and run.status != "failed"
            if run.status == "ready":
                break
            await asyncio.sleep(0.03)
        else:
            pytest.fail("Worker stopped processing when FastAPI was stopped")
        assert worker.returncode is None
        async with live_api(env, unused_tcp_port) as restarted:
            assert (await ready(restarted, str(queued)))["runId"] == str(queued)
            history = (await restarted.get("/api/v1/curve-runs?reportDate=2026-07-31")).json()[
                "runs"
            ]
            assert len(history) == 3
            later_history = (
                await restarted.get(f"/api/v1/curve-runs?reportDate={later_date}")
            ).json()["runs"]
            assert len(later_history) == 1 and later_history[0]["runId"] == str(queued)


@pytest.mark.usefixtures("base_binary_on_path")
async def test_unavailable_go_preserves_saved_base(
    api_settings: Settings,
    connection: DBConnection,
    unused_tcp_port: int,
) -> None:
    spec = specification("0.25", "1", "3").model_copy(update={"stress_version": "test-refused"})
    assert api_settings.calculation.spec_file is not None
    api_settings.calculation.spec_file.write_text(spec.model_dump_json())
    rates = MarketRates(
        report_date=REPORT_DATE, source_as_of=AS_OF, points=source(("1", "2"), ("3", "6"))
    )
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    adapter = SlavaAdapter(
        IntegrationSettings.model_validate(
            {
                "stress_http_url": f"http://127.0.0.1:{unused_tcp_port}/internal/v1/stress-curves",
                "stress_http_version": spec.stress_version,
                "stress_http_timeout_seconds": 0.2,
            }
        )
    )
    async with client_context(api_settings) as (client, app):
        response = await client.post(
            "/api/v1/curve-runs",
            json={"reportDate": str(REPORT_DATE), "scenarioParameters": {"mode": "standard"}},
        )
        run_id = UUID(response.json()["runId"])
        worker = CalculationWorker(
            app.state.database,
            WorkerSettings(
                poll_seconds=0.02, lease_seconds=3, heartbeat_seconds=0.2, stage_timeout_seconds=5
            ),
            build_base_curve,
            adapter.stress,
        )
        assert await worker.run_once()
        saved = await CurvesRepository.read_curves(connection, run_id)
        assert len(saved) == 1
        assert await worker.run_once()
        state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
        assert state["status"] == "failed" and state["stage"] == "stress"
        assert state["error"]["code"] == "CALCULATION_FAILED" and state["baseCurve"]
        assert await CurvesRepository.read_curves(connection, run_id) == saved
        assert (await client.get(f"/api/v1/curve-runs/{run_id}/result")).status_code == 409


async def test_worker_cannot_claim_when_postgresql_unavailable(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
    spec: CalculationSpec,
    parameters: ScenarioParameters,
    unused_tcp_port_factory: Callable[[], int],
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    run_id = await CurveRunsRepository.create_run(
        connection, report_date=REPORT_DATE, parameters=parameters, spec=spec
    )
    env = environment(api_settings, "http://127.0.0.1:1/internal/v1/stress-curves")
    env["DATABASE__DSN"] = (
        f"postgresql://test:do-not-log@127.0.0.1:{unused_tcp_port_factory()}/missing"
    )
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
    stdout, stderr = await asyncio.wait_for(process.communicate(), 5)
    assert process.returncode == 1
    assert b"Worker could not start" in stderr and b"do-not-log" not in stdout + stderr
    assert b"postgresql://" not in stdout + stderr
    run = await CurveRunsRepository.get_run(connection, run_id)
    assert run is not None and run.status == "queued"
