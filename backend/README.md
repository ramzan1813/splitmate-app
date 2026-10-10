# EvenUp Backend (FastAPI)

FastAPI implementation of the EvenUp sync server. It supports both **PostgreSQL** (production & Docker) and **SQLite** (local embedded testing & single-node deployment).

---

## Features

- **Offline-First Synchronization**: Gapless monotonic change logs with client mutation idempotency ledger.
- **Dual Database Engine**: Native asynchronous support for PostgreSQL via `asyncpg` and SQLite via `aiosqlite`.
- **Automatic Migration**: Migrations run automatically on application startup to ensure tables and views exist.
- **Permissions Enforced**: Strict verification of `ADMIN_ONLY`, `CONTRIBUTOR`, and `COLLABORATIVE` access models.
- **Financial Validation**: Enforces exact cent integrity and splits summation matching the transaction amount.
- **Visibility Cascading (`is_display`)**: Support for soft-hiding users, groups, members, and transactions.

---

## Configuration & Environment Variables

The backend accepts configuration through environment variables or a `.env` file placed in the `backend/` directory or container root.

Copy the template:
```bash
cp .env.example .env
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Connection string (PostgreSQL or SQLite) | `sqlite+aiosqlite:///./splitmate.db` |
| `PORT` | Listening port for FastAPI / Uvicorn | `8080` |
| `HOST` | Host interface to bind | `0.0.0.0` |
| `DEBUG` | Enable verbose debugging logs | `false` |
| `ADMIN_API_KEY` | Secret token for admin-restricted endpoints | `None` |
| `EXPO_ACCESS_TOKEN` | Bearer token for Expo push notification delivery | `None` |
| `CORS_ORIGINS` | Permitted CORS origins | `["*"]` |

### Database URLs

- **SQLite**: `sqlite+aiosqlite:///./splitmate.db`
- **PostgreSQL**: `postgresql://user:password@hostname:5432/dbname`

---

## Running with Docker & Compose

A [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml) are provided in this directory.

### Quick Start with Docker Compose

To start both PostgreSQL and the EvenUp backend:
```bash
docker compose up --build -d
```

The server will be available at:
- **API Documentation (Swagger UI)**: `http://localhost:8080/docs`
- **Health Check**: `http://localhost:8080/health`
- **Database Status**: `http://localhost:8080/health/db`

To stop:
```bash
docker compose down
```

### Building and Running the Docker Image Manually

```bash
# Build
docker build -t splitmate-backend .

# Run with environment file
docker run -d --name splitmate-backend -p 8080:8080 --env-file .env splitmate-backend

# Run with inline environment variables
docker run -d --name splitmate-backend -p 8080:8080 -e DATABASE_URL="sqlite+aiosqlite:///./splitmate.db" splitmate-backend
```

---

## Running Locally without Docker

Requires Python 3.10+.

```bash
# Install dependencies
pip install -r requirements.txt
pip install -r requirements-dev.txt

# Run tests
pytest tests

# Start development server
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

---

## Database Migrations

Migrations are stored in [migrations/](migrations/):
- `001_init_postgres.sql`: PostgreSQL schema, tables, and cascading visibility views.
- `001_init_sqlite.sql`: SQLite schema, tables, and views.

Migrations run automatically whenever the application connects to the database during startup.

For complete ERD and database table specifications, see [DATABASE_README.md](../DATABASE_README.md).
