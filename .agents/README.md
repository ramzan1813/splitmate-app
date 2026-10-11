# Agent skills for EvenUp

Instructions that coding agents (Gemini/Antigravity, Claude, others) read when working on this repository.

| File | Loaded | Use it for |
|---|---|---|
| `rules/evenup-core.md` | **always**, in every chat | the non-negotiables and which skill to use when |
| `rules/graphify.md` | always | use the knowledge graph in `graphify-out/` when it exists |
| `skills/evenup-senior-dev/` | start of any task | what the app is, architecture, servers, code map, priorities, never-break list |
| `skills/evenup-mobile-ux/` | building or changing screens | mobile behaviours to add without being asked, layout rules against overlap |
| `skills/evenup-ui-testing/` | before saying "done" | test suites, layout audit at phone sizes, real touch swipe checks, state matrix |
| `skills/evenup-safe-change/` | every fix or edit | reproduce → blast radius → smallest change → prove → review diff |
| `skills/evenup-release/` | version, CHANGELOG, APK, deploy | release steps, signing ("App not installed"), deploy order, production maintenance |
| `skills/splitmate-sync-engineering/` | sync, SQLite, server, permissions, import/export | the sync protocol and production/existing-data rules |
| `skills/splitmate-architecture-review/` | before big structural changes | review template + existing-data checklist |
| `skills/splitmate-sync-debugger/` | sync bugs | step-by-step diagnosis, known failure patterns |
| `skills/graphify/` | codebase questions | the graphify tool |

Scripts used by the testing skill: `skills/evenup-ui-testing/scripts/ui-audit.mjs` (layout audit) and
`skills/evenup-ui-testing/scripts/swipe-check.mjs` (touch swipes). They need Playwright installed outside the repo
(`NODE_PATH` pointing at it) and the web dev server running with `EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:9`.

## How to ask

Agents pick skills by their description, and you can name them explicitly; several skills in one chat is fine and
is the recommended way. Examples:

- *"Use evenup-senior-dev and evenup-mobile-ux. Add a search box to the expenses tab."*
- *"Use evenup-safe-change and evenup-ui-testing. On the member page at small widths, '(1 expense)' overlaps the
  percentage. Fix it."*
- *"Use evenup-release. Bump to 2.2.1 with the fixes from this week and update the release notes."*
- *"Use splitmate-sync-debugger. A phone shows a group as 'Sync error' after the server was restored."*

Keep these files current: when a rule, trap or architecture fact changes, update the matching skill in the same
commit.
