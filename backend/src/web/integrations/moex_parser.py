"""Validate a single published MOEX slice and preserve exact decimal source points."""

import re
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

import simplejson

from web.exceptions.input_rate import InvalidMarketData, NoMarketData
from web.repositories.models import MarketRates, RatePoint
from web.schemas.moex import IssResponse


def parse_rates(body: bytes, report_date: date) -> MarketRates:
    try:
        table = IssResponse.model_validate(
            simplejson.loads(body, use_decimal=True, parse_int=Decimal, allow_nan=False)
        ).yearyields
        if len(set(table.columns)) != len(table.columns):
            raise ValueError("Duplicate columns")
        if not {"tradedate", "tradetime", "period", "value"} <= set(table.columns):
            raise ValueError("Missing columns")
        if not table.data:
            raise NoMarketData("MOEX has no published points for the requested date")
        timestamps: set[datetime] = set()
        points: list[RatePoint] = []
        for values in table.data:
            if len(values) != len(table.columns):
                raise ValueError("Incomplete row")
            row = dict(zip(table.columns, values, strict=True))
            if row["tradedate"] != report_date.isoformat():
                raise ValueError("Another report date")
            source_time = row["tradetime"]
            if not isinstance(source_time, str) or not re.fullmatch(
                r"\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?", source_time
            ):
                raise ValueError("Invalid local source time")
            timestamps.add(
                datetime.combine(
                    report_date, time.fromisoformat(source_time), tzinfo=ZoneInfo("Europe/Moscow")
                )
            )
            tenor, rate = row["period"], row["value"]
            if not isinstance(tenor, Decimal) or not isinstance(rate, Decimal):
                raise ValueError("Expected numeric source points")
            points.append(RatePoint(tenor_years=tenor, rate_percent=rate))
        if len(timestamps) != 1:
            raise ValueError("Mixed source timestamps")
        return MarketRates(
            report_date=report_date,
            source_as_of=timestamps.pop(),
            points=tuple(sorted(points, key=lambda p: p.tenor_years)),
        )
    except (ValueError, TypeError, RecursionError):
        raise InvalidMarketData("MOEX returned invalid or inconsistent published points") from None
