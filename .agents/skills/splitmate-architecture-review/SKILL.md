---
name: splitmate-architecture-review
description: >
  Reviews SplitMate architecture before implementing major changes,
  especially synchronization, backend APIs, SQLite, permissions,
  concurrency, realtime behavior, and offline-first workflows.
---

# SplitMate Architecture Review

> The app is now called **EvenUp** (formerly SplitMate). Load `evenup-senior-dev` first for project context; for any
> fix also follow `evenup-safe-change`, and verify with `evenup-ui-testing` before reporting done.

Before modifying synchronization or backend architecture:

1. Inspect the repository.
2. Inspect package.json.
3. Inspect SQLite schema.
4. Inspect data repository functions.
5. Inspect all callers of affected functions.
6. Identify existing behavior that must remain unchanged.
7. Identify the source of truth for each piece of data.
8. Identify offline behavior.
9. Identify retry behavior.
10. Identify concurrency behavior.
11. Identify authorization requirements.
12. Identify migration requirements.
13. Identify tests required.

Produce:

## Current architecture

Describe what currently exists.

## Problem

Describe the actual technical problem.

## Proposed architecture

Describe the smallest architecture that solves it.

## Data flow

Describe:

write → local DB → outbox → server → change log → realtime → peers

and:

offline → reconnect → push → pull → local DB

## Data model

List required tables and important fields.

## API contract

List endpoints, request bodies, response bodies, and errors.

## Conflict strategy

Explicitly describe concurrent create/update/delete behavior.

## Migration plan

Explain how existing offline-only data will be preserved.

## Test plan

List tests before implementation.

Do not write production code during this review unless explicitly requested.

Do not replace working architecture merely because a different
architecture is more fashionable.

## Existing-data and release compatibility

Required before any change that touches the schema, sync payloads, the
server, import/export, or migrations. Production already holds real
financial records; a release that breaks them has no value.

Answer each with evidence. Use read-only aggregate queries against
production and the code; never guess.

1. Old data, new code: which columns are NULL or legacy-shaped in
   production today (see splitmate-sync-engineering section 24)? Does
   every reader accept them: server SELECTs, bootstrap, change feed,
   client applyServerChange, writeSnapshot, import?
2. New data, old clients: installed v2.1.0 phones talk to the relay URL
   and ignore unknown payload keys. Do they still apply new changes
   correctly? Will the server reject anything they send?
3. Migrations: is the change a new numbered, idempotent migration
   (ADD COLUMN IF NOT EXISTS, nullable or safely defaulted)? Does it
   rewrite or delete existing rows? Has it been run against a local
   copy of the production schema first?
4. Required fields: if a new field is required, is it enforced only for
   new records and for edits of that record (UI plus server
   validation), never for reading or syncing old rows?
5. Local device upgrade: does the SQLite migration in src/data/db.ts
   preserve every existing row, outbox entry, cursor and upload marker?
6. Writers: will more than one server write the production database (relay
   and Python backend)? If so, do they use identical locking (group row FOR
   UPDATE first), sequence allocation, idempotency ledger semantics and error
   envelopes? If that isn't proven by concurrent tests, stop and ask for an
   architecture decision.
7. Destructive automation: does anything delete, merge or rewrite financial
   records without an explicit, reviewed user action? Reject it.
8. Test environment isolation: do tests, web runs and E2E point away
   from production (EXPO_PUBLIC_SERVER_URL, tests/.env.test)?

Add to the review output:

## Existing data impact

- per-column NULL and legacy-shape handling
- old-client compatibility
- migration safety
- rollback plan
