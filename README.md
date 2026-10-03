# SplitMate — offline & E2EE sync edition

A self-contained mobile app for sharing, splitting, and synchronizing group expenses. All data lives on your phone in an on-device **SQLite** database (`expo-sqlite`), with zero-knowledge **End-to-End Encrypted (E2EE)** remote synchronization across devices.

Built with Expo SDK 57 (React Native 0.86, TypeScript, Expo Router).

## Features

| Area | What you get |
|---|---|
| **On-device accounts** | No email, passwords or phone numbers. Cryptographic identities and keypairs are generated and stored 100% on-device. |
| **E2EE Remote Sync** | 256-bit AES-GCM encrypted real-time sync across Wi-Fi, 4G and 5G through a blind, zero-knowledge Cloudflare Worker relay. |
| **QR Code & Deep Link Invites** | ISO/IEC 18004 compliant QR codes and universal invite links (`https://splitmate-relay.rn45819.workers.dev/join?...` / `splitmate://join?...`) to share and join groups in one tap. |
| **Native Camera QR Scanner** | Built-in camera scanner with viewfinder and permission handling to scan peer invite QR codes instantly. |
| **In-App Activity Notifications** | Real-time alerts when friends record an expense, payment, or settlement, viewable in Settings and Group screens. |
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
npm test            # 22 data, crypto, sync & QR tests
npx expo start      # then press "w" for the browser, or scan the QR code with Expo Go
```

To typecheck, run `npx tsc --noEmit`.
To lint, run `npx expo lint`.

> The browser version uses SQLite compiled to WebAssembly, and `metro.config.js` already sets the headers it needs.

## E2EE Cloudflare Worker Relay (`relay/`)

SplitMate includes a standalone, zero-knowledge WebSocket relay server in the `relay/` folder powered by **Cloudflare SQLite Durable Objects**:
- **Default Built-in URL:** `wss://splitmate-relay.rn45819.workers.dev/ws`
- **Web Join Landing Page:** `https://splitmate-relay.rn45819.workers.dev/join?...`
- **Health Check:** `https://splitmate-relay.rn45819.workers.dev/health`

You can deploy your own instance directly from GitHub CI/CD or local CLI with `npx wrangler deploy` (see [`relay/README.md`](relay/README.md)).

## Building the Installable Android APK

You can build a standalone, production-ready `.apk` using either **Expo Cloud (EAS Build)** or **GitHub Actions CI/CD**:

### Method 1: Fast Expo Cloud Build (Recommended & Fastest)

Build the APK in the cloud with zero local Android Studio or SDK setup:

1. **Log in to your Expo account:**
   ```bash
   npx eas-cli@latest login
   ```
2. **Trigger the Cloud APK Build:**
   ```bash
   npm run build:apk
   # or: npx eas-cli@latest build -p android --profile preview
   ```
3. **Download & Install:**
   When EAS finishes compiling, it outputs a direct download link and QR code in your terminal. Open the link on your phone, download the `.apk`, and install it.

---

### Method 2: Free GitHub Actions CI/CD

The repository includes a GitHub Actions workflow that builds a **signed release APK** directly in GitHub:

1. Push this repository to your GitHub account.
2. (Recommended) Add your signing keys as repository secrets (see [SIGNING.md](SIGNING.md)).
3. Go to **Actions → Build Android APK → Run workflow**.
4. Download the `.apk` and `.sha256` checksum directly from the **Releases** section or workflow artifacts.

---

## Project structure

```
splitmate-app/
  app.json                  App config (permissions, icons, plugins)
  eas.json                  Expo Application Services (EAS) cloud build profiles
  metro.config.js           Web support for SQLite (wasm + isolation headers)
  plugins/withReleaseSigning.js   Signs release builds with your keystore
  .github/workflows/build-apk.yml  Cloud APK build (with branch selector)
  relay/                    Zero-knowledge Cloudflare Worker + Durable Objects relay
    src/index.ts            RelayRoom Durable Object logic & /join landing page
    wrangler.toml           Cloudflare Worker config with Durable Objects & logging
    package.json            Worker dependencies and build scripts
    package-lock.json       Cloudflare CI/CD deterministic build lockfile
  src/
    data/                   On-device "backend"
      db.ts                 SQLite open + schema migrations
      platform.ts           expo-sqlite adapter
      repo.ts               Groups, members, transactions, settings (auto-healing keys)
      sync.ts               E2EE sync engine, event log, conflict resolution
      logic.ts              Split maths, balances, settle-up plan
      insights.ts           Dashboard calculations
      backup.ts             Export/import with validation
      types.ts
    app/                    Screens (Expo Router)
      index.tsx             Groups (with HeaderButton insights & settings)
      insights.tsx          Insights dashboard
      settings.tsx          Name, Identity, PIN, Relay config, backup/restore
      import.tsx            Import group / Scan QR code / Join via invite link
      join.tsx              Deep link join screen for invite links & QR codes
      group/new.tsx
      group/[id]/index.tsx       Expenses · Balances · Settle up · Chart · QR Invite
      group/[id]/expense.tsx     Add/edit expense
      group/[id]/payment.tsx     Add/edit payment
      group/[id]/members.tsx     Members, "this is me", share file
      group/[id]/report.tsx      Report, print/PDF, Excel
      group/[id]/settings.tsx    Edit/delete group
      group/[id]/transaction/[tid].tsx
    components/             UI kit (HeaderButton), charts, QR Code, QRScannerModal, PIN pad
    lib/                    Crypto, Identity, Formatting, files, PIN, Excel writer
  tests/                    Node tests for data, sync & QR layer (real SQLite)
```
