"""Sequential worker orchestration. Calculation callables never receive database resources."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import timedelta
from threading import Thread
from typing import TypeVar, cast
from uuid import UUID, uuid4

from core.config import WorkerSettings
from core.database import Database
from web.calculations.discount import with_discount_factors
from web.exceptions.curve_run import (
    ImplementationUnavailable,
    StaleClaim,
    StressCurveError,
    StressTimeoutError,
)
from web.integrations.contracts import BuildBase, BuildStress
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import (
    STRESS_CODES,
    CalculationError,
    CalculationErrorCode,
    Curve,
    CurveCode,
)

logger = logging.getLogger(__name__)
T = TypeVar("T")


async def call_calculation(function: Callable[[], T], timeout_seconds: float) -> T:
    """A daemon thread cannot publish: it receives data only, never a pool/connection.

    On timeout the worker exits, rather than accumulating abandoned computations.
    Python cannot force-cancel arbitrary synchronous third-party code.
    """
    loop = asyncio.get_running_loop()
    future: asyncio.Future[T] = loop.create_future()

    def deliver(value: T | None, error: BaseException | None) -> None:
        if future.done():
            return
        if error is not None:
            future.set_exception(error)
        else:
            future.set_result(cast(T, value))

    def execute() -> None:
        value, error = None, None
        try:
            value = function()
        except BaseException as exc:
            error = exc
        try:
            loop.call_soon_threadsafe(deliver, value, error)
        except RuntimeError:
            pass  # The process/event loop already shut down; no publication is possible.

    Thread(target=execute, daemon=True, name="irrbb-calculation").start()
    async with asyncio.timeout(timeout_seconds):
        return await future


class CalculationWorker:
    def __init__(
        self, database: Database, settings: WorkerSettings, base: BuildBase, stress: BuildStress
    ) -> None:
        self.database, self.settings = database, settings
        self.base, self.stress = base, stress
        self.worker_id = uuid4()
        self.must_exit = False

    async def run_once(self, stop: asyncio.Event | None = None) -> bool:
        stop = stop if stop is not None else asyncio.Event()
        async with self.database.connection() as connection:
            recovered = await CurveRunsRepository.interrupt_expired(connection)
            if recovered:
                logger.warning("Interrupted expired runs count=%s", recovered)
            row = await CurveRunsRepository.claim_next(
                connection,
                worker_id=self.worker_id,
                lease_duration=timedelta(seconds=self.settings.lease_seconds),
            )
        if row is None:
            return False
        run_id, token, stage = row.id, row.claim_token, row.stage
        if token is None:
            raise RuntimeError("Claimed run has no ownership token")
        logger.info("Calculation started runId=%s stage=%s", run_id, stage)
        started = asyncio.get_running_loop().time()
        heartbeat = asyncio.create_task(self._heartbeat(run_id, token))
        shutdown = asyncio.create_task(stop.wait())
        computation: asyncio.Task[tuple[Curve, ...]] | None = None
        try:
            spec = row.calculation_spec
            parameters = row.scenario_parameters
            async with self.database.connection() as connection:
                if stage == "base":
                    snapshot = await InputRatesRepository.read_snapshot(connection, run_id)
                    if snapshot is None:
                        raise ValueError("Missing immutable snapshot")

                    def function() -> tuple[Curve, ...]:
                        return (with_discount_factors(self.base(snapshot.points, spec)),)
                else:
                    curves = await CurvesRepository.read_curves(connection, run_id)
                    base = next(c for c in curves if c.curve_code == "base")

                    def function() -> tuple[Curve, ...]:
                        return tuple(
                            with_discount_factors(c)
                            for c in self.stress(base, parameters, spec.stress_version)
                        )

            # The acquisition above has ended. Only immutable data reaches the function.
            computation = asyncio.create_task(
                call_calculation(
                    function,
                    self.settings.stage_timeout_seconds,
                )
            )
            done, _ = await asyncio.wait(
                (computation, heartbeat, shutdown), return_when=asyncio.FIRST_COMPLETED
            )
            if shutdown in done:
                raise asyncio.CancelledError
            if heartbeat in done:
                await heartbeat
                raise StaleClaim(str(run_id))
            result = await computation
            async with self.database.connection() as connection:
                await CurvesRepository.publish_stage(
                    connection, run_id=run_id, claim_token=token, curves=result
                )
            logger.info("Calculation published runId=%s stage=%s", run_id, stage)
        except StaleClaim:
            logger.warning("Publication ownership lost runId=%s stage=%s", run_id, stage)
        except asyncio.CancelledError:
            await self._fail(run_id, token, "CALCULATION_INTERRUPTED")
            self.must_exit = True
            raise
        except StressTimeoutError:
            # The bounded HTTP call has ended; no abandoned computation remains.
            await self._fail(run_id, token, "CALCULATION_TIMEOUT")
        except TimeoutError:
            self.must_exit = True
            await self._fail(run_id, token, "CALCULATION_TIMEOUT")
        except ImplementationUnavailable:
            logger.error("Implementation unavailable runId=%s stage=%s", run_id, stage)
            await self._fail(
                run_id,
                token,
                "BASE_CURVE_FAILED" if stage == "base" else "CALCULATION_FAILED",
                message="Calculation implementation is not connected",
            )
        except Exception as exc:
            logger.exception("Calculation failed runId=%s stage=%s", run_id, stage)
            curve_code = exc.curve_code if isinstance(exc, StressCurveError) else None
            await self._fail(
                run_id,
                token,
                "BASE_CURVE_FAILED" if stage == "base" else "CALCULATION_FAILED",
                curve_code,
            )
        finally:
            if computation is not None and not computation.done():
                self.must_exit = True  # An abandoned synchronous function may still be running.
            for task in (heartbeat, shutdown, computation):
                if task is not None:
                    task.cancel()
            await asyncio.gather(
                *(t for t in (heartbeat, shutdown, computation) if t is not None),
                return_exceptions=True,
            )
            logger.info(
                "Calculation ended runId=%s stage=%s durationMs=%.1f",
                run_id,
                stage,
                (asyncio.get_running_loop().time() - started) * 1000,
            )
        return True

    async def _heartbeat(self, run_id: UUID, token: UUID) -> None:
        while True:
            await asyncio.sleep(self.settings.heartbeat_seconds)
            async with self.database.connection() as connection:
                valid = await CurveRunsRepository.renew_lease(
                    connection,
                    run_id=run_id,
                    claim_token=token,
                    lease_duration=timedelta(seconds=self.settings.lease_seconds),
                )
            if not valid:
                raise StaleClaim(str(run_id))

    async def _fail(
        self,
        run_id: UUID,
        token: UUID,
        code: CalculationErrorCode,
        curve_code: CurveCode | None = None,
        message: str = "Calculation stage failed; consult backend logs",
    ) -> None:
        error = CalculationError(
            code=code,
            message=message,
            curve_code=curve_code if curve_code in STRESS_CODES else None,
        )
        try:
            async with self.database.connection() as connection:
                await CurveRunsRepository.save_failure(
                    connection, run_id=run_id, claim_token=token, error=error
                )
        except StaleClaim:
            logger.warning("Cannot fail an expired/finished claim runId=%s", run_id)

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set() and not self.must_exit:
            try:
                processed = await self.run_once(stop)
            except asyncio.CancelledError:
                if stop.is_set():
                    return
                raise
            except Exception:
                logger.exception("Worker database/orchestration failure")
                processed = False
            if not processed:
                try:
                    await asyncio.wait_for(stop.wait(), self.settings.poll_seconds)
                except TimeoutError:
                    pass
