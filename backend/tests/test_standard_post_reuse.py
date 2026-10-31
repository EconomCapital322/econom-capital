"""Public standard POST reuses one durable run per input snapshot and specification."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from decimal import Decimal
from uuid import UUID

import pytest

from core.config import Settings
from core.database import DBConnection
from tests.conftest import AS_OF, REPORT_DATE
from tests.test_api_worker import client_context
from tests.test_storage import fake_curve, simulate_owner
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import (
    STRESS_CODES,
    CalculationError,
    CalculationSpec,
    MarketRates,
    ScenarioParameters,
    StoredRun,
)


def standard_payload() -> dict[str, object]:
    return {"reportDate": str(REPORT_DATE), "scenarioParameters": {"mode": "standard"}}


async def test_standard_post_reuses_queued_running_and_ready(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
    spec: CalculationSpec,
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    async with client_context(api_settings) as (client, _):
        first = await client.post("/api/v1/curve-runs", json=standard_payload())
        assert first.status_code == 202 and first.json()["status"] == "queued"
        run_id = UUID(first.json()["runId"])
        assert first.headers["Location"] == f"/api/v1/curve-runs/{run_id}"
        assert (await client.get(first.headers["Location"])).json()["runOrigin"] == "automatic"

        queued = await client.post("/api/v1/curve-runs", json=standard_payload())
        assert queued.status_code == 202 and queued.json() == first.json()

        token = await simulate_owner(connection, run_id)
        running = await client.post("/api/v1/curve-runs", json=standard_payload())
        assert running.status_code == 202
        assert running.json() == {"runId": str(run_id), "status": "running"}
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
        ready = await client.post("/api/v1/curve-runs", json=standard_payload())
        assert ready.status_code == 200
        assert ready.json() == {"runId": str(run_id), "status": "ready"}
        assert ready.headers["Location"] == first.headers["Location"]
        assert await connection.fetchval("SELECT count(*) FROM curve_run") == 1

        newer = rates.model_copy(
            update={
                "source_as_of": AS_OF + timedelta(hours=1),
                "points": tuple(
                    point.model_copy(update={"rate_percent": point.rate_percent + Decimal(1)})
                    for point in rates.points
                ),
            }
        )
        await InputRatesRepository.replace_current(connection, newer, loaded_at=AS_OF)
        refreshed = await client.post("/api/v1/curve-runs", json=standard_payload())
        assert refreshed.status_code == 202 and refreshed.json()["status"] == "queued"
        refreshed_id = UUID(refreshed.json()["runId"])
        assert refreshed_id != run_id
        snapshot = await InputRatesRepository.read_snapshot(connection, refreshed_id)
        assert snapshot is not None and snapshot.points == newer.points

        assert api_settings.calculation.spec_file is not None
        changed_spec = spec.model_copy(update={"base_version": "another-base-version"})
        api_settings.calculation.spec_file.write_text(changed_spec.model_dump_json())
        new_spec = await client.post("/api/v1/curve-runs", json=standard_payload())
        assert new_spec.status_code == 202
        assert UUID(new_spec.json()["runId"]) not in (run_id, refreshed_id)
        assert await connection.fetchval("SELECT count(*) FROM curve_run") == 3


async def test_parallel_standard_posts_create_one_run(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    async with client_context(api_settings) as (client, _):
        responses = await asyncio.gather(
            *(client.post("/api/v1/curve-runs", json=standard_payload()) for _ in range(8))
        )
        assert all(response.status_code == 202 for response in responses)
        assert len({response.json()["runId"] for response in responses}) == 1
        assert all(response.json()["status"] == "queued" for response in responses)
        assert await connection.fetchval("SELECT count(*) FROM curve_run") == 1


async def test_failed_standard_run_can_be_retried_explicitly(
    api_settings: Settings, connection: DBConnection, rates: MarketRates
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    async with client_context(api_settings) as (client, _):
        first = await client.post("/api/v1/curve-runs", json=standard_payload())
        failed_id = UUID(first.json()["runId"])
        token = await simulate_owner(connection, failed_id)
        await CurveRunsRepository.save_failure(
            connection,
            run_id=failed_id,
            claim_token=token,
            error=CalculationError(code="BASE_CURVE_FAILED", message="Test failure"),
        )
        assert (await client.get(first.headers["Location"])).json()["status"] == "failed"
        retry = await client.post("/api/v1/curve-runs", json=standard_payload())
        assert retry.status_code == 202 and retry.json()["status"] == "queued"
        retry_id = UUID(retry.json()["runId"])
        assert retry_id != failed_id
        assert (
            await client.post("/api/v1/curve-runs", json=standard_payload())
        ).json() == retry.json()
        rows = await connection.fetch(
            "SELECT id,status,automatic_key FROM curve_run ORDER BY created_at,id"
        )
        assert len(rows) == 2
        assert rows[0]["automatic_key"] == rows[1]["automatic_key"]
        assert {row["status"] for row in rows} == {"failed", "queued"}


async def test_worker_failure_waits_for_reused_post_response(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    async with client_context(api_settings) as (client, _):
        first = await client.post("/api/v1/curve-runs", json=standard_payload())
        run_id = UUID(first.json()["runId"])
        token = await simulate_owner(connection, run_id)
        entered, release = asyncio.Event(), asyncio.Event()
        original = CurveRunsRepository.get_run

        async def paused_get_run(
            cls: type[CurveRunsRepository], conn: DBConnection, target: UUID
        ) -> StoredRun | None:
            entered.set()
            await release.wait()
            return await original(conn, target)

        monkeypatch.setattr(CurveRunsRepository, "get_run", classmethod(paused_get_run))
        repeated = asyncio.create_task(client.post("/api/v1/curve-runs", json=standard_payload()))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            failure = asyncio.create_task(
                CurveRunsRepository.save_failure(
                    connection,
                    run_id=run_id,
                    claim_token=token,
                    error=CalculationError(code="BASE_CURVE_FAILED", message="Test failure"),
                )
            )
            await asyncio.sleep(0.05)
            assert not failure.done()
        finally:
            release.set()
        response = await repeated
        assert response.status_code == 202
        assert response.json() == {"runId": str(run_id), "status": "running"}
        await failure
        assert (await client.get(first.headers["Location"])).json()["status"] == "failed"


async def test_legacy_manual_standard_history_is_preserved(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
    spec: CalculationSpec,
) -> None:
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
    legacy_id = await CurveRunsRepository.create_run(
        connection,
        report_date=REPORT_DATE,
        parameters=ScenarioParameters(mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3)),
        spec=spec,
    )
    async with client_context(api_settings) as (client, _):
        created = await client.post("/api/v1/curve-runs", json=standard_payload())
        assert created.status_code == 202 and UUID(created.json()["runId"]) != legacy_id
        legacy = await CurveRunsRepository.get_run(connection, legacy_id)
        assert legacy is not None and legacy.run_origin == "manual"
