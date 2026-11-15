from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import asyncpg
import pytest
import simplejson

from core.config import CalculationSettings, DatabaseSettings, Settings, WorkerSettings
from core.database import Database, DBConnection
from web.repositories.models import (
    Bucket,
    CalculationSpec,
    MarketRates,
    RatePoint,
    ScenarioParameters,
)

ROOT = Path(__file__).resolve().parents[1]
REPORT_DATE = date(2026, 7, 31)
AS_OF = datetime(2026, 7, 31, 16, tzinfo=UTC)


@pytest.fixture(scope="session")
def base_binary(tmp_path_factory: pytest.TempPathFactory) -> Path:
    binary = tmp_path_factory.mktemp("base-bin") / "base-curve"
    subprocess.run(
        ["go", "build", "-mod=readonly", "-o", str(binary), "./cmd/base-curve"],
        cwd=ROOT.parent / "base",
        check=True,
        capture_output=True,
        text=True,
    )
    return binary


@pytest.fixture
def base_binary_on_path(base_binary: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", str(base_binary.parent) + os.pathsep + os.environ.get("PATH", ""))


async def migrate(dsn: str, revision: str = "head", *, downgrade: bool = False) -> None:
    env = {**os.environ, "DATABASE__DSN": dsn}
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "alembic",
        "downgrade" if downgrade else "upgrade",
        revision,
        cwd=ROOT,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    assert proc.returncode == 0, (stdout + stderr).decode()


@pytest.fixture
async def database_dsn() -> AsyncIterator[str]:
    admin_dsn = os.environ.get("IRRBB_TEST_ADMIN_DSN")
    if admin_dsn is None:
        result = await asyncio.to_thread(
            subprocess.run,
            ["docker", "compose", "-f", "compose.test.yaml", "port", "postgres-test", "5432"],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        )
        port = result.stdout.strip().rsplit(":", 1)[1]
        admin_dsn = f"postgresql://irrbb_test:local-test-only@127.0.0.1:{port}/irrbb_stage2_test"
    admin = await asyncpg.connect(admin_dsn)
    try:
        marker = await admin.fetchval("SELECT current_setting('irrbb.test_instance', true)")
        if marker != "stage2":
            pytest.fail("Refusing tests: server is not marked as the isolated stage2 instance")
        name = "irrbb_test_" + uuid4().hex
        # Identifier is generated here, never taken from a DSN or user input.
        await admin.execute(f'CREATE DATABASE "{name}"')
        parts = urlsplit(admin_dsn)
        dsn = urlunsplit(parts._replace(path="/" + name))
        try:
            await migrate(dsn)
            yield dsn
        finally:
            await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
    finally:
        await admin.close()


@pytest.fixture
async def db_pool(database_dsn: str) -> AsyncIterator[asyncpg.Pool[Any]]:
    async with Database.open(DatabaseSettings(dsn=database_dsn)) as database:
        yield database.pool


@pytest.fixture
async def connection(db_pool: asyncpg.Pool[Any]) -> AsyncIterator[DBConnection]:
    async with db_pool.acquire() as conn:
        yield conn


@pytest.fixture
def rates() -> MarketRates:
    return MarketRates(
        report_date=REPORT_DATE,
        source_as_of=AS_OF,
        points=(
            RatePoint(tenor_years=Decimal("0.08333333331"), rate_percent=Decimal("-0.25")),
            RatePoint(
                tenor_years=Decimal("0.08333333332"),
                rate_percent=Decimal("14.12345678901234567890123456789"),
            ),
        ),
    )


@pytest.fixture
def parameters() -> ScenarioParameters:
    return ScenarioParameters(mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3))


@pytest.fixture
def spec() -> CalculationSpec:
    return CalculationSpec(
        data_provenance="synthetic",
        base_version="test-only-base",
        stress_version="test-only-stress",
        method="test-only",
        day_count="test-only",
        grid=(
            Bucket(bucket_label="synthetic-short", tenor_years=Decimal("0.05")),
            Bucket(bucket_label="synthetic-long", tenor_years=Decimal("44.444444444444")),
        ),
    )


@pytest.fixture
def api_settings(database_dsn: str, tmp_path: Path, spec: CalculationSpec) -> Settings:
    path = tmp_path / "spec.json"
    path.write_text(simplejson.dumps(spec.model_dump(), use_decimal=True))
    return Settings(
        database=DatabaseSettings(dsn=database_dsn, max_pool_size=2),
        calculation=CalculationSettings(spec_file=path),
        worker=WorkerSettings(
            poll_seconds=0.02, heartbeat_seconds=0.1, lease_seconds=2, stage_timeout_seconds=2
        ),
    )


@pytest.fixture(scope="session")
def stress_binary(tmp_path_factory: pytest.TempPathFactory) -> Path:
    binary = tmp_path_factory.mktemp("stress-bin") / "stress-service"
    subprocess.run(
        ["go", "build", "-mod=readonly", "-o", str(binary), "./cmd/stress-service"],
        cwd=ROOT.parent / "stress",
        check=True,
        capture_output=True,
    )
    return binary


@pytest.fixture
async def stress_url(stress_binary: Path) -> AsyncIterator[str]:
    import socket

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    process = await asyncio.create_subprocess_exec(
        str(stress_binary),
        cwd=ROOT.parent / "stress",
        env={**os.environ, "STRESS_HTTP_ADDR": f"127.0.0.1:{port}"},
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            if process.returncode is not None:
                pytest.fail("Real Go stress service exited before accepting requests")
            try:
                _, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                break
            except OSError:
                await asyncio.sleep(0.05)
        else:
            pytest.fail("Real Go stress service did not start")
        yield f"http://127.0.0.1:{port}/internal/v1/stress-curves"
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()
