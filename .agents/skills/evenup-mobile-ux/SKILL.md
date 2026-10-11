---
name: evenup-mobile-ux
description: >
  Mobile-first UI/UX standards for EvenUp screens. Use whenever you build, change or review any screen,
  component, list, form, tab bar, dialog, QR/camera flow or navigation in src/app or src/components. Lists the
  behaviours a mobile user expects that must be added WITHOUT being asked (swipe between tabs, touch targets,
  keyboard handling, long text, small screens, empty/loading/offline states, confirmations), and how to build
  them with the existing UI kit.
---

# EvenUp Mobile UX Standards

EvenUp is used one-handed on Android phones, often on small screens, with long group names, emojis and big
rupee amounts. The owner should not have to ask for standard mobile behaviour: **if a mobile user would expect
it, build it.** Example: the owner had to ask for the member page's tab list to be swipeable because the group
screen already was. Matching it should have been automatic.

Before writing UI code, open a similar existing screen and reuse its pattern and components.

---

## 1. Build with the existing kit

- Use `src/components/ui.tsx`: `Screen` (scroll + keyboard-aware), `Card`, `Button` (`small`, `variant`
  primary/outline/ghost, `loading`), `HeaderButton`, `Field`, `Chip`, `Segmented`, `Row`, `Avatar`, `Empty`,
  `Loading`, `SectionTitle`. Colors and categories come from `src/lib/theme.ts`; money and dates from
  `src/lib/format.ts` (`money`, `prettyTime`, `txWhen`). Never hard-code `Rs` or format numbers by hand.
- Use dialogs from `src/lib/dialog.ts` (`notify`, `confirm`), not `Alert` directly.
- Every interactive element gets a stable `testID` (pattern: `screen-thing-<id>`), so tests can find it.
- Every icon-only button gets an `accessibilityLabel`.

## 2. Behaviours to add without being asked

| Situation | Expected mobile behaviour | How in this codebase |
|---|---|---|
| Tabs or segmented filters that switch content | **Swipe left/right switches**, content follows the finger, resists at the ends; taps still work; vertical scroll unaffected | `PanResponder` + `isHorizontalSwipe` / `dragOffset` / `swipeDirection` from `src/lib/swipeTabs.ts`, `Animated.View` translateX, container `style={swipeArea}` (stops browser back-swipe on web). Copy from `group/[id]/index.tsx` or `member/[memberId].tsx`. |
| A list the server can change | Pull-to-refresh | `RefreshControl` calling `refresh()` from `useGroup` |
| Multi-select of members | Select all / Unselect all with a count ("2 of 3"), partial state | See the split card in `group/[id]/expense.tsx` (`Checkbox` with `partial`) |
| Destructive action (delete, leave, erase, discard) | Confirmation that says what will be lost, destructive styling | `confirm(title, message, 'Delete', true)` |
| Action the user may not do | Hide it (don't show a button that fails) and keep server enforcement | Permission helpers: `canAdd`, `canAddMember`, `canEditTx`, `canDeleteTx`, `canSettle` |
| Waiting on work | Button `loading`, never a frozen screen; disable double-submit | `Button loading={saving}` |
| No data | Friendly empty state with what to do next | `Empty title=… subtitle=…` |
| Offline / sync problems | Show status, keep working offline, never block the UI on the network | Sync badge via `useSyncStatus`; writes always go to SQLite first |
| Amount input | Numeric keyboard, accepts `1,500.50`, shows currency symbol | `keyboardType="decimal-pad"`, `parseAmount`, `currencySymbol(cur)` |
| Forms | Keyboard never covers the focused field; Enter moves on / submits | Put forms in `Screen` (KeyboardAwareScrollView); `returnKeyType` |
| Long lists (100+ rows) | Smooth scrolling | Prefer `FlatList` for new long lists; keep keys stable (`t.id`) |
| Primary action of a screen | Reachable by thumb, full width near the bottom | `Button` full width at the end of the form |
| Back navigation | Android back closes dialogs/modals first, then the screen; unsaved form → confirm | `Modal onRequestClose`, `router.back()` |
| QR / camera | Explain why the camera is needed, handle "permission denied" with a way forward, offer paste-link fallback, show a scan frame | `QRScannerModal` (has paste fallback); `expo-camera` permission text in `app.json` |
| Share / export | Native share sheet; web downloads a file | `shareFile` in `src/lib/files.ts` |
| Copy-able values (invite link, ids) | Tap to copy + confirmation | `expo-clipboard` + `notify` |

When a new feature resembles an existing one, give it the same gestures and states as the existing one.

## 3. Layout rules that prevent overlap and cut-off text

Test mentally at 320 px width with a long name like "🫂 Three Man Squad 🤑 (copy)" and an amount like
"Rs 1,111,933.32".

- In a `Row`, the text that can grow gets `flex: 1` (or `flexShrink: 1`) and `numberOfLines={1}` or 2; fixed
  things (amounts, icons, buttons) get no flex. Without this, long text pushes buttons off screen.
- Amounts never wrap mid-number: give them their own `Text`, no `flex`, and let the label shrink instead.
- Two buttons in a row (`Breakdown` + `Settle`) need `gap` and must fit at 320 px; if not, stack them.
- Never position with absolute pixel offsets for content; use flex. Don't set fixed heights on text containers.
- Respect safe areas (status bar, gesture bar): stay inside `SafeAreaProvider` / `Screen`.
- Icons and avatars align with the first line of text (`alignItems: 'center'` on the row); same size across rows.
- Content width is capped (`maxWidth: 640–760`, centred) so tablets/web don't stretch.
- Emojis in group names and categories: test them; they change line height and width.
- Font scaling: don't fix heights; let text wrap; for dense rows consider `maxFontSizeMultiplier`.

## 4. Feedback and microcopy

- Messages say what happened and what to do: "Couldn't reach the server. Check your connection and try again."
- Notifications from sync are short and name the person: "Arslan added "Chai" (Rs 200.00)."
- Use the user's words: Expense, Payment, Settle up, Balances, Members, Admin. The app is **EvenUp**.
- Don't show internal ids or codes in UI unless it is a support detail.

## 5. Web parity (the app also runs in a browser)

- Gestures must work with touch on mobile browsers: swipe containers use `swipeArea` (`touch-action: pan-y`).
- `useNativeDriver` is `Platform.OS !== 'web'` for animations.
- Camera/QR on web falls back to paste.

## 6. Current platform standards (2025–2026)

Build to today's standards, not old habits. Where the app has made a deliberate choice, keep it unless the owner
asks to change it.

| Standard | What it means here |
|---|---|
| **Material 3 / Material 3 Expressive** (Android design language) | Rounded cards, clear hierarchy, one primary action per screen, bottom sheets for secondary choices, snackbars for short non-blocking feedback. Express it with the existing kit and `theme.ts`; don't import a new design library. |
| **Touch targets** | 48×48 dp on Android (44×44 pt iOS). WCAG 2.2 (2.5.8) minimum is 24×24 CSS px with spacing. Use padding or `hitSlop`, not bigger icons. |
| **Accessibility: WCAG 2.2 AA** | Text contrast ≥ 4.5:1 (large text 3:1); `accessibilityLabel` on icon buttons, `accessibilityRole`/`accessibilityState` on custom controls; meaning never by color alone (owes = red AND a word/sign); focused element never hidden behind a bar (2.4.11). |
| **Dynamic type** | Layouts survive 200% system font size: no fixed text heights, rows can wrap; cap only dense numeric rows with `maxFontSizeMultiplier`. |
| **Reduced motion** | Respect the OS setting: skip or shorten slide/scale animations when reduce-motion is on (`AccessibilityInfo.isReduceMotionEnabled`, or Reanimated's `useReducedMotion`). Swipe still works; only decorative motion goes. |
| **Edge-to-edge** (Android 15+ default) | Content draws behind status and navigation bars; pad with safe-area insets (`Screen`, `useSafeAreaInsets`), never hard-coded status-bar heights. |
| **Predictive back** (Android 14+) | Currently **disabled** in `app.json` (`predictiveBackGestureEnabled: false`). Don't enable it without the owner; if enabled later, every modal must handle `onRequestClose`. |
| **Theme** | App is **light-only** (`userInterfaceStyle: "light"`). Don't add dark-mode styles piecemeal; if dark mode is requested, do it through `theme.ts` tokens for the whole app. |
| **Loading states** | Prefer skeleton placeholders shaped like the content for lists/cards that take > ~300 ms; spinners for short actions; never a blank screen. |
| **Feedback** | Every tap gives visible feedback within ~100 ms (pressed state, ripple via `android_ripple`, button `loading`). Haptics (`expo-haptics`) are not installed; propose before adding. |
| **"Optimistic" updates** | In EvenUp the UI shows what is in local SQLite, written first, then synced: that is correct offline-first behaviour. Never show UI-only state that isn't in SQLite, and show pending/failed sync honestly (`AGENTS.md`). |
| **Undo vs confirm** | Money records: keep explicit confirmation for delete/leave/erase. Undo snackbars only for non-financial, easily reversible actions. |
| **Gestures and animation tech** | Current RN standard is Reanimated 4 + Gesture Handler (Reanimated is installed). Existing swipe code uses `PanResponder` + `swipeTabs.ts` and is tested: reuse it; don't migrate gesture systems as part of an unrelated task. |
| **Long lists** | `FlatList` with stable keys today; Shopify FlashList v2 is the current high-performance option: propose it if a list is measurably slow, don't add it unasked. |
| **Web performance** | Interaction to Next Paint (INP) < 200 ms; avoid heavy work on tap handlers. |
| **Privacy UX** | Ask for permissions in context with a reason (camera only when scanning), handle "denied" with a way forward. |

## 7. Before you say a UI task is done

Run the checks in `evenup-ui-testing` (screen sizes, overlap, alignment, gestures, states). A UI change without
a real render check is not done.
