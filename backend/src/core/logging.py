"""Explicit logging setup shared by future process entry points."""

import json
import logging
import logging.config
import re
import time
from importlib.resources import files
from importlib.resources.abc import Traversable
from pathlib import Path

from core.config import LoggingSettings

# Quotes and spaces are accepted inside credentials by the driver's DSN parser.
# Redact the rest of a DSN-bearing line rather than risk leaving a password suffix.
_DATABASE_URL = re.compile(r"postgres(?:ql)?(?:\+asyncpg)?://[^\r\n]*", re.IGNORECASE)


class RedactingFormatter(logging.Formatter):
    """Remove database URLs from the final message, including exception text."""

    converter = staticmethod(time.gmtime)

    def format(self, record: logging.LogRecord) -> str:
        return _DATABASE_URL.sub("[database URL redacted]", super().format(record))


def configure_logging(settings: LoggingSettings) -> None:
    resource = files("core").joinpath("log-config.json")
    # Editable installs keep the original file at backend/log-config.json.
    config_file = settings.config_file
    source: Path | Traversable
    if config_file is not None:
        source = config_file
    elif resource.is_file():
        source = resource
    else:
        source = Path(__file__).resolve().parents[2] / "log-config.json"
    with source.open(encoding="utf-8") as stream:
        config = json.load(stream)
    config["root"]["level"] = settings.level
    logging.config.dictConfig(config)
