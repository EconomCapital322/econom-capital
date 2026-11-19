from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from uuid import uuid4

import pytest
import simplejson

from core.config import AutomationSettings, LoaderSettings, Settings
from core.database import Database
from tests.test_api_worker import client_context
from web.calculations.market_grid import MARKET_MIDPOINTS
from web.exceptions.http import ApiError
from web.exceptions.input_rate import MarketTemporaryError, NoMarketData
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import Bucket, CalculationSpec, MarketRates
from web.services.preparation import (
    MOSCOW,
    PreparationWorker,
    enqueue_dates,
    preparation_state,
    request_preparation,
)


def enabled(settings: Settings) -> Settings:
    path = settings.calculation.spec_file
    assert path is not None
    spec = CalculationSpec.model_validate(simplejson.loads(path.read_text(), use_decimal=True))
    market_spec = spec.model_copy(
        update={
            "data_provenance": "market",
            "grid": tuple(
                Bucket(bucket_label=label, tenor_years=tenor) for label, tenor in MARKET_MIDPOINTS
            ),
        }
    )
    path.write_text(market_spec.model_dump_json())
    return settings.model_copy(
        update={
            "automation": AutomationSettings(enabled=True, lookback_days=2),
            "loader": LoaderSettings(
                max_attempts=1,
                backoff_base_seconds=0.01,
                backoff_cap_seconds=0.01,
                request_timeout_seconds=1,
            ),
        }
    )


async def test_requests_are_durable_deduplicated_and_publish_one_run(
    api_settings: Settings, rates: MarketRates
) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        replies = await asyncio.gather(
            *(request_preparation(db, settings, rates.report_date) for _ in range(12))
        )
        assert {r["status"] for r in replies} == {"queued"}
        calls = 0

        async def fetch(day: date) -> MarketRates:
            nonlocal calls
            calls += 1
            # A source request must not retain a database connection/transaction.
            async with db.connection() as c:
                assert await c.fetchval("SELECT count(*) FROM curve_run") == 0
            assert day == rates.report_date
            return rates

        assert await PreparationWorker(db, settings, fetch).run_once()
        assert calls == 1
        ready = await preparation_state(db, rates.report_date)
        assert ready["status"] == "ready" and ready["runId"]
        await asyncio.gather(
            *(request_preparation(db, settings, rates.report_date) for _ in range(8))
        )
        async with db.connection() as c:
            assert await c.fetchval("SELECT count(*) FROM curve_run") == 1
            assert await c.fetchval("SELECT run_origin FROM curve_run") == "automatic"
            assert await c.fetchval("SELECT count(*) FROM input_rate WHERE run_id IS NULL") == len(
                rates.points
            )


async def test_no_data_is_terminal_and_not_automatically_retried(
    api_settings: Settings, rates: MarketRates
) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        await request_preparation(db, settings, rates.report_date)

        async def fetch(day: date) -> MarketRates:
            raise NoMarketData

        worker = PreparationWorker(db, settings, fetch)
        await worker.run_once()
        assert (await request_preparation(db, settings, rates.report_date))["status"] == "no_data"
        assert not await worker.run_once()
        assert (await request_preparation(db, settings, rates.report_date, retry=True))[
            "status"
        ] == "queued"


async def test_failure_requires_explicit_retry(api_settings: Settings, rates: MarketRates) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        await request_preparation(db, settings, rates.report_date)

        async def fail(day: date) -> MarketRates:
            raise MarketTemporaryError

        await PreparationWorker(db, settings, fail).run_once()
        assert (await request_preparation(db, settings, rates.report_date))["status"] == "failed"
        assert (await request_preparation(db, settings, rates.report_date, retry=True))[
            "status"
        ] == "queued"

        async def fetch(day: date) -> MarketRates:
            return rates

        await PreparationWorker(db, settings, fetch).run_once()
        assert (await preparation_state(db, rates.report_date))["status"] == "ready"


async def test_expired_claim_is_recovered_and_stale_owner_cannot_publish(
    api_settings: Settings, rates: MarketRates
) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        await request_preparation(db, settings, rates.report_date)
        old = uuid4()
        async with db.connection() as c:
            await c.execute(
                "UPDATE curve_preparation SET status='running',claim_token=$1, "
                "lease_until=clock_timestamp()-interval '1 second'",
                old,
            )

        async def fetch(day: date) -> MarketRates:
            return rates

        worker = PreparationWorker(db, settings, fetch)
        assert not await worker.publish(rates.report_date, old, rates)
        assert await worker.run_once()
        assert not await worker.publish(rates.report_date, old, rates)
        assert (await preparation_state(db, rates.report_date))["status"] == "ready"


async def test_shutdown_requeues_source_job(api_settings: Settings, rates: MarketRates) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        await request_preparation(db, settings, rates.report_date)
        entered = asyncio.Event()

        async def fetch(day: date) -> MarketRates:
            entered.set()
            await asyncio.Event().wait()
            return rates

        stop = asyncio.Event()
        task = asyncio.create_task(PreparationWorker(db, settings, fetch).run_once(stop))
        await asyncio.wait_for(entered.wait(), 1)
        stop.set()
        await asyncio.wait_for(task, 1)
        assert (await preparation_state(db, rates.report_date))["status"] == "queued"


async def test_scheduler_is_due_and_repeat_safe(api_settings: Settings) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        worker = PreparationWorker(db, settings)
        now = datetime(2026, 10, 30, 18, 0, tzinfo=MOSCOW)
        await worker.schedule(now)
        async with db.connection() as c:
            assert await c.fetchval("SELECT max(report_date) FROM curve_preparation") == date(
                2026, 10, 29
            )
        await worker.schedule(now.replace(hour=20))
        async with db.connection() as c:
            assert await c.fetchval("SELECT max(report_date) FROM curve_preparation") == date(
                2026, 10, 30
            )
            await c.execute("UPDATE curve_preparation SET status='no_data'")
        await worker.schedule(now.replace(hour=21))
        async with db.connection() as c:
            assert (
                await c.fetchval("SELECT count(*) FROM curve_preparation WHERE status='queued'")
                == 0
            )
        await worker.schedule(now + timedelta(days=1))
        async with db.connection() as c:
            assert (
                await c.fetchval("SELECT count(*) FROM curve_preparation WHERE status='queued'")
                == 2
            )


async def test_backfill_is_idempotent(api_settings: Settings) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        assert await enqueue_dates(db, date(2026, 9, 1), date(2026, 10, 31)) == 61
        assert await enqueue_dates(db, date(2026, 9, 1), date(2026, 10, 31)) == 0
        with pytest.raises(ValueError):
            await enqueue_dates(db, date(2026, 10, 31), date(2026, 9, 1))


async def test_http_preparation_is_fast_and_has_read_only_polling(
    api_settings: Settings, rates: MarketRates
) -> None:
    settings = enabled(api_settings)
    async with client_context(settings) as (client, _):
        replies = await asyncio.gather(
            *(
                client.post(
                    "/api/v1/curve-preparations", json={"reportDate": rates.report_date.isoformat()}
                )
                for _ in range(5)
            )
        )
        assert all(r.status_code == 202 for r in replies)
        r = await client.get(
            "/api/v1/curve-preparations", params={"reportDate": rates.report_date.isoformat()}
        )
        assert r.status_code == 200 and r.json()["status"] == "queued"
        assert (
            await client.post(
                "/api/v1/curve-preparations",
                json={"reportDate": rates.report_date.isoformat(), "retry": "yes"},
            )
        ).status_code == 422
        assert (
            await client.post("/api/v1/curve-preparations", json={"reportDate": "not-a-date"})
        ).status_code == 422


async def test_disabled_automation_does_not_queue(
    api_settings: Settings, rates: MarketRates
) -> None:
    async with Database.open(api_settings.database) as db:
        with pytest.raises(ApiError):
            await request_preparation(db, api_settings, rates.report_date)


async def test_existing_rates_create_calculation_without_moex(
    api_settings: Settings, rates: MarketRates
) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        async with db.transaction() as c:
            await InputRatesRepository.replace_current(c, rates, loaded_at=rates.source_as_of)
        assert (await request_preparation(db, settings, rates.report_date))["status"] == "ready"
        assert not await PreparationWorker(db, settings).run_once()


async def test_future_dates_are_not_fetched(api_settings: Settings) -> None:
    from web.services.preparation import MOSCOW

    day = datetime.now(MOSCOW).date() + timedelta(days=1)
    async with Database.open(api_settings.database) as db:
        assert (await request_preparation(db, enabled(api_settings), day))["status"] == "no_data"
        assert (await preparation_state(db, day))["status"] == "no_data"
        async with db.connection() as c:
            assert await c.fetchval("SELECT count(*) FROM curve_preparation") == 0


async def test_ui_does_not_cancel_scheduled_refresh(
    api_settings: Settings, rates: MarketRates
) -> None:
    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        async with db.transaction() as c:
            await InputRatesRepository.replace_current(c, rates, loaded_at=rates.source_as_of)
        await request_preparation(db, settings, rates.report_date)
        await PreparationWorker(db, settings).schedule(datetime(2026, 7, 31, 20, tzinfo=MOSCOW))
        assert (await request_preparation(db, settings, rates.report_date))["status"] == "queued"


async def test_heartbeat_keeps_long_fetch_owned(api_settings: Settings, rates: MarketRates) -> None:
    from core.config import WorkerSettings

    settings = enabled(api_settings)
    settings = settings.model_copy(
        update={
            "worker": WorkerSettings(
                poll_seconds=0.01,
                lease_seconds=0.3,
                heartbeat_seconds=0.05,
                stage_timeout_seconds=2,
            ),
            "loader": LoaderSettings(
                max_attempts=1,
                backoff_base_seconds=0.01,
                backoff_cap_seconds=0.01,
                request_timeout_seconds=2,
            ),
        }
    )
    async with Database.open(settings.database) as db:
        await request_preparation(db, settings, rates.report_date)

        async def fetch(day: date) -> MarketRates:
            await asyncio.sleep(0.7)
            return rates

        await PreparationWorker(db, settings, fetch).run_once()
        assert (await preparation_state(db, rates.report_date))["status"] == "ready"


async def test_combined_worker_cli_processes_source_base_and_stress(
    api_settings: Settings, rates: MarketRates
) -> None:
    import os
    import sys

    from tests.conftest import ROOT

    settings = enabled(api_settings)
    async with Database.open(settings.database) as db:
        await request_preparation(db, settings, rates.report_date)
        env = {
            **os.environ,
            "DATABASE__DSN": settings.database.dsn.get_secret_value(),
            "CALCULATION__SPEC_FILE": str(settings.calculation.spec_file),
            "INTEGRATIONS__FETCH_FUNCTION": "tests.fakes.implementations:fetch",
            "INTEGRATIONS__BASE_FUNCTION": "tests.fakes.implementations:base",
            "INTEGRATIONS__STRESS_FUNCTION": "tests.fakes.implementations:stress",
            "AUTOMATION__ENABLED": "true",
            "LOADER__MAX_ATTEMPTS": "1",
            "LOADER__BACKOFF_BASE_SECONDS": ".01",
            "LOADER__BACKOFF_CAP_SECONDS": ".01",
            "LOADER__REQUEST_TIMEOUT_SECONDS": "2",
            "WORKER__POLL_SECONDS": ".01",
            "WORKER__LEASE_SECONDS": "3",
            "WORKER__HEARTBEAT_SECONDS": ".2",
            "WORKER__STAGE_TIMEOUT_SECONDS": "2",
        }
        env.pop("INTEGRATIONS__STRESS_HTTP_URL", None)
        env.pop("INTEGRATIONS__STRESS_HTTP_VERSION", None)
        for _ in range(3):
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
            out, err = await asyncio.wait_for(process.communicate(), 15)
            assert process.returncode == 0, (out + err).decode()
        async with db.connection() as connection:
            assert await connection.fetchval("SELECT status FROM curve_run") == "ready"
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 1
