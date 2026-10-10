---
name: splitmate-sync-engineering
description: >
  Engineering protocol for SplitMate's offline-first multi-device
  synchronization architecture. Use this skill whenever modifying
  backend APIs, SQLite persistence, synchronization, realtime updates,
  conflict handling, group permissions, transaction mutations, or
  multi-device data consistency.
---

# SplitMate Synchronization Engineering Protocol

## 1. Mission

Build SplitMate as an offline-first mobile application with
multi-device synchronization.

The mobile SQLite database is the local source used by the UI.

The backend is the synchronization authority.

Never replace the local-first architecture with a network-only architecture.

The application must continue to work when the device has no internet.

---

## 2. Existing architecture

This repository is an Expo SDK 57 / React Native application.

Important existing files include:

- src/data/db.ts
- src/data/repo.ts
- src/data/types.ts
- src/data/logic.ts
- src/data/backup.ts
- src/data/syncEngine.ts (push/pull cycle, ensureUploaded, applyServerChange)
- src/data/syncState.ts (cursor, upload marker, resetSyncBinding)
- src/data/outbox.ts
- src/lib/identity.ts (server URL; EXPO_PUBLIC_SERVER_URL override)
- src/lib/useGroup.ts
- src/lib/app.tsx
- relay/src/syncService.ts (the production sync server; see section 24)
- backend/app/sync_service.py (Python port; NOT production-safe yet, see section 24)

Before changing the architecture:

1. Inspect package.json.
2. Inspect the current SQLite schema.
3. Inspect repository/data-layer functions.
4. Inspect existing tests.
5. Identify all callers of affected functions.
6. Do not blindly rewrite working code.

---

## 3. Required architecture

Use:

Mobile UI
    ↓
Local SQLite
    ↓
Sync Engine
    ↓
Backend API
    ↓
PostgreSQL

Realtime notifications may be used to trigger synchronization,
but realtime messages are NOT the authoritative data payload.

The client must be able to recover entirely using the sync cursor.

---

## 4. Synchronization model

Use a change-log based incremental synchronization model.

The backend must maintain an ordered server-side change sequence.

Each change must contain at least:

- changeId
- sequence
- groupId
- entityType
- entityId
- operation
- actorId
- deviceId
- entityVersion
- payload
- createdAt

Operations:

- create
- update
- delete

Deletes must create tombstones/change-log entries.

Never permanently remove a synchronized entity without preserving
enough information for offline clients to learn about the deletion.

---

## 5. Client sync state

Each device must maintain sync state per group.

At minimum:

- deviceId
- groupId
- lastServerSequence
- lastSyncAt
- syncStatus

Possible statuses:

- idle
- syncing
- offline
- error
- conflict

Never download the complete group on every synchronization.

Use:

GET /sync/changes?groupId=<id>&after=<sequence>

and return only changes after the supplied cursor.

---

## 6. Initial group synchronization

When a user joins a group:

1. Authenticate the user.
2. Verify group membership.
3. Download the initial group snapshot.
4. Store the snapshot in SQLite inside a transaction.
5. Store the returned server cursor.
6. Start incremental synchronization.
7. Subscribe to realtime notifications if available.

The bootstrap response must contain a consistent snapshot and
the corresponding cursor.

Never mix a snapshot from one point in time with a cursor from
another point in time.

---

## 7. Offline writes

All user mutations must first update local SQLite.

Create a local outbox record containing:

- operation
- entityType
- entityId
- groupId
- payload
- clientMutationId
- deviceId
- createdAt
- retryCount
- status

Possible statuses:

- pending
- sending
- acknowledged
- failed
- conflict

The UI must remain usable while offline.

---

## 8. Push synchronization

Pending outbox mutations must be sent to the backend.

Use idempotency through clientMutationId.

If the same mutation is transmitted twice, the backend must not
create duplicate transactions.

The server response must identify:

- accepted mutations
- rejected mutations
- conflicts
- resulting server versions
- resulting change sequence

---

## 9. Pull synchronization

After pushing local changes, pull server changes.

Preferred flow:

1. Push pending local mutations.
2. Pull changes after lastServerSequence.
3. Apply changes transactionally to SQLite.
4. Advance the local cursor only after successful application.
5. Notify UI.
6. Continue until caught up.

409 CURSOR_AHEAD means the server has less history than this phone:
its database was restored, replaced or reset, and it may also lack
rows this phone already sent. The client must:

- call resetSyncBinding (cursor 0 and upload marker cleared), not just
  reset the cursor
- let the next cycle run ensureUploaded first: it compares with the
  server's snapshot and uploads what the server lacks
- only then replay the change log from 0

Resetting only the cursor leaves the server permanently missing data
other phones need.

Error codes the client acts on (servers must send {"error","message"}):

- CURSOR_AHEAD: reconcile, re-upload, replay
- GROUP_NOT_FOUND: the group was erased; if this phone has server
  history (cursor > 0), the local copy is erased too
- GROUP_UNAVAILABLE: the group is hidden (is_display=false); keep it

Open risk (needs an architecture decision): a server pointed at an
empty database answers GROUP_NOT_FOUND for every group, and phones
with history erase their local copies. The sync binding is keyed on
the server URL only. A per-database id from the server would let
phones rebind (re-upload) instead of erasing.

If realtime notification is received:

DO NOT assume the notification contains complete state.

Instead:

GET changes after lastServerSequence.

---

## 10. Realtime

Realtime is an optimization, not the synchronization protocol.

A realtime notification should effectively mean:

"New data may be available."

The client then performs incremental synchronization.

This guarantees recovery when:

- the websocket disconnects
- the app is backgrounded
- notifications are missed
- the device sleeps
- the network changes
- the app crashes

---

## 11. Conflict handling

Never silently overwrite financial data.

For update operations use optimistic concurrency.

Client sends:

- entityId
- expectedVersion
- mutation
- clientMutationId

If the server version differs:

return a conflict.

Do not blindly use last-write-wins for financial transactions.

Conflict resolution must be deterministic and tested.

Default policy:

CREATE:
    merge using unique entity IDs.

UPDATE:
    require expected entity version.

DELETE:
    create tombstone.

UPDATE vs DELETE:
    server rejects stale update.

Permission changes:
    server authoritative.

---

## 12. Group permissions

Supported group types:

ADMIN_ONLY
CONTRIBUTOR
COLLABORATIVE

ADMIN_ONLY:

Admin:
    create
    update
    delete

Other members:
    read only

CONTRIBUTOR:

Admin:
    create
    update
    delete

Contributor:
    create
    update/delete own transactions

COLLABORATIVE:

Members:
    create
    update
    delete

Admin:
    full control

All permissions must be enforced on the server.

Client-side permission checks are only for UX.

Never trust client authorization.

Settle up (UX rule, src/data/logic.ts canSettle):

- the admin (group creator) may record any suggested settlement
- other members only the ones they pay or receive
- nobody who cannot add transactions (ADMIN_ONLY members)
- Breakdown stays visible to everyone
- hide every button that records the payment: the row's Settle and the
  breakdown dialog's "Record payment" / "Record direct debt instead"

---

## 13. Audit metadata

Transactions must track:

- createdBy
- createdAt
- updatedBy
- updatedAt
- version

Synchronization changes must track:

- actorId
- deviceId
- operation
- timestamp

Do not infer the actor from the local UI.

The backend must derive actor identity from authentication.

---

## 14. API requirements

Prefer REST APIs such as:

POST   /groups
GET    /groups/:groupId
PATCH  /groups/:groupId

POST   /groups/:groupId/members
GET    /groups/:groupId/members

POST   /groups/:groupId/transactions
GET    /groups/:groupId/transactions
PATCH  /groups/:groupId/transactions/:transactionId
DELETE /groups/:groupId/transactions/:transactionId

GET    /sync/bootstrap/:groupId
GET    /sync/changes/:groupId?after=<sequence>
POST   /sync/push

Do not add APIs without first checking whether an existing API can
support the requirement.

---

## 15. Server efficiency

The application is intended to operate on a free/low-cost backend tier.

Therefore:

- use incremental synchronization
- never poll full datasets
- use cursors
- batch pending mutations
- batch pulled changes
- paginate large histories
- index groupId
- index sequence
- index entityId
- index createdAt
- avoid unnecessary realtime payloads
- avoid sending unchanged records
- use gzip/brotli where available
- debounce local mutation bursts where safe

Do not sacrifice correctness for micro-optimizations.

---

## 16. PATCH behavior

PATCH must be partial and version-aware.

Example:

PATCH /groups/:groupId/transactions/:transactionId

Request:

{
  "expectedVersion": 4,
  "changes": {
    "amount": 2500
  },
  "clientMutationId": "..."
}

Successful response must contain the resulting server version
and synchronization sequence.

The relay applies partial updates field by field (COALESCE) and logs
only the fields it received in sync_changes. Clients must apply a
pulled update the same way:

- a field missing from the payload keeps its local value
- splits are replaced only when the payload carries a non-empty splits array
- the payer is resolved only when paidByMemberUid/paidByName is present
  (never create a placeholder member for a missing payer)
- author_id/author_name never change after creation (CONTRIBUTOR
  permissions depend on them); updates must not overwrite them with the editor

Production already contains a title-only update payload.
See applyServerChange in src/data/syncEngine.ts.

---

## 17. Database rules

Use proper foreign keys.

Use unique IDs that are safe across devices.

Do not depend on SQLite integer IDs as globally unique IDs.

Prefer UUID/ULID-style public entity IDs.

Local SQLite may maintain local integer primary keys if useful,
but synchronization identity must be globally unique.

The entity uid is the ONLY identity of a synchronized record.
Never match, merge, or deduplicate transactions by look-alike fields
(title, amount, date, payer, created time). People really do enter
two "Chai 200" on the same day; production has 13 such clusters,
some with different payers. Local integer ids differ per device, so
any "keep the lowest id" rule makes devices disagree and can delete
both copies.

The single allowed exception is ensureUploaded → queueMissingUploads:
linking rows that have no server identity yet (pre-sync groups, file
imports) to server rows. It must stay one-to-one (claimed set),
payer-aware, and created-time-aware.

---

## 18. Transactional application of changes

When applying a server change:

1. Start SQLite transaction.
2. Validate change.
3. Apply entity mutation.
4. Update entity version.
5. Record synchronization metadata.
6. Advance cursor.
7. Commit.

If any step fails:

ROLLBACK.

Never advance the cursor before the change is safely persisted.

---

## 19. Testing requirements

Before declaring synchronization complete, create automated tests for:

1. New group bootstrap.
2. New user joining existing group.
3. Two online devices.
4. Device going offline.
5. Device reconnecting.
6. Offline transaction creation.
7. Offline transaction update.
8. Offline transaction deletion.
9. Two users creating simultaneously.
10. Two users updating the same transaction.
11. Update/delete conflict.
12. Duplicate mutation delivery.
13. Realtime disconnect.
14. Missed realtime notification.
15. App restart during synchronization.
16. Partial sync failure.
17. Permission rejection.
18. Unauthorized delete.
19. Contributor modifying another user's transaction.
20. Admin-only group restrictions.
21. Look-alike transactions (same title/amount/date) survive viewing,
    pulling and re-syncing on every device.
22. Partial update payloads (e.g. title only) keep amount, payer, splits.
23. Importing any group file (new or old format, with or without ids,
    on a phone that has the group or not) creates a separate group and
    leaves the original group unchanged on every phone and on the server.
24. Legacy server data: NULL created_ts, NULL user_id, NULL
    updated_by_*, legacy change payload shapes, hidden (is_display=false)
    and is_deleted groups.

End-to-end client tests live in tests/server-sync-client.test.ts
(real SyncEngine + HttpSyncTransport against the relay on PGlite).

Use deterministic tests.

Do not declare the feature complete because the happy path works.

---

## 20. Development protocol

For every synchronization task:

PHASE 1:
Inspect existing implementation.

PHASE 2:
Explain the affected architecture.

PHASE 3:
Write/update tests that demonstrate the desired behavior.

PHASE 4:
Implement the smallest coherent change.

PHASE 5:
Run tests.

PHASE 6:
Run TypeScript typecheck.

PHASE 7:
Run Expo lint.

PHASE 8:
Inspect the diff.

PHASE 9:
Check for race conditions.

PHASE 10:
Check offline behavior.

PHASE 11:
Check duplicate/retry behavior.

PHASE 12:
Only then report completion.

Never claim a task is complete if tests, typecheck, or lint fail.

---

## 21. Anti-patterns

Never:

- rewrite the entire app unnecessarily
- remove SQLite
- make UI depend directly on remote API responses
- use full database downloads for routine sync
- silently use last-write-wins for financial records
- trust client-side authorization
- use timestamps as the only conflict mechanism
- delete records without tombstones
- advance sync cursors before successful persistence
- assume realtime delivery is reliable
- create duplicate records after retry
- introduce a dependency without checking Expo SDK compatibility
- invent APIs or database columns without inspecting the repository
- match or merge records by look-alike fields instead of uid (section 17)
- write, delete or enqueue mutations from a read path (e.g. getGroupSummary
  or a screen opening); reads never change data
- run automatic "cleanup" that deletes financial records on the device;
  existing bad data is fixed deliberately, server-side, with tombstones
  every device receives, after the user approves
- apply a pulled update as a full row (section 16)
- let a file import reuse a group, member or transaction uid, or write
  into an existing group; put ids into exported files (section 25)
- pull into a group whose upload marker is missing
- remove the EXPO_PUBLIC_SERVER_URL override; without it every dev, web and
  test run syncs into production
- start any server with backend/.env (it points at the PRODUCTION database)

---

## 22. Expo rules

This project uses Expo SDK 57.

Before changing Expo APIs or adding Expo packages:

1. Inspect package.json.
2. Use the matching Expo SDK documentation.
3. Use Expo-compatible package versions.
4. Run typecheck.
5. Run lint.
6. Run tests.

Do not upgrade Expo as part of an unrelated synchronization task.

---

## 23. Completion criteria

Synchronization is complete only when:

- local-first operation works
- offline writes work
- outbox works
- bootstrap works
- incremental pull works
- incremental push works
- idempotency works
- conflicts are detected
- permissions are server-enforced
- deletes synchronize
- tombstones work
- realtime acceleration works
- missed realtime events recover through cursor sync
- app restart recovery works
- tests pass
- typecheck passes
- lint passes- existing production data still syncs (section 24)

---

## 24. Production and existing-data safety

Facts verified read-only on 2026-10-10. Re-verify before relying on them.

Production topology:

- Server: the Node relay (relay/, Cloudflare Worker, release v2.1.0)
  on Neon Postgres with relay/migrations 001-005 applied
  (tracked in schema_migrations).
- Installed v2.1.0 phones are hard-coded to the relay URL, so any new
  server must stay compatible with them.
- backend/.env points at the PRODUCTION database. The dev database is
  relay/.dev.vars.

Existing production data the code must keep handling:

- transactions.created_ts NULL on old rows (shown as date only)
- group_members.user_id NULL on most rows (linked user is optional)
- transactions.updated_by_* NULL on never-edited rows
- devices.expo_push_token NULL everywhere
- permission_model values are UPPERCASE (ADMIN_ONLY, CONTRIBUTOR,
  COLLABORATIVE)
- most groups have is_display=false (hidden); a few have
  is_deleted=true but still exist
- legacy sync_changes payloads:
  - some transaction payloads lack authorId, authorName, note, txUid,
    updatedTs or createdTs
  - some member payloads lack uid or isMe
  - group deletes carry {groupUid}
  - at least one transaction update carries only {title}
- 9 duplicate transaction pairs (same everything, different author) in
  CONTRIBUTOR groups, created Oct 6-9 by v2.1.0 imports (section 25).
  Clean them up with `cd relay && npm run dedupe` (dry run first, then
  `-- --apply` once the user approves). Never use raw SQL DELETE.

---

## 25. Duplicate transactions from v2.1.0 imports (root cause and repair)

Root cause:

- v2.1.0's importFile inserted transactions with no uid (column
  default '') and no author.
- Sync payloads called those rows tx_<local id> (`t.uid || tx_${id}`),
  but every lookup by uid (`WHERE uid = ?`) missed them.
- When the group was re-synced (server switch or cursor reset), the
  rows were uploaded as new transactions authored by the importer:
  the server duplicates.
- Each server change for tx_<id> that came back was inserted as
  another local copy.
- Phones ended up with the original (author), the imported copy (no
  author) and sometimes a third copy.

Raw SQL deletes on the server never reach phones, because phones only
apply changes from the change log.

Repair:

- Phones: local migration 10 (src/data/db.ts) does four things.
  - Groups with such rows replay their change log from 0. The upload
    marker is kept, so nothing is re-uploaded.
  - Empty uids become tx_<id> / mem_<id>, the ids they were already
    synced under.
  - Rows sharing a uid in a group are merged. The survivor is the
    highest server_version, then the row with an author, then the
    lowest id.
  - It adds `UNIQUE (group_id, uid)` on transactions.
- Server: relay/src/maintenance.ts + relay/scripts/dedupe-transactions.ts.
  - It reads inside a READ ONLY transaction.
  - It removes a copy only when every field matches the kept row,
    including splits and the millisecond created_ts. Look-alikes
    without a created_ts are listed for review and never removed.
  - Deletes go through POST /sync/push as the group creator, with
    deterministic clientMutationIds (`dedupe-<txUid>`), so the cleanup
    is idempotent and every phone receives a tombstone.
  - It keeps the first upload (earliest created_at).
- Test: "phones broken by a v2.1.0 import are repaired …" in
  tests/server-sync-client.test.ts.

Prevention (all in place):

- Import/export rule (src/data/backup.ts): a file import ALWAYS creates
  a new, independent group.
  - It gets a new group uid, new member uids and new transaction uids.
  - It is owned by the importer: creator_id is the importer's identity,
    the file's permission model is kept, and the importer's chosen
    member gets is_me and user_id.
  - It never reads or changes an existing group on this phone, on other
    phones or on the server. Its first sync uploads it as a brand-new
    group.
  - On a name clash it is called "<name> (copy)" (findNameClashes).
  - There is no "update with this file" or "replace everything" option;
    they were removed because they overwrote or erased shared groups.
  - Live sharing is only through invite links (join), never files.
- Exported files carry NO group, member or transaction uids. Group
  "uid" is "" in the file, and parseExport ignores ids in older files.
  This also protects the original group from importers still on
  v2.1.0, which generates a fresh group uid when the file has none.
- Author names and created_ts stay in files as history.
- Every local insert sets a uid.
- Pull refuses to apply while the upload marker is missing.
- The unique index makes any future duplicate-uid insert fail loudly
  instead of silently adding a copy.
- Tests:
  - data.test.ts: "export -> import: the file has no ids …" and
    "import ignores ids in files from older versions"
  - server-sync-client.test.ts: "importing a shared group file on
    another phone creates a separate group and never touches the
    original"

Ordering for a release:

1. Ship the app update (migration 10).
2. Run the server dedupe after it.

The order doesn't affect correctness, because migration 10 replays the
log. Running the dedupe first just means v2.1.0 phones, which can't
match uid '' rows, keep their author-less copy until they update.

Schema-change policy for existing data:

- New columns are added nullable, or NOT NULL with a safe default,
  using ADD COLUMN IF NOT EXISTS in a new numbered migration. Never
  edit an applied migration.
- If a new field is required for new data, enforce it in the UI and in
  server validation for creates, and for edits of that record. Never
  reject reading or syncing an old row because the field is NULL.
- Every reader (server SELECTs, client applyServerChange, writeSnapshot,
  import) must accept the legacy shapes listed above.

Python backend (backend/):

- It is a partial port of the relay and is NOT safe to write to
  production, alone or next to the relay. An audit on 2026-10-10
  reproduced:
  - lost updates and deadlocks: no group FOR UPDATE first, and the
    version is checked before any lock
  - retries applied twice: the idempotency ledger is read outside the
    transaction
  - refused mutations still commit partial writes
  - group delete is soft instead of erase
  - missing validation; amounts are coerced with int()
  - no notifications or webhooks
- Already aligned with the relay (2026-10-10, backend/tests/test_error_contract.py):
  - errors use the relay's {"error","message"} body (main.py handler);
    FastAPI's {"detail":...} hides the codes phones act on
  - find_readable_group: hidden → 404 GROUP_UNAVAILABLE (phones keep
    the group), deleted or unknown → 404 GROUP_NOT_FOUND
  - bootstrap serves only live members and transactions
    (is_deleted=false)
- Its schema script runs on every startup with no version tracking.
  Against relay migrations it is a no-op. On a fresh database it lacks
  device_group_subscriptions, webhook_subscriptions, RLS and the 005
  indexes.
- Before it serves real users, port the relay's push logic one-to-one:
  - group-first FOR UPDATE
  - ledger lookup inside the transaction
  - roll back refused mutations and record the result separately
  - retry on 40P01/40001/23505
  - the relay's validators
  - eraseGroup
  - REPEATABLE READ snapshot for bootstrap
  Then run tests/server-*.test.ts against it over HTTP and add Postgres
  concurrency tests. Two servers writing one database needs an explicit
  architecture decision first.

Working with production:

- Never start a server with backend/.env; startup runs schema DDL.
- Read production only inside an explicit read-only transaction
  (asyncpg: conn.transaction(readonly=True)). Connection-level
  default_transaction_read_only is ignored by the pooler.
- Print schema and aggregate counts only, never personal records or
  credentials. Copying production data off the server is not allowed.
- Reproduce against a local Postgres with relay/migrations applied and
  legacy-shaped seed data, or the dev database.
- Run the web app with EXPO_PUBLIC_SERVER_URL set to the dev relay (or
  http://127.0.0.1:9 for UI-only checks). Without it the web app syncs
  to production.
