"""Official ISS yearyields, already in years and percent per annum.

One response must describe one coherent source timestamp, interpreted in Moscow
local time. Mixed timestamps are rejected rather than inventing a slice policy.
No curve calculation, rounding, date fallback or retries happen in this adapter.
Retries and atomic publication belong to the existing Loader service.
Source contract: https://iss.moex.com/iss/reference/417
"""

from datetime import date

import httpx

from core.config import MoexSettings, get_settings
from web.exceptions.input_rate import MarketPermanentError, MarketTemporaryError
from web.integrations.moex_parser import parse_rates
from web.repositories.models import MarketRates


class MoexClient:
    def __init__(self, settings: MoexSettings) -> None:
        self.settings = settings

    async def fetch(self, report_date: date) -> MarketRates:
        try:
            async with httpx.AsyncClient(
                timeout=self.settings.timeout_seconds,
                trust_env=self.settings.trust_env,
                follow_redirects=False,
            ) as client:
                async with client.stream(
                    "GET",
                    str(self.settings.url),
                    params={
                        "date": report_date.isoformat(),
                        "iss.meta": "off",
                        "iss.only": "yearyields",
                    },
                ) as response:
                    if response.status_code == 429 or 500 <= response.status_code <= 599:
                        raise MarketTemporaryError(
                            f"MOEX temporarily unavailable (HTTP {response.status_code})"
                        )
                    if response.status_code != 200:
                        raise MarketPermanentError(
                            f"MOEX rejected request (HTTP {response.status_code})"
                        )
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(body) + len(chunk) > self.settings.max_response_bytes:
                            raise MarketPermanentError(
                                "MOEX response exceeded the configured size limit"
                            )
                        body.extend(chunk)
            return parse_rates(bytes(body), report_date)
        except httpx.HTTPError:
            raise MarketTemporaryError("MOEX connection or request timeout failure") from None


async def fetch_rates(report_date: date) -> MarketRates:
    return await MoexClient(get_settings().moex).fetch(report_date)
