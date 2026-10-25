from decimal import Decimal

import pytest
import simplejson

from core.config import Settings
from core.database import DBConnection
from tests.conftest import AS_OF, REPORT_DATE
from tests.fakes.implementations import stress
from tests.test_api_worker import client_context, create
from tests.test_base_curve import source, specification
from web.calculations.base_curve import build_base_curve
from web.integrations.adapters import EgorAdapter
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import MarketRates
from web.services.calculations import CalculationWorker

pytestmark = pytest.mark.usefixtures("base_binary_on_path")


async def test_worker_publishes_real_base_from_immutable_snapshot(
    api_settings: Settings, connection: DBConnection
) -> None:
    points = source(("3", "1"), ("0.5", "2"), ("1.5", "4"))
    spec = specification("0.25", "0.5", "1", "1.5", "2", "3", "4").model_copy(
        update={"stress_version": "test-only-stress"}
    )
    assert api_settings.calculation.spec_file is not None
    api_settings.calculation.spec_file.write_text(spec.model_dump_json(), encoding="utf-8")
    api_settings.integrations.base_function = "web.calculations.base_curve:build_base_curve"
    rates = MarketRates(report_date=REPORT_DATE, source_as_of=AS_OF, points=points)
    await InputRatesRepository.replace_current(connection, rates, loaded_at=AS_OF)

    assert api_settings.worker is not None
    async with client_context(api_settings) as (client, app):
        run_id = await create(client)
        # Updating the current market set must not affect this queued calculation.
        await InputRatesRepository.replace_current(
            connection,
            MarketRates(
                report_date=REPORT_DATE,
                source_as_of=AS_OF,
                points=source(("10", "99"), ("20", "99")),
            ),
            loaded_at=AS_OF,
        )
        worker = CalculationWorker(
            app.state.database,
            api_settings.worker,
            EgorAdapter(api_settings.integrations).base,
            stress,
        )
        assert await worker.run_once()
        state = (await client.get(f"/api/v1/curve-runs/{run_id}")).json()
        assert (state["status"], state["stage"]) == ("queued", "stress")
        assert [p["ratePercent"] for p in state["baseCurve"]["points"]] == [1.5, 2, 3, 4, 3, 1, -1]
        saved = await CurvesRepository.read_curves(connection, run_id)
        assert saved == (build_base_curve(points, spec),)
        assert await worker.run_once()
        result = await client.get(f"/api/v1/curve-runs/{run_id}/result")
        assert result.status_code == 200
        curves = simplejson.loads(result.content, use_decimal=True)["curves"]
        assert len(curves) == 7
        base = next(curve for curve in curves if curve["curveCode"] == "base")
        assert base["points"][0]["ratePercent"] == Decimal("1.5")
        assert base["points"][-1]["ratePercent"] == Decimal(-1)
