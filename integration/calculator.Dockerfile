FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake make g++ libgtest-dev python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY calculator/ ./
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j2 && ctest --test-dir build --output-on-failure
FROM python:3.12-slim-bookworm
WORKDIR /app/calculator
COPY calculator/cf-normalizer ./cf-normalizer
RUN pip install --no-cache-dir ./cf-normalizer
COPY --from=build /src/build/core/cfcore /usr/local/bin/cfcore
COPY calculator/examples ./examples
COPY calculator/data ./data
ENTRYPOINT ["python", "-m", "normalizer"]
CMD ["--help"]
