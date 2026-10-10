# SplitMate

Offline-first group expense splitting for Android (and the web), with multi-phone sync.

Every phone keeps its own copy of the data in on-device **SQLite** and works fully offline. Edits are queued in an
outbox and synced through the **SplitMate sync server** (Express on Cloudflare Workers + Postgres) whenever the
phone is online.

Built with Expo SDK 57 (React Native 0.86, TypeScript, Expo Router).

## Features

| Area | What you get |
|---|---|
| **Groups & members** | 160+ currencies, invite by QR code or link. You pick which member you are when you create or join a group, and it stays fixed after that. Members can **leave** a group (removed from their phone only; they can rejoin); the admin can **delete** it for everyone. |
| **Expenses & splits** | Split equally, unequally, by percentage or by shares, with live validation. Categories, dates, notes, and who added or last edited each entry. Each entry shows the date and the time it was added; entries on the same day are listed newest first. |
| **Group overview** | Total spending plus a **group balance** (payments − expenses, negative when overspent). Swipe left/right to move between Expenses, Balances, Settle up and Chart. |
| **Payments & settle up** | One-to-one payments and minimal-transfer settle-up suggestions. |
| **Insights & reports** | Spending trends, category and per-person breakdowns, printable/PDF reports and Excel (.xlsx) export, all generated on the phone. |
| **Permissions** | Per group: **Admin only**, **Contributor** (members add and edit their own entries) or **Collaborative** (anyone edits; only the author or admin deletes). Enforced by the server. |
| **Offline-first sync** | Writes go to SQLite and an outbox first. The app pushes and pulls on launch, on returning to the foreground, when a group opens, on pull-to-refresh and after every edit. Concurrent edits are detected with entity versions; refused changes are kept and shown, never dropped silently. |
| **Sync status** | Each group shows *Synced*, *Syncing*, *N pending*, *Offline*, *Sync error* or *N not synced*; tap it to sync now or resolve refused changes. |
| **Configurable server** | Settings → Server sets the sync server URL, so a phone or the web app can talk to a local development server. |
| **Backup & restore** | JSON backup of every group, validated import. |
| **Privacy** | No accounts, ads or analytics. Optional 4-digit PIN lock (salted hash, lockout). |

## How sync works

```text
phone A ──POST /sync/push──▶ sync server ──▶ Postgres
                                  │ (Expo push / webhooks: "changes available")
phone B ──GET /sync/changes/:group?after=<cursor>──▶ sync server
```

- **Source of truth:** the server. Each phone holds a replica plus an outbox of unsent mutations.
- **Identity & versions:** groups, members and transactions have client-assigned uids and a server version;
  updates send `expectedVersion`, and a stale one is refused as a conflict.
- **Ordering:** each group has a gapless server sequence; a phone stores its cursor and advances it in the same
  SQLite transaction that applies the changes.
- **Retries:** failed pushes stay queued and are retried on the next sync; the server deduplicates by
  `clientMutationId`.
- **Old data:** groups created before the sync engine are uploaded on their first sync.
- **Creation time:** set once by the phone that adds a transaction, stored by the server and sent to every phone,
  so all members see the same time and order. Edits never change it.
- **Leave / delete:** leaving is local only (unsent changes are pushed first). The admin's delete is queued like any
  change; the server then erases every record of the group, and a phone that has synced the group before treats the
  server's `GROUP_NOT_FOUND` as "deleted" and erases its copy too.
- **Hidden rows:** rows marked `is_display = false` in the database are never returned by the server; phones keep
  what they already downloaded.

## Sync Servers & Backends

SplitMate offers two backend deployment options:

1. **Python FastAPI Backend (`backend/`)**:
   - High-performance asynchronous backend with dual support for **PostgreSQL** and **SQLite**.
   - Includes standalone [Dockerfile](backend/Dockerfile), [docker-compose.yml](backend/docker-compose.yml), and `.env` support.
   - Comprehensive documentation and quickstart in [backend/README.md](backend/README.md).
   - Database ERD and schema specification in [DATABASE_README.md](DATABASE_README.md).

2. **Cloudflare Worker Relay (`relay/`)**:
   - Edge server on Cloudflare Workers, backed by Postgres.
   - Endpoints, conflict handling, and webhook contracts in [relay/README.md](relay/README.md).

Engineering rules for sync changes are in [AGENTS.md](AGENTS.md).

## Run it locally

Requires Node.js 22.13+.

```bash
npm install
npm install --prefix relay   # server packages; the test suite starts the server in-process
npm test                     # unit, server and client-sync tests (in-memory SQLite + PGlite)
npm run typecheck
npm run lint
npm start                    # Expo dev server (press "w" for web)
```

After `npm install` adds or removes packages, restart the dev server with `npx expo start -c`; a running
Metro can keep a stale module map and fail with "Unable to resolve module".

To run the app against a local sync server instead of production, start the Python backend (`cd backend && uvicorn app.main:app --port 8080`) or Worker relay (`cd relay && npm run dev`), and set **Settings → Server** in the app to `http://localhost:8080` (or `8787` for relay).
Release APKs only allow `https://` servers (`usesCleartextTraffic` is off).

### Docker

**Python Backend + PostgreSQL Stack:**
```bash
cd backend
docker compose up --build -d                              # backend on :8080, postgres on :5432
docker compose down
```

**Worker Relay + Web App Stack:**
```bash
docker compose up --build -d                              # server on :8787, web app on :8081
docker compose --profile migrate run --rm --build migrate # apply database migrations
docker compose down
```

## Database Architecture & ERD

A dedicated, comprehensive database specification and ERD diagram is documented in [DATABASE_README.md](DATABASE_README.md). It outlines table columns, foreign key constraints, monotonic sequence generation, idempotency ledgers, and cascading `is_display` visibility views.

## Building the Android APK

**GitHub Actions** ([build-apk.yml](.github/workflows/build-apk.yml)) builds a signed release APK when you:

- push a commit whose message contains `[build]`, `[apk]` or `build:` → APK as a workflow artifact;
- push a commit containing `[release]` or `release:`, push a `v*` tag, or run the workflow by hand → APK attached
  to the GitHub Release `v<version>`, with notes taken from the
  matching `## <version>` section of [CHANGELOG.md](CHANGELOG.md).

The version comes from `app.json` (`version`, `android.versionCode`). Signing secrets are described in
[SIGNING.md](SIGNING.md).

**EAS Build:** `npx eas-cli@latest login`, then `npm run build:apk`.

## Project structure

```text
splitmate-app/
├── app.json, eas.json            # Expo app config and EAS build profiles
├── plugins/withReleaseSigning.js # injects the release keystore into the generated Android project
├── DATABASE_README.md            # Database schema, ERD diagram, and constraint specifications
├── backend/                      # Python FastAPI sync backend (Postgres/SQLite, Docker, Compose)
│   ├── app/                      # FastAPI routers, schemas, services, and db drivers
│   ├── migrations/               # PostgreSQL and SQLite migrations
│   ├── Dockerfile, docker-compose.yml # Containerization and stack definitions
│   └── README.md                 # Backend setup and API guide
├── src/
│   ├── app/                      # screens (Expo Router)
│   ├── components/               # UI kit, charts, calendar, QR code and scanner
│   ├── data/
│   │   ├── db.ts                 # SQLite schema and migrations
│   │   ├── platform.ts           # expo-sqlite adapter (serializes transactions)
│   │   ├── repo.ts               # groups, members, transactions; every write also queues an outbox mutation
│   │   ├── outbox.ts             # outbox queue (pending / sending / failed / conflict)
│   │   ├── syncState.ts          # per-group server cursor, status, upload marker
│   │   ├── syncEngine.ts         # push, pull, backfill, join, conflict resolution
│   │   ├── sync.ts               # change notifications and the local-change signal
│   │   ├── settings.ts           # key/value app settings
│   │   ├── logic.ts, insights.ts # split math, balances, group balance, settle-up, analytics
│   │   └── backup.ts, samples.ts # backup import/export, sample groups
│   └── lib/                      # identity and server URL, PIN, formatting, swipe-tab rules, reports, Excel writer
├── relay/                        # Cloudflare Worker sync server — see relay/README.md
├── tests/                        # node:test suites
├── docker-compose.yml, Dockerfile.web, docker/  # local Worker server + web stack
└── vendor/decode-uri-component/  # linear-time replacement (fixes a DoS advisory), forced via package.json "overrides"
```
