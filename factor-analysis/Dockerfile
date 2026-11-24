FROM node:22-bookworm-slim AS node

FROM node AS curves-ui
WORKDIR /app/curves-ui
COPY curves-module/frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY curves-module/frontend/ ./
RUN npm run build:embedded

FROM python:3.12-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ make libgtest-dev \
    && rm -rf /var/lib/apt/lists/*
COPY calculator /app/calculator
RUN cmake -S /app/calculator -B /app/calculator/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /app/calculator/build --target cfcore_cli -j 2

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SPECTRUM_CFCORE=/usr/local/bin/cfcore \
    SPECTRUM_DATA_DIR=/data/runs SPECTRUM_CURVES_DIR=/data/curves \
    SPECTRUM_CURVE_ASSETS=/app/curve-ui
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/calculator/build/core/cfcore /usr/local/bin/cfcore
WORKDIR /app/factor-analysis
COPY factor-analysis/requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY --from=curves-ui /app/curves-ui/dist-spectrum /app/curve-ui
COPY calculator/cf-normalizer/src /app/calculator/cf-normalizer/src
COPY factor-analysis/service ./service
COPY factor-analysis/src ./src
COPY factor-analysis/examples ./examples
COPY factor-analysis/generate.mjs .
EXPOSE 8780
CMD ["python", "-m", "service.server", "--bind", "0.0.0.0", "--port", "8780"]
