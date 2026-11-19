from __future__ import annotations

from datetime import date
from uuid import UUID, uuid4

from core.database import DBConnection
from web.exceptions.curve_run import RunStateConflict, StaleClaim
from web.repositories.models import STRESS_CODES, CalculationSpec, Curve, StoredRun


def validate_grid(curve: Curve, spec: CalculationSpec) -> None:
    if [(p.bucket_label, p.tenor_years) for p in curve.points] != [
        (p.bucket_label, p.tenor_years) for p in spec.grid
    ]:
        raise ValueError("Curve grid differs from the explicit run specification")


class CurvesRepository:
    """Stateless SQL repository; callers explicitly provide a shared connection."""

    @classmethod
    async def read_curves(cls, connection: DBConnection, run_id: UUID) -> tuple[Curve, ...]:
        rows = await connection.fetch(
            (
                "SELECT c.curve_code,p.*,p.rate AS rate_percent FROM curve c JOIN curve_point p ON "
                "p.curve_id=c.id WHERE c.run_id=$1 ORDER BY c.curve_code,p.tenor_years"
            ),
            run_id,
        )
        codes = dict.fromkeys(r["curve_code"] for r in rows)
        return tuple(
            Curve.model_validate(
                {
                    "curve_code": code,
                    "points": [
                        dict(
                            bucket_label=r["bucket_label"],
                            tenor_years=r["tenor_years"],
                            rate_percent=r["rate_percent"],
                            discount_factor=r["discount_factor"],
                            is_interpolated=r["is_interpolated"],
                            is_extrapolated=r["is_extrapolated"],
                        )
                        for r in rows
                        if r["curve_code"] == code
                    ],
                }
            )
            for code in codes
        )

    @classmethod
    async def read_state(
        cls, connection: DBConnection, run_id: UUID
    ) -> tuple[StoredRun, tuple[Curve, ...]] | None:
        # The two statements must observe the same committed publication.
        if connection.is_in_transaction():
            isolation = await connection.fetchval("SHOW transaction_isolation")
            if isolation not in ("repeatable read", "serializable"):
                raise RuntimeError("read_state requires REPEATABLE READ or SERIALIZABLE")
            return await cls._read_state(connection, run_id)
        async with connection.transaction(isolation="repeatable_read", readonly=True):
            return await cls._read_state(connection, run_id)

    @classmethod
    async def read_standard_result(
        cls, connection: DBConnection, report_date: date
    ) -> tuple[StoredRun, tuple[Curve, ...]] | None:
        # Published results are immutable. Use the same snapshot for the run and its points.
        async with connection.transaction(isolation="repeatable_read", readonly=True):
            row = await connection.fetchrow(
                "SELECT * FROM curve_run WHERE report_date=$1 AND status='ready' "
                "AND scenario_parameters->>'mode'='standard' "
                "ORDER BY completed_at DESC,id DESC LIMIT 1",
                report_date,
            )
            if row is None:
                return None
            run = StoredRun.model_validate(dict(row))
            return run, await cls.read_curves(connection, run.id)

    @classmethod
    async def _read_state(
        cls, connection: DBConnection, run_id: UUID
    ) -> tuple[StoredRun, tuple[Curve, ...]] | None:
        row = await connection.fetchrow("SELECT * FROM curve_run WHERE id=$1", run_id)
        if row is None:
            return None
        return StoredRun.model_validate(dict(row)), await cls.read_curves(connection, run_id)

    @classmethod
    async def copy_base(
        cls, connection: DBConnection, *, source_run_id: UUID, target_run_id: UUID
    ) -> None:
        """Copy an immutable base only into its queued stress recalculation."""
        async with connection.transaction():
            target = await connection.fetchrow(
                "SELECT calculation_spec FROM curve_run WHERE id=$1 AND parent_run_id=$2 "
                "AND status='queued' AND stage='stress' FOR UPDATE",
                target_run_id,
                source_run_id,
            )
            if target is None:
                raise RunStateConflict("Target is not a queued recalculation of this source")
            base = next(
                (
                    c
                    for c in await cls.read_curves(connection, source_run_id)
                    if c.curve_code == "base"
                ),
                None,
            )
            if base is None:
                raise RunStateConflict("Source has no saved base curve")
            validate_grid(base, CalculationSpec.model_validate(target["calculation_spec"]))
            await cls._insert(connection, target_run_id, base)

    @classmethod
    async def publish_stage(
        cls, connection: DBConnection, *, run_id: UUID, claim_token: UUID, curves: tuple[Curve, ...]
    ) -> None:
        """Store an owned result without executing or scheduling calculations."""
        async with connection.transaction():
            row = await connection.fetchrow(
                "SELECT * FROM curve_run WHERE id=$1 FOR UPDATE", run_id
            )
            # Check database time after acquiring the row lock, not transaction start time.
            valid = await connection.fetchval(
                (
                    "SELECT status='running' AND claim_token=$2 AND "
                    "lease_expires_at>clock_timestamp() FROM curve_run WHERE id=$1"
                ),
                run_id,
                claim_token,
            )
            if row is None or not valid:
                raise StaleClaim(str(run_id))
            spec = CalculationSpec.model_validate(row["calculation_spec"])
            for curve in curves:
                validate_grid(curve, spec)
            if row["stage"] == "base":
                if len(curves) != 1 or curves[0].curve_code != "base":
                    raise ValueError("Base publication requires exactly one base curve")
            else:
                if len(curves) != 6 or {c.curve_code for c in curves} != STRESS_CODES:
                    raise ValueError("Stress publication requires all six unique scenarios")
                existing = await cls.read_curves(connection, run_id)
                if len(existing) != 1 or existing[0].curve_code != "base":
                    raise ValueError("Stress publication requires the saved base")
                validate_grid(existing[0], spec)
            for curve in curves:
                await cls._insert(connection, run_id, curve)
            published = await connection.fetchval(
                (
                    "UPDATE curve_run SET stage='stress', status=CASE WHEN stage='base' THEN "
                    "'queued' ELSE 'ready' END, completed_at=CASE WHEN stage='stress' THEN "
                    "clock_timestamp() ELSE NULL END, updated_at=clock_timestamp(), "
                    "stage_started_at=NULL, "
                    "worker_id=NULL,claim_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL "
                    "WHERE id=$1 AND status='running' AND claim_token=$2 AND "
                    "lease_expires_at>clock_timestamp() RETURNING id"
                ),
                run_id,
                claim_token,
            )
            if published is None:
                raise StaleClaim(str(run_id))

    @classmethod
    async def _insert(cls, connection: DBConnection, run_id: UUID, curve: Curve) -> None:
        curve = Curve.model_validate(curve)
        if any(point.discount_factor is None for point in curve.points):
            raise ValueError("Stored curve points require discount factors")
        curve_id = uuid4()
        await connection.execute(
            "INSERT INTO curve(id,run_id,curve_code) VALUES ($1,$2,$3)",
            curve_id,
            run_id,
            curve.curve_code,
        )
        await connection.executemany(
            (
                "INSERT INTO curve_point "
                "(id,curve_id,bucket_label,tenor_years,rate,discount_factor,"
                "is_interpolated,is_extrapolated)"
                " VALUES ($1,$2,$3,$4,$5,$6,$7,$8)"
            ),
            [
                (
                    uuid4(),
                    curve_id,
                    p.bucket_label,
                    p.tenor_years,
                    p.rate_percent,
                    p.discount_factor,
                    p.is_interpolated,
                    p.is_extrapolated,
                )
                for p in curve.points
            ],
        )
