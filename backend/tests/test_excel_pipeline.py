"""Full HTTP/SQL/real-Go acceptance against saved Excel values, never generated expectations."""

from __future__ import annotations

from contextlib import AsyncExitStack
from datetime import date, timedelta
from decimal import Decimal, localcontext
from typing import Any, Literal, cast
from uuid import UUID

import pytest
import simplejson

from core.config import LoaderSettings, Settings
from core.database import Database, DBConnection
from tests.conftest import AS_OF, REPORT_DATE, ROOT
from tests.test_live_pipeline import environment, live_api, live_worker, ready
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import CalculationSpec, MarketRates, RatePoint
from web.services.loading import load_rates


def load_control(dataset: str) -> dict[str, Any]:
    if dataset == "original":
        return cast(
            dict[str, Any],
            simplejson.loads(
                (ROOT / "tests/fixtures/excel_original.json").read_text(), use_decimal=True
            ),
        )
    base = simplejson.loads(
        (ROOT.parent / "base/testdata/excel.json").read_text(), use_decimal=True
    )
    stress = simplejson.loads(
        (ROOT.parent / "stress/internal/stress/testdata/excel.json").read_text(), use_decimal=True
    )
    assert base["source"]["sha256"] == stress["source"]["sha256"]
    return {
        "source": base["source"],
        "points": base["points"],
        "grid": base["spec"]["grid"],
        "expected_curves": [
            {"code": "base", "rates": base["expected_rates"]},
            *stress["expected_curves"],
        ],
        "absolute_tolerance_percent": base["absolute_tolerance_percent"],
        "stress_absolute_tolerance": stress["numeric_policy"]["absolute_tolerance"],
        "stress_relative_tolerance": stress["numeric_policy"]["relative_tolerance"],
    }


@pytest.mark.parametrize("dataset", ["original", "extended"])
@pytest.mark.usefixtures("base_binary_on_path")
async def test_excel_full_http_sql_go_pipeline(
    dataset: Literal["original", "extended"],
    api_settings: Settings,
    connection: DBConnection,
    stress_url: str,
    unused_tcp_port: int,
) -> None:
    control = load_control(dataset)
    spec = CalculationSpec.model_validate(
        {
            "data_provenance": "synthetic",
            "base_version": "linear-v1",
            "stress_version": "test-real-go-stress",
            "method": "linear",
            "day_count": "workbook-year-fractions",
            "grid": control["grid"],
        }
    )
    assert api_settings.calculation.spec_file is not None
    api_settings.calculation.spec_file.write_text(spec.model_dump_json())
    rates = MarketRates(
        report_date=REPORT_DATE,
        source_as_of=AS_OF,
        points=tuple(RatePoint.model_validate(p) for p in control["points"]),
    )

    async def fetch(report_date: date) -> MarketRates:
        assert report_date == REPORT_DATE
        return rates

    loader = LoaderSettings(
        max_attempts=1, backoff_base_seconds=1, backoff_cap_seconds=1, request_timeout_seconds=2
    )
    async with Database.open(api_settings.database) as database:
        assert await load_rates(database, REPORT_DATE, fetch, loader) == "saved"
        assert await load_rates(database, REPORT_DATE, fetch, loader) == "unchanged"
    assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
    env = environment(api_settings, stress_url)
    async with AsyncExitStack() as stack:
        async with live_api(env, unused_tcp_port) as client:
            raw = await client.get(f"/api/v1/input-rates?reportDate={REPORT_DATE}")
            points = simplejson.loads(raw.content, use_decimal=True)["points"]
            assert len(points) == 19
            assert [(p["tenorYears"], p["ratePercent"]) for p in points] == [
                (p.tenor_years, p.rate_percent) for p in rates.points
            ]
            assert (await client.get(f"/api/v1/curve-runs?reportDate={REPORT_DATE}")).json()[
                "runs"
            ] == []
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
            created = await client.post(
                "/api/v1/curve-runs",
                json={
                    "reportDate": str(REPORT_DATE),
                    "scenarioParameters": {"mode": "standard"},
                },
            )
            assert created.status_code == 202 and created.json()["status"] == "queued"
            run_id = UUID(created.json()["runId"])
            assert (await client.get(created.headers["Location"])).json()["status"] == "queued"
            worker = await stack.enter_async_context(live_worker(env))
            await ready(client, str(run_id))
            response = await client.get(f"/api/v1/curve-runs/{run_id}/result")
            original_bytes = response.content
            result = simplejson.loads(original_bytes, use_decimal=True)
            assert result["usedParameters"] == {"mode": "standard", "p": 4, "k": 5, "d": 3}
            expected = {c["code"]: c["rates"] for c in control["expected_curves"]}
            assert {c["curveCode"] for c in result["curves"]} == set(expected)
            maximum: dict[str, Decimal] = {}
            with localcontext() as context:
                context.prec = 60
                for curve in result["curves"]:
                    code = curve["curveCode"]
                    assert len(curve["points"]) == len(spec.grid)
                    errors = []
                    for point, bucket, saved in zip(
                        curve["points"], spec.grid, expected[code], strict=True
                    ):
                        assert (point["bucketLabel"], point["tenorYears"]) == (
                            bucket.bucket_label,
                            bucket.tenor_years,
                        )
                        assert (
                            isinstance(point["ratePercent"], Decimal)
                            and point["ratePercent"].is_finite()
                        )
                        target = Decimal(saved)
                        difference = abs(point["ratePercent"] - target)
                        tolerance = (
                            Decimal(control["absolute_tolerance_percent"])
                            if code == "base"
                            else (
                                Decimal(control["stress_absolute_tolerance"])
                                + Decimal(control["stress_relative_tolerance"]) * abs(target)
                            )
                        )
                        assert difference <= tolerance, (
                            dataset,
                            code,
                            bucket.bucket_label,
                            difference,
                            tolerance,
                        )
                        errors.append(difference)
                    maximum[code] = max(errors)
            stored = await CurvesRepository.read_curves(connection, run_id)
            assert len(stored) == 7
            api_curves = {c["curveCode"]: c["points"] for c in result["curves"]}
            for curve in stored:
                assert [(p.bucket_label, p.tenor_years, p.rate_percent) for p in curve.points] == [
                    (p["bucketLabel"], p["tenorYears"], p["ratePercent"])
                    for p in api_curves[curve.curve_code]
                ]
            base = next(c for c in stored if c.curve_code == "base")
            assert sum(p.is_extrapolated is True for p in base.points) == (
                4 if dataset == "extended" else 0
            )
            assert await connection.fetchval(
                "SELECT count(*) FROM curve_result WHERE run_id=$1", run_id
            ) == 7 * len(spec.grid)
            snapshot = await InputRatesRepository.read_snapshot(connection, run_id)
            assert snapshot is not None and snapshot.points == rates.points
            recalc = await client.post(
                f"/api/v1/curve-runs/{run_id}/recalculations",
                json={
                    "scenarioParameters": {"mode": "custom", "p": 6, "k": 7, "d": 8},
                },
            )
            assert recalc.status_code == 202
            child = UUID(recalc.json()["runId"])
            assert child != run_id
            await ready(client, str(child))
            updated = simplejson.loads(
                (await client.get(f"/api/v1/curve-runs/{child}/result")).content, use_decimal=True
            )
            updated_curves = {c["curveCode"]: c["points"] for c in updated["curves"]}
            assert updated_curves["base"] == api_curves["base"]
            for curve in updated["curves"]:
                for i, point in enumerate(curve["points"]):
                    if curve["curveCode"] == "parallel_up":
                        assert abs(
                            point["ratePercent"] - (api_curves["base"][i]["ratePercent"] + 6)
                        ) < Decimal("1e-10")
            assert updated["usedParameters"] == {"mode": "custom", "p": 6, "k": 7, "d": 8}
            assert (
                await client.get(f"/api/v1/curve-runs/{run_id}/result")
            ).content == original_bytes
            assert await InputRatesRepository.read_snapshot(connection, child) == snapshot
            async with Database.open(api_settings.database) as database:
                await load_rates(database, REPORT_DATE, fetch, loader)
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 2
            reused = await client.post(
                "/api/v1/curve-runs",
                json={
                    "reportDate": str(REPORT_DATE),
                    "scenarioParameters": {"mode": "standard"},
                },
            )
            assert reused.status_code == 200
            assert reused.json() == {"runId": str(run_id), "status": "ready"}
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 2

            later_date = REPORT_DATE + timedelta(days=1)
            later_rates = rates.model_copy(update={"report_date": later_date})

            async def fetch_later(report_date: date) -> MarketRates:
                assert report_date == later_date
                return later_rates

            async with Database.open(api_settings.database) as database:
                assert await load_rates(database, later_date, fetch_later, loader) == "saved"
            after_close = await client.post(
                "/api/v1/curve-runs",
                json={
                    "reportDate": str(later_date),
                    "scenarioParameters": {"mode": "standard"},
                },
            )
            assert after_close.status_code == 202
            detached = UUID(after_close.json()["runId"])
        # Both HTTP client and FastAPI are closed; the real independent Worker remains.
        for _ in range(200):
            run = await CurveRunsRepository.get_run(connection, detached)
            assert run is not None and run.status != "failed"
            if run.status == "ready":
                break
            import asyncio

            await asyncio.sleep(0.03)
        else:
            pytest.fail("Excel calculation did not finish after client/API shutdown")
        assert worker.returncode is None
        async with live_api(env, unused_tcp_port) as restarted:
            await ready(restarted, str(detached))
            history = (await restarted.get(f"/api/v1/curve-runs?reportDate={REPORT_DATE}")).json()[
                "runs"
            ]
            assert len(history) == 2
            assert {r["runOrigin"] for r in history} == {"automatic", "manual"}
            later_history = (
                await restarted.get(f"/api/v1/curve-runs?reportDate={later_date}")
            ).json()["runs"]
            assert len(later_history) == 1 and later_history[0]["runOrigin"] == "automatic"
        print(
            f"EXCEL {dataset}: inputs=19 buckets={len(spec.grid)} points/run={7 * len(spec.grid)} "
            f"max_absolute_errors={maximum}"
        )
