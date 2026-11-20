from __future__ import annotations

import hashlib
import logging
from datetime import date, timedelta
from uuid import UUID, uuid4

import simplejson

from core.database import DBConnection
from web.exceptions.curve_run import InputDataNotReady, RunNotFound, RunStateConflict, StaleClaim
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository, lock_date
from web.repositories.models import (
    CalculationError,
    CalculationSpec,
    RunOrigin,
    ScenarioParameters,
    StoredRun,
)

logger = logging.getLogger(__name__)


class CurveRunsRepository:
    """Stateless SQL repository; callers explicitly provide a shared connection."""

    @classmethod
    async def create_run(
        cls,
        connection: DBConnection,
        *,
        report_date: date,
        parameters: ScenarioParameters,
        spec: CalculationSpec,
        run_origin: RunOrigin = "manual",
    ) -> UUID:
        """Create a durable queued run and its immutable input snapshot together."""
        parameters = ScenarioParameters.model_validate(parameters.model_dump())
        spec = CalculationSpec.model_validate(spec.model_dump())
        if run_origin not in ("manual", "automatic"):
            raise ValueError("Unknown run origin")
        if run_origin == "automatic" and parameters.mode != "standard":
            raise ValueError("Automatic calculations require standard parameters")
        async with connection.transaction():
            await lock_date(connection, report_date)
            rates = await InputRatesRepository.read_current(connection, report_date)
            if rates is None:
                raise InputDataNotReady(str(report_date))
            automatic_key = None
            if run_origin == "automatic":
                identity = {
                    "report_date": report_date.isoformat(),
                    "source_as_of": rates.source_as_of.isoformat(),
                    "points": [
                        p.model_dump()
                        for p in sorted(rates.points, key=lambda point: point.tenor_years)
                    ],
                    "spec": spec.model_dump(),
                    "parameters": parameters.model_dump(),
                }
                automatic_key = hashlib.sha256(
                    simplejson.dumps(
                        identity, use_decimal=True, sort_keys=True, separators=(",", ":")
                    ).encode()
                ).hexdigest()
                existing = await connection.fetchval(
                    "SELECT id FROM curve_run WHERE automatic_key=$1 "
                    "AND status<>'failed' FOR UPDATE",
                    automatic_key,
                )
                if existing is not None:
                    return UUID(str(existing))
            run_id = uuid4()
            await connection.execute(
                "INSERT INTO curve_run "
                "(id,report_date,source,currency,scenario_parameters,calculation_spec,"
                "source_as_of,input_loaded_at,run_origin,automatic_key) "
                "VALUES ($1,$2,'moex','RUB',$3,$4,$5,$6,$7,$8)",
                run_id,
                report_date,
                parameters.model_dump(),
                spec.model_dump(),
                rates.source_as_of,
                rates.loaded_at,
                run_origin,
                automatic_key,
            )
            await connection.executemany(
                "INSERT INTO input_rate "
                "(id,run_id,report_date,source,source_as_of,loaded_at,tenor_years,rate) "
                "VALUES ($1,$2,$3,'moex',$4,$5,$6,$7)",
                [
                    (
                        uuid4(),
                        run_id,
                        report_date,
                        rates.source_as_of,
                        rates.loaded_at,
                        p.tenor_years,
                        p.rate_percent,
                    )
                    for p in rates.points
                ],
            )
        return run_id

    @classmethod
    async def get_run(cls, connection: DBConnection, run_id: UUID) -> StoredRun | None:
        row = await connection.fetchrow("SELECT * FROM curve_run WHERE id=$1", run_id)
        return StoredRun.model_validate(dict(row)) if row is not None else None

    @classmethod
    async def start_stage(
        cls, connection: DBConnection, *, run_id: UUID, worker_id: UUID, lease_duration: timedelta
    ) -> UUID | None:
        """Compare-and-set queued → running for an explicit run, without a worker loop."""
        if lease_duration <= timedelta(0):
            raise ValueError("lease_duration must be positive")
        async with connection.transaction():
            await connection.fetchrow("SELECT id FROM curve_run WHERE id=$1 FOR UPDATE", run_id)
            # Start the lease only after any wait for the row lock has ended.
            claimed: UUID | None = await connection.fetchval(
                "WITH t AS (SELECT clock_timestamp() ts) UPDATE curve_run SET "
                "status='running',started_at=COALESCE(started_at,t.ts),stage_started_at=t.ts,"
                "updated_at=t.ts,worker_id=$2,claim_token=$3,heartbeat_at=t.ts,"
                "lease_expires_at=t.ts+$4::interval FROM t "
                "WHERE id=$1 AND status='queued' RETURNING claim_token",
                run_id,
                worker_id,
                uuid4(),
                lease_duration,
            )
            return claimed

    @classmethod
    async def list_runs(cls, connection: DBConnection, report_date: date) -> list[StoredRun]:
        rows = await connection.fetch(
            "SELECT * FROM curve_run WHERE report_date=$1 ORDER BY created_at DESC,id DESC",
            report_date,
        )
        return [StoredRun.model_validate(dict(row)) for row in rows]

    @classmethod
    async def save_failure(
        cls, connection: DBConnection, *, run_id: UUID, claim_token: UUID, error: CalculationError
    ) -> None:
        """Persist an owned-stage failure without changing saved inputs or base curves."""
        error = CalculationError.model_validate(error)
        async with connection.transaction():
            await connection.fetchrow("SELECT id FROM curve_run WHERE id=$1 FOR UPDATE", run_id)
            updated = await connection.fetchval(
                "UPDATE curve_run SET status='failed',error=$3,completed_at=clock_timestamp(),"
                "updated_at=clock_timestamp(),worker_id=NULL,claim_token=NULL,"
                "heartbeat_at=NULL,lease_expires_at=NULL "
                "WHERE id=$1 AND status='running' AND claim_token=$2 "
                "AND lease_expires_at>clock_timestamp() RETURNING id",
                run_id,
                claim_token,
                error.model_dump(by_alias=True, exclude_none=True),
            )
            if updated is None:
                raise StaleClaim(str(run_id))

    @classmethod
    async def claim_next(
        cls,
        connection: DBConnection,
        *,
        worker_id: UUID,
        lease_duration: timedelta,
    ) -> StoredRun | None:
        async with connection.transaction():
            # Serialize queue decisions, including the empty-queue case.
            await connection.execute("SELECT pg_advisory_xact_lock($1,$2)", 0x49525242, -1)
            if await connection.fetchval(
                "SELECT EXISTS(SELECT 1 FROM curve_run WHERE status='running' "
                "AND lease_expires_at>clock_timestamp())"
            ):
                return None
            row = await connection.fetchrow(
                "SELECT id FROM curve_run WHERE status='queued' "
                "ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1"
            )
            if row is None:
                return None
            token = await cls.start_stage(
                connection, run_id=row["id"], worker_id=worker_id, lease_duration=lease_duration
            )
            return await cls.get_run(connection, row["id"]) if token else None

    @classmethod
    async def renew_lease(
        cls,
        connection: DBConnection,
        *,
        run_id: UUID,
        claim_token: UUID,
        lease_duration: timedelta,
    ) -> bool:
        if lease_duration <= timedelta(0):
            raise ValueError("lease_duration must be positive")
        async with connection.transaction():
            await connection.fetchrow("SELECT id FROM curve_run WHERE id=$1 FOR UPDATE", run_id)
            # The timestamp must be captured after acquiring the lock. A heartbeat
            # that waited beyond its lease must never restore expired ownership.
            updated = await connection.fetchval(
                "WITH t AS (SELECT clock_timestamp() ts) UPDATE curve_run SET "
                "heartbeat_at=t.ts,lease_expires_at=t.ts+$3::interval FROM t "
                "WHERE id=$1 AND status='running' AND claim_token=$2 "
                "AND lease_expires_at>t.ts RETURNING id",
                run_id,
                claim_token,
                lease_duration,
            )
            return updated is not None

    @classmethod
    async def interrupt_expired(cls, connection: DBConnection) -> int:
        rows = await connection.fetch(
            "UPDATE curve_run SET status='failed',completed_at=clock_timestamp(),"
            "updated_at=clock_timestamp(),error=$1,worker_id=NULL,claim_token=NULL,"
            "heartbeat_at=NULL,lease_expires_at=NULL "
            "WHERE status='running' AND lease_expires_at<=clock_timestamp() RETURNING id,stage",
            {
                "code": "CALCULATION_INTERRUPTED",
                "message": "Worker lost ownership of the stage",
                "details": [],
            },
        )
        for row in rows:
            logger.warning(
                "Calculation recovered runId=%s stage=%s error=CALCULATION_INTERRUPTED",
                row["id"],
                row["stage"],
            )
        return len(rows)

    @classmethod
    async def recalculate(
        cls,
        connection: DBConnection,
        *,
        parent_id: UUID,
        parameters: ScenarioParameters,
    ) -> UUID:
        async with connection.transaction():
            parent = await connection.fetchrow(
                "SELECT * FROM curve_run WHERE id=$1 FOR UPDATE",
                parent_id,
            )
            if parent is None:
                raise RunNotFound(str(parent_id))
            saved_parent = StoredRun.model_validate(dict(parent))
            if saved_parent.stage != "stress" or saved_parent.status not in ("ready", "failed"):
                raise RunStateConflict(str(parent_id))
            run_id = uuid4()
            await connection.execute(
                "INSERT INTO curve_run(id,report_date,source,currency,scenario_parameters,"
                "calculation_spec,stage,source_as_of,input_loaded_at,parent_run_id) "
                "VALUES($1,$2,'moex','RUB',$3,$4,'stress',$5,$6,$7)",
                run_id,
                saved_parent.report_date,
                parameters.model_dump(),
                saved_parent.calculation_spec.model_dump(),
                saved_parent.source_as_of,
                saved_parent.input_loaded_at,
                parent_id,
            )
            points = await connection.fetch("SELECT * FROM input_rate WHERE run_id=$1", parent_id)
            if len(points) < 2:
                raise RunStateConflict("Parent snapshot is incomplete")
            await connection.executemany(
                "INSERT INTO input_rate(id,run_id,report_date,source,source_as_of,loaded_at,"
                "tenor_years,rate) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
                [
                    (
                        uuid4(),
                        run_id,
                        p["report_date"],
                        p["source"],
                        p["source_as_of"],
                        p["loaded_at"],
                        p["tenor_years"],
                        p["rate"],
                    )
                    for p in points
                ],
            )
            await CurvesRepository.copy_base(
                connection, source_run_id=parent_id, target_run_id=run_id
            )
        return run_id
