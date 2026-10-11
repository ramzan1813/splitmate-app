---
name: splitmate-sync-debugger
description: >
  Diagnoses SplitMate synchronization failures using logs, database
  state, sync cursors, outbox records, server change sequences,
  realtime events, and reproducible multi-device scenarios.
---

# SplitMate Sync Debugger

> The app is now called **EvenUp** (formerly SplitMate). Load `evenup-senior-dev` first for project context; for any
> fix also follow `evenup-safe-change`, and verify with `evenup-ui-testing` before reporting done.

Never randomly modify code to fix a synchronization bug.

First establish:

device
group
user
entity
local version
server version
last server sequence
outbox state
network state
realtime state

For every failure answer:

1. What did the user do?
2. What was written to local SQLite?
3. What entered the outbox?
4. What request reached the server?
5. What did the server accept?
6. What change-log sequence was generated?
7. What realtime notification was sent?
8. What did the receiving device pull?
9. What did SQLite apply?
10. Where did the expected state diverge?

Prefer reproducing the bug with a deterministic test.

Do not change multiple unrelated components simultaneously.

After fixing:

- add a regression test
- run existing tests
- run typecheck
- run lint
- inspect the final diff
## Known failure patterns

Check these first. Each one happened in this codebase.

- Duplicate transactions: on phones, the original plus copies without
  "added by"; on the server, the same title, amount, splits and
  created_ts but a different author.
  - Cause: v2.1.0 imports saved rows with uid '' (see
    splitmate-sync-engineering section 25). Lookups by uid never found
    them, so re-syncs uploaded them again and every echoed change
    inserted another local copy.
  - Phone repair: local migration 10.
  - Server repair: `cd relay && npm run dedupe` (dry run), then
    `-- --apply`. It deletes through /sync/push so phones get
    tombstones.
  - Never `DELETE FROM transactions` on the server: phones never learn
    about it.
  - Quick check on a phone database: rows with `uid = ''`, or the same
    uid twice in one group, mean the phone hasn't been repaired yet.
- A transaction vanishes, or two become one, on some devices only.
  Cause: some code matched rows by title/amount/date instead of uid
  (a dedup on screen open, or a merge on pull). Grep for look-alike
  matching outside queueMissingUploads.
- A group's sync is stuck on the same change every cycle. Cause:
  applyServerChange threw on a legacy or partial payload (e.g. a
  title-only update writing NULL into NOT NULL amount). The pull
  rolls back and the cursor never advances.
- Duplicate local rows with the same uid. Cause: a pull applied
  changes before ensureUploaded linked freshly imported rows. The
  pull now stops while the upload marker is missing.
- "Import failed: Error finalizing statement" (web): a SQLite
  constraint error, e.g. NULL into transactions.author_id from an old
  export without authors.
- A test or web run wrote to production: EXPO_PUBLIC_SERVER_URL was
  unset, or its override was removed from src/lib/identity.ts.
- Endless `GET /sync/changes/<group>?after=N` → 409 after the server's
  database was replaced or reset. The phone's cursor is beyond the
  server's last_sequence.
  - Fixed 2026-10-10 in two places:
    - Python errors now use the relay's {error,message} body, so the
      phone sees CURSOR_AHEAD, not HTTP_409.
    - The phone's CURSOR_AHEAD handler calls resetSyncBinding, so the
      next cycle re-uploads what the server lost before replaying.
  - If it comes back, check:
    - the response body has a top-level "error"
    - the phone's sync_state cursor dropped to 0 and the sync.uploaded
      marker was cleared
- Before pointing any server at an empty or new database, remember
  that phones with history get GROUP_NOT_FOUND for every group and
  erase their local copies. Only use such a server with test devices
  whose data you can lose.

## Investigating production

- Production is the relay on Neon. backend/.env holds its URL;
  relay/.dev.vars holds the dev database.
- Never start a server with backend/.env: its startup runs schema DDL
  against production.
- Query production only inside an explicit read-only transaction
  (asyncpg `conn.transaction(readonly=True)`, then check
  `SHOW transaction_read_only`). Use a throwaway script in the
  scratchpad that loads app.config.settings, so the URL is never
  printed.
- Return aggregates only: counts, value domains, jsonb_object_keys of
  payloads. Never print names, titles or notes. Copying production
  rows to another machine is not allowed.
- Useful aggregates:
  - groups whose last_sequence differs from max(sequence)
  - sequence gaps
  - live transactions whose splits don't sum to the amount
  - payers or split members that are deleted or belong to another group
  - non-delete change payloads missing title/amount/splits/payer
  - clusters of identical title/amount/date/payer, with and without
    created_ts
- Reproduce what you find against a local Postgres (relay/migrations
  001-005 plus legacy-shaped seed data), then write the regression test
  in tests/server-sync-client.test.ts.
