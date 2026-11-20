"""Queue missing historical dates and report the state of every day in the interval."""

import argparse
import asyncio
import json
from collections import Counter
from datetime import date
from pathlib import Path

from core.config import get_settings
from core.database import Database
from web.services.preparation import automation_spec, enqueue_dates, history_dates


async def main(
    start: date, end: date, *, report_only: bool = False, output: Path | None = None
) -> None:
    if end < start or (end - start).days > 3660:
        raise ValueError("Expected a date range no longer than ten years")
    settings = get_settings()
    if not report_only:
        automation_spec(settings)
    async with Database.open(settings.database) as database:
        count = 0 if report_only else await enqueue_dates(database, start, end)
        days = await history_dates(database, start, end)
    report = {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "newlyQueued": count,
        "counts": dict(Counter(day["status"] for day in days)),
        "dates": days,
    }
    if output is None:
        print(json.dumps(report, indent=2))
    else:
        await asyncio.to_thread(
            output.write_text, json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
        print(f"Queued {count} missing dates. Report: {output}")


def cli() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="start", required=True, type=date.fromisoformat)
    parser.add_argument("--to", dest="end", required=True, type=date.fromisoformat)
    parser.add_argument("--report-only", action="store_true", help="Read history without queuing")
    parser.add_argument("--output", type=Path, help="Write JSON report to this path")
    args = parser.parse_args()
    asyncio.run(main(args.start, args.end, report_only=args.report_only, output=args.output))


if __name__ == "__main__":
    cli()
