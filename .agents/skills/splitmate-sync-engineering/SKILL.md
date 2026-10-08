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
- src/lib/useGroup.ts
- src/lib/app.tsx

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

---

## 17. Database rules

Use proper foreign keys.

Use unique IDs that are safe across devices.

Do not depend on SQLite integer IDs as globally unique IDs.

Prefer UUID/ULID-style public entity IDs.

Local SQLite may maintain local integer primary keys if useful,
but synchronization identity must be globally unique.

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
- lint passes