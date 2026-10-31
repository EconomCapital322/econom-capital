"""Opt-in real MOEX + CLI Loader + PostgreSQL + both real Go modules, no source fallback."""

from __future__ import annotations

import asyncio
import os
import sys
from contextlib import AsyncExitStack
from datetime import date
from uuid import UUID

import pytest

from core.config import Settings
from core.database import DBConnection
from tests.conftest import ROOT
from tests.test_live_pipeline import environment, live_api, live_worker, ready
from web.integrations.specification import load_specification
from web.repositories.input_rates import InputRatesRepository


@pytest.mark.skipif(
    os.environ.get("IRRBB_LIVE_MOEX") != "1", reason="Live MOEX requires explicit opt-in"
)
@pytest.mark.usefixtures("base_binary_on_path")
async def test_live_moex_loader_and_user_calculation(
    api_settings: Settings,
    connection: DBConnection,
    stress_url: str,
    unused_tcp_port: int,
) -> None:
    report_date = date(2026, 7, 31)
    spec = load_specification(ROOT / "examples/demo-calculation-spec.json").model_copy(
        update={
            "data_provenance": "market",
            "stress_version": "test-real-go-stress",
        }
    )
    assert api_settings.calculation.spec_file is not None
    api_settings.calculation.spec_file.write_text(spec.model_dump_json())
    env = environment(api_settings, stress_url)
    env.update(
        {
            "INTEGRATIONS__FETCH_FUNCTION": "web.integrations.moex:fetch_rates",
            "LOADER__MAX_ATTEMPTS": "2",
            "LOADER__BACKOFF_BASE_SECONDS": "1",
            "LOADER__BACKOFF_CAP_SECONDS": "2",
            "LOADER__REQUEST_TIMEOUT_SECONDS": "20",
            "MOEX__TIMEOUT_SECONDS": "10",
            "MOEX__TRUST_ENV": "true",
        }
    )
    env.pop("LOADER__ENQUEUE_AUTOMATIC", None)

    async def load(value: date) -> None:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "web.processes.moex_loader",
            "--report-date",
            str(value),
            cwd=ROOT,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 50)
            assert process.returncode == 0, (stdout + stderr).decode()
        finally:
            if process.returncode is None:
                process.kill()
                await process.communicate()

    await load(report_date)
    saved = await InputRatesRepository.read_current(connection, report_date)
    assert saved is not None and len(saved.points) >= 2
    assert saved.report_date == report_date and saved.source_as_of.date() == report_date
    assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
    async with AsyncExitStack() as stack:
        async with live_api(env, unused_tcp_port) as client:
            assert (await client.get(f"/api/v1/input-rates?reportDate={report_date}")).json()[
                "available"
            ]
            assert (await client.get(f"/api/v1/curve-runs?reportDate={report_date}")).json()[
                "runs"
            ] == []
            response = await client.post(
                "/api/v1/curve-runs",
                json={
                    "reportDate": str(report_date),
                    "scenarioParameters": {"mode": "standard"},
                },
            )
            assert response.status_code == 202
            run_id = UUID(response.json()["runId"])
            await stack.enter_async_context(live_worker(env))
            result = await ready(client, str(run_id))
            assert result["dataProvenance"] == "market" and len(result["curves"]) == 7  # type: ignore[arg-type]
            snapshot = await InputRatesRepository.read_snapshot(connection, run_id)
            assert snapshot == saved
            await load(report_date)
            assert await InputRatesRepository.read_current(connection, report_date) == saved
            assert await InputRatesRepository.read_snapshot(connection, run_id) == snapshot
            await load(date(2026, 10, 31))
            assert await InputRatesRepository.read_current(connection, date(2026, 10, 31)) is None
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 1
            assert (await client.get(f"/api/v1/curve-runs/{run_id}/result")).json() == result
    print(
        f"LIVE MOEX date={report_date} sourceAsOf={saved.source_as_of.isoformat()} "
        f"points={len(saved.points)} minTenor={saved.points[0].tenor_years} "
        f"maxTenor={saved.points[-1].tenor_years} curves=7; repeat=unchanged; noData=2026-10-31"
    )
