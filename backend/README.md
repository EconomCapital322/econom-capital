# Backend модуля кривых IRRBB

Реализованы PostgreSQL/asyncpg/Alembic, классы репозиториев с `@classmethod`, все шесть операций HTTP API, независимые Calculation Worker и MOEX Loader. Построение базовой кривой реализовано: [линейная интерполяция/экстраполяция, подключение и формат для yyeart](BASE_CURVE.md). MOEX-коннектор и адаптер стрессов подключаются отдельно. Тестовые реализации находятся только в `tests/fakes`.

Подробное объяснение PostgreSQL, пула и обеих миграций: [учебный документ](../docs/how-postgres-and-migrations-work.md). Контракт: [api.md](../docs/api.md). Архитектурные решения: [план](../docs/backend-implementation-plan.md).

## Подготовка PostgreSQL и окружения

Из `backend`:

```sh
uv sync --frozen --group dev
docker compose -f compose.test.yaml up -d --wait
docker compose -f compose.test.yaml port postgres-test 5432
cp .env.example .env
```

Укажи в `.env` порт из последней команды:

```dotenv
DATABASE__DSN=postgresql://irrbb_test:local-test-only@127.0.0.1:PORT/irrbb_stage2_test
```

Это выделенная временная PostgreSQL 17, доступная только на 127.0.0.1. Tmpfs очищается при остановке контейнера. Рабочие данные нужно хранить в отдельной PostgreSQL с постоянным хранилищем. Существующие контейнеры и volumes не подключаются.

```sh
uv run alembic upgrade head
uv run alembic current
uv run alembic history
docker compose -f compose.test.yaml exec -T postgres-test psql -U irrbb_test -d irrbb_stage2_test -c '\dt'
docker compose -f compose.test.yaml exec -T postgres-test psql -U irrbb_test -d irrbb_stage2_test -c '\d input_rate'
```

Четыре бизнес-таблицы: curve_run, input_rate, curve, curve_point. alembic_version — служебная. 0001 создаёт схему; 0002 переименовывает ставки в `rate`, сохраняя данные. Оба файла на этапе 3 оставлены неизменными. `downgrade base` удаляет таблицы: проверяется только в новых одноразовых тестовых БД, не запускается на пользовательской БД.

## FastAPI

```sh
uv run uvicorn web.app:create_app --factory --host 127.0.0.1 --port 8000
```

Swagger: http://127.0.0.1:8000/docs. OpenAPI: http://127.0.0.1:8000/openapi.json.

- GET `/api/v1/input-rates?reportDate=2026-07-31`
- POST `/api/v1/curve-runs`
- GET `/api/v1/curve-runs/{runId}`
- GET `/api/v1/curve-runs?reportDate=2026-07-31`
- GET `/api/v1/curve-runs/{runId}/result`
- POST `/api/v1/curve-runs/{runId}/recalculations`

Пустая дата возвращает available=false, POST без исходных ставок — 409. Для POST при наличии ставок нужен `CALCULATION__SPEC_FILE`: JSON с явно согласованными base_version, stress_version, method, day_count и grid из bucket_label/tenor_years. Нет файла/невалиден — 503 без создания запуска. Производственной сетки и версии по умолчанию нет.

Тело стандартного POST:

```json
{"reportDate":"2026-07-31","scenarioParameters":{"mode":"standard"}}
```

202 отдаётся после commit запуска, параметров и независимого снимка. База/стрессы не вычисляются в HTTP. Lifespan через `Database.open(settings.database)` создаёт только HTTP-пул, не запускает Worker/Loader/миграции. Перезапуск FastAPI не меняет очередь.

Результат и список реализованы полностью. Пересчёт создаёт новый queued/stress на снимке и базе родителя, сохраняет новые параметры, не использует текущие MOEX-точки и не меняет родителя.

Ответы явно проверяются Pydantic-схемами перед сериализацией, сохраняя Decimal и отсутствие необязательных полей. Даты проверяются как YYYY-MM-DD, UUID валидируется, неизвестные поля POST запрещены. P/K/D — конечные JSON numbers в (0,25], numeric strings/bool/null запрещены. JSON разбирается с Decimal; ответы содержат JSON numbers без float-конверсии. HTTP-ошибки имеют `{error:{code,message,details,curveCode?}}`. Request ID возвращается в X-Request-ID, журнал содержит метод, путь, статус и длительность. Секреты/traceback в ответ не включаются.

`docs/api.md` содержит исходный контракт и **явно отмеченные** уточнения о транспортных ошибках и восстановлении: queued сохраняются, API не прерывает независимый Worker. Исходный api.md на Desktop не изменён.

## Calculation Worker

```sh
uv run python -m web.processes.calculation_worker --help
uv run python -m web.processes.calculation_worker
```

До запуска явно задай WORKER__POLL_SECONDS, WORKER__LEASE_SECONDS, WORKER__HEARTBEAT_SECONDS, WORKER__STAGE_TIMEOUT_SECONDS. Lease должен быть больше трёх heartbeat-интервалов. Производственных defaults нет. `--once` обрабатывает максимум один технический этап.

Настройки реальных функций:

```dotenv
INTEGRATIONS__BASE_FUNCTION=web.calculations.base_curve:build_base_curve
INTEGRATIONS__STRESS_FUNCTION=your_package.module:build_stress_curves
```

Базовый адаптер доступен в репозитории; необходимо собрать Go-бинарник из `../base` и добавить его в PATH процесса Worker, см. [подключение](BASE_CURVE.md). В спецификации нужны `base_version="linear-v1"` и `method="linear"`. `your_package.module:build_stress_curves` — место для отдельно подключаемого стрессового адаптера. Без настроенной реализации соответствующий этап становится failed с кодом BASE_CURVE_FAILED/CALCULATION_FAILED; фиктивный ready не выдаётся.

Один активный Worker на одном POSIX-хосте. Локальный process lock отклоняет второй экземпляр для того же подключённого адреса/порта сервера и имени БД, даже если отличаются credentials, схема postgres/postgresql или параметры DSN. Для определения ключа пул кратко выдаёт соединение и сразу получает его обратно; файловая блокировка соединение не удерживает. PostgreSQL дополнительно сериализует claim, не позволяет выбрать queued при живом running и использует SKIP LOCKED. Поддержка распределённого множества Worker не заявлена. Каждый claim имеет UUID-токен и lease; heartbeat продлевает только своё действующее владение. Поздние записи отклоняются даже если восстановление ещё не началось.

После SIGKILL running не меняется HTTP-процессом. После истечения lease следующий Worker фиксирует CALCULATION_INTERRUPTED, сохраняя этап, вход и базу. Queued не истекает. Для работающего stage с действующим lease восстановление ничего не меняет.

Вычисления не удерживают DB-connection/транзакцию. Одна синхронная функция выполняется в daemon thread. При timeout сохраняется CALCULATION_TIMEOUT и Worker выходит с ненулевым кодом; дальнейшие задания этот процесс не берёт. Произвольный синхронный поток нельзя безопасно принудительно отменить: завершение процесса и его перезапуск относятся к supervisor. Поток не получает соединений и не может опубликовать поздний результат. При штатном SIGTERM текущий stage помечается interrupted и пул закрывается, включая режим `--once`, без traceback. Внешняя отмена без stop-event не скрывается. Heartbeat и начало этапа получают серверное время после ожидания блокировки строки; истёкшее владение восстановить нельзя.

## MOEX Loader и расписание

```sh
uv run python -m web.processes.moex_loader --help
uv run python -m web.processes.moex_loader --report-date 2026-07-31
```

Требуются LOADER__MAX_ATTEMPTS, LOADER__BACKOFF_BASE_SECONDS, LOADER__BACKOFF_CAP_SECONDS, LOADER__REQUEST_TIMEOUT_SECONDS и реальная INTEGRATIONS__FETCH_FUNCTION. Нет реализации — явная ошибка и exit 1, не имитация MOEX.

Команда обрабатывает одну дату и завершает работу. Временные сетевые ошибки/MarketTemporaryError повторяются не более max_attempts раз, включая первую попытку, с exponential backoff/full jitter/cap. NoMarketData — успешное отсутствие данных без удаления корректного набора. Плохие данные и постоянные ошибки не ретраятся. После исчерпания попыток — exit 1. Exit 2 означает уже запущенную загрузку той же БД/даты на хосте. Ключ определяется по фактическим адресу/порту PostgreSQL и имени БД; credentials и дополнительные параметры DSN его не меняют. Исходные точки публикуются атомарно; сохранённые снимки не меняются. curve_run не создаётся.

Час загрузки и целевую отчётную дату выбирает внешний планировщик. Шаблон cron с явными заполнителями приведён в разделе 14 [учебного документа](../docs/how-postgres-and-migrations-work.md). Никакой cron/timer этой задачей не установлен.

## Контракты коллег

`src/web/integrations/contracts.py` содержит FetchRates, BuildBase и BuildStress. Канонические модели данных — `src/web/repositories/models.py`; они не импортируют PostgreSQL/FastAPI. Егор получает дату и возвращает полный проверенный MarketRates, а для базы принимает tuple RatePoint и CalculationSpec. Слава получает Curve, ScenarioParameters, algorithm_version и возвращает ровно шесть Curve. Все сроки — Decimal в годах, ставки — Decimal в процентах годовых, P/K/D — п.п. Стрессовые коды и сетки проверяются до публикации.

Перед реальным запуском необходимо согласовать сетку/day count, доступные версии алгоритмов, источник/срез, правила ошибок MOEX, точность Decimal и допуск сверки с Excel. Адаптеры проверяют форму, дату и результат; математика базы находится в Go-модуле `../base`, а `src/web/calculations/base_curve.py` связывает его с Worker. Совместимый с Go-стрессами JSON-пример и правила точности описаны в [документации модуля](../base/README.md).

## Проверки и изоляция

```sh
uv run ruff check src migrations tests
uv run ruff format --check src migrations tests
uv run mypy src migrations tests
uv run pytest -q
```

Тесты сами находят выделенный контейнер по compose.test.yaml. Сервер должен иметь маркер irrbb.test_instance=stage2. Каждый тест создаёт новую БД irrbb_test_<uuid> и удаляет только созданную им БД. Без маркера тесты отказываются работать; PostgreSQL не заменяется SQLite и недоступность сервера не маскируется skip.

При необходимости IRRBB_TEST_ADMIN_DSN указывает на тот же выделенный маркированный сервер. Никогда не задавай рабочую базу для тестов. В тестах есть явные синтетические функции и отдельные subprocess проверки Worker/Loader. Они не включаются производственной настройкой по умолчанию.

Проверки этапа 3 включают HTTP/Decimal/OpenAPI/ошибки, base→stress→ready, пересчёт на старом снимке после обновления актуальных ставок, ошибки/timeout, остановку и SIGKILL Worker, второй локальный Worker, перезапуск API при живом Worker, отсутствие соединения во время математики, bounded retry и команду Loader. История этапа 3 — docs/stage-3-verification.md. Отчёт первых исправлений — [docs/backend-fixes-verification.md](../docs/backend-fixes-verification.md). Актуальная повторная проверка субагентами и последующие исправления — [docs/backend-subagent-verification.md](../docs/backend-subagent-verification.md).

Создание/закрытие пула, настройка JSONB, получение соединений и транзакции находятся в классе `Database`. Логирование настраивает точка входа до открытия пула. Репозитории возвращают `StoredRun`, сервисы — модели ответов; пересчёт копирует базу через публичный `CurvesRepository.copy_base`.

Тело POST ограничено `APP__MAX_REQUEST_BODY_BYTES` (по умолчанию 16384 байта). Проверяется фактический размер потока, а не только Content-Length. Превышение — 422 VALIDATION_ERROR; неподдерживаемый HTTP-метод — 405 VALIDATION_ERROR с Allow. Длинное число не вызывает 500, допустимые Decimal не округляются. Проверяются технические границы PostgreSQL NUMERIC/JSONB; непредставимые значения дают 422, не 500. Незначащие конечные нули удаляются точно, независимо от Decimal context; финансовый диапазон P/K/D остаётся (0,25]. CORS и X-Request-ID сохраняются на ответах 500; preflight также получает request ID.

Wheel содержит штатный `core/log-config.json`; при необходимости `LOGGING__CONFIG_FILE` задаёт внешний файл с приоритетом. В checkout стандартный файл остаётся на прежнем месте — `backend/log-config.json`. Применение миграций поддерживается из checkout: отдельно доставляются `alembic.ini` и каталог `migrations`, команды выполняются из backend. Wheel приложения не заменяет поставку этих файлов и не запускает миграции автоматически.

Секреты: .env исключён из Git, DSN скрыт в модели настроек, log-config.json использует RedactingFormatter для PostgreSQL URL, включая traceback. DSN со спецсимволами в пароле редактируется целиком до конца строки, чтобы не оставлять хвост секрета. Управляющие символы в DSN должны быть percent-encoded. В репозитории есть только публичные реквизиты одноразового тестового контейнера.

## Основные файлы этапа 3

```text
src/core/config.py                  # группы настроек без рабочих алгоритмов/default grid
src/core/process_lock.py            # POSIX lock без занятого DB-соединения
src/web/app.py                      # create_app, ошибки, HTTP request ID
src/web/lifespans.py                # только ресурсы HTTP-процесса
src/web/dependencies.py             # Settings/Database/pool из app.state, Decimal body parser
src/web/serialization.py            # точные JSON numbers
src/web/routes/curve_runs.py        # шесть операций
src/web/schemas/requests.py
src/web/schemas/responses.py
src/web/repositories/curve_runs.py  # claim, lease, восстановление, пересчёт
src/web/services/curve_runs.py
src/web/services/calculations.py
src/web/services/loading.py
src/web/integrations/contracts.py
src/web/integrations/adapters.py
src/web/processes/calculation_worker.py
src/web/processes/moex_loader.py
src/web/exceptions/curve_run.py
src/web/exceptions/input_rate.py
src/web/exceptions/http.py
tests/fakes/implementations.py
tests/test_api_worker.py
tests/test_loader.py
```

Существующие репозитории сохраняют @classmethod с явно передаваемым connection. Контекстные методы Database.connection/transaction берут и возвращают соединения. Миграции и четыре бизнес-таблицы на этапе 3 не расширяются.
