---
name: evenup-safe-change
description: >
  Regression-safe protocol for fixing bugs and changing existing EvenUp code. Use for every bug fix, tweak,
  refactor or "small change" — especially when the owner reports a mistake and asks for a fix — so the fix does
  not break something else. Covers reproducing first, finding the blast radius, the smallest correct change,
  tests, data/schema safety, verifying neighbours, reviewing the diff, commits, and what to do when stuck.
---

# Changing EvenUp Without Breaking It

The owner's rule: **fixing one thing must not break another.** Most regressions in this project came from a fix
that was reasonable locally but wrong for the rest of the app. Follow every step; small changes are where
shortcuts happen.

---

## 1. Reproduce before you touch code

- State the bug as: what the user did → what happened → what should happen.
- Reproduce it: a failing test (`tests/…`) for logic/sync/data, `ui-audit.mjs` / `swipe-check.mjs` / a screenshot
  for UI (see `evenup-ui-testing`). If you cannot reproduce it, say so and investigate; don't guess-fix.
- Find the **root cause** (which line, which assumption). A fix that only hides the symptom will return as
  another bug.

## 2. Find the blast radius

Before editing a function, component or style, list everything that depends on it:

```bash
git grep -n "functionOrComponentName" -- src tests relay backend
```

- Shared code changes everywhere at once: `src/components/ui.tsx` (all screens), `src/lib/format.ts` (all money
  and dates), `src/lib/theme.ts`, `src/data/repo.ts`, `src/data/syncEngine.ts`, `src/data/db.ts`, `useGroup.ts`.
  For these, check every caller or make the change opt-in (a new prop with the old default).
- Note the behaviours that must stay the same (the "Never break" list in `evenup-senior-dev`, section 7).
- For sync/data/server/permissions also follow `splitmate-sync-engineering` and, for anything structural,
  `splitmate-architecture-review` first.

## 3. Make the smallest correct change

- Change only what the fix needs. No renames, reformatting, dependency bumps or "while I'm here" refactors in a fix.
  Files use CRLF line endings: keep them (editing tools may silently convert).
- Reuse existing helpers and patterns (UI kit, `swipeTabs.ts`, `money()`, permission helpers) instead of new
  near-duplicates.
- New behaviour on a shared component → add an optional prop that defaults to the current behaviour.
- Never fix sync problems with timeouts, polling, refetching everything, forced reloads or UI-only state (AGENTS.md).
- Never match, merge or delete records by look-alike fields; never let a read path write; never auto-delete
  financial data on the device.
- Schema change → a NEW numbered migration (SQLite in `src/data/db.ts` with `SCHEMA_VERSION` bump; Postgres in
  `relay/migrations/NNN_*.sql`). Never edit an applied migration. New columns nullable or with safe defaults;
  existing rows and old app versions must keep working.
- Don't change the identifiers kept from SplitMate (package, scheme, db file, format id, secrets).

## 4. Prove it

1. The reproducing test now passes; it must fail without your fix (check that once).
2. Full suite: `npm test`, `npm run typecheck`, `npm run lint` (+ backend/relay checks if touched).
3. UI: `ui-audit.mjs` on the screens using what you changed, before vs after; `swipe-check.mjs` if anything near
   tabs or scroll containers changed. Look at the screenshots.
4. Re-test the neighbours: other screens importing the file, other callers of the function, the same feature in
   other permission models (admin / contributor / collaborative).

## 5. Review your own diff

```bash
git status --short
git diff
```

- Only intended files changed? No debug logs, probes, commented-out code, temp files, secrets or `.env` values?
- Does the diff do anything the commit message doesn't say?
- Did a test assertion change? Then the behaviour change must be intended and mentioned.

## 6. Commit and report

- Commit only when asked or when the owner's workflow expects it; never push, tag or release without being asked.
- One concern per commit, conventional message (`fix(member): …`, `feat: …`, `docs: …`), with the why and how it
  was verified; end with the attribution line your environment requires.
- Report to the owner: root cause in one sentence, files changed, tests added, what you ran and saw, what you did
  NOT verify, any decision they must make.

## 7. When you are stuck

- After two failed attempts, stop changing code. Re-read the code path end to end and write down your hypothesis.
- Add temporary logs/probes to confirm the order of events (and remove them all afterwards; grep for them).
- Check environment causes before code causes (see below).
- If the remaining choice is a product or risk decision, ask the owner with the options and your recommendation.

## 8. Known traps in this project (each caused a real bug)

| Trap | What happened | Rule |
|---|---|---|
| "Cleanup" heuristics | A dedup on screen open deleted real look-alike expenses and synced the deletes | uid is the only identity; reads never write |
| Merge on pull by title/amount/date | Two real expenses (different payers) merged into one | never match by look-alike fields |
| Removing `EXPO_PUBLIC_SERVER_URL` support | Every dev/web/test run synced into production | keep the override in `identity.ts` |
| Extra `useEffect` calling refresh | Two sync cycles per screen open, lint error | `useFocusEffect` already refreshes |
| Full-row apply of a partial update | Sync stuck / splits wiped | apply only present fields |
| Import kept original ids | Importer's phone uploaded copies into the original group | import = new group, files have no ids |
| Hiding a row with `is_display=false` | Phones kept it; its delete never reached them | delete through the sync API |
| Python error body `{"detail":…}` | App never saw `CURSOR_AHEAD`; sync looped on 409 | keep `{"error","message"}` |
| Release built without signing secrets | APK couldn't update installed app | CI now refuses; check `SIGNING.md` fingerprint |
| Testing swipes with mouse events | "Swipe broken" false alarm | use touch events (`swipe-check.mjs`) |

Environment traps (Windows machine of the owner):
- Git Bash rewrites arguments starting with `/` into Windows paths: pass `group/3`, or set `MSYS_NO_PATHCONV=1`.
- Start Metro from `C:\…` (PowerShell `Set-Location`), not a lowercase `c:\` cwd.
- Heredocs with quotes break in some shells: write scripts to a file and run them.
- Stopping a background `expo start` can leave node processes on the port: kill the listener on that port.
