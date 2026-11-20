from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal, TypeAlias

import asyncpg
import simplejson

from core.config import DatabaseSettings

DBConnection: TypeAlias = "asyncpg.Connection[Any] | asyncpg.pool.PoolConnectionProxy[Any]"
logger = logging.getLogger(__name__)


class Database:
    """One pool per process; services share acquired connections and transactions."""

    def __init__(self, pool: asyncpg.Pool[Any], settings: DatabaseSettings) -> None:
        self.pool = pool
        self.settings = settings

    @staticmethod
    async def _configure_connection(connection: asyncpg.Connection[Any]) -> None:
        for name in ("json", "jsonb"):
            await connection.set_type_codec(
                name,
                schema="pg_catalog",
                encoder=lambda value: simplejson.dumps(value, use_decimal=True, allow_nan=False),
                decoder=lambda value: simplejson.loads(value, use_decimal=True),
                format="text",
            )

    @classmethod
    @asynccontextmanager
    async def open(cls, settings: DatabaseSettings) -> AsyncIterator[Database]:
        """Own one process pool for the whole context, including exceptional shutdown."""
        pool = await asyncpg.create_pool(
            dsn=settings.dsn.get_secret_value(),
            min_size=settings.min_pool_size,
            max_size=settings.max_pool_size,
            timeout=settings.connect_timeout,
            command_timeout=settings.command_timeout,
            server_settings={"timezone": "UTC", "application_name": "irrbb-curves"},
            init=cls._configure_connection,
        )
        database = cls(pool, settings)
        logger.info("PostgreSQL pool opened")
        try:
            yield database
        finally:
            await database.close()

    async def close(self) -> None:
        try:
            async with asyncio.timeout(self.settings.close_timeout):
                await self.pool.close()
            logger.info("PostgreSQL pool closed")
        except BaseException:
            self.pool.terminate()
            logger.warning("PostgreSQL pool terminated during shutdown")
            raise

    async def identity(self) -> str:
        """A credential-free server endpoint/database identity for local process locks."""
        async with self.connection() as connection:
            row = await connection.fetchrow(
                "SELECT current_database(), "
                "CASE WHEN inet_server_addr() IS NULL THEN "
                "'unix:' || current_setting('unix_socket_directories') "
                "ELSE 'tcp:' || inet_server_addr()::text END, "
                "COALESCE(inet_server_port(), current_setting('port')::integer)"
            )
        if row is None:
            raise RuntimeError("Cannot identify the connected PostgreSQL database")
        return simplejson.dumps(tuple(row))

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[DBConnection]:
        async with self.pool.acquire(timeout=self.settings.acquire_timeout) as connection:
            yield connection

    @asynccontextmanager
    async def transaction(
        self,
        *,
        isolation: Literal["read_committed", "repeatable_read", "serializable"] = "read_committed",
        readonly: bool = False,
    ) -> AsyncIterator[DBConnection]:
        async with (
            self.connection() as connection,
            connection.transaction(isolation=isolation, readonly=readonly),
        ):
            yield connection
