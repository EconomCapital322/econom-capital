import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

from core.config import LoaderSettings
from core.database import Database
from web.exceptions.input_rate import MarketTemporaryError, NoMarketData
from web.integrations.contracts import FetchRates
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import CalculationSpec, MarketRates, ScenarioParameters

logger = logging.getLogger(__name__)


async def load_rates(
    database: Database,
    report_date: date,
    fetch: FetchRates,
    settings: LoaderSettings,
    *,
    automatic_spec: CalculationSpec | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    jitter: Callable[[float, float], float] = random.uniform,
) -> Literal["saved", "unchanged", "no_data"]:
    if settings.enqueue_automatic and automatic_spec is None:
        raise ValueError("Automatic loading requires an explicit calculation specification")
    for attempt in range(settings.max_attempts):
        try:
            async with asyncio.timeout(settings.request_timeout_seconds):
                rates = MarketRates.model_validate(await fetch(report_date))
            if rates.report_date != report_date:
                raise ValueError("Source returned another report date")
            break
        except NoMarketData:
            logger.info("MOEX has no data reportDate=%s", report_date)
            return "no_data"
        except (MarketTemporaryError, OSError, TimeoutError):
            if attempt + 1 == settings.max_attempts:
                logger.error(
                    "MOEX attempts exhausted reportDate=%s attempts=%s", report_date, attempt + 1
                )
                raise
            # Iterative cap avoids overflow for an accidentally very large attempt setting.
            delay_cap = settings.backoff_base_seconds
            for _ in range(attempt):
                delay_cap = min(settings.backoff_cap_seconds, delay_cap * 2)
            delay = jitter(0, min(settings.backoff_cap_seconds, delay_cap))
            logger.warning(
                "MOEX retry reportDate=%s attempt=%s delaySeconds=%.3f",
                report_date,
                attempt + 1,
                delay,
            )
            await sleep(delay)
        except Exception:
            logger.exception("MOEX implementation/validation failure reportDate=%s", report_date)
            raise
    run_id = None
    async with database.transaction() as connection:
        changed = await InputRatesRepository.replace_current(
            connection, rates, loaded_at=datetime.now(UTC)
        )
        if automatic_spec is not None:
            run_id = await CurveRunsRepository.create_run(
                connection,
                report_date=report_date,
                parameters=ScenarioParameters(
                    mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3)
                ),
                spec=automatic_spec,
                run_origin="automatic",
            )
    if run_id is not None:
        logger.info("Automatic calculation queued reportDate=%s runId=%s", report_date, run_id)
    logger.info("MOEX load finished reportDate=%s changed=%s", report_date, changed)
    return "saved" if changed else "unchanged"
