FROM python:3.12-slim-bookworm

COPY --from=golang:1.27-bookworm /usr/local/go /usr/local/go
COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PROJECT_ENVIRONMENT=/opt/venv
ENV PATH="/opt/venv/bin:/usr/local/go/bin:${PATH}"

WORKDIR /app
COPY backend /app/backend
COPY base /app/base
COPY stress /app/stress

RUN cd backend && uv sync --frozen --group dev
