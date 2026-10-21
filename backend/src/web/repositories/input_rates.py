from __future__ import annotations

from datetime import date, datetime
from uuid import UUID, uuid4

from core.database import DBConnection
from web.repositories.models import MarketRates, RatePoint, StoredRates, require_aware

# Stable across processes, including dates that have no current rows yet.
LOCK_NAMESPACE = 0x49525242


async def lock_date(connection: DBConnection, report_date: date) -> None:
    if not connection.is_in_transaction():
        raise RuntimeError("Date lock requires a caller-owned transaction")
    if await connection.fetchval("SHOW transaction_isolation") != "read committed":
        raise RuntimeError("Input replacement/snapshot creation requires READ COMMITTED")
    await connection.execute(
        "SELECT pg_advisory_xact_lock($1, $2)", LOCK_NAMESPACE, report_date.toordinal()
    )


class InputRatesRepository:
    """Stateless SQL repository; callers explicitly provide a shared connection."""

    @classmethod
    async def read_current(cls, connection: DBConnection, report_date: date) -> StoredRates | None:
        rows = await connection.fetch(
            (
                "SELECT report_date, source_as_of, loaded_at, tenor_years, rate AS rate_percent "
                "FROM input_rate WHERE run_id IS NULL AND report_date=$1 AND "
                "source='moex' ORDER BY tenor_years"
            ),
            report_date,
        )
        if not rows:
            return None
        if len({(r["source_as_of"], r["loaded_at"]) for r in rows}) != 1:
            raise ValueError("Inconsistent stored input metadata")
        return StoredRates(
            report_date=report_date,
            source_as_of=rows[0]["source_as_of"],
            loaded_at=rows[0]["loaded_at"],
            points=tuple(
                RatePoint(tenor_years=r["tenor_years"], rate_percent=r["rate_percent"])
                for r in rows
            ),
        )

    @classmethod
    async def replace_current(
        cls, connection: DBConnection, rates: MarketRates, *, loaded_at: datetime
    ) -> bool:
        """Atomic replacement. Nested transaction is a savepoint if called by a service."""
        require_aware(loaded_at)
        async with connection.transaction():
            await lock_date(connection, rates.report_date)
            current = await cls.read_current(connection, rates.report_date)
            points = tuple(sorted(rates.points, key=lambda p: p.tenor_years))
            if current and (
                current.source_as_of > rates.source_as_of
                or (current.source_as_of == rates.source_as_of and current.points == points)
            ):
                return False
            await connection.execute(
                (
                    "DELETE FROM input_rate WHERE run_id IS NULL AND report_date=$1 AND "
                    "source='moex'"
                ),
                rates.report_date,
            )
            await connection.executemany(
                (
                    "INSERT INTO input_rate "
                    "(id,report_date,source,source_as_of,loaded_at,tenor_years,rate) "
                    "VALUES ($1,$2,'moex',$3,$4,$5,$6)"
                ),
                [
                    (
                        uuid4(),
                        rates.report_date,
                        rates.source_as_of,
                        loaded_at,
                        p.tenor_years,
                        p.rate_percent,
                    )
                    for p in points
                ],
            )
        return True

    @classmethod
    async def read_snapshot(cls, connection: DBConnection, run_id: UUID) -> StoredRates | None:
        rows = await connection.fetch(
            (
                "SELECT report_date,source_as_of,loaded_at,tenor_years,rate AS rate_percent FROM "
                "input_rate WHERE run_id=$1 ORDER BY tenor_years"
            ),
            run_id,
        )
        if not rows:
            return None
        if len({(r["report_date"], r["source_as_of"], r["loaded_at"]) for r in rows}) != 1:
            raise ValueError("Inconsistent stored snapshot metadata")
        return StoredRates(
            report_date=rows[0]["report_date"],
            source_as_of=rows[0]["source_as_of"],
            loaded_at=rows[0]["loaded_at"],
            points=tuple(
                RatePoint(tenor_years=r["tenor_years"], rate_percent=r["rate_percent"])
                for r in rows
            ),
        )
