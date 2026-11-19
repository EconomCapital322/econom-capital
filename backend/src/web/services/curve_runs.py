from datetime import date
from decimal import Decimal
from uuid import UUID

from core.config import Settings
from core.database import Database
from web.exceptions.curve_run import (
    ImplementationUnavailable,
    InputDataNotReady,
    RunNotFound,
    RunStateConflict,
)
from web.exceptions.http import ApiError
from web.integrations.specification import load_specification
from web.repositories.curve_runs import CurveRunsRepository
from web.repositories.curves import CurvesRepository
from web.repositories.input_rates import InputRatesRepository
from web.repositories.models import CalculationSpec, Curve, RunStatus, ScenarioParameters, StoredRun
from web.schemas.responses import (
    BucketPoint,
    CurveResponse,
    ErrorInfo,
    InputPoint,
    InputRatesResponse,
    ResultResponse,
    RunListItem,
    RunListResponse,
    StateResponse,
    UsedParameters,
)


def required_discount_factor(value: Decimal | None) -> Decimal:
    if value is None:
        raise ValueError("Stored curve point has no discount factor")
    return value


def curve_response(curve: Curve) -> CurveResponse:
    return CurveResponse(
        curve_code=curve.curve_code,
        points=[
            BucketPoint(
                bucket_label=p.bucket_label,
                tenor_years=p.tenor_years,
                rate_percent=p.rate_percent,
                discount_factor=required_discount_factor(p.discount_factor),
            )
            for p in curve.points
        ],
    )


def used_parameters(parameters: ScenarioParameters) -> UsedParameters:
    return UsedParameters(mode=parameters.mode, p=parameters.p, k=parameters.k, d=parameters.d)


def build_result(run: StoredRun, curves: tuple[Curve, ...]) -> ResultResponse:
    if len(curves) != 7 or run.completed_at is None:
        raise RuntimeError("Incomplete stored ready result")
    return ResultResponse(
        run_id=run.id,
        run_origin=run.run_origin,
        data_provenance=run.calculation_spec.data_provenance,
        report_date=run.report_date,
        source=run.source,
        completed_at=run.completed_at,
        used_parameters=used_parameters(run.scenario_parameters),
        curves=[curve_response(c) for c in curves],
    )


class RunService:
    def __init__(self, database: Database, settings: Settings) -> None:
        self.database, self.settings = database, settings

    async def input_rates(self, report_date: date) -> InputRatesResponse:
        async with self.database.connection() as connection:
            rates = await InputRatesRepository.read_current(connection, report_date)
            synthetic = await connection.fetchval(
                "SELECT current_setting('irrbb.demo_instance',true) "
                "IN ('synthetic','backend-final')"
            )
        response = InputRatesResponse(
            report_date=report_date,
            source="moex",
            available=rates is not None,
            source_as_of=rates.source_as_of if rates else None,
            loaded_at=rates.loaded_at if rates else None,
            points=[
                InputPoint(tenor_years=p.tenor_years, rate_percent=p.rate_percent)
                for p in rates.points
            ]
            if rates
            else [],
        )

        if synthetic:
            response.data_provenance = "synthetic"
        return response

    def calculation_spec(self) -> CalculationSpec:
        try:
            return load_specification(self.settings.calculation.spec_file)
        except ImplementationUnavailable as exc:
            raise ApiError(503, "SERVICE_UNAVAILABLE", str(exc)) from None

    async def create(
        self, report_date: date, parameters: ScenarioParameters
    ) -> tuple[UUID, RunStatus]:
        # Absence has priority over a missing specification; no speculative run is saved.
        async with self.database.connection() as connection:
            if await InputRatesRepository.read_current(connection, report_date) is None:
                raise ApiError(
                    409, "INPUT_DATA_NOT_READY", "No validated input rates for this date"
                )
        spec = self.calculation_spec()
        try:
            async with self.database.transaction() as connection:
                run_id = await CurveRunsRepository.create_run(
                    connection,
                    report_date=report_date,
                    parameters=parameters,
                    spec=spec,
                    run_origin="automatic" if parameters.mode == "standard" else "manual",
                )
                run = await CurveRunsRepository.get_run(connection, run_id)
                if run is None:
                    raise RuntimeError("Accepted calculation run was not found")
                return run_id, run.status
        except InputDataNotReady:
            raise ApiError(
                409, "INPUT_DATA_NOT_READY", "No validated input rates for this date"
            ) from None

    async def _read_state(self, run_id: UUID) -> tuple[StoredRun, tuple[Curve, ...]]:
        async with self.database.connection() as connection:
            saved = await CurvesRepository.read_state(connection, run_id)
        if saved is None:
            raise ApiError(404, "RUN_NOT_FOUND", "Calculation run was not found")
        return saved

    async def state(self, run_id: UUID) -> StateResponse:
        run, curves = await self._read_state(run_id)
        response = StateResponse(
            run_id=run.id,
            run_origin=run.run_origin,
            data_provenance=run.calculation_spec.data_provenance,
            report_date=run.report_date,
            status=run.status,
            stage=run.stage,
            used_parameters=used_parameters(run.scenario_parameters),
        )
        if run.stage == "stress":
            base = next(c for c in curves if c.curve_code == "base")
            response.base_curve = curve_response(base)
        if run.error is not None:
            response.error = ErrorInfo.model_validate(
                run.error.model_dump(by_alias=True, exclude_none=True)
            )
        return response

    async def result(self, run_id: UUID) -> ResultResponse:
        run, curves = await self._read_state(run_id)
        if run.status == "failed":
            if run.error is None:
                raise RuntimeError("Stored failed run has no error")
            raise ApiError(409, "", "", saved_error=run.error)
        if run.status != "ready":
            raise ApiError(409, "RESULT_NOT_READY", "Full calculation result is not ready")
        return build_result(run, curves)

    async def standard_result(self, report_date: date) -> ResultResponse:
        async with self.database.connection() as connection:
            saved = await CurvesRepository.read_standard_result(connection, report_date)
        if saved is None:
            raise ApiError(
                404, "STANDARD_RESULT_NOT_FOUND", "No ready standard calculation for this date"
            )
        return build_result(*saved)

    async def list_runs(self, report_date: date) -> RunListResponse:
        async with self.database.connection() as connection:
            runs = await CurveRunsRepository.list_runs(connection, report_date)
        return RunListResponse(
            report_date=report_date,
            runs=[
                RunListItem(
                    run_id=run.id,
                    run_origin=run.run_origin,
                    data_provenance=run.calculation_spec.data_provenance,
                    created_at=run.created_at,
                    status=run.status,
                    stage=run.stage,
                    used_parameters=used_parameters(run.scenario_parameters),
                )
                for run in runs
            ],
        )

    async def recalculate(self, parent_id: UUID, parameters: ScenarioParameters) -> UUID:
        try:
            async with self.database.transaction() as connection:
                return await CurveRunsRepository.recalculate(
                    connection, parent_id=parent_id, parameters=parameters
                )
        except RunNotFound:
            raise ApiError(404, "RUN_NOT_FOUND", "Calculation run was not found") from None
        except RunStateConflict:
            raise ApiError(409, "RUN_STATE_CONFLICT", "Cannot recalculate this run") from None
