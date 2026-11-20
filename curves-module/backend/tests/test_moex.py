from datetime import date
from decimal import Decimal
from typing import Any

import httpx
import pytest

from web.exceptions.input_rate import MarketPermanentError, MarketTemporaryError, NoMarketData
from web.integrations.moex import fetch_rates, parse_yields

DAY = date(2026, 7, 31)


def table(rows: list[list[Any]]) -> dict[str, Any]:
    return {"yearyields": {"columns": ["tradedate", "tradetime", "period", "value"], "data": rows}}


def test_published_percent_values_and_moscow_timestamp() -> None:
    result = parse_yields(
        table(
            [
                ["2026-07-31", "18:49:59", Decimal("0.5"), Decimal("13.3455")],
                ["2026-07-31", "18:49:59", Decimal("0.25"), Decimal("13.5852")],
            ]
        ),
        DAY,
    )
    assert result.points[0].tenor_years == Decimal("0.25")
    assert result.points[0].rate_percent == Decimal("13.5852")
    assert result.source_as_of.isoformat() == "2026-07-31T18:49:59+03:00"


@pytest.mark.parametrize(
    "rows",
    [
        [["2026-07-30", "18:49:59", 1, 13], ["2026-07-30", "18:49:59", 2, 14]],
        [["2026-07-31", "18:49:59", 1, 13], ["2026-07-31", "18:50:00", 2, 14]],
        [["2026-07-31", "18:49:59", 1, 13], ["2026-07-31", "18:49:59", 1, 14]],
        [["2026-07-31", "18:49:59", 0, 13], ["2026-07-31", "18:49:59", 2, 14]],
        [["2026-07-31", "18:49:59", 1, None], ["2026-07-31", "18:49:59", 2, 14]],
        [["2026-07-31", "18:49:59", True, 13], ["2026-07-31", "18:49:59", 2, 14]],
        [["2026-07-31", "18:49:59", 1, Decimal("NaN")], ["2026-07-31", "18:49:59", 2, 14]],
        [["2026-07-31", "18:49:59", 1, 13]],
    ],
)
def test_rejects_inconsistent_or_invalid_snapshots(rows: list[list[Any]]) -> None:
    with pytest.raises(MarketPermanentError):
        parse_yields(table(rows), DAY)


def test_no_data_is_distinct_from_a_broken_payload() -> None:
    with pytest.raises(NoMarketData):
        parse_yields(table([]), DAY)
    with pytest.raises(MarketPermanentError):
        parse_yields({}, DAY)


@pytest.mark.parametrize(
    "status,error",
    [(429, MarketTemporaryError), (503, MarketTemporaryError), (403, MarketPermanentError)],
)
async def test_http_failures(
    monkeypatch: pytest.MonkeyPatch, status: int, error: type[Exception]
) -> None:
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(status))
    monkeypatch.setattr(
        "web.integrations.moex.httpx.AsyncClient",
        lambda **kwargs: original(transport=transport, **kwargs),
    )
    with pytest.raises(error):
        await fetch_rates(DAY)


async def test_transport_preserves_decimal_and_requested_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.params["date"] == DAY.isoformat()
        return httpx.Response(
            200,
            text=(
                '{"yearyields":{"columns":["tradedate","tradetime","period","value"],'
                '"data":[["2026-07-31","18:49:59",0.25,13.5852],'
                '["2026-07-31","18:49:59",0.5,13.3455]]}}'
            ),
        )

    original = httpx.AsyncClient
    monkeypatch.setattr(
        "web.integrations.moex.httpx.AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    result = await fetch_rates(DAY)
    assert result.points[0].rate_percent == Decimal("13.5852")


async def test_transport_failure_is_retryable(monkeypatch: pytest.MonkeyPatch) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("test timeout", request=request)

    original = httpx.AsyncClient
    monkeypatch.setattr(
        "web.integrations.moex.httpx.AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    with pytest.raises(MarketTemporaryError):
        await fetch_rates(DAY)


@pytest.mark.parametrize("body", ["<html>not JSON</html>", '{"yearyields":NaN}', "x" * 2097153])
async def test_invalid_or_oversized_response(monkeypatch: pytest.MonkeyPatch, body: str) -> None:
    original = httpx.AsyncClient
    monkeypatch.setattr(
        "web.integrations.moex.httpx.AsyncClient",
        lambda **kwargs: original(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body)), **kwargs
        ),
    )
    with pytest.raises(MarketPermanentError):
        await fetch_rates(DAY)
