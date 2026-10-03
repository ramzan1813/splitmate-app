# SplitMate — offline & E2EE sync edition

A self-contained mobile app for sharing, splitting, and synchronizing group expenses. All data lives on your phone in an on-device **SQLite** database (`expo-sqlite`), with zero-knowledge **End-to-End Encrypted (E2EE)** remote synchronization across devices.

Built with Expo SDK 57 (React Native 0.86, TypeScript, Expo Router).

## Features

| Area | What you get |
|---|---|
| **On-device accounts** | No email, passwords or phone numbers. Cryptographic identities and keypairs are generated and stored 100% on-device. |
| **E2EE Remote Sync** | 256-bit AES-GCM encrypted real-time sync across Wi-Fi, 4G and 5G through a blind, zero-knowledge Cloudflare Worker relay. |
| **QR & Link Invites** | Instant offline SVG QR codes and deep links (`splitmate://join?...`) to share and join groups in one tap. |
| Groups & members | Groups with 160+ currencies. Friends are just names, and you mark which member is you. |
| Expenses | Split **equally, unequally, by percentage or by shares**, with live validation. Each expense has a category, date, author tag and note. |
| Payments | One-to-one payments, plus **Settle up** suggestions you can record in one tap. |
| Balances | Paid, share, payments sent and received, and net balance per person. |
| Charts | Pie chart per group (share, paid or category). |
| **Insights dashboard** | Where your money goes: totals, change vs the previous period, per-day average, plain-language findings, spending by category and month, who's spending (paid vs share), what each person spends on, day of week, and biggest expenses. Filter by period (this month, 30 days, 3 months, this year, all time) and by group. |
| Reports | A report screen you can print or save as PDF, and an **Excel (.xlsx) export** created on the phone. |
| Sharing & Backup | **Share as a file** or **Export a full backup** and restore it on a new phone, merging or replacing what's there. |
| Privacy & Lock | **Optional 4-digit PIN** (salted hash, lockout after wrong tries). No analytics, no ads, and zero personal tracking. |

## Run it on your computer (development)

You need Node.js 22.13+ (https://nodejs.org). No admin rights are needed.

```bash
cd splitmate-app
npm install
npm test            # 17 data & sync tests (splits, balances, import, crypto, 2-device sync)
npx expo start      # then press "w" for the browser, or scan the QR code with Expo Go
```

To lint, run `npx expo lint`.

> The browser version uses SQLite compiled to WebAssembly, and `metro.config.js` already sets the headers it needs.

## E2EE Cloudflare Worker Relay (`relay/`)

SplitMate includes a standalone, zero-knowledge WebSocket relay server in the `relay/` folder. It can be deployed in 1 command to Cloudflare's free tier:

```bash
cd relay
npm run deploy
```

Set your worker URL in the app under **Settings → E2EE Remote Sync Relay**.

## Get the APK (installable app)

The repository includes a GitHub Actions workflow that builds a **signed release APK** for free.

1. Create a new **private** repository on GitHub and upload the contents of the `splitmate-app` folder.
2. Add your signing key as repository secrets (see **SIGNING.md**).
3. Go to **Actions → Build Android APK → Run workflow**. You can choose which branch to build.
4. Download the APK from the finished run artifacts or Releases.

## Project structure

```
splitmate-app/
  app.json                  App config (permissions, icons, plugins)
  metro.config.js           Web support for SQLite (wasm + isolation headers)
  plugins/withReleaseSigning.js   Signs release builds with your keystore
  .github/workflows/build-apk.yml  Cloud APK build (with branch selector)
  relay/                    Zero-knowledge Cloudflare Worker WebSocket relay
    src/index.ts            Relay server logic
    wrangler.toml           Cloudflare Worker config
  vendor/decode-uri-component/     Safe local replacement
  src/
    data/                   On-device "backend"
      db.ts                 SQLite open + schema migrations
      platform.ts           expo-sqlite adapter
      repo.ts               Groups, members, transactions, settings
      sync.ts               E2EE sync engine, event log, conflict resolution
      logic.ts              Split maths, balances, settle-up plan
      insights.ts           Dashboard calculations
      backup.ts             Export/import with validation
      types.ts
    app/                    Screens (Expo Router)
      index.tsx             Groups
      insights.tsx          Insights dashboard
      settings.tsx          Name, Identity, PIN, Relay config, backup/restore
      import.tsx            Import group / Join via invite link
      group/new.tsx
      group/[id]/index.tsx       Expenses · Balances · Settle up · Chart · QR Invite
      group/[id]/expense.tsx     Add/edit expense
      group/[id]/payment.tsx     Add/edit payment
      group/[id]/members.tsx     Members, "this is me", share file
      group/[id]/report.tsx      Report, print/PDF, Excel
      group/[id]/settings.tsx    Edit/delete group
      group/[id]/transaction/[tid].tsx
    components/             UI kit, charts, QR Code, PIN pad, lock/welcome
    lib/                    Crypto, Identity, Formatting, files, PIN, Excel writer
  tests/                    Node tests for data & sync layer (real SQLite)
```
