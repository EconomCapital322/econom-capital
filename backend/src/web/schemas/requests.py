import re
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, WithJsonSchema

from web.repositories.models import Parameter as StoredParameter
from web.repositories.models import ScenarioParameters


def calendar_date(value: Any) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Expected calendar date YYYY-MM-DD")
    return date.fromisoformat(value)


def number_token(value: Any) -> Decimal | int:
    if isinstance(value, bool) or not isinstance(value, (Decimal, int)):
        raise ValueError("Expected a finite JSON number")
    return value


ReportDate = Annotated[date, BeforeValidator(calendar_date)]
Parameter = Annotated[
    StoredParameter,
    BeforeValidator(number_token),
    WithJsonSchema({"type": "number", "exclusiveMinimum": 0, "maximum": 25}),
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=False)


class StandardParameters(RequestModel):
    mode: Literal["standard"]

    def effective(self) -> ScenarioParameters:
        return ScenarioParameters(mode="standard", p=Decimal(4), k=Decimal(5), d=Decimal(3))


class CustomParameters(RequestModel):
    mode: Literal["custom"]
    p: Parameter
    k: Parameter
    d: Parameter

    def effective(self) -> ScenarioParameters:
        return ScenarioParameters(mode="custom", p=self.p, k=self.k, d=self.d)


Parameters = Annotated[StandardParameters | CustomParameters, Field(discriminator="mode")]


class RecalculationRequest(RequestModel):
    scenario_parameters: Parameters = Field(alias="scenarioParameters")


class CreateRunRequest(RecalculationRequest):
    report_date: ReportDate = Field(alias="reportDate")
