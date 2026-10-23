from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from core.config import Settings
from core.database import Database
from web.dependencies import database_dependency, request_body, settings_dependency
from web.exceptions.http import ApiError
from web.schemas.requests import CreateRunRequest, RecalculationRequest, ReportDate
from web.schemas.responses import (
    AcceptedResponse,
    InputRatesResponse,
    ResultResponse,
    RunListResponse,
    StateResponse,
)
from web.serialization import DecimalJSONResponse
from web.services.curve_runs import RunService

router = APIRouter(prefix="/api/v1", tags=["Curves"])


def service(
    database: Annotated[Database, Depends(database_dependency)],
    settings: Annotated[Settings, Depends(settings_dependency)],
) -> RunService:
    return RunService(database, settings)


Service = Annotated[RunService, Depends(service)]


def body_schema(model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema()
    definitions = schema.pop("$defs", {})

    def inline(value: Any) -> Any:
        if isinstance(value, list):
            return [inline(v) for v in value]
        if not isinstance(value, dict):
            return value
        if "$ref" in value:
            return inline(definitions[value["$ref"].rsplit("/", 1)[1]])
        # Inline union alternatives; discriminator mapping would still reference $defs.
        return {k: inline(v) for k, v in value.items() if k != "discriminator"}

    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": inline(schema)}},
        }
    }


def uuid_path(value: str) -> UUID:
    try:
        return UUID(value)
    except ValueError:
        raise ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid runId",
            [{"field": "runId", "reason": "Expected UUID"}],
        ) from None


def accepted(run_id: UUID) -> DecimalJSONResponse:
    return DecimalJSONResponse.from_model(
        AcceptedResponse,
        AcceptedResponse(run_id=run_id, status="queued"),
        status_code=202,
        headers={"Location": f"/api/v1/curve-runs/{run_id}"},
    )


@router.get("/input-rates", response_model=InputRatesResponse)
async def input_rates(
    service: Service, report_date: Annotated[ReportDate, Query(alias="reportDate")]
) -> DecimalJSONResponse:
    return DecimalJSONResponse.from_model(
        InputRatesResponse, await service.input_rates(report_date)
    )


@router.get("/curve-runs", response_model=RunListResponse)
async def list_runs(
    service: Service, report_date: Annotated[ReportDate, Query(alias="reportDate")]
) -> DecimalJSONResponse:
    return DecimalJSONResponse.from_model(RunListResponse, await service.list_runs(report_date))


@router.post(
    "/curve-runs",
    status_code=202,
    response_model=AcceptedResponse,
    openapi_extra=body_schema(CreateRunRequest),
)
async def create_run(request: Request, service: Service) -> DecimalJSONResponse:
    body = await request_body(request, CreateRunRequest)
    return accepted(await service.create(body.report_date, body.scenario_parameters.effective()))


@router.get("/curve-runs/{runId}", response_model=StateResponse)
async def state(runId: str, service: Service) -> DecimalJSONResponse:
    return DecimalJSONResponse.from_model(StateResponse, await service.state(uuid_path(runId)))


@router.get("/curve-runs/{runId}/result", response_model=ResultResponse)
async def result(runId: str, service: Service) -> DecimalJSONResponse:
    return DecimalJSONResponse.from_model(ResultResponse, await service.result(uuid_path(runId)))


@router.post(
    "/curve-runs/{runId}/recalculations",
    status_code=202,
    response_model=AcceptedResponse,
    openapi_extra=body_schema(RecalculationRequest),
)
async def recalculate(runId: str, request: Request, service: Service) -> DecimalJSONResponse:
    parent = uuid_path(runId)
    body = await request_body(request, RecalculationRequest)
    return accepted(await service.recalculate(parent, body.scenario_parameters.effective()))
