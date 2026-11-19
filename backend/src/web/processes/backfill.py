"""Queue a bounded historical interval; the ordinary worker performs all work."""

import argparse
import asyncio
from datetime import date

from core.config import get_settings
from core.database import Database
from web.services.preparation import automation_spec, enqueue_dates


async def main(start: date, end: date) -> None:
    settings = get_settings()
    automation_spec(settings)
    async with Database.open(settings.database) as database:
        count = await enqueue_dates(database, start, end)
    print(f"Queued {count} missing dates; existing jobs and results preserved")


def cli() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="start", required=True, type=date.fromisoformat)
    parser.add_argument("--to", dest="end", required=True, type=date.fromisoformat)
    args = parser.parse_args()
    asyncio.run(main(args.start, args.end))


if __name__ == "__main__":
    cli()
