"""Explicit synthetic inputs for the isolated backend-final demo PostgreSQL.

Queues normal jobs; never writes fabricated curves or ready states. The old
legacy demo instance is intentionally rejected, even if its schema is readable.
"""

import argparse
import asyncio
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID

from core.config import get_settings
from core.database import Database
from core.logging import configure_logging
from web.integrations.specification import load_specification
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import CalculationSpec, MarketRates, RatePoint, ScenarioParameters


async def prepare_history(database: Database, spec: CalculationSpec) -> list[UUID]:
    spec = CalculationSpec.model_validate(spec.model_dump())
    if spec.data_provenance != "synthetic":
        raise ValueError("Demo requires an explicitly synthetic calculation specification")
    ids: list[UUID] = []
    async with database.transaction() as connection:
        marker = await connection.fetchval("SELECT current_setting('irrbb.demo_instance',true)")
        if marker != "backend-final":
            raise ValueError("Refusing seed: database is not marked as the backend-final demo")
        await connection.execute("SELECT pg_advisory_xact_lock($1,$2)", 0x49525242, -2)
        for offset in range(3):
            report_date = date(2026, 7, 29 + offset)
            rates = MarketRates(
                report_date=report_date,
                source_as_of=datetime(2026, 7, 29 + offset, 16, tzinfo=UTC),
                points=(
                    RatePoint(tenor_years=Decimal("0.25"), rate_percent=Decimal(10 + offset)),
                    RatePoint(tenor_years=Decimal(10), rate_percent=Decimal(12 + offset)),
                ),
            )
            existing_rates = await InputRatesRepository.read_current(connection, report_date)
            if existing_rates is not None and (
                existing_rates.source_as_of != rates.source_as_of
                or existing_rates.points != rates.points
            ):
                raise ValueError("Refusing to replace a different historical/demo input set")
            await InputRatesRepository.replace_current(
                connection, rates, loaded_at=datetime.now(UTC)
            )
            for parameters in (
                ScenarioParameters(mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3)),
                ScenarioParameters(
                    mode="custom", p=Decimal(2 + offset), k=Decimal(3), d=Decimal(4)
                ),
            ):
                # Deduplication is specific to this explicit seed. Ordinary manual POSTs
                # always create independent runs, even for identical input/parameters.
                existing = await connection.fetchval(
                    "SELECT id FROM curve_run WHERE report_date=$1 AND run_origin='manual' "
                    "AND scenario_parameters=$2 AND calculation_spec=$3 "
                    "AND parent_run_id IS NULL "
                    "ORDER BY created_at,id LIMIT 1",
                    report_date,
                    parameters.model_dump(),
                    spec.model_dump(),
                )
                run_id = (
                    UUID(str(existing))
                    if existing
                    else await CurveRunsRepository.create_run(
                        connection,
                        report_date=report_date,
                        parameters=parameters,
                        spec=spec,
                        run_origin="manual",
                    )
                )
                ids.append(run_id)
    return ids


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.logging)
    spec = load_specification(settings.calculation.spec_file)
    async with Database.open(settings.database) as database:
        ids = await prepare_history(database, spec)
    print("SYNTHETIC input data. Jobs queued/preserved; normal Worker calculates results.")
    for run_id in ids:
        print(run_id)


def cli() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        asyncio.run(main())
    except Exception:
        parser.exit(1, "Demo seed failed: verify backend-final marker, schema and specification\n")


if __name__ == "__main__":
    cli()
