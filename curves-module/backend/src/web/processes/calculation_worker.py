import argparse
import asyncio
import logging
import os
import signal
from pathlib import Path

from core.config import get_settings
from core.database import Database
from core.logging import configure_logging
from core.process_lock import process_lock
from web.exceptions.curve_run import WorkerAlreadyRunning
from web.integrations.adapters import EgorAdapter, SlavaAdapter
from web.services.calculations import CalculationWorker
from web.services.preparation import PreparationWorker

logger = logging.getLogger(__name__)


async def main(*, once: bool = False) -> int:
    path = os.environ.get("WORKER_READY_FILE")
    ready_file = Path(path) if path else None
    if ready_file is not None:
        ready_file.unlink(missing_ok=True)

    settings = get_settings()
    if settings.worker is None:
        raise ValueError("Explicit WORKER settings are required; configure WORKER__ settings")
    configure_logging(settings.logging)
    async with Database.open(settings.database) as database:
        key = "worker:" + await database.identity()
        with process_lock(key) as acquired:
            if not acquired:
                raise WorkerAlreadyRunning("Another worker is already running on this host")
            worker = CalculationWorker(
                database,
                settings.worker,
                EgorAdapter(settings.integrations).base,
                SlavaAdapter(settings.integrations).stress,
            )
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, stop.set)
            try:
                if ready_file is not None:
                    ready_file.touch()
                if once:
                    if not settings.automation.enabled or not await PreparationWorker(
                        database, settings
                    ).run_once(stop):
                        await worker.run_once(stop)
                elif settings.automation.enabled:
                    await PreparationWorker(database, settings).run(worker, stop)
                else:
                    await worker.run(stop)
            except asyncio.CancelledError:
                if not stop.is_set():
                    raise
            finally:
                if ready_file is not None:
                    ready_file.unlink(missing_ok=True)
                for sig in (signal.SIGINT, signal.SIGTERM):
                    loop.remove_signal_handler(sig)
            return 1 if worker.must_exit and not stop.is_set() else 0


def cli() -> None:
    parser = argparse.ArgumentParser(description="Run the independent IRRBB calculation worker")
    parser.add_argument(
        "--once", action="store_true", help="Process at most one queued stage and exit"
    )
    args = parser.parse_args()
    try:
        code = asyncio.run(main(once=args.once))
    except WorkerAlreadyRunning as exc:
        parser.exit(2, str(exc) + "\n")
    except Exception:
        # Configuration/import/connection errors must not dump a secret-bearing DSN to stderr.
        parser.exit(1, "Worker could not start; verify settings and database availability\n")
    raise SystemExit(code)


if __name__ == "__main__":
    cli()
