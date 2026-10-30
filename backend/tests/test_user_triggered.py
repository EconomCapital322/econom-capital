from __future__ import annotations

import asyncio
from datetime import timedelta
from decimal import Decimal
from uuid import UUID

import pytest
from pydantic import ValidationError

from core.config import IntegrationSettings, LoaderSettings, Settings
from core.database import DBConnection
from tests.conftest import AS_OF, REPORT_DATE
from tests.fakes.implementations import base, failing_stress, stress
from tests.test_api_worker import client_context
from web.integrations.adapters import SlavaAdapter
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import MarketRates
from web.services.calculations import CalculationWorker


async def test_date_reads_failed_history_and_explicit_retry(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    dates = (REPORT_DATE, REPORT_DATE + timedelta(days=1))
    for report_date in dates:
        await InputRatesRepository.replace_current(
            connection, rates.model_copy(update={"report_date": report_date}), loaded_at=AS_OF
        )
    async with client_context(api_settings) as (client, app):
        assert api_settings.worker is not None
        worker = CalculationWorker(app.state.database, api_settings.worker, base, failing_stress)
        assert not await worker.run_once()
        for report_date in dates:
            for path in ("input-rates", "curve-runs"):
                assert (
                    await client.get(f"/api/v1/{path}?reportDate={report_date}")
                ).status_code == 200
        assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
        payload = {"reportDate": str(REPORT_DATE), "scenarioParameters": {"mode": "standard"}}
        response = await client.post("/api/v1/curve-runs", json=payload)
        assert response.status_code == 202 and response.json()["status"] == "queued"
        old_id = UUID(response.json()["runId"])
        assert await worker.run_once() and await worker.run_once()
        before = await CurveRunsRepository.get_run(connection, old_id)
        assert before is not None and before.status == "failed"
        saved_base = await CurvesRepository.read_curves(connection, old_id)
        old_snapshot = await InputRatesRepository.read_snapshot(connection, old_id)
        for _ in range(2):
            assert (await client.get(f"/api/v1/curve-runs/{old_id}")).json()["status"] == "failed"
            assert (await client.get(f"/api/v1/curve-runs/{old_id}/result")).status_code == 409
            assert (
                len(
                    (await client.get(f"/api/v1/curve-runs?reportDate={REPORT_DATE}")).json()[
                        "runs"
                    ]
                )
                == 1
            )
        newer = rates.model_copy(
            update={
                "source_as_of": AS_OF + timedelta(hours=1),
                "points": tuple(
                    p.model_copy(update={"rate_percent": Decimal(7)}) for p in rates.points
                ),
            }
        )
        await InputRatesRepository.replace_current(connection, newer, loaded_at=AS_OF)
        response = await client.post("/api/v1/curve-runs", json=payload)
        new_id = UUID(response.json()["runId"])
        assert response.status_code == 202 and new_id != old_id
        snapshot = await InputRatesRepository.read_snapshot(connection, new_id)
        assert snapshot is not None and snapshot.points == newer.points
        assert await InputRatesRepository.read_snapshot(connection, old_id) == old_snapshot
        successful = CalculationWorker(app.state.database, api_settings.worker, base, stress)
        assert await successful.run_once() and await successful.run_once()
        assert (await client.get(f"/api/v1/curve-runs/{new_id}/result")).status_code == 200
        assert await CurveRunsRepository.get_run(connection, old_id) == before
        assert await CurvesRepository.read_curves(connection, old_id) == saved_base
        assert await CurveRunsRepository.list_runs(connection, dates[1]) == []
        assert not await successful.run_once()


async def test_real_http_read_timeout_is_saved_as_timeout(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    release = asyncio.Event()
    handlers: set[asyncio.Task[None]] = set()

    async def delayed(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        handlers.add(task)
        try:
            await reader.readuntil(b"\r\n\r\n")
            await release.wait()
        finally:
            writer.close()
            await writer.wait_closed()
            handlers.discard(task)

    server = await asyncio.start_server(delayed, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    adapter = SlavaAdapter(
        IntegrationSettings.model_validate(
            {
                "stress_http_url": f"http://127.0.0.1:{port}/internal/v1/stress-curves",
                "stress_http_version": "test-only-stress",
                "stress_http_timeout_seconds": 0.05,
            }
        )
    )
    try:
        async with asyncio.timeout(10), client_context(api_settings) as (client, app):
            response = await client.post(
                "/api/v1/curve-runs",
                json={
                    "reportDate": str(REPORT_DATE),
                    "scenarioParameters": {"mode": "standard"},
                },
            )
            run_id = UUID(response.json()["runId"])
            assert api_settings.worker is not None
            worker = CalculationWorker(
                app.state.database, api_settings.worker, base, adapter.stress
            )
            assert await worker.run_once()
            saved = await CurvesRepository.read_curves(connection, run_id)
            assert await worker.run_once()
            state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
            assert state["status"] == "failed" and state["stage"] == "stress"
            assert state["error"]["code"] == "CALCULATION_TIMEOUT"
            assert state["baseCurve"] and not worker.must_exit
            assert await CurvesRepository.read_curves(connection, run_id) == saved
    finally:
        server.close()
        release.set()
        for task in tuple(handlers):
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)
        await server.wait_closed()


def test_legacy_loader_switch_cannot_enable_calculations(monkeypatch: pytest.MonkeyPatch) -> None:
    fields = dict(
        max_attempts=1, backoff_base_seconds=1, backoff_cap_seconds=1, request_timeout_seconds=1
    )
    assert LoaderSettings(**fields).enqueue_automatic is False
    with pytest.raises(ValidationError):
        LoaderSettings.model_validate({**fields, "enqueue_automatic": True})
    monkeypatch.setenv("LOADER__ENQUEUE_AUTOMATIC", "false")
    settings = Settings(_env_file=None, database={"dsn": "postgresql://unused/test"}, loader=fields)
    assert settings.loader is not None and settings.loader.enqueue_automatic is False
