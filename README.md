# EvenUp

Offline-first group expense splitting for Android (and the web), with multi-phone sync. Formerly **SplitMate**.

Every phone keeps its own copy of the data in on-device **SQLite** and works fully offline. Edits are queued in an
outbox and synced through the **EvenUp sync server** whenever the phone is online. The default server is
`https://evenup.ramzankhan.shop`, and **Settings → Server URL** can point the app at any other one.

Built with Expo SDK 57 (React Native 0.86, TypeScript, Expo Router). Current version: **2.2.0** (see
[CHANGELOG.md](CHANGELOG.md)).

## Features

| Area | What you get |
|---|---|
| **Groups & members** | 160+ currencies, invite by QR code or link. You pick which member you are when you create or join a group, and it stays fixed after that. Members can **leave** a group (removed from their phone only; they can rejoin); the admin can **delete** it for everyone. |
| **Expenses & splits** | Split equally, unequally, by percentage or by shares, with live validation and **Select all / Unselect all** for equal splits. Categories, dates, notes, and who added or last edited each entry. Each entry shows the date and the time it was added; entries on the same day are listed newest first. |
| **Group overview** | Total spending plus a **group balance** (payments − expenses, negative when overspent). Swipe left/right to move between Expenses, Balances, Settle up and Chart. |
| **Member dashboard** | Per-member totals, category breakdown, who owes whom, and an **Activity & Transactions** list (All / Paid / Shared / Payments) you can also swipe between. |
| **Payments & settle up** | One-to-one payments, direct and simplified (minimal-transfer) settle-up suggestions, and a **Breakdown** of the transactions behind each suggestion. **Settle** appears only on payments you make or receive; the group admin can settle any of them. |
| **Insights & reports** | Spending trends, category and per-person breakdowns, printable/PDF reports and Excel (.xlsx) export, all generated on the phone. |
| **Permissions** | Per group: **Admin only**, **Contributor** (members add and edit their own entries) or **Collaborative** (anyone edits; only the author or admin deletes). Enforced by the server. |
| **Offline-first sync** | Writes go to SQLite and an outbox first. The app pushes and pulls on launch, on returning to the foreground, when a group opens, on pull-to-refresh and after every edit. Concurrent edits are detected with entity versions; refused changes are kept and shown, never dropped silently. |
| **Sync status** | Each group shows *Synced*, *Syncing*, *N pending*, *Offline*, *Sync error* or *N not synced*; tap it to sync now or resolve refused changes. |
| **Configurable server** | Settings → Server URL shows the server in use (default `https://evenup.ramzankhan.shop`). Enter another one to use your own or a development server; *Reset to default* switches back. |
| **Backup & import** | Export one group or a full backup as `*.evenup.json`. **Importing always creates a new, independent group that you own**: it never changes the original group on any phone or the server. To share a live group, use an invite link. |
| **Privacy** | No accounts, ads or analytics. Optional 4-digit PIN lock (salted hash, lockout). |

## How sync works

```text
phone A ──POST /sync/push──▶ sync server ──▶ Postgres
                                  │ (Expo push / webhooks: "changes available")
phone B ──GET /sync/changes/:group?after=<cursor>──▶ sync server
```

- **Source of truth:** the server. Each phone holds a replica plus an outbox of unsent mutations.
- **Identity:** groups, members and transactions have client-assigned uids. **The uid is the only identity of a
  record**: two expenses with the same title, amount and day are separate records, and nothing is ever matched or
  merged by look-alike fields. On the phone a transaction uid is unique per group (`UNIQUE (group_id, uid)`).
- **Versions & conflicts:** every entity has a server version; updates send `expectedVersion`, and a stale one is
  refused as a conflict. Updates may be partial: a phone applies only the fields a change carries, just like the
  server, and a transaction's author never changes after it is created.
- **Ordering:** each group has a gapless server sequence; a phone stores its cursor and advances it in the same
  SQLite transaction that applies the changes.
- **Retries:** failed pushes stay queued and are retried on the next sync; the server deduplicates by
  `clientMutationId`.
- **Old data:** groups created before the sync engine are uploaded on their first sync, linking rows the server
  already has (one-to-one) and uploading only what it lacks.
- **Server lost history:** if the server answers `CURSOR_AHEAD` (its database was restored, replaced or reset), the
  phone resets that group's binding, uploads what the server is missing, then replays the change log from 0.
- **Switching servers:** a phone that starts using another server re-binds every group the same way.
- **Creation time:** set once by the phone that adds a transaction, stored by the server and sent to every phone,
  so all members see the same time and order. Edits never change it.
- **Leave / delete:** leaving is local only (unsent changes are pushed first). The admin's delete is queued like any
  change; the server then erases every record of the group, and a phone that has synced the group before treats the
  server's `GROUP_NOT_FOUND` as "deleted" and erases its copy too.
- **Hidden rows:** rows marked `is_display = false` in the database are never returned by the server (a hidden group
  answers `GROUP_UNAVAILABLE`); phones keep what they already downloaded. To remove a record from every phone,
  delete it through the sync API (a tombstone in the change log); hiding it or deleting it in SQL never reaches phones.
- **Import / export:** files carry no group, member or transaction ids. An import always gets new ids and the
  importer as admin, so a file can never write into the group it came from, even from an older app version.

Engineering rules for sync changes, including the production and existing-data rules, are in [AGENTS.md](AGENTS.md)
and [.agents/skills/](.agents/skills/).

## Sync servers

Both servers implement the same HTTP API (`/sync/bootstrap`, `/sync/changes`, `/sync/push`, `/devices/register`,
`/join`, `/health`) on the same Postgres schema, and answer errors as `{"error": CODE, "message": text}`.

| Server | Where | Status |
|---|---|---|
| **Python FastAPI** ([backend/](backend/)) | Docker behind Nginx at `https://evenup.ramzankhan.shop` (the app's default from 2.2.0) | Partial port of the relay. Not yet safe for concurrent writers; see [backend/README.md](backend/README.md#status). |
| **Node relay** ([relay/](relay/)) | Cloudflare Worker + Neon Postgres at `https://splitmate-relay.rn45819.workers.dev` | The reference implementation and the server of app 2.1.0. Full feature set: push notifications, webhooks, maintenance tools. |

- Database schema and ERD: [DATABASE_README.md](DATABASE_README.md).
- Relay endpoints, conflict codes, webhooks and the duplicate-cleanup tool: [relay/README.md](relay/README.md).

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

**Never test against production by accident.** Without configuration the app syncs with the production server.
For development, build with `EXPO_PUBLIC_SERVER_URL` pointing at a local or development server (the test suite does
this through `tests/.env.test`):

```bash
EXPO_PUBLIC_SERVER_URL=http://localhost:8080 npx expo start --web   # Python backend
EXPO_PUBLIC_SERVER_URL=http://localhost:8787 npx expo start --web   # Worker relay (npm run dev in relay/)
```

You can also change **Settings → Server URL** in a running app. Release APKs only allow `https://` servers
(`usesCleartextTraffic` is off).

### Docker

**Python backend:**

```bash
cd backend
docker compose up --build -d     # backend on :8080; set DATABASE_URL in backend/.env
docker compose down
```

**Worker relay + web app:**

```bash
docker compose up --build -d                              # server on :8787, web app on :8081
docker compose --profile migrate run --rm --build migrate # apply database migrations
docker compose down
```

## Building the Android APK

**GitHub Actions** ([build-apk.yml](.github/workflows/build-apk.yml)) builds a signed release APK named
`EvenUp-<version>.apk` when you:

- push a commit whose message contains `[build]`, `[apk]` or `build:` → APK as a workflow artifact;
- push a commit containing `[release]` or `release:`, push a `v*` tag, or run the workflow by hand → APK attached
  to the GitHub Release `v<version>` (titled `EvenUp <version>`), with notes taken from the matching `## <version>` section
  of [CHANGELOG.md](CHANGELOG.md).

Automatic builds run for `main`, `master` and `feat/**`; for other branches run the workflow by hand.

The version comes from `app.json` (`version`, `android.versionCode`); bump both for every release. Signing secrets are
described in [SIGNING.md](SIGNING.md).

**Kept from SplitMate on purpose:** the Android package `com.splitmate.app`, the iOS bundle id, the `splitmate://`
link scheme, the on-device database file `splitmate.db` and the backup format id. Changing any of them would make
phones install a separate app, lose their local data, or break invite links and old backups.

**EAS Build:** `npx eas-cli@latest login`, then `npm run build:apk`.

## Project structure

```text
splitmate-app/
├── app.json, eas.json            # Expo app config (name EvenUp, version, package) and EAS build profiles
├── plugins/withReleaseSigning.js # injects the release keystore into the generated Android project
├── AGENTS.md, .agents/skills/    # sync engineering rules, production/existing-data safety, review checklists
├── DATABASE_README.md            # server database schema, ERD and constraints
├── backend/                      # Python FastAPI sync server (Postgres/SQLite, Docker, Compose)
├── relay/                        # Node/Express sync server on Cloudflare Workers — see relay/README.md
│   └── scripts/                  # migrate.ts (schema), dedupe-transactions.ts (remove uploaded-twice copies)
├── src/
│   ├── app/                      # screens (Expo Router)
│   ├── components/               # UI kit, charts, calendar, QR code and scanner
│   ├── data/
│   │   ├── db.ts                 # SQLite schema and migrations (10: uid repair + unique uid per group)
│   │   ├── platform.ts           # expo-sqlite adapter (serializes transactions)
│   │   ├── repo.ts               # groups, members, transactions; every write also queues an outbox mutation
│   │   ├── outbox.ts             # outbox queue (pending / sending / failed / conflict)
│   │   ├── syncState.ts          # per-group server cursor, status, upload marker, binding reset
│   │   ├── syncEngine.ts         # push, pull, backfill, join, conflict and lost-history recovery
│   │   ├── sync.ts               # change notifications and the local-change signal
│   │   ├── settings.ts           # key/value app settings
│   │   ├── logic.ts, insights.ts # split math, balances, settle-up and who may settle, analytics
│   │   └── backup.ts, samples.ts # id-free export, import as a new group, sample groups
│   └── lib/                      # identity and server URL, PIN, formatting, swipe-tab rules, reports, Excel writer
├── tests/                        # node:test suites (app, server, end-to-end client sync)
├── docker-compose.yml, Dockerfile.web, docker/  # local Worker server + web stack
└── vendor/decode-uri-component/  # linear-time replacement (fixes a DoS advisory), forced via package.json "overrides"
```
