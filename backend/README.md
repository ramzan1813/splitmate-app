# EvenUp Backend (FastAPI)

FastAPI implementation of the EvenUp sync server. It supports both **PostgreSQL** (production & Docker) and **SQLite** (local embedded testing & single-node deployment).

It implements the same HTTP API and Postgres schema as the Node relay in [../relay/](../relay/), which is the reference
implementation. It runs at **`https://evenup.ramzankhan.shop`**, the app's default server from version 2.2.0.

## Status

The backend is a partial port of the relay. Already aligned with it:

- errors use the relay's body, `{"error": CODE, "message": text}`, so phones can act on the code (see
  [Error contract](#error-contract));
- hidden groups (`is_display = false`) answer `GROUP_UNAVAILABLE`, deleted or unknown groups `GROUP_NOT_FOUND`;
- bootstrap serves only live members and transactions.

**Still missing before it is safe with several phones writing at once** (found in a side-by-side audit against
the relay):

- push does not lock the group row before checking versions, so two concurrent edits can both be accepted (one is
  lost), and it can deadlock with the relay;
- the idempotency ledger is read outside the mutation's transaction, so a retried mutation can be applied twice;
- refused mutations still commit partial writes;
- deleting a group is a soft delete instead of the relay's erase;
- less validation than the relay (amounts, splits, types), and the creator of an uploaded group is taken from the
  uploader instead of the payload;
- no push notifications or webhooks.

The fix is a one-to-one port of the relay's push path (`relay/src/syncService.ts`), then running the relay's
`tests/server-*.test.ts` against this server. Until then, don't run it and the relay against the same database.

---

## Features

- **Offline-First Synchronization**: Gapless monotonic change logs with client mutation idempotency ledger.
- **Dual Database Engine**: Native asynchronous support for PostgreSQL via `asyncpg` and SQLite via `aiosqlite`.
- **Automatic Migration**: The schema script runs on every startup (`CREATE … IF NOT EXISTS`, `CREATE OR REPLACE VIEW`). On a database that already has the relay's migrations it changes nothing; note that it has no version tracking.
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
| `HOST` | Host interface to bind (the Docker image always binds `0.0.0.0`) | `localhost` |
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

To start the EvenUp backend (it uses the database in `DATABASE_URL`; the compose file has no Postgres service and joins the external `proxy` network used by Nginx Proxy Manager):
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

### Deploying behind Nginx Proxy Manager

This is how `https://evenup.ramzankhan.shop` is set up:

1. Run the container with port `8080` published (`docker compose up -d`).
2. In Nginx Proxy Manager, add a proxy host for the domain:
   - **Scheme** `http`, **Forward port** `8080`.
   - **Forward hostname:** `172.17.0.1`, the Docker host as seen from the proxy container (it works because the
     port is published), or the container name `splitmate-backend` if the proxy runs on the same `proxy` network.
   - Don't use a container IP such as `172.18.0.3`: it changes when the container is recreated, and requests to the
     domain then hang.
3. Request a Let's Encrypt certificate on the SSL tab and turn on **Force SSL**. Release APKs only connect over
   `https://`.
4. Check it: `curl https://evenup.ramzankhan.shop/health` should return `{"status":"ok",…}`.

**Never start the backend with a production `DATABASE_URL` by accident:** startup runs the schema script against
that database.

---

## Error contract

Every error response has the relay's shape, which the app depends on:

```json
{ "error": "CURSOR_AHEAD", "message": "Cursor 33 is ahead of server sequence 26; re-bootstrap required" }
```

| Code | Status | What the app does |
|---|---|---|
| `CURSOR_AHEAD` | 409 | The server has less history than the phone: it re-uploads what the server lacks, then replays from 0 |
| `GROUP_NOT_FOUND` | 404 | The group was deleted (or never existed): a phone that synced it before erases its copy |
| `GROUP_UNAVAILABLE` | 404 | The group is hidden (`is_display = false`): the phone keeps its copy |

FastAPI's default `{"detail": …}` body would hide these codes; [app/main.py](app/main.py) converts every
`HTTPException`. Covered by [tests/test_error_contract.py](tests/test_error_contract.py).

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
