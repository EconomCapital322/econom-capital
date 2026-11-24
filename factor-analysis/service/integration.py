"""Build dated portfolios with the shared calculator and public curves API."""

from __future__ import annotations

import csv
import io
import json
import os
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import date
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NORMALIZER = ROOT.parent / "calculator" / "cf-normalizer" / "src"
sys.path.insert(0, str(NORMALIZER))

from normalizer.curves import CODES, CurvesClient, save_curves, validate_result  # noqa: E402
from normalizer.discounting import discount_flows  # noqa: E402

SCENARIOS = dict(zip(CODES, (
    "Базовая кривая", "Параллельный вверх", "Параллельный вниз",
    "Увеличение наклона", "Уменьшение наклона", "Короткие ставки вверх",
    "Короткие ставки вниз",
), strict=True))
LABELS = {
    "npv": "NPV базы", "stress_delta": "ΔPV выбранного сценария к базе",
    "interest12": "Процентные потоки за 12 месяцев", "cash12": "Платежи за 12 месяцев",
    "principal": "Остаток долга", "contract_rate": "Кредитная ставка",
    "term_years": "Оставшийся срок, лет", "age_years": "Возраст сделки, лет",
    "payment_type": "График платежей", "rate_type": "Тип ставки",
    "market_1y": "Ставка бакета 1 год", "market_5y": "Ставка бакета 5 лет",
}
TARGETS = ("npv", "stress_delta", "interest12", "cash12")
FEATURES = ("principal", "contract_rate", "term_years", "age_years", "payment_type", "rate_type", "market_1y", "market_5y")
DIRECTIONS = {"ANN": "Аннуитет", "RGM": "Равномерное погашение", "SIMPLE": "Тело в конце"}
RATE_TYPES = {"FIXED": "Фиксированная", "FLOAT": "Плавающая"}


def read_rows(path, delimiter=","):
    with path.open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source, delimiter=delimiter))


def write_rows(path, rows, fields, delimiter=","):
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields, delimiter=delimiter)
        writer.writeheader()
        writer.writerows(rows)


def run(command, *, data=None, timeout=120):
    result = subprocess.run(
        command, input=data, text=True, capture_output=True, timeout=timeout, encoding="utf-8"
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[-800:]
        raise ValueError(detail or "Локальный расчёт завершился с ошибкой.")
    return result.stdout


def core_path():
    location = os.environ.get("SPECTRUM_CFCORE")
    exe = "cfcore.exe" if os.name == "nt" else "cfcore"
    candidates = [Path(location).expanduser()] if location else [
        ROOT.parent / "calculator" / "build" / "core" / exe,
        ROOT.parent / "calculator" / "build" / "core" / "Release" / exe,
        ROOT / ".local" / "bin" / exe,
    ]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
    raise ValueError("Калькулятор не найден. Запустите start.command или задайте SPECTRUM_CFCORE.")


def curves_url():
    return os.environ.get("SPECTRUM_CURVES_URL", "http://127.0.0.1:8000")


def portfolio_history(settings, destination, progress):
    scenario = settings.get("scenario", "parallel_up")
    if scenario not in SCENARIOS or scenario == "base":
        raise ValueError("Выберите стрессовый сценарий.")
    node = shutil.which("node")
    if not node:
        raise ValueError("Для генератора сделок нужен Node.js.")
    generated = json.loads(run([node, str(ROOT / "generate.mjs")], data=json.dumps(settings)))
    core = core_path()
    curves = CurvesClient(curves_url())
    cache_mode = settings.get("useSavedCurves") is True
    batches = generated["batches"]
    positions, schedule = {}, defaultdict(list)
    panel, periods = [], []

    for index, batch in enumerate(batches, 1):
        day = date.fromisoformat(batch["date"])
        folder = destination / day.isoformat()
        folder.mkdir()
        progress(index - 1, len(batches), f"{day:%d.%m.%Y} · подготовка кривых команды 2")
        if cache_mode:
            saved = ROOT / ".local" / "curves" / f"{day}.json"
            if not saved.is_file():
                raise ValueError(f"Нет сохранённых рыночных кривых на {day:%d.%m.%Y}. Включите расчёт через API.")
            raw = saved.read_bytes()
            curve_result = validate_result(json.loads(raw, parse_float=Decimal), day)
        else:
            try:
                curve_result, raw = curves.result(day)
            except ValueError as error:
                raise ValueError(f"{day:%d.%m.%Y}. {error}") from error
            cache = ROOT / ".local" / "curves"
            cache.mkdir(parents=True, exist_ok=True)
            temporary = cache / f"{day}.tmp"
            temporary.write_bytes(raw)
            temporary.replace(cache / f"{day}.json")
        link = save_curves(folder / "curves", curve_result, raw, "all")

        for instrument, contract in list(positions.items()):
            original = Decimal(contract["current_principal_amt"])
            paid = sum((amount for payment_day, amount in schedule[instrument] if payment_day <= day), Decimal(0))
            remaining = max(Decimal(0), (original - paid).quantize(Decimal("0.01")))
            if remaining == 0 or date.fromisoformat(contract["maturity_dttm"]) <= day:
                del positions[instrument]
                continue
            positions[instrument] = {**contract, "report_dttm": day.isoformat(),
                                     "current_principal_amt": str(remaining)}

        source = csv.DictReader(io.StringIO(batch["newDeals"]), delimiter=";")
        fields = source.fieldnames
        for contract in source:
            positions[contract["deal_id"]] = contract
        if not positions:
            raise ValueError(f"К {day:%d.%m.%Y} все сделки погашены. Увеличьте срок или добавьте новые сделки.")
        input_path = folder / "calculator_input.csv"
        write_rows(input_path, positions.values(), fields, delimiter=";")
        core_dir = folder / "core"
        progress(index - 1, len(batches), f"{day:%d.%m.%Y} · калькулятор команды 1, {len(positions)} сделок")
        run([str(core), "--input", str(input_path), "--output-dir", str(core_dir), "--threads", "2"])
        errors = read_rows(core_dir / "errors.csv")
        summary = read_rows(core_dir / "deal_summary.csv")
        if errors or {item["instrument_id"] for item in summary} != set(positions):
            message = next(iter(errors), {})
            raise ValueError(f"{day:%d.%m.%Y}: калькулятор обработал {len(summary)} из {len(positions)} сделок. {message}")
        flow_rows = read_rows(core_dir / "cashflows.csv")
        schedule = defaultdict(list)
        for flow in flow_rows:
            if flow["cash_flow_type"] == "PRINCIPAL":
                schedule[flow["instrument_id"]].append(
                    (date.fromisoformat(flow["payment_date"]), Decimal(flow["amount"]))
                )
        discount_flows(core_dir, input_path, curve_result, "all")
        rows, metrics = summarize(day, positions, curve_result, core_dir, flow_rows, scenario)
        panel.extend(rows)
        periods.append({
            **metrics, "date": day.isoformat(), "deals": len(positions), "flowRows": len(flow_rows),
            "runId": curve_result["runId"], "sha256": link["sha256"],
            "curveSource": "saved" if cache_mode else "api",
        })
        progress(index, len(batches), f"{day:%d.%m.%Y} · рассчитано {len(positions)} сделок во всех 7 сценариях")

    write_rows(destination / "dataset.csv", panel, panel[0].keys())
    return {
        "source": "integrated", "periods": periods, "scenario": scenario,
        "settings": {**generated["settings"], "monthly": settings["monthly"], "periods": settings["periods"]},
        "uniqueDeals": generated["uniqueDeals"],
        "snapshotCount": len(panel), "method": "calendar-bucket-v1",
    }


def summarize(day, positions, curve_result, core_dir, flows, stress_code):
    prices = defaultdict(dict)
    for record in read_rows(core_dir / "discounted_deal_summary.csv"):
        prices[record["instrument_id"]][record["curveCode"]] = float(record["present_value"])
    if set(prices) != set(positions) or any(set(p) != set(CODES) for p in prices.values()):
        raise ValueError("Оценка калькулятора должна содержать все 7 сценариев для каждой сделки.")
    curves = {
        c["curveCode"]: [{"label": x["bucketLabel"], "years": float(x["tenorYears"]),
                         "rate": float(x["ratePercent"])} for x in c["points"]]
        for c in curve_result["curves"]
    }
    base_rates = {p["label"]: p["rate"] for p in curves["base"]}
    one_year = day.replace(year=day.year + 1) if (day.month, day.day) != (2, 29) else day.replace(year=day.year + 1, day=28)
    totals = defaultdict(float)
    interest = defaultdict(float)
    for flow in flows:
        ident = flow["instrument_id"]
        if date.fromisoformat(flow["payment_date"]) <= one_year:
            sign = 1 if positions[ident]["side"] == "ASSET" else -1
            amount = sign * float(flow["amount"])
            totals[ident] += amount
            if flow["cash_flow_type"] == "INTEREST":
                interest[ident] += amount
    weighted_time = 0.0
    by_bucket = defaultdict(lambda: defaultdict(float))
    with (core_dir / "discounted_cashflows.csv").open(encoding="utf-8-sig", newline="") as file:
        for flow in csv.DictReader(file):
            value = float(flow["present_value"])
            by_bucket[flow["curveCode"]][flow["bucketLabel"]] += value
            if flow["curveCode"] == "base":
                days = (date.fromisoformat(flow["payment_date"]) - day).days
                weighted_time += days / 365 * value

    rows = []
    for deal_id, contract in positions.items():
        estimates = prices[deal_id]
        rows.append({
            "date": day.isoformat(), "deal_id": deal_id, "npv": estimates["base"],
            "stress_delta": estimates[stress_code] - estimates["base"],
            "interest12": interest[deal_id], "cash12": totals[deal_id],
            "principal": float(contract["current_principal_amt"]),
            "contract_rate": 100 * (float(contract["interest_rate"]) + float(contract["base_indicator_rate"] or "0")),
            "term_years": (date.fromisoformat(contract["maturity_dttm"]) - day).days / 365,
            "age_years": (day - date.fromisoformat(contract["deal_dttm"])).days / 365,
            "payment_type": DIRECTIONS[contract["discriminator"]],
            "rate_type": RATE_TYPES[contract["rate_type_cd"]],
            "market_1y": base_rates["1y"], "market_5y": base_rates["5y"],
        })
    totals_by_scenario = {code: sum(p[code] for p in prices.values()) for code in CODES}
    base = totals_by_scenario["base"]
    return rows, {
        "scenarios": [{"code": code, "name": SCENARIOS[code], "pv": value, "delta": value - base}
                      for code, value in totals_by_scenario.items()],
        "cash12": sum(totals.values()), "interest12": sum(interest.values()),
        "duration": weighted_time / base if base else None,
        "curves": curves,
        "bucketDeltas": {code: [
            {"label": point["label"], "value": by_bucket[code][point["label"]] - by_bucket["base"][point["label"]]}
            for point in curves["base"]
        ] for code in CODES if code != "base"},
    }
