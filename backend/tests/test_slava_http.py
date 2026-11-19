from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from core.config import IntegrationSettings
from tests.test_storage import fake_curve
from web.exceptions.curve_run import ImplementationUnavailable, StressCurveError
from web.integrations.adapters import SlavaAdapter
from web.repositories.models import STRESS_CODES, CalculationSpec, ScenarioParameters


def settings(**updates: object) -> IntegrationSettings:
    return IntegrationSettings.model_validate(
        {
            "stress_http_url": "http://localhost/internal/v1/stress-curves",
            "stress_http_version": "test-only-stress",
            **updates,
        }
    )


def install_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    original = httpx.Client

    def client(**kwargs: Any) -> httpx.Client:
        return original(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "Client", client)


def response_curves(spec: CalculationSpec) -> list[dict[str, Any]]:
    return [
        fake_curve(spec, code).model_dump(mode="json", exclude_none=True)
        for code in sorted(STRESS_CODES)
    ]


def test_exact_transport_and_valid_result(
    monkeypatch: pytest.MonkeyPatch,
    spec: CalculationSpec,
    parameters: ScenarioParameters,
) -> None:
    base = fake_curve(spec)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        payload = json.loads(request.content)
        assert set(payload) == {"base", "parameters"}
        assert payload["parameters"] == {"mode": "standard", "p": "4", "k": "5", "d": "3"}
        assert payload["base"]["points"][1]["tenor_years"] == "44.444444444444"
        assert payload["base"]["points"][0]["rate_percent"] == "-1.234"
        assert "discount_factor" not in payload["base"]["points"][0]
        assert payload["base"]["points"][0]["is_interpolated"] is False
        return httpx.Response(200, json={"curves": response_curves(spec)})

    install_transport(monkeypatch, handler)
    curves = SlavaAdapter(settings()).stress(base, parameters, spec.stress_version)
    assert len(calls) == 1
    assert {c.curve_code for c in curves} == STRESS_CODES
    assert curves[0].points[1].tenor_years == base.points[1].tenor_years


@pytest.mark.parametrize("status", [301, 400, 422, 500, 503])
def test_http_failure_is_not_retried(
    monkeypatch: pytest.MonkeyPatch,
    spec: CalculationSpec,
    parameters: ScenarioParameters,
    status: int,
) -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status, json={"code": "VALIDATION_ERROR", "message": "private"})

    install_transport(monkeypatch, handler)
    with pytest.raises(StressCurveError, match=f"HTTP {status}") as error:
        SlavaAdapter(settings()).stress(fake_curve(spec), parameters, spec.stress_version)
    assert "private" not in str(error.value) and len(calls) == 1


@pytest.mark.parametrize("error_type", [httpx.ConnectError, httpx.ReadTimeout])
def test_network_failure(
    monkeypatch: pytest.MonkeyPatch,
    spec: CalculationSpec,
    parameters: ScenarioParameters,
    error_type: type[httpx.RequestError],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error_type("sensitive upstream diagnostics", request=request)

    install_transport(monkeypatch, handler)
    with pytest.raises(StressCurveError) as error:
        SlavaAdapter(settings()).stress(fake_curve(spec), parameters, spec.stress_version)
    assert "sensitive" not in str(error.value)


@pytest.mark.parametrize(
    "case",
    ["json", "missing", "duplicate", "grid", "label", "nan", "infinity", "extra", "points", "size"],
)
def test_invalid_response(
    monkeypatch: pytest.MonkeyPatch,
    spec: CalculationSpec,
    parameters: ScenarioParameters,
    case: str,
) -> None:
    curves = response_curves(spec)
    if case == "missing":
        curves.pop()
    elif case == "duplicate":
        curves[-1] = curves[0]
    elif case == "grid":
        curves[0]["points"][0]["tenor_years"] = "0.06"
    elif case == "label":
        curves[0]["points"][0]["bucket_label"] = "wrong"
    elif case in ("nan", "infinity"):
        curves[0]["points"][0]["rate_percent"] = "NaN" if case == "nan" else "Infinity"
    elif case == "extra":
        curves[0]["unexpected"] = True
    elif case == "points":
        curves[0]["points"] = []
    body = b"not JSON" if case == "json" else json.dumps({"curves": curves}).encode()
    install_transport(monkeypatch, lambda request: httpx.Response(200, content=body))
    config = settings(stress_http_max_response_bytes=16) if case == "size" else settings()
    with pytest.raises(StressCurveError):
        SlavaAdapter(config).stress(fake_curve(spec), parameters, spec.stress_version)


def test_version_and_ambiguous_settings(
    spec: CalculationSpec,
    parameters: ScenarioParameters,
) -> None:
    with pytest.raises(ImplementationUnavailable):
        SlavaAdapter(settings()).stress(fake_curve(spec), parameters, "another-version")
    for updates in (
        {"stress_function": "package:func"},
        {"stress_http_version": None},
        {"stress_http_url": "file:///tmp/fake"},
        {"stress_http_url": "http://user:password@localhost/internal"},
    ):
        with pytest.raises(ValidationError):
            settings(**updates)
