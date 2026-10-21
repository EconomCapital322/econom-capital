import argparse
import asyncio
from datetime import date

from core.config import get_settings
from core.database import Database
from core.logging import configure_logging
from core.process_lock import process_lock
from web.exceptions.curve_run import ImplementationUnavailable
from web.exceptions.input_rate import LoaderAlreadyRunning
from web.integrations.adapters import EgorAdapter
from web.services.loading import load_rates


async def main(report_date: date) -> int:
    settings = get_settings()
    if settings.loader is None:
        raise ValueError("Explicit LOADER settings are required; see backend README")
    configure_logging(settings.logging)
    async with Database.open(settings.database) as database:
        key = f"loader:{await database.identity()}:{report_date.isoformat()}"
        with process_lock(key) as acquired:
            if not acquired:
                raise LoaderAlreadyRunning("Loader for this date already runs on this host")
            await load_rates(
                database, report_date, EgorAdapter(settings.integrations).fetch, settings.loader
            )
    return 0


def cli() -> None:
    parser = argparse.ArgumentParser(description="Load one report date; scheduling is external")
    parser.add_argument("--report-date", required=True, type=date.fromisoformat)
    args = parser.parse_args()
    try:
        code = asyncio.run(main(args.report_date))
    except LoaderAlreadyRunning as exc:
        parser.exit(2, str(exc) + "\n")
    except ImplementationUnavailable:
        parser.exit(1, "MOEX implementation is not connected: set INTEGRATIONS__FETCH_FUNCTION\n")
    except Exception:
        parser.exit(1, "MOEX load failed; check configuration, implementation and source logs\n")
    raise SystemExit(code)


if __name__ == "__main__":
    cli()
