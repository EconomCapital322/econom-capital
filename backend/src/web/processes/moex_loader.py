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
from web.integrations.specification import load_specification
from web.services.loading import load_rates


async def main(report_date: date) -> int:
    settings = get_settings()
    if settings.loader is None:
        raise ValueError("Explicit LOADER settings are required; configure LOADER__ settings")
    configure_logging(settings.logging)
    async with Database.open(settings.database) as database:
        key = f"loader:{await database.identity()}:{report_date.isoformat()}"
        with process_lock(key) as acquired:
            if not acquired:
                raise LoaderAlreadyRunning("Loader for this date already runs on this host")
            await load_rates(
                database,
                report_date,
                EgorAdapter(settings.integrations).fetch,
                settings.loader,
                automatic_spec=load_specification(settings.calculation.spec_file)
                if settings.loader.enqueue_automatic
                else None,
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
    except ImplementationUnavailable as exc:
        parser.exit(
            1,
            f"MOEX load unavailable: {exc}; check FETCH_FUNCTION and CALCULATION__SPEC_FILE\n",
        )
    except Exception:
        parser.exit(1, "MOEX load failed; check configuration, implementation and source logs\n")
    raise SystemExit(code)


if __name__ == "__main__":
    cli()
