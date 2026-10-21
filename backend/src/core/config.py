from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, SecretStr, model_validator
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
    max_attempts: int = Field(ge=1)
    backoff_base_seconds: float = Field(gt=0, allow_inf_nan=False)
    backoff_cap_seconds: float = Field(gt=0, allow_inf_nan=False)
    request_timeout_seconds: float = Field(gt=0, allow_inf_nan=False)


class Settings(BaseSettings):
    database: DatabaseSettings
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
    app: AppSettings = Field(default_factory=AppSettings)
    calculation: CalculationSettings = Field(default_factory=CalculationSettings)
    integrations: IntegrationSettings = Field(default_factory=IntegrationSettings)
    worker: WorkerSettings | None = None
    loader: LoaderSettings | None = None
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
