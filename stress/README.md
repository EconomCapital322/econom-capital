# Сервис стрессовых кривых

Отдельный Go-модуль вычисляет шесть стрессовых кривых из базовой кривой через HTTP. Точка входа — [`cmd/stress-service`](cmd/stress-service/main.go), расчёт — [`internal/stress`](internal/stress/calculate.go). Модуль требует Go 1.27.0 согласно [`go.mod`](go.mod).

## Запуск

Из корня репозитория:

```sh
cd stress
cp .env.example .env
go run ./cmd/stress-service
```

Сервис слушает `127.0.0.1:8081` по умолчанию. Файл `.env` необязателен; он читается из текущего рабочего каталога, а переменные окружения имеют приоритет. Все настройки и их примерные значения приведены в [`.env.example`](.env.example): `STRESS_HTTP_ADDR`, таймауты HTTP-сервера (`STRESS_READ_HEADER_TIMEOUT`, `STRESS_READ_TIMEOUT`, `STRESS_WRITE_TIMEOUT`, `STRESS_IDLE_TIMEOUT`, `STRESS_SHUTDOWN_TIMEOUT`), `STRESS_LOG_LEVEL` (`DEBUG`, `INFO`, `WARN`, `ERROR`) и `STRESS_LOG_FORMAT` (`text`, `json`). Для таймаутов нужны положительные значения с единицей измерения Go, например `10s`.

## HTTP API

`POST /internal/v1/stress-curves` принимает базовую кривую и параметры сценария:

```sh
curl -sS -X POST http://127.0.0.1:8081/internal/v1/stress-curves \
  -H 'Content-Type: application/json' \
  -d '{
    "base": {
      "curve_code": "base",
      "points": [{
        "bucket_label": "1m",
        "tenor_years": "0.041700",
        "rate_percent": "14.45",
        "is_interpolated": false,
        "is_extrapolated": false
      }]
    },
    "parameters": {"mode": "standard", "p": "4", "k": "5", "d": "3"}
  }'
```

Числовые поля передаются **строками**. `curve_code` базовой кривой должен быть `base`; точки должны иметь непустые уникальные метки и строго возрастающие положительные сроки в годах. Оба флага происхождения точки обязательны и не могут одновременно быть `true`. Для `standard` нужны ровно `p=4`, `k=5`, `d=3`; диапазон для `custom` — `(0, 50]`.

Успешный ответ (`200`) содержит массив `curves` с кодами `parallel_up`, `parallel_down`, `steepener`, `flattener`, `short_rate_up`, `short_rate_down`. У каждой кривой та же сетка точек; `bucket_label`, `tenor_years` и рассчитанный `rate_percent` возвращаются строками. Некорректный JSON даёт `400 INVALID_JSON`, неверный запрос — `422 VALIDATION_ERROR`. Ошибки возвращаются объектом с полями `code`, `message`, `details`.

Расчёт использует `float64`; точность и численный допуск ещё помечены в коде как требующие согласования. Не рассчитывайте на точную десятичную арифметику при сверке результатов.

## Проверка

Из каталога `stress`:

```sh
go test ./...
```
