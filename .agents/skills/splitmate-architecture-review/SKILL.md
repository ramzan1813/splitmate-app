---
name: splitmate-architecture-review
description: >
  Reviews SplitMate architecture before implementing major changes,
  especially synchronization, backend APIs, SQLite, permissions,
  concurrency, realtime behavior, and offline-first workflows.
---

# SplitMate Architecture Review

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