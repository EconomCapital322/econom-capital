import asyncio

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection, make_url
from sqlalchemy.ext.asyncio import create_async_engine

from core.config import get_settings


def migrate(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()


async def online() -> None:
    url = make_url(get_settings().database.dsn.get_secret_value())
    engine = create_async_engine(url.set(drivername="postgresql+asyncpg"), poolclass=pool.NullPool)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(migrate)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    context.configure(dialect_name="postgresql", literal_binds=True, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(online())
