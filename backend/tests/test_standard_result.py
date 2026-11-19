from datetime import timedelta
from decimal import Decimal
from math import exp, isclose
from uuid import UUID

import simplejson

from core.config import Settings
from core.database import DBConnection
from tests.conftest import REPORT_DATE
from tests.fakes.implementations import base, stress
from tests.test_api_worker import client_context
from tests.test_storage import seed_run
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.models import CalculationSpec, MarketRates, ScenarioParameters
from web.schemas.responses import ResultResponse
from web.services.calculations import CalculationWorker


async def test_standard_result_selects_latest_completed_standard_run(
    api_settings: Settings,
    connection: DBConnection,
    rates: MarketRates,
    parameters: ScenarioParameters,
    spec: CalculationSpec,
) -> None:
    url = "/api/v1/curve-runs/standard-result"
    params = {"reportDate": str(REPORT_DATE)}
    async with client_context(api_settings) as (client, app):
        response = await client.get(url, params=params)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "STANDARD_RESULT_NOT_FOUND"
        assert (await client.get(url, params={"reportDate": "2026-02-30"})).status_code == 422

        assert api_settings.worker is not None
        worker = CalculationWorker(app.state.database, api_settings.worker, base, stress)
        first = await seed_run(connection, rates, parameters, spec)
        assert (await client.get(url, params=params)).status_code == 404
        assert await worker.run_once() and await worker.run_once()
        assert UUID((await client.get(url, params=params)).json()["runId"]) == first

        second = await seed_run(connection, rates, parameters, spec)
        assert await worker.run_once() and await worker.run_once()
        custom = parameters.model_copy(update={"mode": "custom", "p": Decimal(7)})
        await seed_run(connection, rates, custom, spec)
        assert await worker.run_once() and await worker.run_once()
        await seed_run(connection, rates, parameters, spec)
        response = await client.get(url, params=params)
        assert response.status_code == 200
        payload = simplejson.loads(response.content, use_decimal=True)
        assert UUID(payload["runId"]) == second and payload["reportDate"] == str(REPORT_DATE)
        assert len(payload["curves"]) == 7
        for curve in payload["curves"]:
            for point in curve["points"]:
                assert isinstance(point["discountFactor"], Decimal)
                assert isclose(
                    point["discountFactor"], exp(-point["ratePercent"] * point["tenorYears"] / 100)
                )
        assert response.content == (await client.get(f"/api/v1/curve-runs/{second}/result")).content
        assert (
            await client.get(url, params={"reportDate": str(REPORT_DATE + timedelta(days=1))})
        ).status_code == 404
        assert len(await CurveRunsRepository.list_runs(connection, REPORT_DATE)) == 4

        operation = (await client.get("/openapi.json")).json()["paths"][url]["get"]
        example = operation["responses"]["200"]["content"]["application/json"]["example"]
        assert len(ResultResponse.model_validate(example).curves) == 7
        assert "404" in operation["responses"]
