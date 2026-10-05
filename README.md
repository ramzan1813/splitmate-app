# SplitMate — Offline-First Multi-Device Synchronized App

A self-contained mobile app for sharing, splitting, and synchronizing group expenses across devices. All data lives on your phone in an on-device **SQLite** database (`expo-sqlite`), with server-authoritative, conflict-safe synchronization powered by **Cloudflare Workers & SQLite Durable Objects**.

Built with Expo SDK 57 (React Native 0.86, TypeScript, Expo Router).

---

## 🌟 Key Features

| Area | What you get |
|---|---|
| **Offline-First SQLite** | Read and write with zero latency directly to local SQLite. Offline mutations are enqueued in an `outbox` table. |
| **Server-Authoritative Sync** | Atomic push batches with idempotency, monotonic server sequence change log (`sync_changes`), and cursor pull. |
| **Optimistic Concurrency** | Transaction updates verify `expectedVersion` — stale concurrent writes are rejected with `VERSION_MISMATCH` instead of blind overwrites. |
| **Group Permission Models** | 3 server-enforced permission models per group: **Admin Only** (admin control), **Contributor** (peers can add and edit own expenses), and **Collaborative** (author-protected deletion with audit trail). |
| **Realtime Notifications** | WebSocket (`/ws`) `CHANGES_AVAILABLE` signals prompt connected clients to pull incremental changes and advance cursors. |
| **QR Code & Deep Link Invites** | ISO/IEC 18004 compliant QR codes and universal invite links (`https://splitmate-relay.rn45819.workers.dev/join?...` / `splitmate://join?...`) to share and join groups in one tap. |
| **On-device accounts** | No email or phone numbers required. Cryptographic identities and device IDs are generated and stored 100% on-device. |
| **Groups & members** | Multi-currency support (160+ currencies). Members are mapped seamlessly across devices. |
| **Expenses & Splits** | Split **equally, unequally, by percentage or by shares**, with live validation. Category, date, author tag, and audit notes. |
| **Payments & Settlements** | One-to-one payments, plus **Settle up** suggestions calculated from minimal transfer plans. |
| **Insights dashboard** | Spending trends, category breakdown, paid vs share breakdown, day of week analysis, and top expenses. |
| **Reports & Excel Export** | In-app printable/PDF reports and standalone **Excel (.xlsx)** export generated on the phone. |
| **Privacy & Security** | Optional 4-digit PIN (salted hash, lockout protection). No analytics, no ads, and zero personal tracking. |

---

## 💻 Run it Locally

Requires Node.js 22.13+ (https://nodejs.org).

### 1. Install & Test Frontend & Backend
```bash
# In the root repository:
npm install
npm test              # Runs 58 automated unit, integration, and E2E tests
npx tsc --noEmit      # TypeScript verification (0 errors)
npx expo start        # Start Expo development server (press 'w' for web)
```

### 2. Run Relay Server Locally
```bash
# In the relay/ folder:
cd relay
npm install
npm run dev           # Runs Cloudflare Worker locally via Wrangler at http://localhost:8787
npm run build         # Validates Worker bundling & Durable Object bindings
```

---

## 🌐 Cloudflare Worker Relay Coordinator (`relay/`)

All backend synchronization endpoints, SQLite Durable Objects, and WebSocket brokers reside exclusively in the **`relay/`** directory:

- **Health Check:** `GET /health` or `GET /`
- **Bootstrap Snapshot:** `GET /sync/bootstrap/:groupId`
- **Incremental Changes:** `GET /sync/changes/:groupId?after=<sequence>`
- **Atomic Outbox Push:** `POST /sync/push`
- **Realtime WebSocket:** `GET /ws`
- **Web Join Landing Page:** `GET /join`

To deploy the relay coordinator to Cloudflare Workers:
```bash
cd relay
npx wrangler login
npm run deploy
```

---

## 📱 Building the Android APK

You can build a standalone release `.apk` using either **Expo Cloud (EAS Build)** or **GitHub Actions CI/CD**:

### Method 1: Fast Expo Cloud Build (EAS)
```bash
npx eas-cli@latest login
npm run build:apk
```

### Method 2: Free GitHub Actions CI/CD
1. Push this repository to your GitHub account.
2. (Optional) Add signing secrets (see [SIGNING.md](SIGNING.md)).
3. Go to **Actions → Build Android APK → Run workflow**.
4. Download the signed `.apk` from the Releases / Artifacts page.

---

## 📂 Project Structure

```
splitmate-app/
├── app.json                  # Expo application configuration & native permissions
├── package.json              # Mobile dependencies, scripts, and Expo toolchain
├── relay/                    # Cloudflare Workers & Durable Objects SQLite Coordinator
│   ├── wrangler.toml         # Cloudflare Worker config with DO SQLite migrations
│   ├── package.json          # Relay scripts & wrangler dependencies
│   ├── tsconfig.json         # Relay TypeScript compiler settings
│   ├── README.md             # Relay architecture & API documentation
│   └── src/
│       ├── index.ts          # Worker fetch router & RelayRoom Durable Object
│       ├── api.ts            # REST API handler (/sync/bootstrap, /sync/changes, /sync/push)
│       ├── db.ts             # Cloudflare DO SQLite & In-memory adapter
│       ├── syncService.ts    # Push mutations, monotonic sequence log, optimistic concurrency
│       ├── permissions.ts    # Server-authoritative permission engine
│       ├── realtimeHub.ts    # Pub/Sub lightweight notification dispatcher
│       └── types.ts          # Shared server DTO interfaces
├── src/                      # Mobile Offline-First Application Source
│   ├── data/                 # Local SQLite Engine & Outbox Sync Coordinator
│   │   ├── db.ts             # SQLite initialization & schema migrations (v1-v4)
│   │   ├── repo.ts           # Local repositories (groups, members, transactions, outbox enqueue)
│   │   ├── outbox.ts         # Local outbox management (pending, synced, conflict states)
│   │   ├── syncState.ts      # Server sequence cursors & sync watermarks
│   │   ├── syncEngine.ts     # Mobile sync engine (push outbox, pull changes, apply to SQLite)
│   │   ├── logic.ts          # Split math, balances, settle-up algorithms
│   │   ├── insights.ts       # Spending trends & analytics calculations
│   │   ├── backup.ts         # JSON backup export & validated import
│   │   └── types.ts          # Core TypeScript data definitions
│   ├── app/                  # Expo Router Screens
│   ├── components/           # UI Components, QR code generator, and camera scanner
│   └── lib/                  # Identity, Crypto, PIN, formatting, and Excel writer
└── tests/                    # 58 Automated Node & SQLite Test Suites
```
