# SplitMate Offline-First Synchronization Relay (Cloudflare Workers + Durable Objects SQLite)

A stateful, server-authoritative synchronization coordinator and real-time notification engine powered by **Cloudflare SQLite Durable Objects** (`state.storage.sql`). It coordinates offline-first transactions, outbox mutations, optimistic concurrency, and monotonic change logs across SplitMate clients.

---

## 🔒 Architecture & Core Principles

- **Offline-First & Local SQLite Authority**: The mobile app reads and writes directly to local SQLite. Network latency or outages never block the user interface.
- **Outbox & Monotonic Server Sequence**: Mutations are stored locally in an `outbox` table and flushed atomically to `POST /sync/push`. The server assigns each accepted mutation a strictly increasing `server_sequence` number in the `sync_changes` log.
- **Optimistic Concurrency & Conflict Detection**: Updates and deletions check `expectedVersion`. If a concurrent change occurred, the server rejects the stale update with `VERSION_MISMATCH` rather than blindly overwriting data.
- **Server-Authoritative Authorization**:
  - **`ADMIN_ONLY`**: Only group admin can modify group settings or add/edit/delete members and transactions.
  - **`CONTRIBUTOR`**: Non-admin members can add expenses and edit/delete their own transactions, but cannot delete or edit other members' transactions.
  - **`COLLABORATIVE`**: Any member can add and edit transactions with audit trails; deletions are restricted to the author or admin.
- **Tombstones & Non-Destructive Soft Deletes**: Deleted records are marked with `is_deleted = 1` and propagated to peers so deletions sync cleanly across all devices.
- **Lightweight Realtime Notifications**: WebSockets (`/ws`) deliver `CHANGES_AVAILABLE` signals containing the latest sequence number. Clients pull delta changes (`GET /sync/changes/:groupId?after=<seq>`) and advance their local cursor.

---

## 🌐 Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` or `/` | `GET` | Service status, health check, and architecture metadata |
| `/sync/bootstrap/:groupId` | `GET` | Initial full group snapshot with current `serverSequence` watermark |
| `/sync/changes/:groupId?after=<seq>` | `GET` | Incremental delta changes strictly after the given sequence cursor |
| `/sync/push` | `POST` | Batch push outbox mutations with idempotency, optimistic concurrency, and permissions |
| `/ws` | `GET (Upgrade)` | WebSocket channel broadcasting realtime `CHANGES_AVAILABLE` notifications |
| `/join` | `GET` | Universal web invite page with direct deep links into the app |

---

## 📂 Source Code Layout (`relay/src/`)

```
relay/
├── wrangler.toml              # Cloudflare Worker config with Durable Object SQLite bindings
├── package.json               # Relay scripts & worker types
├── tsconfig.json              # TypeScript compilation config
└── src/
    ├── index.ts               # Worker router & RelayRoom Durable Object
    ├── api.ts                 # REST API router (/sync/bootstrap, /sync/changes, /sync/push)
    ├── db.ts                  # Cloudflare DO SQLite & In-memory adapter with automatic migrations
    ├── syncService.ts         # Mutation processing, monotonic change logging, idempotency
    ├── permissions.ts         # Server-authoritative permission engine (ADMIN_ONLY, CONTRIBUTOR, COLLABORATIVE)
    ├── realtimeHub.ts         # Pub/Sub lightweight notification broker
    └── types.ts               # Shared server DTOs and type definitions
```

---

## 🚀 Deployment (Cloudflare Workers)

### 1. Change to the Relay directory
```bash
cd relay
```

### 2. Log in to Cloudflare (one-time setup)
```bash
npx wrangler login
```

### 3. Deploy
```bash
npm run deploy
# or: npx wrangler deploy
```

---

## 🛠 Local Development & Testing

```bash
cd relay
npm run dev
# or: npx wrangler dev
```
Runs locally at `http://localhost:8787` with hot-reloading.
