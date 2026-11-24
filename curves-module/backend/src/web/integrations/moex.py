"""Published MOEX ISS zero-coupon yields, without local curve approximation."""

import re
import ssl
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import certifi
import httpx
import simplejson

from web.exceptions.input_rate import (
    InvalidMarketData,
    MarketPermanentError,
    MarketTemporaryError,
    NoMarketData,
)
from web.repositories.models import MarketRates, RatePoint

MOEX_URL = "https://iss.moex.com/iss/engines/stock/zcyc/securities.json"
MOSCOW = ZoneInfo("Europe/Moscow")
MAX_RESPONSE_BYTES = 2_097_152


def parse_yields(payload: Any, report_date: date) -> MarketRates:
    """Reject a wrong date, mixed snapshots and invalid points atomically."""
    try:
        if not isinstance(payload, dict):
            raise ValueError("Expected an ISS object")
        block = payload["yearyields"]
        columns, rows = block["columns"], block["data"]
        if (
            not isinstance(columns, list)
            or not all(isinstance(column, str) for column in columns)
            or len(set(columns)) != len(columns)
            or not {"tradedate", "tradetime", "period", "value"}.issubset(columns)
            or not isinstance(rows, list)
        ):
            raise ValueError("Invalid yearyields table")
        if not rows:
            raise NoMarketData("MOEX has no published curve for the requested date")
        points: list[RatePoint] = []
        timestamps: set[datetime] = set()
        for row in rows:
            if not isinstance(row, list) or len(row) != len(columns):
                raise ValueError("Invalid ISS row")
            record = dict(zip(columns, row, strict=True))
            if record["tradedate"] != report_date.isoformat():
                raise ValueError("MOEX returned another report date")
            raw_time = record["tradetime"]
            if not isinstance(raw_time, str) or not re.fullmatch(
                r"[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?", raw_time
            ):
                raise ValueError("Expected exchange-local source time")
            source_time = time.fromisoformat(raw_time)
            timestamps.add(datetime.combine(report_date, source_time, tzinfo=MOSCOW))
            for key in ("period", "value"):
                if isinstance(record[key], bool) or not isinstance(
                    record[key], (Decimal, int, float)
                ):
                    raise ValueError("Expected numeric tenor and rate")
            points.append(
                RatePoint(
                    tenor_years=Decimal(str(record["period"])),
                    rate_percent=Decimal(str(record["value"])),
                )
            )
        if len(timestamps) != 1:
            raise ValueError("Points belong to different source snapshots")
        return MarketRates(
            report_date=report_date,
            source_as_of=next(iter(timestamps)),
            points=tuple(sorted(points, key=lambda point: point.tenor_years)),
        )
    except NoMarketData:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidMarketData("MOEX returned an invalid or inconsistent yield curve") from exc


async def fetch_rates(report_date: date) -> MarketRates:
    """Loader owns retry/backoff. Rates remain in percent; date fallback is forbidden."""
    tls = ssl.create_default_context(cafile=certifi.where())
    tls.load_verify_locations(cafile=Path(__file__).with_name("russian-root.pem"))
    try:
        async with httpx.AsyncClient(verify=tls, timeout=15, follow_redirects=False) as client:
            async with client.stream(
                "GET",
                MOEX_URL,
                params={
                    "date": report_date.isoformat(),
                    "iss.meta": "off",
                    "iss.only": "yearyields",
                },
                headers={"Accept": "application/json"},
            ) as response:
                if response.status_code in (408, 425, 429) or response.status_code >= 500:
                    raise MarketTemporaryError("MOEX is temporarily unavailable")
                if response.status_code != 200:
                    raise MarketPermanentError("MOEX did not return a successful data response")
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_RESPONSE_BYTES:
                        raise InvalidMarketData("MOEX response exceeds the size limit")
        payload = simplejson.loads(content.decode("utf-8"), use_decimal=True, allow_nan=False)
    except httpx.RequestError as exc:
        raise MarketTemporaryError("MOEX connection failed") from exc
    except (UnicodeError, simplejson.JSONDecodeError, RecursionError) as exc:
        raise InvalidMarketData("MOEX did not return valid JSON") from exc
    return parse_yields(payload, report_date)
