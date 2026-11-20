# Подключение Go-модуля базовой кривой

Математика реализована в [base](../base/README.md) на Go. Python-функция
`web.calculations.base_curve:build_base_curve` — адаптер существующего контракта
`BuildBase`: передаёт `tuple[RatePoint, ...]` и `CalculationSpec` в Go через JSON
stdin, проверяет выход и возвращает `Curve`. Ставки/сроки передаются десятичными
строками без float. Python не дублирует расчёт.

## Подготовка

Собрать из `base`:

```sh
mkdir -p bin
go build -o bin/base-curve ./cmd/base-curve
```

Из `backend` добавить бинарник в окружение процесса и настроить `.env`:

```sh
export PATH="$PWD/../base/bin:$PATH"
```

```dotenv
INTEGRATIONS__BASE_FUNCTION=web.calculations.base_curve:build_base_curve
CALCULATION__SPEC_FILE=/absolute/path/to/linear-calculation-spec.json
```

Для локальной проверки есть [пример спецификации](../base/examples/linear-calculation-spec.json).
Для рабочего запуска нужны утверждённые сетка/day count и версия стрессового
алгоритма вместо `example-stress-v1`. PostgreSQL/Worker настраиваются по [README](README.md).
MOEX-коннектор и стрессовый адаптер подключаются отдельно.

## Поведение

Calculation Worker вызывает адаптер на сохранённом снимке. Подпроцесс не получает
соединений с БД. Синхронный расчёт выполняется вне транзакции; существующий механизм
claim/lease публикует проверенную кривую и автоматически ставит этап стрессов в очередь.
Адаптер проверяет код `base`, сетку, конечность чисел и признаки происхождения
через существующие модели. Несовпадение сетки не публикуется.

Если бинарник не найден в PATH, возникает `ImplementationUnavailable`, а Worker
сохраняет `BASE_CURVE_FAILED`. Ошибка Go и некорректный результат также приводят
к ошибке базового этапа. Подпроцесс имеет отдельный технический timeout 30 секунд:
`subprocess.run` завершает его при превышении. Действующий timeout Worker задаётся
отдельно; при его срабатывании публикация позднего результата исключена.

Для передачи базы Славе / yyeart используются:

```python
payload = {
    "base": base.model_dump(mode="json"),
    "parameters": parameters.model_dump(mode="json"),
}
```

Полный формат и пример: [base/README.md](../base/README.md),
[stress-request.json](../base/examples/stress-request.json).

## Проверки

```sh
uv sync --frozen --group dev
uv run pytest -q tests/test_base_curve.py tests/test_base_curve_worker.py
uv run ruff check src migrations tests
uv run ruff format --check src migrations tests
uv run mypy src migrations tests
```

Тесты сами собирают временный Go-бинарник, поэтому Go требуется и для этих Python
проверок. Тест расчёта не использует PostgreSQL. Интеграционный тест Worker требует
выделенную тестовую БД из README и проверяет цепочку снимок → Go → хранение → API.
Стрессы в этой проверке синтетические; совместимость реального стрессового handler
проверяется отдельно в Go по общему JSON-примеру.
