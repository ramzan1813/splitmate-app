---
name: evenup-workflow-builder
description: >
  Helps the owner design, write, test and improve agent workflows (saved step-by-step procedures run with a
  slash command, stored in .agents/workflows/) for EvenUp: fix a bug, build a feature, UI change, release,
  test sweep, sync investigation. Use when the owner says "make a workflow", "create a process/checklist for…",
  "automate these steps", "turn this into a slash command", or wants to change an existing workflow. Covers when
  to use a workflow vs a skill vs a rule, interviewing the owner, the step format with gates and evidence, safe
  auto-run, and dry-running the workflow before saving.
---

# Building Workflows With the Owner

A **workflow** is a saved, ordered procedure the agent runs when the owner types `/<workflow-name>`. It makes
repeated work predictable: same steps, same checks, same report every time.

---

## 1. Workflow, skill or rule?

| Use a… | When | Lives in |
|---|---|---|
| **Rule** | Must apply to every chat, always ("never write to production") | `.agents/rules/*.md` |
| **Skill** | Knowledge and standards the agent pulls in when relevant ("how mobile UX should look") | `.agents/skills/<name>/SKILL.md` |
| **Workflow** | An ordered procedure with a start, checkpoints and a finish ("fix a reported bug") | `.agents/workflows/<name>.md` |

Workflows should **call skills, not copy them**: "Step 3: apply `evenup-safe-change` section 2 (blast radius)".
Copies go stale; references stay correct.

## 2. Interview the owner first

Ask only what you cannot infer. Usually 3–5 questions, in one message:

1. **Trigger:** when will you run it? What do you type after the command (e.g. `/fix-bug <description>`)?
2. **Outcome:** what does "finished" look like? (a commit? a report? an APK? a PR?)
3. **Steps you already do by hand**, in order — even rough.
4. **Checkpoints:** where must the agent stop and wait for your OK? (before commit, before touching production,
   before release, after the plan)
5. **Never:** what must it never do in this workflow? (push, deploy, change data…)

Then propose the workflow as a draft and let the owner correct it before saving.

## 3. File format

```markdown
---
description: <one line: what it does and when to run it — the agent uses this to recognise it>
---

# <Title>

Input: <what the owner provides after the slash command>
Skills: <skills to load first, e.g. evenup-agent-discipline, evenup-safe-change>
Never: <hard limits for this workflow>

## 1. <Step name>
Do: <one action, imperative, specific>
Run: `<command, if any>`
Evidence: <what output/screenshot/file proves this step is done>
Stop if: <condition that ends the workflow or needs the owner>

## 2. <Step name>
...

## Report
<the exact report format to finish with>
```

## 4. Rules for good steps

- **One action per step.** "Reproduce the bug" and "fix the bug" are two steps.
- **Every step has Evidence.** Without it the agent will tick steps it didn't really do.
- **Every risky step has Stop if.** E.g. "Stop if the bug can't be reproduced — report what you tried."
- **Gates are explicit**, written as their own step:
  `## 4. GATE — owner approval` / `Do: show the plan and wait. Do not edit code until the owner says go.`
  Put gates before: editing code on big changes, commits, anything on production, releases, deleting data.
- **Order matters:** reproduce → understand → plan → change → verify → report. Verification is never last-minute
  optional; it is its own step with commands.
- **Concrete commands**, copied from the skills (`npm test`, `npm run typecheck`, `npm run lint`, `ui-audit.mjs`).
  No "run the tests" without the command.
- **Conditional steps** say so: "Only if `relay/` changed: `cd relay && npx tsc --noEmit -p .`".
- **Loop guard** in any workflow that edits code: "If the same check fails twice, stop and follow
  `evenup-agent-discipline` section 3."
- **Short:** 5–12 steps. Longer → split into two workflows; a workflow may tell the agent to run another
  (`Run /ui-check`).
- Plain words. The owner must be able to read it and see exactly what will happen.

## 5. Auto-run safety

Antigravity lets a workflow mark steps whose terminal commands may run without asking (the `// turbo` line above
a step, or `// turbo-all` for the whole file).

- Allowed for **read-only or local-only** commands: `npm test`, `npm run typecheck`, `npm run lint`,
  `git status`, `git diff`, starting the local dev server with `EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:9`.
- **Never** for: `git push`, tags, releases, deploys, database migrations or scripts against any non-local
  database, `rm -rf`, anything with a production URL or `DATABASE_URL`, `npm install <new package>`.
- Never use `// turbo-all` in a workflow that commits, deploys or touches data.

## 6. Test the workflow before saving

1. **Dry run:** walk through it on a real recent example and narrate each step without executing risky ones. Does
   every step have what it needs from the previous one?
2. Check: inputs defined, every step has Evidence, gates where the owner wants them, no step contradicts a rule
   (`AGENTS.md`, `rules/evenup-core.md`), commands are correct for Windows (PowerShell vs Git Bash noted).
3. Show the owner the final file, then save it to `.agents/workflows/<kebab-name>.md`.
4. Add it to the table in `.agents/README.md`.

## 7. Improving a workflow

When a run goes wrong, ask: which step allowed it? Then fix **that step** (add a Stop if, an Evidence, or a
gate). Don't add a new paragraph of general advice at the top; agents skim those.

## 8. Starter ideas for this project

| Workflow | Core steps |
|---|---|
| `/fix-bug` | Request card → baseline tests → reproduce (failing test or screenshot) → root cause → blast radius → GATE if shared/data code → smallest fix → full suite + UI audit → diff review → report |
| `/new-feature` | Request card → find similar screen → plan + mobile behaviours list → GATE → build → tests → UI audit + swipe check → report |
| `/ui-change` | Baseline `ui-audit.mjs` → change → audit again at 4 sizes → compare → report screenshots |
| `/qa-sweep` | Suites → UI audit standard set → swipe checks → state matrix → negative cases → report (uses `evenup-qa-testing`) |
| `/release` | Uses `evenup-release`: version bump → CHANGELOG → tests → GATE → commit with `[release]` (no push without approval) |
| `/sync-investigate` | Uses `splitmate-sync-debugger`: collect state → reproduce in test → hypothesis → GATE → fix |
