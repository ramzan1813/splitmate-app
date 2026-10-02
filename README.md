# SplitMate — offline edition

A single, self-contained mobile app for sharing and splitting group expenses. There's **no server, no account and no internet** — the app's own data layer stores everything in an on-device **SQLite** database (`expo-sqlite`).

Built with Expo SDK 57 (React Native 0.86, TypeScript, Expo Router).

## Features

| Area | What you get |
|---|---|
| Groups & members | Groups with a currency. Friends are just names, and you mark which member is you. |
| Expenses | Split **equally, unequally, by percentage or by shares**, with live validation. Each expense has a category, date and note. |
| Payments | One-to-one payments, plus **Settle up** suggestions you can record in one tap. |
| Balances | Paid, share, payments sent and received, and net balance per person. |
| Charts | Pie chart per group (share, paid or category). |
| **Insights dashboard** | Where your money goes: totals, change vs the previous period, per-day average, plain-language findings, spending by category and month, who's spending (paid vs share), what each person spends on, day of week, and biggest expenses. Filter by period (this month, 30 days, 3 months, this year, all time) and by group. |
| Reports | A report screen you can print or save as PDF, and an **Excel (.xlsx) export** created on the phone. |
| Sharing | **Share a group as a file** (WhatsApp, email, Drive). A friend imports it, picks their name, and gets updates by re-importing. |
| Backup | **Export a full backup** and restore it on a new phone, merging or replacing what's there. |
| Privacy | **Optional 4-digit PIN** (salted hash, lockout after wrong tries). No analytics, no ads, and no contacts, location, camera, microphone or storage permissions. |

## Run it on your computer (development)

You need Node.js 22.13+ (https://nodejs.org). No admin rights are needed.

```bash
cd splitmate-app
npm install
npm test            # 9 data-layer tests (splits, balances, import validation, insights, Excel)
npx expo start      # then press "w" for the browser, or scan the QR code with Expo Go
```

To lint, run `npx expo lint`. It installs ESLint the first time, which is why ESLint isn't in the default install. Expo's lint config still needs ESLint 9, so you'll see one deprecation notice for it. That's a development tool only and isn't part of the app.

> The browser version uses SQLite compiled to WebAssembly, and `metro.config.js` already sets the headers it needs.

## Get the APK (installable app)

The repository includes a GitHub Actions workflow that builds a **signed release APK** for free.

1. Create a new **private** repository on GitHub and upload the contents of the `splitmate-app` folder. This works with drag-and-drop on the website or with GitHub Desktop, and needs no admin rights.
   The `.gitignore` already keeps keystores, `node_modules` and generated native folders out of the repo.
2. Add your signing key as repository secrets (see **SIGNING.md**). It takes 2 minutes and is strongly recommended.
3. Go to **Actions → Build Android APK → Run workflow**.
4. After about 15–20 minutes, open the finished run and download **splitmate-apk** under **Artifacts**. Unzip it to get `SplitMate-1.0.0.apk`, plus a `.sha256` checksum.

The workflow also runs the type check and unit tests, so a broken build never produces an APK.

### Installing on your phone, and the "unknown app" warnings

Any APK that doesn't come from the Play Store triggers these screens on Android. This is expected:

1. **"Install unknown apps"**: Android asks you to allow the app you opened the APK with (Files, Chrome, WhatsApp…). Allow it once, and you can turn it off again afterwards.
2. **Play Protect "Unknown app" or "App scan recommended"**: tap **More details → Install anyway**, or **Scan app**. This appears because the developer (you) isn't registered with Google, not because something is wrong with the app.

What this project does to keep those warnings to a minimum, and keep the app trustworthy:

- **Signed with your own release key**, not the public debug key. Updates install over the old version without losing data, and the signature stays consistent, which is what Play Protect looks at.
- **No dangerous permissions.** Storage, media, microphone and overlay permissions are explicitly removed, and plain-HTTP (cleartext) traffic is disabled.
- A current target SDK (from Expo SDK 57), no obfuscated native code, and no network calls.
- The `.sha256` file lets you verify the APK you downloaded is the one GitHub built.

The only way to remove the warnings completely is to publish through Google Play. A one-time $25 developer account lets you use **Internal testing** for up to 100 testers. The same keystore can be used there.

## Updating the app later

- Bump `expo.version` (e.g. `1.0.1`) and `expo.android.versionCode` (e.g. `2`) in `app.json`.
- Always build with **the same keystore**, or Android will refuse to install the update over the old one.
- Data stays on the phone between updates. Uninstalling deletes it, so export a backup first.

## Security & dependency notes

- `npm install` runs with **no warnings**. `npm audit` reports only `node-forge` (4 entries, one package). It's used by Expo's command-line tools for code-signing certificates on your computer, is **not included in the app**, and has no patched release yet. Re-run `npm audit` later and it will clear once Expo updates it.
- `react-native-reanimated` and `react-native-worklets` are pinned to the versions Expo SDK 57 supports. `expo-router` was pulling in newer, incompatible ones, which can crash native builds.
- `uuid` (used by build tooling) is overridden to the patched 11.x.
- `decode-uri-component` (a DoS advisory, used by the router's URL parsing) is replaced by a small local, linear-time version in `vendor/`. The patched upstream release is ESM-only and would break the router.
- Imported files are treated as untrusted. They're size-limited and strictly validated: types, member references, and splits must add up to the amount. All database writes use parameterised SQL.
- The PIN is stored as a salted, iterated SHA-256 hash, never in plain text. After 5 wrong attempts the lock screen waits 30 seconds, doubling with each further miss.

## Project structure

```
splitmate-app/
  app.json                  App config (permissions, icons, plugins)
  metro.config.js           Web support for SQLite (wasm + isolation headers)
  plugins/withReleaseSigning.js   Signs release builds with your keystore
  .github/workflows/build-apk.yml  Cloud APK build
  vendor/decode-uri-component/     Safe local replacement (see notes)
  src/
    data/                   On-device "backend"
      db.ts                 SQLite open + schema migrations
      platform.ts           expo-sqlite adapter
      repo.ts               Groups, members, transactions, settings
      logic.ts              Split maths, balances, settle-up plan
      insights.ts           Dashboard calculations
      backup.ts             Export/import with validation
      types.ts
    app/                    Screens (Expo Router)
      index.tsx             Groups
      insights.tsx          Insights dashboard
      settings.tsx          Name, PIN, backup/restore, erase
      import.tsx            Import group / restore backup
      group/new.tsx
      group/[id]/index.tsx       Expenses · Balances · Settle up · Chart
      group/[id]/expense.tsx     Add/edit expense
      group/[id]/payment.tsx     Add/edit payment
      group/[id]/members.tsx     Members, "this is me", share file
      group/[id]/report.tsx      Report, print/PDF, Excel
      group/[id]/settings.tsx    Edit/delete group
      group/[id]/transaction/[tid].tsx
    components/             UI kit, charts, PIN pad, lock/welcome
    lib/                    Formatting, files, PIN, Excel writer, report
  tests/                    Node tests for the data layer (real SQLite)
```
