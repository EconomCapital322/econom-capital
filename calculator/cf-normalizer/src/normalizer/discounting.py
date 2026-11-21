"""Explicit calendar-bucket-v1 policy; supplied DF is never recomputed."""

import calendar
import csv
from datetime import date, timedelta
from decimal import Decimal, localcontext
from pathlib import Path

from normalizer.curves import CurvesError

MONTHS = (
    1,
    3,
    6,
    9,
    12,
    18,
    24,
    36,
    48,
    60,
    72,
    84,
    96,
    108,
    120,
    180,
    240,
    360,
    420,
    480,
    540,
    600,
)
LABELS = (
    "1d",
    "1m",
    "3m",
    "6m",
    "9m",
    "1y",
    "1,5y",
    "2y",
    "3y",
    "4y",
    "5y",
    "6y",
    "7y",
    "8y",
    "9y",
    "10y",
    "15y",
    "20y",
    "30y",
    "35y",
    "40y",
    "45y",
    "50y",
)


def boundaries(report_date):
    result = [report_date + timedelta(days=1)]
    for months in MONTHS:
        value = report_date.year * 12 + report_date.month - 1 + months
        year, month = divmod(value, 12)
        month += 1
        result.append(
            date(year, month, min(report_date.day, calendar.monthrange(year, month)[1]))
        )
    return result


def bucket_for(payment, report_date):
    if payment <= report_date:
        raise CurvesError(
            "Для дисконтирования поддерживаются только платежи после отчётной даты."
        )
    for label, upper in zip(LABELS, boundaries(report_date)):
        if payment <= upper:
            return label
    raise CurvesError(
        "Платёж за пределами сетки 50 лет. Требуется расширение согласованной сетки."
    )


def discount_flows(core_dir: Path, normalized: Path, result, scenario):
    report_date = date.fromisoformat(result["reportDate"])
    curves = {
        c["curveCode"]: {p["bucketLabel"]: p for p in c["points"]}
        for c in result["curves"]
    }
    if any(tuple(p) != LABELS for p in curves.values()):
        raise CurvesError("Сетка API не соответствует правилу calendar-bucket-v1.")
    deals = {}
    with normalized.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            if (
                row["report_dttm"] != report_date.isoformat()
                or row["currency_id"] != "RUB"
            ):
                raise CurvesError("Дата или валюта сделки не соответствует кривым.")
            if row["deal_id"] in deals or row["side"] not in ("ASSET", "LIABILITY"):
                raise CurvesError("Неоднозначный идентификатор или сторона сделки.")
            deals[row["deal_id"]] = row["side"]
    temp = core_dir / "discounted_cashflows.csv.tmp"
    target = core_dir / "discounted_cashflows.csv"
    totals = {}
    try:
        with localcontext() as context:
            context.prec = 34
            with (
                (core_dir / "cashflows.csv").open(
                    encoding="utf-8-sig", newline=""
                ) as src,
                temp.open("w", encoding="utf-8-sig", newline="") as dest,
            ):
                writer = csv.writer(dest)
                writer.writerow(
                    [
                        "instrument_id",
                        "payment_date",
                        "cash_flow_type",
                        "side",
                        "curveCode",
                        "bucketLabel",
                        "tenorYears",
                        "ratePercent",
                        "discountFactor",
                        "amount",
                        "present_value",
                    ]
                )
                for row in csv.DictReader(src):
                    side = deals.get(row["instrument_id"])
                    if side is None:
                        raise CurvesError("Платёж не связан с нормализованной сделкой.")
                    amount = Decimal(row["amount"])
                    if not amount.is_finite() or amount < 0:
                        raise CurvesError("Некорректная сумма платежа.")
                    label = bucket_for(
                        date.fromisoformat(row["payment_date"]), report_date
                    )
                    codes = tuple(curves) if scenario == "all" else (scenario,)
                    for code in codes:
                        p = curves[code][label]
                        pv = (
                            amount
                            * p["discountFactor"]
                            * (1 if side == "ASSET" else -1)
                        )
                        key = (row["instrument_id"], side, code)
                        totals[key] = totals.get(key, Decimal(0)) + pv
                        writer.writerow(
                            [
                                row["instrument_id"],
                                row["payment_date"],
                                row["cash_flow_type"],
                                side,
                                code,
                                label,
                                p["tenorYears"],
                                p["ratePercent"],
                                p["discountFactor"],
                                amount,
                                pv,
                            ]
                        )
        temp.replace(target)
    except Exception:
        temp.unlink(missing_ok=True)
        raise
    with (core_dir / "discounted_deal_summary.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as f:
        writer = csv.writer(f)
        writer.writerow(["instrument_id", "side", "curveCode", "present_value"])
        for key, value in sorted(totals.items()):
            writer.writerow([*key, value])
    return len(totals)
