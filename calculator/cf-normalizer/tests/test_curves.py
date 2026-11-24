import csv
import json
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from normalizer.curves import (
    CODES,
    CurvesClient,
    CurvesError,
    save_curves,
    validate_result,
)
from normalizer.discounting import LABELS, boundaries, bucket_for, discount_flows

DAY = date(2026, 7, 31)
RUN = "fe0745c4-ae34-42f5-9e5f-0981b8b119d3"


@pytest.fixture
def result():
    return {
        "reportDate": str(DAY),
        "source": "moex",
        "dataProvenance": "market",
        "runId": RUN,
        "completedAt": "2026-07-31T17:00:00Z",
        "usedParameters": {"mode": "standard", "p": 4, "k": 5, "d": 3},
        "curves": [
            {
                "curveCode": code,
                "points": [
                    {
                        "bucketLabel": label,
                        "tenorYears": Decimal(i + 1) / 10,
                        "ratePercent": Decimal("-0.001"),
                        "discountFactor": Decimal("0.9999999999999999999991"),
                    }
                    for i, label in enumerate(LABELS)
                ],
            }
            for code in CODES
        ],
    }


@pytest.mark.parametrize(
    "change",
    [
        lambda v: v.update(reportDate="2026-07-30"),
        lambda v: v.update(dataProvenance="synthetic"),
        lambda v: v.update(runId="bad"),
        lambda v: v["curves"].pop(),
        lambda v: v["curves"][1]["points"].pop(),
        lambda v: v["curves"][0]["points"][0].update(discountFactor="0.9"),
        lambda v: v["curves"][0]["points"][0].update(discountFactor=Decimal("NaN")),
        lambda v: v["curves"][0]["points"][0].update(discountFactor=0),
        lambda v: v["curves"][0]["points"][1].update(bucketLabel="1d"),
        lambda v: v["usedParameters"].update(mode="custom"),
    ],
)
def test_invalid_result_is_never_used(result, change):
    change(result)
    with pytest.raises(CurvesError):
        validate_result(result, DAY)


def test_ready_does_not_post_and_preserves_original_bytes(
    result, monkeypatch, tmp_path
):
    raw = b'{"original":"unchanged decimal representation"}'
    client = CurvesClient("http://localhost:8000")
    calls = []

    def request(path, body=None):
        calls.append((path, body))
        return result, raw

    monkeypatch.setattr(client, "request", request)
    value, payload = client.result(DAY)
    assert len(calls) == 1 and calls[0][1] is None
    ref = save_curves(tmp_path, value, payload, "base")
    assert Path(ref["resultFile"]).read_bytes() == raw
    with (tmp_path / "curve-points.csv").open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 7 * 23
    assert rows[0]["discountFactor"] == "0.9999999999999999999991"


def test_lost_post_recovers_without_second_post(result, monkeypatch):
    client = CurvesClient("http://localhost:8000", poll_seconds=0)
    calls = []

    def request(path, body=None):
        calls.append((path, body))
        if body is not None:
            raise CurvesError("response lost")
        if "standard-result" in path:
            return None, b""
        if path.startswith("/curve-preparations?"):
            return {"reportDate": str(DAY), "status": "ready", "runId": RUN}, b""
        if path.endswith("/result"):
            return result, b"{}"
        return {"reportDate": str(DAY), "status": "ready", "runId": RUN}, b""

    monkeypatch.setattr(client, "request", request)
    assert client.result(DAY)[0]["runId"] == RUN
    assert sum(body is not None for _, body in calls) == 1


def test_portfolio_curve_request_recovers_stored_moex_failure(result, monkeypatch):
    client = CurvesClient("http://localhost:8000", poll_seconds=0)
    submissions = []
    statuses = iter(("queued", "ready"))

    def request(path, body=None):
        if "standard-result" in path:
            return None, b""
        if body is not None:
            submissions.append(body["retry"])
            return None, b""
        if path.startswith("/curve-preparations?"):
            status = next(statuses) if True in submissions else "failed"
            return {
                "reportDate": str(DAY),
                "status": status,
                "errorCode": "SOURCE_UNAVAILABLE" if status == "failed" else None,
                "runId": RUN if status == "ready" else None,
            }, b""
        if path.endswith("/result"):
            return result, b"{}"
        return {"reportDate": str(DAY), "status": "ready", "runId": RUN}, b""

    monkeypatch.setattr(client, "request", request)
    assert client.result(DAY)[0]["runId"] == RUN
    assert submissions == [False, True]


@pytest.mark.parametrize(
    "status,code,text",
    [
        ("no_data", None, "Нет публикации"),
        ("failed", "INVALID_MARKET_DATA", "некорректные"),
        ("failed", "SOURCE_UNAVAILABLE", "временно недоступен"),
        ("failed", "PREPARATION_FAILED", "подготовить"),
        ("failed", "/secret/trace", "Ошибка подготовки"),
    ],
)
def test_preparation_causes_are_separate(monkeypatch, status, code, text):
    client = CurvesClient("http://localhost:8000", poll_seconds=0)
    submissions = []

    def request(path, body=None):
        if body is not None:
            submissions.append(body["retry"])
        if "standard-result" in path:
            return None, b""
        return {
            "reportDate": str(DAY),
            "status": status,
            "errorCode": code,
            "message": "secret",
        }, b""

    monkeypatch.setattr(client, "request", request)
    with pytest.raises(CurvesError, match=text) as exc:
        client.result(DAY)
    assert "secret" not in str(exc.value)
    assert submissions == ([False, True] if code == "SOURCE_UNAVAILABLE" else [False])


def test_every_calendar_boundary_is_inclusive():
    upper = boundaries(DAY)
    for i, day in enumerate(upper):
        assert bucket_for(day, DAY) == LABELS[i]
        if i < len(upper) - 1:
            assert bucket_for(day + timedelta(days=1), DAY) == LABELS[i + 1]
    assert upper[1] == date(2026, 8, 31)
    assert boundaries(date(2024, 1, 31))[1] == date(2024, 2, 29)
    with pytest.raises(CurvesError):
        bucket_for(upper[-1] + timedelta(days=1), DAY)
    with pytest.raises(CurvesError):
        bucket_for(DAY, DAY)


def test_discounting_uses_api_factor_exactly_and_liability_sign(result, tmp_path):
    normalized = tmp_path / "normalized.csv"
    normalized.write_text(
        "deal_id;report_dttm;currency_id;side\n1;2026-07-31;RUB;LIABILITY\n"
    )
    (tmp_path / "cashflows.csv").write_text(
        "instrument_id,payment_date,cash_flow_type,amount\n1,2026-08-31,PRINCIPAL,100\n"
    )
    assert discount_flows(tmp_path, normalized, result, "all") == 7
    with (tmp_path / "discounted_cashflows.csv").open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 7 and {r["bucketLabel"] for r in rows} == {"1m"}
    assert Decimal(rows[0]["present_value"]) == Decimal("-99.9999999999999999999100")
    assert rows[0]["ratePercent"] == "-0.001"


def test_cli_runs_real_core_with_controlled_curves(result, monkeypatch, tmp_path):
    import os

    from normalizer.__main__ import main

    binary = os.environ.get("CFCORE_BIN")
    if not binary:
        pytest.skip("CFCORE_BIN is required for the real C++ CLI")
    source = (
        Path(__file__).resolve().parents[2] / "examples/manual/simple-fixed-curves.json"
    )
    monkeypatch.setattr(
        CurvesClient,
        "result",
        lambda self, day: (validate_result(result, day), b'{"fixture":true}'),
    )
    args = [
        str(source),
        "--manual",
        "--output-dir",
        str(tmp_path),
        "--format",
        "csv",
        "--cfcore",
        binary,
        "--curves-url",
        "http://localhost:8000",
        "--curve-scenario",
        "all",
    ]
    assert main(args) == 0
    manifest = json.loads((tmp_path / "core/run_manifest.json").read_text())
    assert manifest["discounting_applied"] is True
    assert manifest["curves"]["runId"] == RUN
    assert (
        json.loads((tmp_path / "integration-status.json").read_text())["status"]
        == "ready"
    )
    with (tmp_path / "core/discounted_cashflows.csv").open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert {r["curveCode"] for r in rows} == set(CODES)

    def fail(self, day):
        raise CurvesError("Источник MOEX временно недоступен.")

    monkeypatch.setattr(CurvesClient, "result", fail)
    with pytest.raises(SystemExit) as exc:
        main(args)
    assert exc.value.code == 2
    assert (
        json.loads((tmp_path / "integration-status.json").read_text())["status"]
        == "failed"
    )


def test_no_valid_core_deals_cannot_publish_discounted_success(
    result, monkeypatch, tmp_path
):
    import os

    from normalizer.__main__ import main

    binary = os.environ.get("CFCORE_BIN")
    if not binary:
        pytest.skip("CFCORE_BIN is required")
    source = (
        Path(__file__).resolve().parents[2] / "examples/manual/simple-fixed-curves.json"
    )
    invalid = json.loads(source.read_text())
    invalid["principal_payments"] = [{"date": "2026-08-31", "amount": 100001}]
    bad = tmp_path / "invalid-core.json"
    bad.write_text(json.dumps(invalid))
    monkeypatch.setattr(
        CurvesClient,
        "result",
        lambda self, day: (validate_result(result, day), b'{"fixture":true}'),
    )
    assert (
        main(
            [
                str(bad),
                "--manual",
                "--output-dir",
                str(tmp_path),
                "--format",
                "csv",
                "--cfcore",
                binary,
                "--curves-url",
                "http://localhost:8000",
            ]
        )
        == 2
    )
    state = json.loads((tmp_path / "integration-status.json").read_text())
    assert state == {"status": "failed", "reason": "CFCORE_NO_VALID_DEALS"}
    assert not (tmp_path / "core/discounted_cashflows.csv").exists()
