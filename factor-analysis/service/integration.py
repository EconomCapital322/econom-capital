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
from uuid import UUID

from .fixtures import curve_fixture

ROOT = Path(__file__).resolve().parents[1]
NORMALIZER = ROOT.parent / "calculator" / "cf-normalizer" / "src"
sys.path.insert(0, str(NORMALIZER))

from normalizer.curves import CODES, CurvesClient, save_curves, validate_result  # noqa: E402
from normalizer.discounting import LABELS as BUCKET_LABELS, discount_flows  # noqa: E402

SCENARIOS = dict(zip(CODES, (
    "Базовая кривая", "Общий рост ставок", "Общее снижение ставок",
    "Увеличение наклона кривой", "Уменьшение наклона кривой", "Рост краткосрочных ставок",
    "Снижение краткосрочных ставок",
), strict=True))
LABELS = {
    "npv": "NPV базы", "stress_delta": "ΔPV выбранного сценария к базе",
    "interest12": "Процентные потоки за 12 месяцев", "cash12": "Платежи за 12 месяцев",
    "principal": "Остаток долга", "contract_rate": "Кредитная ставка",
    "term_years": "Оставшийся срок, лет", "age_years": "Возраст сделки, лет",
    "payment_type": "График платежей", "rate_type": "Тип ставки",
    "market_1y": "Ставка бакета 1 год", "market_5y": "Ставка бакета 5 лет",
    "market_short": "Ставка 1 месяц", "market_long": "Ставка 10 лет",
    "market_level": "Средний уровень кривой", "market_slope": "Наклон 10 лет − 1 год",
    "market_curvature": "Кривизна между 1 и 10 годами", "side": "Сторона сделки",
    "cash_effect": "Денежные потоки", "discount_effect": "Коэффициенты дисконтирования",
}
TARGETS = ("npv", "stress_delta", "interest12", "cash12")
FEATURES = ("principal", "contract_rate", "term_years", "age_years", "payment_type", "rate_type", "side",
            "market_short", "market_long", "market_level", "market_slope", "market_curvature", "market_1y", "market_5y")
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


def validated_snapshot_curves(value, day):
    if isinstance(value, dict) and value.get("source") == "synthetic_fixture" and value.get("dataProvenance") == "synthetic":
        validate_result({**value, "source": "moex", "dataProvenance": "market"}, day)
        return value
    return validate_result(value, day)


def selected_curve_ref(value):
    try:
        day = date.fromisoformat(value["reportDate"])
        run_id = str(UUID(value["runId"]))
        if day.isoformat() != value["reportDate"] or run_id != value["runId"]:
            raise ValueError()
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise ValueError("Выберите корректную дату и Run ID кривых.") from error
    return day, run_id


def market_curve_run(client, day, run_id):
    route = "/curve-runs/" + run_id
    state, _ = client.request(route)
    if (not isinstance(state, dict) or state.get("reportDate") != day.isoformat()
            or state.get("runId") != run_id or state.get("status") != "ready"):
        raise ValueError("Выбранный запуск кривых недоступен или ещё не готов.")
    if state.get("dataProvenance") != "market" or (state.get("usedParameters") or {}).get("mode") != "standard":
        raise ValueError("Для оценки доступны рыночные кривые со стандартными P = 4, K = 5, D = 3.")
    result, raw = client.request(route + "/result")
    validate_result(result, day)
    if result["runId"] != run_id or result["usedParameters"] != state["usedParameters"]:
        raise ValueError("Результат кривых не соответствует выбранному запуску.")
    if {p["bucketLabel"] for p in result["curves"][0]["points"]} != set(BUCKET_LABELS):
        raise ValueError("В выбранном запуске нужны все 23 календарных бакета.")
    return result, raw


def curve_metadata(result):
    parameters = result["usedParameters"]
    return {
        "source": result["source"], "curveProvenance": result.get("dataProvenance", "market"),
        "curveCompletedAt": result["completedAt"],
        "curveParameters": {"mode": parameters["mode"], **{k: float(parameters[k]) for k in ("p", "k", "d")}},
    }


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
    fixture_mode = settings.get("demoCurves") is True
    cache = Path(os.environ.get("SPECTRUM_CURVES_DIR", ROOT / ".local" / "curves"))
    if cache_mode and fixture_mode:
        raise ValueError("Выберите один источник кривых на весь расчёт.")
    batches = generated["batches"]
    pinned = settings.get("curveSelection")
    if pinned is not None:
        selected_day, run_id = selected_curve_ref(pinned)
        if cache_mode or fixture_mode:
            raise ValueError("Выбранный Run ID можно применить только при расчёте через API.")
        if not any(batch["date"] == selected_day.isoformat() for batch in batches):
            raise ValueError("Дата выбранных кривых должна входить в период расчёта портфеля.")
    positions, schedule = {}, defaultdict(list)
    panel, periods = [], []

    for index, batch in enumerate(batches, 1):
        day = date.fromisoformat(batch["date"])
        folder = destination / day.isoformat()
        folder.mkdir()
        progress(index - 1, len(batches), f"{day:%d.%m.%Y} · подготовка кривых команды 2")
        if fixture_mode:
            curve_result, raw = curve_fixture(day, CODES, BUCKET_LABELS)
        elif cache_mode:
            saved = cache / f"{day}.json"
            if not saved.is_file():
                raise ValueError(f"Нет сохранённых рыночных кривых на {day:%d.%m.%Y}. Включите расчёт через API.")
            raw = saved.read_bytes()
            curve_result = validate_result(json.loads(raw, parse_float=Decimal), day)
        elif pinned is not None and day == selected_day:
            curve_result, raw = market_curve_run(curves, day, run_id)
        else:
            try:
                curve_result, raw = curves.result(day)
            except ValueError as error:
                raise ValueError(f"{day:%d.%m.%Y}. {error}") from error
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
        progress(index - 1, len(batches), f"{day:%d.%m.%Y} · дисконтирование платежей по семи кривым")
        discount_flows(core_dir, input_path, curve_result, "all")
        rows, metrics = summarize(day, positions, curve_result, core_dir, flow_rows, scenario)
        panel.extend(rows)
        periods.append({
            **metrics, "date": day.isoformat(), "deals": len(positions), "flowRows": len(flow_rows),
            "runId": curve_result["runId"], "sha256": link["sha256"],
            "curveSource": "fixture" if fixture_mode else "saved" if cache_mode else
            "pinned" if pinned is not None and day == selected_day else "api",
            **curve_metadata(curve_result),
        })
        progress(index, len(batches), f"{day:%d.%m.%Y} · рассчитано {len(positions)} сделок во всех 7 сценариях")

    write_rows(destination / "dataset.csv", panel, panel[0].keys())
    return {
        "source": "integrated", "portfolioSource": "synthetic", "periods": periods, "scenario": scenario,
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
    short, one, middle, long = (base_rates[key] for key in ("1m", "1y", "5y", "10y"))
    curve_features = {"market_short": short, "market_long": long, "market_level": (one + middle + long) / 3,
                      "market_slope": long - one, "market_curvature": 2 * middle - one - long}
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
            "payment_type": DIRECTIONS.get(contract["discriminator"], contract["discriminator"]),
            "rate_type": RATE_TYPES.get(contract["rate_type_cd"], contract["rate_type_cd"]),
            "side": contract["side"],
            **curve_features,
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
