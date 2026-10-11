---
name: evenup-workflow-runner
description: >
  How the agent must read and execute an EvenUp workflow (a /slash-command procedure in .agents/workflows/, or
  a numbered step list the owner gives in chat): read it fully first, turn it into a checklist, run steps in
  order, collect evidence per step, obey gates and "Stop if" conditions, never skip/merge/reorder or invent
  steps, handle failures and interruptions, resume correctly, and report step by step. Use whenever a workflow
  is invoked or the owner says "follow these steps", "do it in this order" or "continue the workflow".
---

# Running a Workflow Exactly

A workflow is the owner's decision about **how** a job is done. Your job is to execute it faithfully, not to
improve it while running. Improvements are suggested at the end.

---

## 1. Before step 1

1. Read the **whole** workflow file once, top to bottom, including Input, Skills and Never lines.
2. Load every skill it names (plus `evenup-agent-discipline`, always).
3. Check you have the **Input**. Missing or ambiguous → ask once, before starting.
4. Write the checklist (task list artifact or in your reply), one line per step, with its Evidence:

```text
[ ] 1. Reproduce        — evidence: failing test name / screenshot
[ ] 2. Root cause       — evidence: file:line + one-sentence cause
[ ] 3. GATE             — evidence: owner said go
...
```

5. Note the **Never** lines and every **GATE** position. These override anything else you think is a good idea.

## 2. Executing steps

- **In order.** Don't start step N+1 before step N has its evidence.
- **Don't skip.** A step that doesn't apply gets marked `[–] skipped: <reason>` (e.g. "relay/ not changed").
  Conditional steps ("only if…") are skipped only when the condition is clearly false.
- **Don't merge** steps to save time, and don't add steps the workflow doesn't have. If you believe an extra step
  is needed (a missing safety check, for example), **ask** — or, if it is read-only and harmless, do it and say
  so clearly as "extra, not in workflow".
- **Run commands exactly as written.** If a command fails because of the environment (wrong path, shell syntax),
  fix the invocation, not the intent, and note it.
- **Tick with evidence only.** Paste the key line of output (e.g. `# pass 112  # fail 0`) or name the screenshot.
  "Looks fine" is not evidence.

## 3. Gates

A step marked GATE (or "wait for the owner", "ask before…") means:

- Show what the owner needs to decide (the plan, the diff summary, the risk) in a short message.
- **Stop and wait.** Do not continue "in the meantime" with later steps that change files, data or git.
  Read-only preparation is fine if you say so.
- Only an explicit OK from the owner passes a gate. Silence, or approval of a different gate earlier, does not.

## 4. When a step fails

- A **Stop if** condition is met → stop the workflow, report which step, what happened, what you tried.
- A check fails (test, lint, audit) → fix within the scope of the workflow, re-run the same check. Same failure
  twice → follow the loop-breaking procedure in `evenup-agent-discipline` section 3; do not move on to later
  steps with a red check.
- Never "pass" a step by weakening it: no skipping tests, no lowering assertions, no deleting the failing case.
- The workflow itself seems wrong for this case (step impossible, contradicts a rule in `AGENTS.md` or
  `rules/evenup-core.md`) → rules win; stop and tell the owner which step conflicts and why.

## 5. Interruptions and resuming

- If the owner interrupts with a question, answer it, then say where you are: "Back to step 5 of /fix-bug."
- If the owner changes the request mid-workflow, restate the change, show which completed steps are still valid
  and which must be redone, then continue.
- When resuming in a new chat or after a long pause, don't trust memory: re-read the workflow, then check the
  real state (`git status`, `git diff`, test results) and mark steps done only if the evidence still holds.

## 6. Final report

Finish with the workflow's own **Report** section if it has one. Otherwise:

```text
WORKFLOW: /<name>  — <completed | stopped at step N>
STEPS:
  1. Reproduce      ✔ test "member tabs swipe" failed before fix
  2. Root cause     ✔ member/[memberId].tsx:142 — PanResponder not attached
  3. GATE           ✔ owner approved
  4. ...            – skipped: relay/ not changed
VERIFIED: <commands + results>
NOT VERIFIED: <...>
SUGGESTED WORKFLOW IMPROVEMENTS: <optional, one line each — not applied>
```

## 7. Never

- Never reorder, skip silently, merge or invent steps.
- Never pass a gate without the owner's explicit OK.
- Never run a step's command against production unless the workflow AND the owner explicitly say so for this run.
- Never edit the workflow file while running it. Suggest changes in the report; the owner decides
  (`evenup-workflow-builder`).
