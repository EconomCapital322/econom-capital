from __future__ import annotations

import asyncio
import os
import signal
import sys
from collections.abc import AsyncIterator
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4
from zipfile import ZipFile

import asyncpg
import pytest

from core.config import AppSettings, Settings
from core.database import Database, DBConnection
from tests.conftest import REPORT_DATE, ROOT
from tests.fakes.implementations import base, stress
from tests.test_api_worker import client_context, worker_environment
from tests.test_storage import fake_curve, seed_run, simulate_owner
from web.exceptions.curve_run import RunStateConflict
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.models import CalculationSpec, MarketRates, ScenarioParameters
from web.schemas.responses import InputRatesResponse
from web.services.calculations import CalculationWorker
from web.services.curve_runs import RunService


async def wait_for_lock(connection: DBConnection, pid: int) -> None:
    for _ in range(300):
        if await connection.fetchval(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')",
            pid,
        ):
            return
        await asyncio.sleep(0.01)
    pytest.fail("The operation did not reach the expected PostgreSQL row lock")


async def test_heartbeat_waiting_past_expiration_cannot_restore_ownership(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    async with (
        db_pool.acquire() as owner,
        db_pool.acquire() as locker,
        db_pool.acquire() as observer,
    ):
        run_id = await seed_run(owner, rates, parameters, spec)
        token = await CurveRunsRepository.start_stage(
            owner, run_id=run_id, worker_id=uuid4(), lease_duration=timedelta(seconds=1)
        )
        assert token is not None
        before = await CurveRunsRepository.get_run(observer, run_id)
        assert before is not None
        renewal = None
        try:
            async with locker.transaction():
                await locker.fetchrow("SELECT id FROM curve_run WHERE id=$1 FOR UPDATE", run_id)
                renewal = asyncio.create_task(
                    CurveRunsRepository.renew_lease(
                        owner, run_id=run_id, claim_token=token, lease_duration=timedelta(seconds=5)
                    )
                )
                await wait_for_lock(observer, owner.get_server_pid())
                await observer.execute("SELECT pg_sleep(1.1)")
                assert await observer.fetchval(
                    "SELECT lease_expires_at<=clock_timestamp() FROM curve_run WHERE id=$1", run_id
                )
            assert await renewal is False
        finally:
            if renewal is not None:
                if not renewal.done():
                    renewal.cancel()
                await asyncio.gather(renewal, return_exceptions=True)
        after = await CurveRunsRepository.get_run(observer, run_id)
        assert after is not None and after.lease_expires_at == before.lease_expires_at
        assert await CurveRunsRepository.interrupt_expired(observer) == 1
        recovered = await CurveRunsRepository.get_run(observer, run_id)
        assert recovered is not None and recovered.error is not None
        assert recovered.error.code == "CALCULATION_INTERRUPTED"


async def test_stage_lease_starts_after_waiting_for_lock(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    async with db_pool.acquire() as claimant, db_pool.acquire() as locker:
        run_id = await seed_run(claimant, rates, parameters, spec)
        task = None
        try:
            async with locker.transaction():
                await locker.fetchrow("SELECT id FROM curve_run WHERE id=$1 FOR UPDATE", run_id)
                task = asyncio.create_task(
                    CurveRunsRepository.start_stage(
                        claimant,
                        run_id=run_id,
                        worker_id=uuid4(),
                        lease_duration=timedelta(seconds=1),
                    )
                )
                await wait_for_lock(locker, claimant.get_server_pid())
                await locker.execute("SELECT pg_sleep(1.1)")
            assert await task is not None
        finally:
            if task is not None:
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert await locker.fetchval(
            "SELECT lease_expires_at>clock_timestamp() FROM curve_run WHERE id=$1", run_id
        )


async def test_json_resource_limits_are_client_errors(
    api_settings: Settings,
    connection: DBConnection,
) -> None:
    async with client_context(api_settings) as (client, app):
        oversized_number = (
            b'{"reportDate":"2026-07-31","scenarioParameters":{"mode":"custom","p":'
            + b"9" * 5000
            + b',"k":5,"d":3}}'
        )
        huge_exponent = (
            b'{"reportDate":"2026-07-31","scenarioParameters":{"mode":"custom",'
            b'"p":1e9999999999999999999999,"k":5,"d":3}}'
        )
        for body in (oversized_number, huge_exponent, b"[" * 2000 + b"]" * 2000):
            response = await client.post(
                "/api/v1/curve-runs", content=body, headers={"Content-Type": "application/json"}
            )
            assert response.status_code in (400, 422), response.text
            assert response.json()["error"]["code"] in ("INVALID_JSON", "VALIDATION_ERROR")
        app.state.settings.app.max_request_body_bytes = 128

        async def chunks() -> AsyncIterator[bytes]:
            yield b" " * 100
            yield b" " * 100

        # Enforce bytes actually received, including chunked/incorrect Content-Length input.
        response = await client.post(
            "/api/v1/curve-runs",
            content=chunks(),
            headers={"Content-Type": "application/json", "Content-Length": "1"},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
        assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0


async def test_cors_errors_preflights_and_http_headers(
    api_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api_settings.app = AppSettings(cors_origins=["http://localhost:5173"])
    origin = {"Origin": "http://localhost:5173", "X-Request-ID": "cors-regression"}
    async with client_context(api_settings) as (client, app):
        good = await client.get("/api/v1/input-rates?reportDate=2026-07-31", headers=origin)
        assert good.status_code == 200
        method = await client.delete("/api/v1/input-rates", headers=origin)
        assert method.status_code == 405 and "GET" in method.headers["Allow"]
        assert method.json()["error"]["code"] == "VALIDATION_ERROR"
        preflight = await client.options(
            "/api/v1/curve-runs", headers={**origin, "Access-Control-Request-Method": "POST"}
        )
        assert preflight.status_code == 200

        async def fail(self: RunService, report_date: date) -> InputRatesResponse:
            raise RuntimeError("Synthetic regression failure")

        monkeypatch.setattr(RunService, "input_rates", fail)
        bad = await client.get("/api/v1/input-rates?reportDate=2026-07-31", headers=origin)
        assert bad.status_code == 500 and bad.json()["error"]["code"] == "INTERNAL_ERROR"
        for response in (good, method, preflight, bad):
            assert response.headers["Access-Control-Allow-Origin"] == origin["Origin"]
            assert response.headers["X-Request-ID"] == origin["X-Request-ID"]


async def test_invalid_response_is_rejected_before_serialization(
    api_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def corrupted(self: RunService, report_date: date) -> InputRatesResponse:
        response = InputRatesResponse(
            report_date=report_date,
            available=True,
            source="moex",
            source_as_of=None,
            loaded_at=None,
            points=[],
        )
        # Bypass assignment validation to simulate a broken service boundary.
        object.__setattr__(response, "source", "unexpected-source")
        return response

    monkeypatch.setattr(RunService, "input_rates", corrupted)
    async with client_context(api_settings) as (client, app):
        response = await client.get("/api/v1/input-rates?reportDate=2026-07-31")
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "INTERNAL_ERROR"
        assert "unexpected-source" not in response.text


async def test_copy_base_rejects_unrelated_target(
    connection: DBConnection,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    parent = await seed_run(connection, rates, parameters, spec)
    token = await simulate_owner(connection, parent)
    await CurvesRepository.publish_stage(
        connection, run_id=parent, claim_token=token, curves=(fake_curve(spec),)
    )
    target = await CurveRunsRepository.create_run(
        connection,
        report_date=REPORT_DATE,
        parameters=parameters,
        spec=spec,
    )
    with pytest.raises(RunStateConflict):
        await CurvesRepository.copy_base(connection, source_run_id=parent, target_run_id=target)
    assert await CurvesRepository.read_curves(connection, target) == ()
    assert len(await CurvesRepository.read_curves(connection, parent)) == 1


async def wait_for_running(connection: DBConnection, run_id: UUID) -> None:
    for _ in range(250):
        run = await CurveRunsRepository.get_run(connection, run_id)
        if run is not None and run.status == "running":
            return
        await asyncio.sleep(0.02)
    pytest.fail("Worker did not claim the test run")


async def test_worker_once_sigterm_is_a_clean_interruption(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    run_id = await seed_run(connection, rates, parameters, spec)
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "web.processes.calculation_worker",
        "--once",
        cwd=ROOT,
        env=worker_environment(api_settings),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        await wait_for_running(connection, run_id)
        process.send_signal(signal.SIGTERM)
        stdout, stderr = await asyncio.wait_for(process.communicate(), 5)
        run = await CurveRunsRepository.get_run(connection, run_id)
        assert run is not None and run.status == "failed" and run.error is not None
        assert run.error.code == "CALCULATION_INTERRUPTED"
        assert b"pool closed" in stdout
        assert process.returncode == 0 and b"Traceback" not in stderr
    finally:
        if process.returncode is None:
            process.kill()
            await process.communicate()


async def test_packaged_backend_has_working_default_logging(
    database_dsn: str,
    tmp_path: Path,
) -> None:
    wheel_dir = tmp_path / "dist"
    build = await asyncio.create_subprocess_exec(
        "uv",
        "build",
        "--wheel",
        "--out-dir",
        str(wheel_dir),
        cwd=ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(build.communicate(), 60)
    assert build.returncode == 0, (stdout + stderr).decode()
    unpacked = tmp_path / "package"
    with ZipFile(next(wheel_dir.glob("*.whl"))) as archive:
        archive.extractall(unpacked)
    script = """
import asyncio, os
from pathlib import Path
import httpx
import core
from core.config import DatabaseSettings, Settings
from web.app import create_app
assert Path(core.__file__).resolve().is_relative_to(Path(os.environ["PYTHONPATH"]))
async def main():
    settings = Settings(_env_file=None, database=DatabaseSettings(dsn=os.environ["DATABASE__DSN"]))
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/input-rates?reportDate=2026-07-31")
            assert response.status_code == 200, response.text
            assert response.json()["available"] is False
    assert app.state.settings.logging.config_file is None
asyncio.run(main())
"""
    env = {**os.environ, "PYTHONPATH": str(unpacked), "DATABASE__DSN": database_dsn}
    env.pop("LOGGING__CONFIG_FILE", None)
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        script,
        cwd=tmp_path,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 10)
        assert process.returncode == 0, (stdout + stderr).decode()
        assert b"pool opened" in stdout and b"pool closed" in stdout
    finally:
        if process.returncode is None:
            process.kill()
            await process.communicate()


async def test_worker_loop_preserves_external_cancellation(
    db_pool: asyncpg.Pool[Any],
    api_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = asyncio.Event()

    async def blocked(self: CalculationWorker, stop: asyncio.Event | None = None) -> bool:
        entered.set()
        await asyncio.Event().wait()
        return False

    monkeypatch.setattr(CalculationWorker, "run_once", blocked)
    assert api_settings.worker is not None
    worker = CalculationWorker(
        Database(db_pool, api_settings.database), api_settings.worker, base, stress
    )
    task = asyncio.create_task(worker.run(asyncio.Event()))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
