"""Durable, idempotent preparation of a report date. HTTP never calls MOEX."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from core.config import Settings
from core.database import Database
from web.exceptions.http import ApiError
from web.integrations.adapters import EgorAdapter
from web.integrations.contracts import FetchRates
from web.integrations.specification import load_specification
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import CalculationSpec, MarketRates, ScenarioParameters
from web.services.calculations import CalculationWorker
from web.services.loading import fetch_validated_rates

logger = logging.getLogger(__name__)
MOSCOW = ZoneInfo("Europe/Moscow")
STANDARD = ScenarioParameters(mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3))


def automation_spec(settings: Settings) -> CalculationSpec:
    if not settings.automation.enabled or settings.loader is None or settings.worker is None:
        raise ApiError(503, "AUTOMATION_UNAVAILABLE", "Date preparation is not configured")
    try:
        spec = load_specification(settings.calculation.spec_file)
    except Exception as exc:
        raise ApiError(
            503, "AUTOMATION_UNAVAILABLE", "Calculation specification is unavailable"
        ) from exc
    if spec.data_provenance != "market":
        raise ApiError(
            503, "AUTOMATION_UNAVAILABLE", "Date preparation requires a market specification"
        )
    return spec


def response(row: Any, report_date: date) -> dict[str, Any]:
    return {
        "reportDate": report_date.isoformat(),
        "status": row["status"] if row else "idle",
        "runId": str(row["run_id"]) if row and row["run_id"] else None,
        "errorCode": row["error_code"] if row else None,
    }


async def preparation_state(database: Database, report_date: date) -> dict[str, Any]:
    if report_date > datetime.now(MOSCOW).date():
        return {
            "reportDate": report_date.isoformat(),
            "status": "no_data",
            "runId": None,
            "errorCode": None,
        }
    async with database.connection() as connection:
        row = await connection.fetchrow(
            "SELECT * FROM curve_preparation WHERE report_date=$1", report_date
        )
    return response(row, report_date)


async def request_preparation(
    database: Database,
    settings: Settings,
    report_date: date,
    *,
    retry: bool = False,
) -> dict[str, Any]:
    spec = automation_spec(settings)
    if report_date > datetime.now(MOSCOW).date():
        return {
            "reportDate": report_date.isoformat(),
            "status": "no_data",
            "runId": None,
            "errorCode": None,
        }
    async with database.transaction() as connection:
        await connection.execute(
            "INSERT INTO curve_preparation(report_date,status,priority) VALUES($1,'queued',10) "
            "ON CONFLICT(report_date) DO NOTHING",
            report_date,
        )
        row = await connection.fetchrow(
            "SELECT * FROM curve_preparation WHERE report_date=$1 FOR UPDATE", report_date
        )
        if row is None:
            raise RuntimeError("Preparation row missing")
        if row["status"] == "running" or (
            row["status"] == "queued" and row["last_scheduled_on"] is not None
        ):
            return response(row, report_date)
        if row["status"] == "failed":
            if retry:
                row = await connection.fetchrow(
                    "UPDATE curve_preparation SET status='queued',error_code=NULL,priority=10, "
                    "requested_at=clock_timestamp(),updated_at=clock_timestamp() "
                    "WHERE report_date=$1 RETURNING *",
                    report_date,
                )
            return response(row, report_date)
        rates = await InputRatesRepository.read_current(connection, report_date)
        if rates is not None:
            if row["run_id"] and not retry:
                existing = await CurveRunsRepository.get_run(connection, row["run_id"])
                if existing is not None and existing.status == "failed":
                    return response(row, report_date)
            run_id = await CurveRunsRepository.create_run(
                connection,
                report_date=report_date,
                parameters=STANDARD,
                spec=spec,
                run_origin="automatic",
            )
            row = await connection.fetchrow(
                "UPDATE curve_preparation SET status='ready',run_id=$2,error_code=NULL, "
                "updated_at=clock_timestamp() WHERE report_date=$1 RETURNING *",
                report_date,
                run_id,
            )
        elif row["status"] == "ready" or (retry and row["status"] in ("failed", "no_data")):
            row = await connection.fetchrow(
                "UPDATE curve_preparation SET "
                "status='queued',run_id=NULL,error_code=NULL,priority=10, "
                "requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE "
                "report_date=$1 RETURNING *",
                report_date,
            )
        elif row["status"] == "queued":
            await connection.execute(
                "UPDATE curve_preparation SET priority=10 WHERE report_date=$1", report_date
            )
    return response(row, report_date)


async def enqueue_dates(database: Database, start: date, end: date) -> int:
    if end < start or (end - start).days > 3660:
        raise ValueError("Expected a date range no longer than ten years")
    end = min(end, datetime.now(MOSCOW).date())
    async with database.transaction() as connection:
        result = await connection.fetch(
            "INSERT INTO curve_preparation(report_date,status) "
            "SELECT d::date,'queued' FROM generate_series($1::date,$2::date,'1 day') d "
            "ON CONFLICT(report_date) DO NOTHING RETURNING report_date",
            start,
            end,
        )
    return len(result)


class PreparationWorker:
    def __init__(
        self, database: Database, settings: Settings, fetch: FetchRates | None = None
    ) -> None:
        self.database, self.settings = database, settings
        self.spec = automation_spec(settings)
        self.fetch = fetch if fetch is not None else EgorAdapter(settings.integrations).fetch

    async def schedule(self, now: datetime | None = None) -> None:
        local = (now or datetime.now(MOSCOW)).astimezone(MOSCOW)
        end = local.date()
        if local.time() < self.settings.automation.run_at:
            end -= timedelta(days=1)
        start = end - timedelta(days=self.settings.automation.lookback_days - 1)
        async with self.database.transaction() as connection:
            await connection.execute(
                "INSERT INTO curve_preparation(report_date,status,priority,last_scheduled_on) "
                "SELECT d::date,'queued',5,$3 FROM generate_series($1::date,$2::date,'1 day') d "
                "ON CONFLICT(report_date) DO UPDATE SET "
                "status=CASE WHEN curve_preparation.status IN ('ready','no_data','failed') "
                "THEN 'queued' ELSE curve_preparation.status END, "
                "priority=GREATEST(curve_preparation.priority,5),last_scheduled_on=$3, "
                "updated_at=clock_timestamp() "
                "WHERE curve_preparation.last_scheduled_on IS NULL OR "
                "(curve_preparation.status IN ('no_data','failed') AND "
                "curve_preparation.last_scheduled_on<$3)",
                start,
                end,
                local.date(),
            )

    async def heartbeat(self, day: date, token: UUID) -> None:
        assert self.settings.worker is not None
        while True:
            await asyncio.sleep(self.settings.worker.heartbeat_seconds)
            async with self.database.connection() as connection:
                renewed = await connection.fetchval(
                    "UPDATE curve_preparation SET lease_until=clock_timestamp()+$3 "
                    "WHERE report_date=$1 AND claim_token=$2 AND status='running' "
                    "AND lease_until>clock_timestamp() RETURNING true",
                    day,
                    token,
                    timedelta(seconds=self.settings.worker.lease_seconds),
                )
            if not renewed:
                return

    async def publish(self, day: date, token: UUID, rates: MarketRates | None) -> bool:
        async with self.database.transaction() as connection:
            owner = await connection.fetchrow(
                "SELECT * FROM curve_preparation WHERE report_date=$1 AND claim_token=$2 "
                "AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",
                day,
                token,
            )
            if owner is None:
                return False
            if rates is not None:
                await InputRatesRepository.replace_current(
                    connection, rates, loaded_at=datetime.now(MOSCOW)
                )
            current = await InputRatesRepository.read_current(connection, day)
            run_id = None
            if current is not None:
                run_id = await CurveRunsRepository.create_run(
                    connection,
                    report_date=day,
                    parameters=STANDARD,
                    spec=self.spec,
                    run_origin="automatic",
                )
            await connection.execute(
                "UPDATE curve_preparation SET "
                "status=$3,run_id=$4,error_code=NULL,claim_token=NULL, "
                "lease_until=NULL,updated_at=clock_timestamp() WHERE report_date=$1 "
                "AND claim_token=$2",
                day,
                token,
                "ready" if current else "no_data",
                run_id,
            )
        return True

    async def run_once(self, stop: asyncio.Event | None = None) -> bool:
        assert self.settings.worker is not None and self.settings.loader is not None
        stop = stop if stop is not None else asyncio.Event()
        token = uuid4()
        async with self.database.connection() as connection:
            row = await connection.fetchrow(
                "WITH job AS (SELECT report_date FROM curve_preparation WHERE status='queued' OR "
                "(status='running' AND lease_until<=clock_timestamp()) "
                "ORDER BY priority DESC,requested_at FOR UPDATE SKIP LOCKED LIMIT 1) "
                "UPDATE curve_preparation q SET status='running',claim_token=$1, "
                "lease_until=clock_timestamp()+$2,updated_at=clock_timestamp() "
                "FROM job WHERE q.report_date=job.report_date RETURNING q.report_date",
                token,
                timedelta(seconds=self.settings.worker.lease_seconds),
            )
        if row is None:
            return False
        day = row["report_date"]
        heartbeat = asyncio.create_task(self.heartbeat(day, token))
        fetch_task = asyncio.create_task(
            fetch_validated_rates(day, self.fetch, self.settings.loader)
        )
        shutdown = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait(
                {fetch_task, shutdown}, return_when=asyncio.FIRST_COMPLETED
            )
            if shutdown in done:
                raise asyncio.CancelledError
            rates = await fetch_task
            await self.publish(day, token, rates)
        except asyncio.CancelledError:
            async with self.database.connection() as connection:
                await connection.execute(
                    "UPDATE curve_preparation SET "
                    "status='queued',claim_token=NULL,lease_until=NULL "
                    "WHERE report_date=$1 AND claim_token=$2",
                    day,
                    token,
                )
            if not stop.is_set():
                raise
        except Exception:
            logger.exception("Date preparation failed reportDate=%s", day)
            async with self.database.connection() as connection:
                await connection.execute(
                    "UPDATE curve_preparation SET status='failed',error_code='SOURCE_UNAVAILABLE', "
                    "claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() "
                    "WHERE report_date=$1 AND claim_token=$2",
                    day,
                    token,
                )
        finally:
            for task in (heartbeat, fetch_task, shutdown):
                task.cancel()
            for task in (heartbeat, fetch_task, shutdown):
                with suppress(asyncio.CancelledError, Exception):
                    await task
        return True

    async def run(self, calculation: CalculationWorker, stop: asyncio.Event) -> None:
        next_schedule = 0.0
        while not stop.is_set() and not calculation.must_exit:
            if asyncio.get_running_loop().time() >= next_schedule:
                await self.schedule()
                next_schedule = asyncio.get_running_loop().time() + 60
            loaded = await self.run_once(stop)
            if stop.is_set():
                break
            calculated = await calculation.run_once(stop)
            if not loaded and not calculated:
                assert self.settings.worker is not None
                with suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), self.settings.worker.poll_seconds)
