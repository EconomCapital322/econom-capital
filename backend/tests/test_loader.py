from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import asyncpg
import pytest
from pydantic import ValidationError

from core.config import DatabaseSettings, IntegrationSettings, LoaderSettings
from core.database import Database
from core.process_lock import process_lock
from tests.conftest import AS_OF, REPORT_DATE, ROOT
from web.exceptions.curve_run import ImplementationUnavailable
from web.exceptions.input_rate import MarketPermanentError, MarketTemporaryError, NoMarketData
from web.integrations.adapters import EgorAdapter
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import MarketRates
from web.services.loading import load_rates


@pytest.fixture
def loader_settings() -> LoaderSettings:
    return LoaderSettings(
        max_attempts=3, backoff_base_seconds=1, backoff_cap_seconds=1.5, request_timeout_seconds=2
    )


async def test_loader_retries_and_no_calculations(
    db_pool: asyncpg.Pool[Any], rates: MarketRates, loader_settings: LoaderSettings
) -> None:
    database = Database(db_pool, DatabaseSettings(dsn="postgresql://unused/test"))
    attempts = 0
    delays = []

    async def fetch(report_date: date) -> MarketRates:
        nonlocal attempts
        assert db_pool.get_idle_size() == db_pool.get_size()
        attempts += 1
        if attempts < 3:
            raise MarketTemporaryError("synthetic temporary failure")
        return rates

    async def sleep(delay: float) -> None:
        delays.append(delay)

    assert (
        await load_rates(
            database,
            REPORT_DATE,
            fetch,
            loader_settings,
            sleep=sleep,
            jitter=lambda low, high: high,
        )
        == "saved"
    )
    assert attempts == 3 and delays == [1, 1.5]
    async with database.connection() as conn:
        assert await conn.fetchval("SELECT count(*) FROM curve_run") == 0
        saved = await InputRatesRepository.read_current(conn, REPORT_DATE)
        assert saved is not None and saved.points == rates.points


async def test_loader_absence_errors_and_saved_data(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
    loader_settings: LoaderSettings,
) -> None:
    database = Database(db_pool, DatabaseSettings(dsn="postgresql://unused/test"))
    async with database.connection() as conn:
        await InputRatesRepository.replace_current(conn, rates, loaded_at=AS_OF)
        before = await InputRatesRepository.read_current(conn, REPORT_DATE)
    calls = 0

    async def missing(report_date: date) -> MarketRates:
        raise NoMarketData("correct source absence")

    assert await load_rates(database, REPORT_DATE, missing, loader_settings) == "no_data"
    for exception in (MarketTemporaryError, MarketPermanentError):
        calls = 0

        async def fetch(report_date: date, exception: type[Exception] = exception) -> MarketRates:
            nonlocal calls
            calls += 1
            raise exception("synthetic source failure")

        async def no_wait(delay: float) -> None:
            pass

        with pytest.raises(exception):
            await load_rates(database, REPORT_DATE, fetch, loader_settings, sleep=no_wait)
        assert calls == (3 if exception is MarketTemporaryError else 1)

    async def wrong_date(report_date: date) -> MarketRates:
        return rates.model_copy(update={"report_date": report_date + timedelta(days=1)})

    with pytest.raises(ValueError, match="another report date"):
        await load_rates(database, REPORT_DATE, wrong_date, loader_settings)
    with pytest.raises(ImplementationUnavailable):
        await load_rates(
            database, REPORT_DATE, EgorAdapter(IntegrationSettings()).fetch, loader_settings
        )
    async with database.connection() as conn:
        assert await InputRatesRepository.read_current(conn, REPORT_DATE) == before
        assert await conn.fetchval("SELECT count(*) FROM curve_run") == 0


async def test_loader_entrypoint_and_duplicate_guard(database_dsn: str) -> None:
    import asyncio

    environment = {
        **os.environ,
        "DATABASE__DSN": database_dsn,
        "LOADER__MAX_ATTEMPTS": "2",
        "LOADER__BACKOFF_BASE_SECONDS": ".01",
        "LOADER__BACKOFF_CAP_SECONDS": ".02",
        "LOADER__REQUEST_TIMEOUT_SECONDS": "1",
        "INTEGRATIONS__FETCH_FUNCTION": "tests.fakes.implementations:fetch",
    }
    command = [sys.executable, "-m", "web.processes.moex_loader", "--report-date", str(REPORT_DATE)]
    async with Database.open(DatabaseSettings(dsn=database_dsn)) as database:
        identity = await database.identity()
    with process_lock(f"loader:{identity}:{REPORT_DATE.isoformat()}") as locked:
        assert locked
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=ROOT,
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await process.communicate()
        assert process.returncode == 2 and b"already runs" in err
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=ROOT,
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await process.communicate()
    assert process.returncode == 0, (out + err).decode()


@pytest.mark.parametrize("invalid_kind", ["one_point", "unrepresentable_rate"])
async def test_loader_revalidates_copied_models_before_publication(
    db_pool: asyncpg.Pool[Any],
    rates: MarketRates,
    loader_settings: LoaderSettings,
    invalid_kind: str,
) -> None:
    database = Database(db_pool, DatabaseSettings(dsn="postgresql://unused/test"))
    async with database.connection() as connection:
        await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)
        before = await InputRatesRepository.read_current(connection, rates.report_date)
    points = (
        (rates.points[0],)
        if invalid_kind == "one_point"
        else (
            rates.points[0].model_copy(update={"rate_percent": Decimal("1e-16384")}),
            *rates.points[1:],
        )
    )

    async def fetch(report_date: date) -> MarketRates:
        # model_copy deliberately does not validate updates, including nested points.
        return rates.model_copy(
            update={"source_as_of": AS_OF + timedelta(hours=1), "points": points}
        )

    with pytest.raises(ValidationError):
        await load_rates(database, rates.report_date, fetch, loader_settings)
    async with database.connection() as connection:
        assert await InputRatesRepository.read_current(connection, rates.report_date) == before
        assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
