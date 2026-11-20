FROM golang:1.27-bookworm AS builder

WORKDIR /app/stress
COPY stress/go.mod stress/go.sum ./
COPY stress/cmd ./cmd
COPY stress/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /out/stress-service ./cmd/stress-service

FROM alpine:3.24
WORKDIR /app/stress
COPY --from=builder /out/stress-service /app/stress
CMD [ "/app/stress/stress-service" ]