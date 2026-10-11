---
name: evenup-agent-discipline
description: >
  How the agent must work with the EvenUp owner on EVERY request: understand the request before acting
  (voice-typed, short messages), lock the scope and change ONLY what was asked, never "fix" unrelated things on
  its own, detect and break loops (same error, same file, flip-flopping fixes), stop fix-one-break-another,
  handle corrections without repeating the mistake, and report with evidence. Load it at the start of every
  task, and again whenever the owner repeats themselves, says "that's not what I asked", or you have failed twice.
---

# Working With the Owner: Focus, Scope, No Loops

The owner's main complaints about agents on this project:

1. **Loops.** The agent tries the same fix again and again, or undoes and redoes its own changes.
2. **Fix one thing, break another.**
3. **Not getting the point.** The owner explains, the agent still does something else.
4. **Unrequested changes.** The owner asks for A; the agent also changes B "to improve it".

Each section below prevents one of these. They are not optional for small tasks: small tasks are where they
happen most.

---

## 1. Understand before you act (prevents 3)

The owner often types by voice. Messages contain filler words, repeated phrases, transcription errors
("scale" for "skill", "talk" for "break") and run-on sentences. Read for intent, not literal words.

Before any edit, write a **Request card** in your reply (or task list artifact):

```text
REQUEST (in my words): <one or two sentences>
DONE WHEN:            <observable result the owner can check, e.g. "on the member page, swiping left shows Payments">
IN SCOPE:             <files / screens / behaviours I expect to touch>
OUT OF SCOPE:         <things I will NOT change, even if I notice problems>
ASSUMPTIONS:          <anything I guessed>
```

- If an assumption could change **what** gets built (which screen, which behaviour, which data), ask ONE short
  question with 2–3 concrete options and your recommendation, then wait.
- If it only changes **how** (naming, internal structure), pick the sensible default, state it, and continue.
- Never ask about something you can find out by reading the code.
- A transcription that makes no sense: quote it and offer your best reading ("By 'talk other thing' I think you
  mean 'break another thing' — correct?").

## 2. Scope lock (prevents 4)

The owner asked for exactly what they asked for.

- Change only what the Request card's IN SCOPE needs. No renames, reformatting, restyling, dependency upgrades,
  "cleanups", new abstractions, or copy changes that were not requested.
- Noticed another bug or a better design? **Write it down, don't do it.** List it at the end under "Noticed, not
  changed" with one line each. The owner decides.
- The only exceptions, which you must still name in the report:
  - The requested change cannot work without a small related change (say why).
  - A standard mobile behaviour the owner would obviously expect from the requested feature (see
    `evenup-mobile-ux` section 2), for example making a new tab bar swipeable like the others.
- Before finishing, run `git diff --stat`. Every file must map to the Request card. A file you can't justify →
  revert that part.

## 3. Loop detection and breaking (prevents 1)

You are in a loop if ANY of these is true:

| Signal | Example |
|---|---|
| Same error/test failure after 2 attempts | "TypeError: x is undefined" again |
| Same file/function edited 3+ times for one problem | `expense.tsx` changed, reverted, changed |
| You are undoing your own earlier change | re-adding a line you removed 10 minutes ago |
| Tests flip: fixing A fails B, fixing B fails A | |
| You are about to try "one more small tweak" without new information | |
| The owner has repeated the same request | |

When a signal fires, **STOP editing code** and do this, in order:

1. **Write the state down:** what you tried (each attempt, one line), what happened each time, what you now know.
2. **Re-read** the owner's original request and the full code path end to end (caller → function → data), not just
   the line that errors.
3. **Form one hypothesis** that explains *all* observations, and a way to *test* it without changing behaviour
   (a log, a probe, a focused test, reading the library source/docs).
4. **Run the test of the hypothesis.** Only change code when evidence supports it.
5. Still stuck after that → **ask the owner** with: what you tried, what you learned, 2 options, your
   recommendation. Asking is better than a fourth blind attempt.

Also check environment causes before code causes: wrong cwd (`c:\` vs `C:\`), stale Metro cache, old dev server
still running on the port, wrong `EXPO_PUBLIC_SERVER_URL`, Git Bash path rewriting, missing `npm install`.

Never break a loop by: deleting or skipping the failing test, adding `setTimeout`/retries/polling, wrapping in
`try {} catch {}` and ignoring, `// @ts-ignore`, or forcing a reload. Those hide the problem (see `AGENTS.md`).

## 4. Fix one thing without breaking another (prevents 2)

- **Baseline first:** run `npm test` (and `npm run typecheck`) BEFORE changing anything and note the result. You
  can then prove which failures are yours.
- **Blast radius:** `git grep -n "<symbol>"` for every function/component/style you touch; check every caller.
  Shared files (`ui.tsx`, `format.ts`, `theme.ts`, `repo.ts`, `syncEngine.ts`, `db.ts`) affect the whole app.
- **Smallest change** that fixes the root cause. New behaviour on shared code = opt-in prop with old default.
- **After:** full suite + typecheck + lint + UI check of changed screens AND their neighbours
  (`evenup-ui-testing`). Compare with the baseline.
- Full protocol: `evenup-safe-change`.

## 5. When the owner corrects you

A correction ("no, I meant…", "you changed the wrong thing", "I already told you") is the highest-priority
input in the conversation.

1. Acknowledge in one line, restate the corrected understanding as a new Request card.
2. Undo what was wrong **only if the owner wants it undone** (ask if unclear) — don't silently leave half of a
   rejected change in place.
3. Keep a **"Owner decisions"** list in your task notes for the rest of the session (for example: "Keep the
   Settle button visible only for admin and the two members"). Re-read it before each edit. Never reintroduce
   something the owner rejected.
4. If the same misunderstanding happens twice, explain what you understood both times and ask them to confirm
   with an example of the expected result.

## 6. Long tasks: keep the thread

- Keep a short task checklist (Antigravity task list artifact or a numbered list in replies). Tick items only with
  evidence.
- Before each new step, re-read: the Request card, Owner decisions, and the checklist. Long sessions drift; this
  is how you notice.
- One concern at a time: finish, verify, then start the next. Don't open three half-done fixes in parallel.
- If the conversation is long and you are unsure what is already done, check `git status` / `git diff` instead of
  trusting memory.

## 7. Report with evidence

End every task with:

```text
DONE:          <what now works, in the owner's words>
CHANGED:       <files, one line each, why>
VERIFIED:      <commands run + results; screens checked + sizes>
NOT VERIFIED:  <what you could not test, e.g. real camera on a phone>
NOTICED, NOT CHANGED: <other issues seen, one line each>
DECISIONS NEEDED: <only if any>
```

- Never write "should work", "fixed" or "tested" without having run the check. If you didn't run it, say so.
- Never claim a test passes that you didn't see pass in this session.

## 8. Quick self-check before every edit

- Is this edit on the Request card's IN SCOPE list?
- Do I know the root cause, or am I guessing?
- Have I already tried this (or something like it)?
- Does it contradict an Owner decision?
- Will I be able to show evidence that it worked?

Any "no / not sure" → stop and resolve it first.
