---
name: evenup-qa-testing
description: >
  QA engineer playbook for EvenUp using current (2025–2026) industry practice: risk-based test planning, the
  testing trophy, positive / negative / boundary / equivalence testing, input and schema validation testing,
  property-based testing, regression and smoke suites, API contract testing, end-to-end and UI testing, visual
  and accessibility testing, offline-first sync testing (multi-device concurrency, idempotency, conflicts,
  network faults), performance testing (load, stress, spike, soak, breakpoint) with k6, chaos/fault injection,
  mutation testing, security testing (OWASP MASVS / ASVS), flaky-test handling and QA reporting. Use when asked to
  test, QA, write test cases, do regression/negative/stress/load testing, check quality before a release, or
  find what could break. For the screen-level UI procedure and scripts, also load evenup-ui-testing.
---

# EvenUp QA Playbook

QA's job is to **find the failures before users do and prove the important things work**, with evidence. For a
money app the most important things are: no lost, duplicated or wrong amounts, and every phone ending up with
the same data.

Hard limits (from `AGENTS.md`, `rules/evenup-core.md`):
- **Never test against production.** Not the app default server, not the production database, not "just one
  request". Web runs use `EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:9` (offline) or the local stack.
- Load, stress and chaos tests only against local/dev targets (section 9), after confirming the target.
- Never weaken, skip or delete a failing test to get green. A failing test is a finding.

---

## 1. Plan by risk (risk-based testing)

Before writing cases, rank what the change could break: **likelihood × impact**.

| Impact | Areas in EvenUp |
|---|---|
| Critical | split math and balances (`logic.ts`), sync push/pull, outbox, cursors, conflicts, import/export, permissions, migrations, money formatting/parsing |
| High | transaction add/edit/delete screens, settle up, invites/join/QR, backup |
| Medium | charts, insights, reports, settings |
| Low | copy, colors, static screens |

Write a short **test charter** for the task: scope, risks, techniques to use (sections 3–11), environments,
what is out of scope. Test critical areas deepest. Use `git diff --stat` + blast radius (`git grep`) to choose the
regression area.

## 2. Test layers: the testing trophy

Modern JS practice favours many fast integration tests over many tiny mocked unit tests:

| Layer | In EvenUp | Tool (already in repo) |
|---|---|---|
| Static | types, lint | `npm run typecheck`, `npm run lint` |
| Unit | pure logic: splits, balances, parsing, swipe rules | `node:test` via `tsx` (`npm test`) |
| Integration (biggest layer) | repo + SQLite, relay API on PGlite, phone ↔ server sync end to end | `tests/server-*.test.ts`, `tests/server-sync-client.test.ts`; backend `pytest` |
| End to end / UI | real screens in a browser at phone sizes, touch gestures | Playwright scripts in `evenup-ui-testing` |
| Manual on device | camera, share sheet, file picker, real network changes | owner's phone; list what must be checked |

Use the existing runner (`node:test` + `tsx`) and patterns. Don't introduce a new test framework (Jest, Vitest,
Detox…) unless the owner asks; propose it instead.

## 3. Positive, negative and boundary cases

For every input or operation, cover all four families:

| Family | Meaning | EvenUp examples |
|---|---|---|
| **Positive (happy path)** | valid input → correct result | add expense Rs 300 split 3 ways → each owes 100.00 |
| **Negative** | invalid input / forbidden action → rejected cleanly, nothing changed | amount `abc`, `-50`, `0`; empty title; contributor editing another's expense; joining with an expired/invalid invite; server returns 409/500 |
| **Boundary (BVA)** | values at and around limits | 0.01, 0.00, 0.005 (rounding), very large (99,999,999.99), max name length ±1, 1 member, 50 members |
| **Equivalence partitioning** | one representative per class instead of every value | split types: equal / unequal / % / shares; roles: admin / contributor / collaborative member; online / offline |

Plus **edge and special content**: emojis and RTL text in names, `1,500.50` with commas, leading/trailing
spaces, duplicate member names, same expense details entered twice (must stay two expenses: uid is identity),
date at midnight / timezone change, deleted member with history.

For each negative case verify **three things**: the user sees a clear message, no data was written (or it was
rolled back), and sync/outbox state is unchanged.

## 4. Validation testing

- **Input validation:** every form field — type, range, required, format, length, decimal places. UI blocks it AND
  the server rejects it (send the bad request directly to the local relay; the UI is not a security boundary).
- **Schema/contract validation:** API request/response bodies match the documented shape; error bodies are
  `{"error","message"}` (both relay and Python backend, `backend/tests/test_error_contract.py`).
- **Business-rule validation:** splits sum exactly to the amount in integer cents; percentages sum to 100;
  settle-up suggestions zero all balances; permissions match the group's model.
- **Data/migration validation:** after a migration, old rows still load, counts and totals are unchanged, old app
  versions still sync.

## 5. Property-based testing (for money and sync logic)

Instead of a few hand-picked examples, state a rule that must hold for **all** inputs and let a generator try
hundreds of random cases and shrink failures to the smallest example.

Properties worth testing in EvenUp:
- For any amount and any split, shares sum exactly to the amount (no lost or extra cent).
- For any list of transactions, the sum of all balances is 0.
- Applying settle-up suggestions makes every balance 0.
- Applying the same server change twice gives the same state (**idempotency**).
- Any interleaving of offline edits from two phones converges to the same state on both after sync.

Tools: `fast-check` (TypeScript) and `Hypothesis` (Python backend). They are not installed yet: propose adding
them as dev dependencies; don't add silently. Until then, a seeded random loop in a `node:test` case is
acceptable.

## 6. Regression, smoke and sanity

- **Smoke** (minutes, after any build): app opens, create group, add expense, balances show, sync badge sane.
- **Sanity** (after a fix): the fixed behaviour + its direct neighbours.
- **Regression** (before done / before release): full `npm test`, typecheck, lint, backend pytest if touched,
  `ui-audit.mjs` standard set compared to baseline, `swipe-check.mjs` both screens, plus the "Never break" list in
  `evenup-senior-dev` section 7.
- **Every bug fixed gets a regression test** that fails without the fix. That is how the suite grows.

## 7. Offline-first and sync testing (EvenUp's highest risk)

Write these as end-to-end tests in `tests/server-sync-client.test.ts` style (real SyncEngine + relay on PGlite),
not mocks.

| Scenario | Expected |
|---|---|
| Two phones edit the same expense offline, then sync | one wins by version; the other gets a visible conflict; **nothing silently discarded** |
| Phone A deletes, phone B edits the same row | defined conflict behaviour, both phones converge |
| Push succeeds on server but response is lost (retry) | no duplicate transaction (idempotent by uid / mutation id) |
| Network drops mid-pull | cursor does not advance past unapplied changes; next pull resumes |
| App killed with pending outbox | outbox survives restart and pushes later |
| Server restored from older backup (`CURSOR_AHEAD`) | group rebinds; no stuck "Sync error" |
| Member removed / group hidden | `GROUP_UNAVAILABLE`, local data kept, not deleted |
| 3+ phones, random interleavings | all converge to identical balances (pair with section 5) |
| Old app version (2.1.0) + new version on same group | both keep syncing |
| Clock skew between phones | ordering by server sequence, not device time |

## 8. UI, visual and accessibility testing

- Procedure and scripts: `evenup-ui-testing` (layout audit at 320/360/412/768 px, touch swipe checks, state
  matrix). Always compare against a baseline.
- **Visual regression:** compare screenshots before vs after (the audit already saves them). Any pixel change on a
  screen you did not intend to change is a finding.
- **Accessibility (WCAG 2.2 AA):** contrast ≥ 4.5:1 for text, targets ≥ 24×24 CSS px (aim for 48 dp on Android),
  every icon button has `accessibilityLabel`, focus order sensible, text still usable at 200% font scale.
  On web, `@axe-core/playwright` can scan a page automatically (install outside the repo like Playwright).
- **Device matrix to report:** small phone (320–360 wide), standard (412), tablet/web (768+), light and dark
  theme, large font.

## 9. Performance testing (load, stress, spike, soak, breakpoint)

Tool: **Grafana k6** (current standard: scripts in JavaScript, thresholds as pass/fail, runs from CLI or Docker
`grafana/k6`). Locust is the Python alternative. JMeter is legacy; don't start new suites with it.

| Type | Question it answers | Shape |
|---|---|---|
| **Load** | Does it meet targets at expected traffic? | ramp to normal users, hold 10–30 min |
| **Stress** | What breaks first above normal, and does it fail gracefully? | ramp well past normal |
| **Spike** | Survives a sudden burst (e.g. everyone opens the app after a trip)? | jump 0 → high → 0 |
| **Soak / endurance** | Leaks or slow degradation over hours? | moderate load, 1–4 h+ |
| **Breakpoint** | Max capacity before errors/latency exceed limits? | keep increasing until thresholds fail |

Define thresholds before running, e.g. `http_req_failed < 1%`, `p(95) < 500 ms` for push/pull, **zero** data
errors. For EvenUp, also assert **correctness under load**: after the run, the server's transaction count and
balances equal what the virtual users created — no duplicates, no gaps in group sequences.

Targets and safety:
- Allowed target: the local stack (`docker compose up --build` → relay on `http://localhost:8787`). It uses the
  database in `relay/.dev.vars`: confirm that it is the dedicated dev database, not production, before starting.
- That dev database is hosted (Neon): keep runs modest and **ask the owner before heavy stress, spike, soak or
  breakpoint runs** (cost and compute limits).
- Never point k6 at the app's default server or any production URL.
- Client-side performance: long lists (500+ transactions) scroll smoothly; screen opens don't trigger more than
  one sync cycle; on web check INP/LCP with Lighthouse.

## 10. Chaos and fault injection

Test that the app recovers, not just that it works on a good network:
- Server down (the dead `127.0.0.1:9` URL), slow responses, timeouts, 500s, 409 conflicts, malformed JSON.
- Latency, packet loss and dropped connections between phone and relay: **Toxiproxy** (Docker) in front of the
  local relay, or Playwright's network throttling / `page.route` to fail specific requests in UI tests.
- Kill the app/test process between "server accepted" and "client recorded" → retry must not duplicate.
- Expected: no data loss, clear status in the UI, automatic recovery when the fault ends, **no** fixes by polling,
  timeouts or reload (`AGENTS.md`).

## 11. Test quality: mutation testing and flaky tests

- **Mutation testing** (StrykerJS for TS, mutmut for Python) changes the code on purpose (`>` → `>=`, removes a
  line) and checks that a test fails. Surviving mutants in `logic.ts` or sync code = missing assertions. Propose it
  for critical modules; run it on a narrow file set because it is slow.
- **Code coverage** is a hint, not a goal: 100% lines with weak assertions still misses bugs.
- **Flaky tests:** a test that passes and fails without code changes is a bug in the test or a real race. Re-run
  it in a loop to confirm, find the cause (shared state, ordering, timing, real network). Never "fix" by adding
  sleeps or retries; never quarantine silently — tell the owner.

## 12. Security testing

- Follow **OWASP MASVS v2** (mobile) and **OWASP ASVS 5** (server API) as checklists.
- Server: every endpoint enforces auth and group permissions (`tests/server-authorization.test.ts`); one user
  can't read or change another group by changing an id (IDOR/BOLA); invalid tokens rejected; no stack traces in
  error bodies; input size limits.
- App: no secrets in the bundle or logs; invite links can't grant more than member access; deep links
  (`splitmate://`) validate input.
- Supply chain: `npm audit --omit=dev` (and in `relay/`), review new dependencies before adding.
- SAST/secret scanning in CI (e.g. GitHub CodeQL, secret scanning) can be proposed; don't add CI jobs unasked.

## 13. Exploratory testing

After scripted tests, spend a time-boxed session (15–30 min) using the app like a real group on a trip: fast
taps, back button mid-save, rotate, switch apps, go offline mid-edit, enter silly values. Write down what you
did and saw (session notes). This finds the bugs scripts don't.

## 14. Writing test cases and bug reports

Test case: `ID · Title · Preconditions · Steps · Test data · Expected result · Priority · Type
(positive/negative/boundary/…)`. Use Given / When / Then for readability when useful.

Bug report:

```text
Title:     <what is wrong, where>              Severity: critical/high/medium/low
Env:       <web 360x780 / Android 15 phone / test suite>, app version, server (local/dev)
Steps:     1… 2… 3…
Expected:  …
Actual:    …           Evidence: screenshot / log / failing test
Data impact: <none | wrong amount | lost | duplicated | sync stuck>
```

## 15. QA report (end of every QA task)

```text
SCOPE & RISKS:   <what was tested and why>
RESULTS:         <suite: pass/fail counts; audits; scenarios run>
FINDINGS:        <bugs, severity-ordered, with evidence>
NOT TESTED:      <and why, e.g. real camera needs a phone>
RELEASE CALL:    <ready / ready with known issues / not ready> + reason
```
