# SplitMate E2EE SQLite Sync & Relay Server (Cloudflare Worker + Durable Objects)

A resilient, stateful, zero-knowledge sync and queue coordinator server powered by **Cloudflare SQLite Durable Objects** that synchronizes end-to-end encrypted (E2EE) expenses, payments, and full group history across SplitMate peers in real time and across offline sessions.

---

## 🔒 Security & Architecture Overview

- **Zero Plaintext:** All payloads sent through the relay are encrypted on-device with AES-GCM-256 using the group's private encryption key before transmission.
- **SQLite Queue Engine on Durable Objects:** Each group room runs inside an isolated Cloudflare SQLite Durable Object (`RelayRoom`) identified by a SHA-256 room hash.
- **Queue Pruning & Zero Payload Retention:** Changes are queued in SQLite with monotonic sequence numbers. As soon as all active peers acknowledge receipt of events up to sequence `N`, the server automatically purges the encrypted payloads from SQLite storage, retaining only state sequence metadata and sync counters.
- **Offline Sync Resilience:** Peers create local changes offline in SQLite with `synced = 0`. When coming online, peers push pending changes (`POST /sync/push`) and pull missing changes in exact chronological sequence order (`POST /sync/pull`), guaranteeing conflict-free Last-Write-Wins (LWW) convergence.
- **State Snapshot Coordination for New Members:** When a new peer joins or requests state hydration, the server identifies the active peer with the latest sync state and coordinates chunked `STATE_SNAPSHOT` replication to bring the new device up to date immediately.
- **Hybrid Interface:** Supports both HTTP REST API endpoints and WebSocket connections (`/ws`) for instant real-time notifications.

---

## 🌐 Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` or `/` | `GET` | Server health check and version info |
| `/join` | `GET` | Responsive mobile web landing page with deep link |
| `/sync/push?room=<hash>` | `POST` | Push encrypted sync event(s) to SQLite queue |
| `/sync/pull?room=<hash>` | `POST` | Pull pending queued events since `lastSeq` |
| `/sync/ack?room=<hash>` | `POST` | Acknowledge received sequence numbers |
| `/sync/request-snapshot?room=<hash>` | `POST` | Request full replica snapshot from online peer |
| `/sync/peers?room=<hash>` | `GET / POST` | Query room peers, sync watermarks, and online status |
| `/ws?room=<hash>` | `GET (Upgrade)` | Real-time WebSocket connection for instant push/pull |

---

## 🚀 Deployment (Terminal / CLI)

### 1. Open Terminal in the `relay` Folder
```bash
cd relay
```

### 2. Log in to Cloudflare (Only Needed Once)
```bash
npx wrangler login
```

### 3. Deploy to Cloudflare
```bash
npx wrangler deploy
```

---

## 🛠 Local Development & Testing

```bash
cd relay
npx wrangler dev
```
Runs locally at `http://localhost:8787` with hot-reloading.
