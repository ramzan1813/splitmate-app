---
name: evenup-ui-testing
description: >
  How to test EvenUp before calling any change done: automated test suites, a real render check of every changed
  screen at several phone sizes (text overlap, cut-off or off-screen content, icon alignment, content stuck under
  bars, tap target size), real touch-gesture checks (swipe between tabs, vertical scroll, no browser back),
  states (empty, loading, offline, error, long names, emojis, big amounts), QR/camera and permission flows,
  regression of nearby features, and doing all of it without touching the production server. Includes ready
  scripts: scripts/ui-audit.mjs and scripts/swipe-check.mjs.
---

# EvenUp Testing Protocol

"Done" means: automated tests pass AND the changed screens were actually rendered and checked. Code that compiles
is not done. Report exactly what you ran and what you saw; say plainly what you could not test (for example, the
real camera on a phone).

---

## 1. Automated suites (every change)

```bash
npm test                 # app logic, server API (PGlite), end-to-end phone<->server sync
npm run typecheck
npm run lint             # 0 errors; for new files under scripts/ also run: npx eslint <file>
cd backend && ../.venv/Scripts/python.exe -m pytest -q    # when backend/ changed
cd relay && npx tsc --noEmit -p .                          # when relay/ changed
```

- Read the test output; don't commit before reading lint results.
- Logic change → add/adjust a test in `tests/` that fails before your fix and passes after. Sync or data change →
  an end-to-end test in `tests/server-sync-client.test.ts` (real SyncEngine + HTTP + relay on PGlite).
- If a test asserts old behaviour you were asked to change, update it and say so; never weaken a test to make a
  bug pass.

## 2. Run the web app safely

```powershell
# PowerShell, from the C:\ path (a lowercase c:\ cwd breaks module resolution on this machine)
Set-Location "C:\Users\<you>\Downloads\SplitMate-projects\splitmate-app"
$env:EXPO_PUBLIC_SERVER_URL = 'http://127.0.0.1:9'   # dead address: nothing can sync to production
npx expo start --web --port 8099
```

- Without `EXPO_PUBLIC_SERVER_URL` the app syncs with the LIVE server. Only do that on purpose, and block requests
  in the browser if you just want to see the UI.
- A fresh browser profile shows onboarding ("What should we call you?" → Get started) and creates three sample
  groups: `/group/1`, `/group/2`, `/group/3` (Dubai Family Holiday, 3 members, many transactions). Member pages are
  `/group/3/member/<id>`; in a fresh profile `/group/3/member/8` exists (find others by tapping a member on the
  Balances tab).
- Stop the dev server when done (and kill whatever still listens on the port).

## 3. Layout audit at phone sizes (every UI change)

The script renders screens at 320×640, 360×780, 412×915 and 768×1024 and reports:

| Kind | Meaning | Typical fix |
|---|---|---|
| `overlap` | two texts drawn on top of each other | give the growing text `flex: 1` + `numberOfLines`; keep amounts unflexed; stack instead of row at small widths |
| `offscreen` | content past the screen edge (not in a deliberate sideways scroller) | `flexShrink`, wrap, `maxWidth`, move badges below titles |
| `hidden` | at the end of the list, content still under a bottom bar | add bottom padding ≥ bar height to the scroll content |
| `target` | tap area under ~40×24 px (warning) | bigger padding or `hitSlop`; ignore for non-interactive bars |
| `pageerror` | JavaScript error while rendering | fix it |

```bash
# needs Playwright once, outside the repo:  npm i playwright@1.54.2 --prefix <temp>  (+ npx playwright install chromium)
export NODE_PATH=<temp>/node_modules            # so the script finds playwright
node .agents/skills/evenup-ui-testing/scripts/ui-audit.mjs --out <temp>/ui-audit group/3 group/3/member/8
# no screen arguments = the standard set of 11 screens; --chrome <path> to use an installed Chromium
```

- In Git Bash pass screen paths WITHOUT the leading slash (`group/3`): Git Bash rewrites `/group/3` into a Windows
  path. (Or set `MSYS_NO_PATHCONV=1`.)
- The script is a detector, not a judge: open the screenshots in `<out>/<viewport>/` for every flagged screen and
  confirm by eye before "fixing". Mid-scroll text under pinned bars and chip rows that scroll sideways are already
  excluded.
- Also look at the screenshots for what a script can't judge: icons aligned with their text, consistent spacing,
  colors from the theme, nothing visually broken.

Run it before the change (baseline) and after. A change must not add new findings on any screen, not just the one
you edited. Known findings at the time of writing (fix-candidates, not regressions):
member page category rows overlap "(N expense)" with the % at 320–360 px; Insights "SMART COPILOT" badge overflows
its card at 320 px; group title touches the 🔗 header button at 320 px.

## 4. Gesture check (any tab/segment/swipe change, and as regression for screens near your change)

Mouse drags do NOT trigger React Native's touch responder: a mouse-based test says "swipe broken" when it works.
Use real touch events:

```bash
node .agents/skills/evenup-ui-testing/scripts/swipe-check.mjs --path group/3 --content group-tab-content
node .agents/skills/evenup-ui-testing/scripts/swipe-check.mjs --path group/3/member/8 --content member-activity-content
```

It checks: each left swipe changes the tab, a right swipe comes back, the URL never changes (no browser
"back"), a vertical drag keeps the tab. Give new swipe areas a `testID` on the animated content so this works.

## 5. State and content matrix (check what applies to your screen)

| Case | What to verify |
|---|---|
| Long text | group name with emojis + "(copy)", 30-char member names, long notes: truncated or wrapped, never overlapping |
| Big numbers | `Rs 1,111,933.32`, 7-digit amounts, many decimals entered: formatted, aligned, not wrapping mid-number |
| Empty | no transactions / no members / filter with 0 results: `Empty` with guidance |
| Loading | spinner or button `loading`; no double submit |
| Offline / server down | (the dead URL above *is* offline) app keeps working, writes saved locally, sync badge shows offline/pending |
| Permissions | admin vs member vs contributor: buttons hidden or shown correctly (Settle only for admin or the row's members) |
| Keyboard | focused field stays visible; decimal keypad for amounts |
| Many items | 50+ transactions scroll smoothly; last item reachable above bottom bars |
| Dialogs | Android back closes them; destructive ones confirm |

## 6. QR, camera, share, files

- QR on web: the scanner falls back to pasting a link; test pasting a valid invite (`splitmate://join?...` and
  `https://…/join?...`) and an invalid one (clear error).
- On a real phone (owner's device), list what must be checked by hand: camera permission prompt, denied
  permission path, scan of a real invite QR, share sheet, file picker for import. Say these were not verified if you
  could not run them.
- Import: use a file with long names and old-format fields; the result must be a NEW group "(copy)" when the name
  exists, and the original group must be unchanged.

## 7. Regression sweep before you finish

1. `npm test`, typecheck, lint all green.
2. `ui-audit.mjs` on the standard set: no new findings compared with the baseline.
3. `swipe-check.mjs` on both swipe screens.
4. Re-test the specific neighbour features of what you touched (same component, same screen, same data function).
   Use `git diff --stat` to list touched files and check every screen that imports them.
5. Write the report: what changed (files), tests added, what you ran and saw, what you could not verify.
