# Critical Engineering Rule

SplitMate is an offline-first synchronized application.

Never solve synchronization bugs by making the UI repeatedly
refetch the entire backend dataset.

Never hide synchronization problems with arbitrary timeouts,
setInterval polling, forced reloads, or optimistic UI-only state.

Every synchronization behavior must have an explicit:

- source of truth
- entity identity
- version
- server sequence
- retry behavior
- conflict behavior
- offline behavior
- recovery behavior

If the architecture does not define these things, stop implementation
and request an architecture decision rather than guessing.

For financial transactions, correctness is more important than
eventual UI appearance.

Never silently discard another user's transaction update.