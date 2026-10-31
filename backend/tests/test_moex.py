from __future__ import annotations

import copy
from decimal import Decimal
from typing import Any

import httpx
import pytest
import simplejson

from core.config import LoaderSettings, MoexSettings, Settings
from core.database import Database
from tests.conftest import REPORT_DATE
from web.exceptions.input_rate import MarketPermanentError, MarketTemporaryError, NoMarketData
from web.integrations.moex import MoexClient
from web.integrations.moex_parser import parse_rates
from web.repositories.input_rates import InputRatesRepository
from web.services.loading import load_rates

PAYLOAD = {
    "yearyields": {
        "columns": ["tradedate", "tradetime", "period", "value"],
        "data": [
            ["2026-07-31", "18:49:59", Decimal("0.25"), Decimal("-0.123456789012345678901")],
            ["2026-07-31", "18:49:59", Decimal(20), Decimal("15.9530")],
        ],
    }
}


def encoded(value: object) -> bytes:
    return simplejson.dumps(value, use_decimal=True).encode()


def test_exact_points_and_moscow_timestamp() -> None:
    rates = parse_rates(encoded(PAYLOAD), REPORT_DATE)
    assert rates.points[0].rate_percent == Decimal("-0.123456789012345678901")
    assert rates.source_as_of.isoformat() == "2026-07-31T18:49:59+03:00"
    assert rates.points[-1].tenor_years == 20


@pytest.mark.parametrize(
    "case",
    [
        "missing",
        "empty",
        "one",
        "wrong_date",
        "mixed_time",
        "time",
        "duplicate",
        "null",
        "nan",
        "infinity",
        "negative_tenor",
        "bool",
        "short_row",
        "columns",
    ],
)
def test_invalid_or_absent_response(case: str) -> None:
    payload = copy.deepcopy(PAYLOAD)
    table: dict[str, Any] = payload["yearyields"]
    rows = table["data"]
    if case == "missing":
        payload = {}
    elif case == "empty":
        table["data"] = []
    elif case == "one":
        table["data"] = rows[:1]
    elif case == "wrong_date":
        rows[0][0] = "2026-07-30"
    elif case == "mixed_time":
        rows[0][1] = "18:40:00"
    elif case == "time":
        rows[0][1] = "25:00:00"
    elif case == "duplicate":
        rows[1][2] = rows[0][2]
    elif case == "null":
        rows[0][3] = None
    elif case == "nan":
        rows[0][3] = "NaN"
    elif case == "infinity":
        rows[0][3] = "Infinity"
    elif case == "negative_tenor":
        rows[0][2] = Decimal(-1)
    elif case == "bool":
        rows[0][3] = True
    elif case == "short_row":
        rows[0].pop()
    elif case == "columns":
        table["columns"][0] = "value"
    with pytest.raises(NoMarketData if case == "empty" else MarketPermanentError):
        parse_rates(encoded(payload), REPORT_DATE)


@pytest.mark.parametrize("status", [301, 400, 403, 404, 429, 500, 503])
async def test_status_and_request(monkeypatch: pytest.MonkeyPatch, status: int) -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.url.params["date"] == "2026-07-31"
        assert request.url.params["iss.only"] == "yearyields"
        return httpx.Response(status, text="private source diagnostics")

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw)
    )
    with pytest.raises(
        MarketTemporaryError if status in (429, 500, 503) else MarketPermanentError
    ) as error:
        await MoexClient(MoexSettings()).fetch(REPORT_DATE)
    assert len(calls) == 1 and "private" not in str(error.value)


@pytest.mark.parametrize("case", ["timeout", "connection", "json", "size"])
async def test_network_and_bounded_response(monkeypatch: pytest.MonkeyPatch, case: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if case == "timeout":
            raise httpx.ReadTimeout("private", request=request)
        if case == "connection":
            raise httpx.ConnectError("private", request=request)
        return httpx.Response(200, content=b"bad JSON" if case == "json" else encoded(PAYLOAD))

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw)
    )
    with pytest.raises(
        MarketTemporaryError if case in ("timeout", "connection") else MarketPermanentError
    ) as error:
        await MoexClient(MoexSettings(max_response_bytes=16)).fetch(REPORT_DATE)
    assert "private" not in str(error.value)


async def test_connector_loader_retry_and_no_jobs(
    api_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loader_settings = LoaderSettings(
        max_attempts=3, backoff_base_seconds=1, backoff_cap_seconds=2, request_timeout_seconds=3
    )
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503) if calls == 1 else httpx.Response(200, content=encoded(PAYLOAD))

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw)
    )

    async def no_wait(delay: float) -> None:
        pass

    async with Database.open(api_settings.database) as database:
        client = MoexClient(MoexSettings())
        assert (
            await load_rates(database, REPORT_DATE, client.fetch, loader_settings, sleep=no_wait)
            == "saved"
        )
        assert await load_rates(database, REPORT_DATE, client.fetch, loader_settings) == "unchanged"
        async with database.connection() as connection:
            saved = await InputRatesRepository.read_current(connection, REPORT_DATE)
            assert saved is not None and len(saved.points) == 2
            assert await connection.fetchval("SELECT count(*) FROM curve_run") == 0
