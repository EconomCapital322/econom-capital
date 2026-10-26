# curves-module

Модуль кривых IRRBB проекта Economic Capital.

- [Backend: PostgreSQL, миграции, репозитории и проверки](backend/README.md)
- [Stress: Go-сервис расчёта стрессовых кривых](stress/README.md)
- [План реализации backend](docs/backend-implementation-plan.md)
- [Frontend: запуск демонстрационного интерфейса](frontend/README.md)

Backend реализует слой хранения, HTTP API, MOEX Loader и Calculation Worker как
три независимых процесса. Реальные функции MOEX и математики подключаются после
получения кода Егора и Славы.

[Как работают PostgreSQL, пул и Alembic](docs/how-postgres-and-migrations-work.md).
