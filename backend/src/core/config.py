from datetime import time
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AnyHttpUrl, BaseModel, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class DatabaseSettings(BaseModel):
    model_config = {"extra": "forbid", "hide_input_in_errors": True}
    dsn: SecretStr
    min_pool_size: int = Field(default=1, ge=0)
    max_pool_size: int = Field(default=5, gt=0)
    connect_timeout: float = Field(default=10, gt=0, allow_inf_nan=False)
    acquire_timeout: float = Field(default=10, gt=0, allow_inf_nan=False)
    command_timeout: float = Field(default=30, gt=0, allow_inf_nan=False)
    close_timeout: float = Field(default=10, gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def check_pool_bounds(self) -> "DatabaseSettings":
        if self.min_pool_size > self.max_pool_size:
            raise ValueError("min_pool_size must not exceed max_pool_size")
        if not self.dsn.get_secret_value().startswith(("postgresql://", "postgres://")):
            raise ValueError("A PostgreSQL DSN is required")
        if any(
            ord(character) < 32 or ord(character) == 127
            for character in self.dsn.get_secret_value()
        ):
            raise ValueError("Control characters in a PostgreSQL DSN must be percent-encoded")
        return self


class LoggingSettings(BaseModel):
    model_config = {"extra": "forbid"}
    config_file: Path | None = None
    level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"


class AppSettings(BaseModel):
    title: str = "IRRBB curves"
    cors_origins: list[str] = Field(default_factory=list)
    max_request_body_bytes: int = Field(default=16_384, gt=0)


class CalculationSettings(BaseModel):
    spec_file: Path | None = None


class IntegrationSettings(BaseModel):
    fetch_function: str | None = None
    base_function: str | None = None
    stress_function: str | None = None
    stress_http_url: AnyHttpUrl | None = None
    stress_http_version: str | None = Field(default=None, min_length=1, pattern=r"\S")
    stress_http_timeout_seconds: float = Field(default=10, gt=0, allow_inf_nan=False)
    stress_http_max_response_bytes: int = Field(default=8_388_608, gt=0)

    @model_validator(mode="after")
    def stress_transport(self) -> "IntegrationSettings":
        if self.stress_http_url is not None:
            if self.stress_function or self.stress_http_version is None:
                raise ValueError("HTTP stress requires an explicit version and no stress_function")
            if self.stress_http_url.username or self.stress_http_url.password:
                raise ValueError("Stress service URL must not contain credentials")
        elif self.stress_http_version is not None:
            raise ValueError("stress_http_version requires stress_http_url")
        return self


class WorkerSettings(BaseModel):
    poll_seconds: float = Field(gt=0, allow_inf_nan=False)
    lease_seconds: float = Field(gt=0, allow_inf_nan=False)
    heartbeat_seconds: float = Field(gt=0, allow_inf_nan=False)
    stage_timeout_seconds: float = Field(gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def check_heartbeat(self) -> "WorkerSettings":
        if self.heartbeat_seconds * 3 >= self.lease_seconds:
            raise ValueError("lease_seconds must be greater than three heartbeat intervals")
        return self


class LoaderSettings(BaseModel):
    # Compatibility with old environments: false is harmless, true must fail startup.
    enqueue_automatic: bool = False
    max_attempts: int = Field(ge=1)
    backoff_base_seconds: float = Field(gt=0, allow_inf_nan=False)
    backoff_cap_seconds: float = Field(gt=0, allow_inf_nan=False)
    request_timeout_seconds: float = Field(gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def reject_automatic_calculations(self) -> "LoaderSettings":
        if self.enqueue_automatic:
            raise ValueError(
                "LOADER__ENQUEUE_AUTOMATIC=true is no longer supported; "
                "configure AUTOMATION__ENABLED instead"
            )
        return self


class AutomationSettings(BaseModel):
    enabled: bool = False
    run_at: time = time(19, 15)
    lookback_days: int = Field(default=7, ge=1, le=366)

    @model_validator(mode="after")
    def exchange_local_time(self) -> "AutomationSettings":
        if self.run_at.tzinfo is not None:
            raise ValueError("Automation time must be local Europe/Moscow time")
        return self


class Settings(BaseSettings):
    database: DatabaseSettings
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
    app: AppSettings = Field(default_factory=AppSettings)
    calculation: CalculationSettings = Field(default_factory=CalculationSettings)
    integrations: IntegrationSettings = Field(default_factory=IntegrationSettings)
    worker: WorkerSettings | None = None
    loader: LoaderSettings | None = None
    automation: AutomationSettings = Field(default_factory=AutomationSettings)
    model_config = SettingsConfigDict(
        env_nested_delimiter="__",
        env_file=Path(__file__).resolve().parents[2] / ".env",
        env_file_encoding="utf-8",
        extra="forbid",
        hide_input_in_errors=True,
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
