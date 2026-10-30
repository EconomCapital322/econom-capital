from decimal import Decimal

import asyncpg
import pytest

from core.config import (
    CalculationSettings,
    DatabaseSettings,
    IntegrationSettings,
    Settings,
    WorkerSettings,
)
from core.database import Database
from tests.conftest import ROOT
from tests.test_api_worker import client_context
from web.calculations.base_curve import build_base_curve
from web.integrations.adapters import SlavaAdapter
from web.integrations.specification import load_specification
from web.processes.demo_history import prepare_history


@pytest.mark.usefixtures("base_binary_on_path")
async def test_seed_real_worker_history_and_sql(database_dsn: str, stress_url: str) -> None:
    from web.services.calculations import CalculationWorker

    spec = load_specification(ROOT / "examples/demo-calculation-spec.json")
    db_settings = DatabaseSettings(dsn=database_dsn)
    async with Database.open(db_settings) as database:
        with pytest.raises(ValueError, match="not marked"):
            await prepare_history(database, spec)
    admin = await asyncpg.connect(database_dsn)
    try:
        name = await admin.fetchval("SELECT current_database()")
        assert name.startswith("irrbb_test_")
        await admin.execute(f"ALTER DATABASE \"{name}\" SET irrbb.demo_instance='backend-final'")
    finally:
        await admin.close()
    async with Database.open(db_settings) as database:
        ids = await prepare_history(database, spec)
        assert ids == await prepare_history(database, spec)
        adapter = SlavaAdapter(
            IntegrationSettings.model_validate(
                {"stress_http_url": stress_url, "stress_http_version": spec.stress_version}
            )
        )
        worker = CalculationWorker(
            database,
            WorkerSettings(
                poll_seconds=0.02, lease_seconds=3, heartbeat_seconds=0.2, stage_timeout_seconds=5
            ),
            build_base_curve,
            adapter.stress,
        )
        for _ in range(12):
            assert await worker.run_once()
        assert not await worker.run_once()
        assert ids == await prepare_history(database, spec)
        async with database.connection() as connection:
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 6
            assert await connection.fetchval("SELECT count(*) FROM curve") == 42
            assert await connection.fetchval("SELECT count(*) FROM curve_point") == 210
            assert (
                await connection.fetchval("SELECT count(*) FROM curve_run WHERE status='ready'")
                == 6
            )
            assert (
                await connection.fetchval("SELECT count(DISTINCT report_date) FROM curve_run") == 3
            )
            assert (
                await connection.fetchval(
                    "SELECT count(*) FROM curve_result WHERE mode='standard' "
                    "AND p=4 AND k=5 AND d=3"
                )
                == 105
            )
            # Real SQL operations requested for the demonstration.
            assert (
                len(
                    await connection.fetch(
                        "SELECT * FROM curve_run WHERE report_date='2026-07-31' "
                        "ORDER BY created_at DESC,id DESC"
                    )
                )
                == 2
            )
            assert (
                len(await connection.fetch("SELECT * FROM curve_result WHERE run_id=$1", ids[0]))
                == 35
            )
            assert (
                len(
                    await connection.fetch(
                        "SELECT tenor_years,rate FROM curve_result "
                        "WHERE run_id=$1 AND curve_code='parallel_up' ORDER BY tenor_years",
                        ids[0],
                    )
                )
                == 5
            )
            differences = await connection.fetch(
                "SELECT b.rate-a.rate AS difference FROM curve_result a "
                "JOIN curve_result b USING(curve_code,bucket_label,tenor_years) "
                "WHERE a.run_id=$1 AND b.run_id=$2 AND a.curve_code='parallel_up'",
                ids[0],
                ids[1],
            )
            assert differences and all(row[0] == Decimal(-2) for row in differences)
            assert (
                len(
                    await connection.fetch(
                        "SELECT run_origin,count(*) FROM curve_run GROUP BY run_origin"
                    )
                )
                == 1
            )
            counts = await connection.fetch(
                "SELECT run_id,count(DISTINCT curve_code),count(*) "
                "FROM curve_result WHERE status='ready' GROUP BY run_id"
            )
            assert len(counts) == 6 and all(tuple(r)[1:] == (7, 35) for r in counts)
    api = Settings(
        database=db_settings,
        calculation=CalculationSettings(spec_file=ROOT / "examples/demo-calculation-spec.json"),
    )
    async with client_context(api) as (client, app):
        data = (await client.get("/api/v1/input-rates?reportDate=2026-07-31")).json()
        assert data["dataProvenance"] == "synthetic"
        for run_id in ids:
            response = await client.get(f"/api/v1/curve-runs/{run_id}/result")
            assert response.status_code == 200 and len(response.json()["curves"]) == 7
            assert response.json()["dataProvenance"] == "synthetic"
        history = (await client.get("/api/v1/curve-runs?reportDate=2026-07-31")).json()["runs"]
        assert {run["runOrigin"] for run in history} == {"manual"}
