"""Bridge to the existing Go API. Decimal strings are transport, not Go precision.

Go currently computes in float64. We preserve its output digits and validate
structure/grid; production comparison tolerances remain an agreed specification.
"""

import logging

import httpx
from pydantic import BaseModel, ConfigDict, Field

from core.config import IntegrationSettings
from web.exceptions.curve_run import ImplementationUnavailable, StressCurveError, StressTimeoutError
from web.repositories.models import STRESS_CODES, Curve, ScenarioParameters

logger = logging.getLogger(__name__)


class StressResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    curves: tuple[Curve, ...] = Field(min_length=6, max_length=6)


def build_stress_http(
    settings: IntegrationSettings, base: Curve, parameters: ScenarioParameters, version: str
) -> tuple[Curve, ...]:
    """A synchronous BuildStress callable; Worker invokes it outside DB acquisition."""
    if settings.stress_http_url is None or version != settings.stress_http_version:
        raise ImplementationUnavailable("Stress implementation version is not configured/matched")
    if base.curve_code != "base":
        raise StressCurveError("Stress input must be a base curve")
    payload = {
        "base": base.model_dump(mode="json", exclude={"points": {"__all__": {"discount_factor"}}}),
        "parameters": parameters.model_dump(mode="json"),
    }
    try:
        with httpx.Client(
            timeout=settings.stress_http_timeout_seconds, trust_env=False, follow_redirects=False
        ) as client:
            with client.stream("POST", str(settings.stress_http_url), json=payload) as response:
                if response.status_code != 200:
                    logger.warning(
                        "Stress service rejected request status=%s", response.status_code
                    )
                    raise StressCurveError(f"Stress service returned HTTP {response.status_code}")
                body = bytearray()
                for chunk in response.iter_bytes():
                    if len(body) + len(chunk) > settings.stress_http_max_response_bytes:
                        raise StressCurveError("Stress response exceeded the configured size limit")
                    body.extend(chunk)
        curves = StressResponse.model_validate_json(body).curves
        if {curve.curve_code for curve in curves} != STRESS_CODES:
            raise ValueError("Expected six unique stress scenarios")
        grid = [(point.bucket_label, point.tenor_years) for point in base.points]
        if any([(p.bucket_label, p.tenor_years) for p in c.points] != grid for c in curves):
            raise ValueError("Stress service changed the base grid")
        return curves
    except httpx.TimeoutException:
        raise StressTimeoutError("Stress service request timed out") from None
    except httpx.HTTPError:
        raise StressCurveError("Stress service connection/transport failed") from None
    except ValueError:
        raise StressCurveError("Stress service returned invalid curves or JSON") from None
