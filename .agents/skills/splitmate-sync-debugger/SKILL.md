---
name: splitmate-sync-debugger
description: >
  Diagnoses SplitMate synchronization failures using logs, database
  state, sync cursors, outbox records, server change sequences,
  realtime events, and reproducible multi-device scenarios.
---

# SplitMate Sync Debugger

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