# SplitMate Sync API (`relay/`)

Express 5 on Cloudflare Workers, backed by Postgres (Neon in production). Clients sync over plain HTTPS.
There are no WebSockets. Other devices learn about changes through **signed webhooks** and
**Expo push notifications**, and then pull deltas with a cursor.

```text
phone ──POST /sync/push──▶ Worker (Express) ──▶ Postgres
                              │  (after commit)
                              ├──▶ Expo push  { CHANGES_AVAILABLE, groupUid, latestSequence } ──▶ other phones
                              └──▶ webhooks   (same event, HMAC-signed)                        ──▶ your services
other phone ──GET /sync/changes/:groupUid?after=<cursor>──▶ Worker
```

## Sync contract

| Concern | Behaviour |
|---|---|
| Source of truth | Postgres. Clients hold replicas plus an outbox. |
| Entity identity | Client-assigned `uid` (group `uid`, `member_uid`, `tx_uid`). Members are also matched by name within a group, because the client references payers and splits by name. |
| Version | `server_version` per entity, +1 per accepted mutation. Updates and deletes must send `expectedVersion`. |
| Server sequence | `groups.last_sequence`, incremented under the group row lock in the same transaction as the `sync_changes` insert. Sequences become visible in commit order, so `after=N` never skips a change. |
| Retry | `clientMutationId` is idempotent. The first outcome (ACCEPTED, CONFLICT or REJECTED) is stored and replayed verbatim. Transient DB errors return **503**; mutations already processed stay committed and replay on retry. |
| Conflict | Stale `expectedVersion` → `CONFLICT / VERSION_MISMATCH` with the current version, and nothing is written. Re-creating an existing uid → `ALREADY_EXISTS`. A second member with the same name → `DUPLICATE_MEMBER_NAME`. |
| Financial validation | Amounts are positive integer cents. Splits are required, and their shares must sum exactly to the amount (`SPLIT_TOTAL_MISMATCH`). Changing an amount requires new splits (`SPLITS_REQUIRED`). A rejected mutation rolls back everything it touched. |
| Offline | Clients keep writing locally and push the outbox when back online. The server never needs a connected client. |
| Recovery | The app pulls from its cursor on launch, on returning to the foreground, when a group opens, on pull-to-refresh and after each local edit. `latestServerSequence` is the last sequence in the page, so paging never skips changes. A cursor ahead of the server → **409 `CURSOR_AHEAD`**; the app then replays the change log from 0. |
| Notifications | Hints only, never data. A target is pending while its `delivered_sequence < last_sequence`. That state commits with the change, so nothing is lost and bursts coalesce. A cron job every minute retries with exponential backoff (30s → 1h). |
| Deletes | Tombstones (`is_deleted = true`), propagated as `delete` changes. |

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | – | Service status |
| `GET /health/db` | – | Database connectivity |
| `GET /sync/bootstrap/:groupUid` | – | Full snapshot plus `serverSequence`, read in one REPEATABLE READ snapshot |
| `GET /sync/changes/:groupUid?after=&limit=` | – | Ordered changes after the cursor (`limit` ≤ 500) |
| `POST /sync/push` | – | `{ groupUid, deviceId, actorId, actorName, mutations[] }` (≤ 200 per call) |
| `POST /devices/register` | – | `{ deviceId, expoPushToken?, groupUids[] }`, which subscribes the device to Expo push |
| `DELETE /devices/:deviceId/push-token` | – | Stop push to a device |
| `POST /groups/:groupUid/webhooks` | admin | `{ url }` (https only). Returns `secret` **once**. |
| `GET /groups/:groupUid/webhooks` | admin | Lists webhooks with their delivery state |
| `DELETE /webhooks/:id` | admin | Removes a webhook |
| `POST /webhooks/:id/reactivate` | admin | Re-enables a webhook disabled after 30 failed attempts |
| `POST /notifications/dispatch` | admin | Runs the dispatcher now (the cron job does this every minute) |
| `GET /join?uid=&name=&cur=` | – | Invite page that opens `splitmate://join?...`; the app then loads the group from `/sync/bootstrap` |

Admin routes need `Authorization: Bearer <ADMIN_API_KEY>`. If the key is not set, they return 503.

### Webhook delivery

```http
POST <your url>
Content-Type: application/json
X-SplitMate-Event: CHANGES_AVAILABLE
X-SplitMate-Delivery: <webhookId>:<sequence>
X-SplitMate-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

{"type":"CHANGES_AVAILABLE","groupUid":"grp_…","latestSequence":42,"timestamp":"…"}
```

Any 2xx counts as delivered. Verify the signature with `verifyWebhookSignature` in
[src/notifications.ts](src/notifications.ts) and reject timestamps older than 5 minutes.
Several deliveries can carry the same `latestSequence`, so treat them as idempotent.

## Setup

### 1. Install dependencies
```bash
cd relay
npm install
```

### 2. Create the schema
Works with any Postgres (Neon, Supabase, local). Use a **direct** or **session-pooled** connection string.
Non-local hosts get `sslmode=verify-full` automatically unless the URL sets `sslmode`
(use `sslmode=disable` for a plaintext Postgres container reached by service name):
```bash
DATABASE_URL="postgresql://<user>:<password>@<host>/<database>" npm run migrate
```
You can also paste [migrations/001_init.sql](migrations/001_init.sql) into your provider's SQL editor.
The migration enables RLS with no policies, so a Supabase-style Data API (anon key) cannot read
these tables. The Worker connects as the table owner and is unaffected.

### 3. Configure the Worker
```bash
# Each command prompts for the value. Pass only the NAME, never "NAME=value".
npx wrangler secret put DATABASE_URL       # Postgres connection string (used when Hyperdrive is not bound)
npx wrangler secret put ADMIN_API_KEY      # long random string
npx wrangler secret put EXPO_ACCESS_TOKEN  # only if Expo push security is enabled
```
Optional: put [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) in front of Postgres to pool
connections (`npx wrangler hyperdrive create splitmate-db --connection-string="..."`), then uncomment the
`[[hyperdrive]]` block in [wrangler.toml](wrangler.toml). The Worker prefers `HYPERDRIVE` when it is bound.

For local dev, put the same keys in `relay/.dev.vars` (git-ignored), then run `npm run dev`.

### 4. Deploy
The Worker is connected to this repository through Cloudflare's Git integration, so Cloudflare builds
and deploys it on push. That does not touch the database: when a change adds a file under
`relay/migrations/`, run `npm run migrate` against the production `DATABASE_URL` before (or right after)
pushing, then check `/health/db`.

Manual deploy from a machine logged in with `wrangler login`:
```bash
npm run migrate   # with DATABASE_URL set
npm run deploy
```
Roll back with `npx wrangler rollback`.

The v2 relay's `RelayRoom` Durable Objects still hold that version's data. [src/legacyRelayRoom.ts](src/legacyRelayRoom.ts)
keeps the class exported so the data is not erased; remove it only together with a deliberate delete-class migration.

### Local Docker stack
From the repo root, with `relay/.dev.vars` filled in:
```bash
docker compose up --build -d                      # server on :8787, web app on :8081
docker compose --profile migrate run --rm --build migrate
docker compose down
```
The server uses whatever database `relay/.dev.vars` points at. Point `DATABASE_URL` at a local
Postgres (e.g. `postgresql://postgres:<pw>@host.docker.internal:5432/splitmate?sslmode=disable`)
rather than production when you test, so test groups don't land in real data.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | `wrangler dev` on http://localhost:8787 |
| `npm run typecheck` | Type-checks src, scripts and the test harness |
| `npm run cf-typegen` | Regenerates `worker-configuration.d.ts` after editing `wrangler.toml` |
| `npm test` (repo root) | Runs every test. Server tests run the real Express app against [PGlite](https://pglite.dev) (in-memory Postgres) using the production migrations. |

## Layout

```text
relay/
├── migrations/001_init.sql   # Postgres schema (source of truth)
├── scripts/migrate.ts        # applies migrations once each (schema_migrations table)
├── src/
│   ├── index.ts              # Worker entry: Express via httpServerHandler + cron dispatcher
│   ├── app.ts                # Express routes, auth, error mapping
│   ├── syncService.ts        # bootstrap / changes / push (versioning, sequencing, idempotency)
│   ├── permissions.ts        # ADMIN_ONLY / CONTRIBUTOR / COLLABORATIVE rules
│   ├── notifications.ts      # webhook signing + Expo push dispatcher with retries
│   ├── db.ts                 # per-request pg connection + transactions
│   ├── joinPage.ts           # invite landing page
│   ├── legacyRelayRoom.ts    # keeps the v2 Durable Object class (and its data) alive
│   └── types.ts              # wire types shared with the app
├── test-support/             # PGlite test server + fake Expo hub (used by the root test suite)
└── Dockerfile                # local wrangler-dev image for docker-compose.yml
```
