FROM golang:1.27-bookworm AS base-builder

WORKDIR /build/base
COPY base/go.mod ./
COPY base/cmd ./cmd
COPY base/curve.go ./curve.go
RUN CGO_ENABLED=0 go build -trimpath -o /out/base-curve ./cmd/base-curve


FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /uvx /usr/local/bin/
COPY --from=base-builder /out/base-curve /usr/local/bin/base-curve

ENV UV_PROJECT_ENVIRONMENT=/opt/venv
ENV PATH="/opt/venv/bin:/usr/local/bin:${PATH}"

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY backend/alembic.ini backend/log-config.json ./
COPY backend/examples ./examples

RUN uv sync --frozen --no-dev