# curves-module

Модуль кривых IRRBB проекта Economic Capital.

- [Backend: PostgreSQL, миграции, репозитории и проверки](backend/README.md)
- [Базовая кривая на Go: расчёт, примеры и формат для yyeart](base/README.md)
- [Stress: Go-сервис расчёта стрессовых кривых](stress/README.md)
- [План реализации backend](docs/backend-implementation-plan.md)
- [Frontend: запуск демонстрационного интерфейса](frontend/README.md)

Backend реализует слой хранения, HTTP API, MOEX Loader и Calculation Worker как
три независимых процесса. Реализовано построение базовой кривой на Go с линейной
интерполяцией и экстраполяцией. MOEX-коннектор и стрессовый адаптер подключаются отдельно.

[Как работают PostgreSQL, пул и Alembic](docs/how-postgres-and-migrations-work.md).
