from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from core.database import Database
from core.logging import configure_logging


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging(app.state.settings.logging)
    async with Database.open(app.state.settings.database) as database:
        app.state.database = database
        app.state.pool = database.pool
        try:
            yield
        finally:
            del app.state.database
            del app.state.pool
