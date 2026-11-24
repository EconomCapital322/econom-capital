"""Public curves API client. No Go/MOEX access and no local curve mathematics."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import time
from datetime import date
from decimal import Decimal
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from uuid import UUID

CODES = (
    "base",
    "parallel_up",
    "parallel_down",
    "steepener",
    "flattener",
    "short_rate_up",
    "short_rate_down",
)
MESSAGES = {
    "INVALID_MARKET_DATA": "MOEX вернула некорректные данные за выбранную дату.",
    "SOURCE_UNAVAILABLE": "Источник MOEX временно недоступен.",
    "PREPARATION_FAILED": "Не удалось подготовить данные для расчёта.",
    "BASE_CURVE_FAILED": "Ошибка построения базовой кривой.",
    "CALCULATION_FAILED": "Ошибка стрессового этапа.",
    "CALCULATION_TIMEOUT": "Превышено время серверного расчёта.",
}


class CurvesError(ValueError):
    """Safe public error, never contains server exception text."""


class ApiRejected(CurvesError):
    """An explicit HTTP rejection, distinct from an uncertain POST response."""


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise CurvesError("Некорректный числовой контракт API кривых.")
    result = Decimal(value)
    if not result.is_finite():
        raise CurvesError("API кривых вернул неконечное число.")
    return result


def validate_result(value, report_date):
    try:
        if value["reportDate"] != report_date.isoformat() or value["source"] != "moex":
            raise ValueError()
        if value.get("dataProvenance", "market") != "market":
            raise ValueError()
        UUID(value["runId"])
        date.fromisoformat(value["completedAt"][:10])
        params = value["usedParameters"]
        if params["mode"] != "standard" or [
            number(params[k]) for k in ("p", "k", "d")
        ] != [4, 5, 3]:
            raise ValueError()
        curves = value["curves"]
        if len(curves) != 7 or {c["curveCode"] for c in curves} != set(CODES):
            raise ValueError()
        grid = None
        for curve in curves:
            points = curve["points"]
            if not points:
                raise ValueError()
            current = []
            for point in points:
                label = point["bucketLabel"]
                tenor = number(point["tenorYears"])
                number(point["ratePercent"])
                if (
                    not isinstance(label, str)
                    or not label.strip()
                    or tenor <= 0
                    or number(point["discountFactor"]) <= 0
                ):
                    raise ValueError()
                current.append((label, tenor))
            tenors = [t for _, t in current]
            if len({s for s, _ in current}) != len(current) or tenors != sorted(
                set(tenors)
            ):
                raise ValueError()
            if grid is not None and grid != current:
                raise ValueError()
            grid = current
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise CurvesError("Неполный или несогласованный результат API кривых.") from exc
    return value


class CurvesClient:
    def __init__(self, base_url, *, wait_seconds=120, poll_seconds=1.5):
        url = urlsplit(base_url)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise CurvesError(
                "Укажите HTTP(S)-адрес API кривых без секретов и параметров."
            )
        if not math.isfinite(wait_seconds) or wait_seconds <= 0:
            raise CurvesError(
                "Время ожидания должно быть положительным конечным числом."
            )
        self.base = base_url.rstrip("/") + "/api/v1"
        self.wait = wait_seconds
        self.poll = poll_seconds

    def request(self, path, body=None):
        payload = None if body is None else json.dumps(body).encode()
        # POST is attempted once. An uncertain response is recovered only by GET.
        for attempt in range(1 if body is not None else 3):
            try:
                req = Request(
                    self.base + path,
                    data=payload,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                    },
                )
                with urlopen(req, timeout=min(15, self.wait)) as response:
                    raw = response.read(8_000_001)
                    if len(raw) > 8_000_000:
                        raise CurvesError("Слишком большой ответ API кривых.")
                    if body is not None and response.status not in (200, 202):
                        raise CurvesError("Неизвестный ответ на подготовку даты.")
                value = json.loads(
                    raw,
                    parse_float=Decimal,
                    parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
                )
                return value, raw
            except HTTPError as exc:
                if exc.code == 404 and body is None:
                    return None, b""
                if body is None and exc.code >= 500 and attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                try:
                    info = json.loads(exc.read(65536)).get("error", {})
                    code = info.get("code") if isinstance(info, dict) else None
                except (ValueError, AttributeError):
                    code = None
                raise ApiRejected(
                    MESSAGES.get(code, f"API кривых отклонил запрос (HTTP {exc.code}).")
                ) from exc
            except (URLError, TimeoutError, OSError) as exc:
                if body is None and attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise CurvesError(
                    "Нет ответа API кривых. Проверьте соединение и состояние задания."
                ) from exc
            except (ValueError, UnicodeError) as exc:
                raise CurvesError("Некорректный JSON в ответе API кривых.") from exc
        raise CurvesError("API кривых недоступен.")

    def result(self, day: date):
        query = "?" + urlencode({"reportDate": day.isoformat()})
        value, raw = self.request("/curve-runs/standard-result" + query)
        if value is not None:
            return validate_result(value, day), raw
        try:
            self.request(
                "/curve-preparations", {"reportDate": day.isoformat(), "retry": False}
            )
        except ApiRejected:
            raise
        except CurvesError:
            # A lost response is not proof the server rejected the job.
            pass
        deadline = time.monotonic() + self.wait
        while time.monotonic() < deadline:
            prep, _ = self.request("/curve-preparations" + query)
            if not isinstance(prep, dict) or prep.get("reportDate") != day.isoformat():
                raise CurvesError("Несогласованное состояние подготовки даты.")
            status = prep.get("status")
            if status == "no_data":
                raise CurvesError("Нет публикации MOEX за выбранную дату.")
            if status == "failed":
                raise CurvesError(
                    MESSAGES.get(prep.get("errorCode"), "Ошибка подготовки данных.")
                )
            if status not in ("idle", "queued", "running", "ready"):
                raise CurvesError("Неизвестное состояние подготовки даты.")
            run_id = prep.get("runId")
            if run_id:
                try:
                    UUID(run_id)
                except (ValueError, TypeError, AttributeError) as exc:
                    raise CurvesError("Некорректный идентификатор расчёта.") from exc
                run, _ = self.request("/curve-runs/" + run_id)
                if (
                    not isinstance(run, dict)
                    or run.get("reportDate") != day.isoformat()
                    or run.get("runId") != run_id
                ):
                    raise CurvesError("Несогласованное состояние расчёта.")
                if run.get("status") == "failed":
                    raise CurvesError(
                        MESSAGES.get(
                            (run.get("error") or {}).get("code"),
                            "Ошибка серверного расчёта.",
                        )
                    )
                if run.get("status") == "ready":
                    value, raw = self.request("/curve-runs/" + run_id + "/result")
                    validate_result(value, day)
                    if value["runId"] != run_id:
                        raise CurvesError("Результат относится к другому запуску.")
                    return value, raw
                if run.get("status") not in ("queued", "running"):
                    raise CurvesError("Неизвестное состояние серверного расчёта.")
            time.sleep(min(self.poll, max(0, deadline - time.monotonic())))
        raise CurvesError(
            "Расчёт пока не готов. Сервер продолжает работу; повторите получение позже."
        )


def save_curves(directory: Path, value, raw, scenario):
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "standard-result.json"
    temp = directory / "standard-result.json.tmp"
    temp.write_bytes(raw)
    temp.replace(target)
    with (directory / "curve-points.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "reportDate",
                "runId",
                "curveCode",
                "bucketLabel",
                "tenorYears",
                "ratePercent",
                "discountFactor",
            ]
        )
        for curve in value["curves"]:
            for p in curve["points"]:
                writer.writerow(
                    [
                        value["reportDate"],
                        value["runId"],
                        curve["curveCode"],
                        p["bucketLabel"],
                        p["tenorYears"],
                        p["ratePercent"],
                        p["discountFactor"],
                    ]
                )
    return {
        "reportDate": value["reportDate"],
        "runId": value["runId"],
        "scenario": scenario,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "resultFile": str(target.resolve()),
        "mappingRule": "calendar-bucket-v1",
    }
