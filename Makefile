.PHONY: up down logs restart-worker rebuild check check-python check-go check-frontend reset-local-db

up:
	@docker compose up -d --build --wait

restart-worker:
	@docker compose restart worker
	@docker compose up -d --no-deps --wait worker

rebuild:
	@docker compose up -d --build --no-deps --force-recreate --wait stress
	@docker compose up -d --build --no-deps --force-recreate --wait worker

down:
	@docker compose down

logs:
	@docker compose logs -f --tail=100

check: check-python check-go check-frontend

check-python:
	@set -e; \
	trap 'docker compose --profile check stop postgres-test >/dev/null' EXIT; \
	docker compose --profile check build backend-check; \
	docker compose --profile check up -d --wait postgres-test; \
	docker compose --profile check run --rm --no-deps backend-check sh -ec 'cd backend && pytest -q && ruff check src migrations tests && ruff format --check src migrations tests && mypy src migrations tests'

check-go:
	@docker compose --profile check build backend-check
	@docker compose --profile check run --rm --no-deps backend-check sh -ec 'cd base && go test -race ./... && go vet ./... && cd ../stress && go test -race ./... && go vet ./...'

check-frontend:
	@docker compose --profile check build frontend
	docker compose --profile check run --rm --no-deps frontend sh -ec 'npm ci && npm run typecheck && npm run lint && npm run build'

reset-local-db:
	@test "$(CONFIRM)" = "delete-local-data" || { echo 'Run make reset-local-db CONFIRM=delete-local-data to delete local PostgreSQL data.' >&2; exit 1; }
	@docker compose down -v
