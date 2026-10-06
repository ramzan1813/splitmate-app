# Changelog

Release notes for each version. The release workflow copies the section matching the version in `app.json` into the GitHub Release.

## 2.0.0 — 2026-10-06

Sync moves from the encrypted WebSocket relay to the new SplitMate sync server. Update every phone in a group: older versions can no longer sync.

### New
- **Reliable multi-phone sync.** Edits are saved on the phone first and sent to the server when you're online — on app launch, when you return to the app, when you open a group, on pull-to-refresh and right after each change. Nothing is lost while offline.
- **Sync status on every group.** The badge shows *Synced*, *Syncing*, *N pending*, *Offline*, *Sync error* or *N not synced*. Tap it to sync now.
- **Safe conflict handling.** If two people edit the same expense at once, the second edit is refused instead of overwriting the first, shown as *not synced*, and you choose to take the group's current version.
- **Server setting.** Settings → Server shows the sync server URL, can test the connection, and can point the app at another server (for development).
- **Joining loads the group from the server**, including all past expenses, and lets you pick which existing member you are.
- **Merging members now syncs** to everyone in the group.
- Notifications list what other members added, edited or deleted.

### Upgrading
- Groups created on this phone before 2.0.0 are uploaded to the server automatically on first sync. If the group already exists on the server (another member uploaded it first), only what's missing is added; if your copy of an expense differs, the shared copy is kept and you get a notification.
- Old invite links and QR codes still work.

### Fixed
- The group badge stuck on "Sync Active" and never connecting.
- The old relay connection retrying in the background every few seconds, and errors when background sync and your own edits wrote to the database at the same time.

### Removed
- The end-to-end encrypted relay. Group data is now stored on the sync server so new members can download a group's full history.

## 1.4.1 — 2026-10-04

### New & Architecture
- **Cloudflare Worker SQLite Queue Sync Engine (`RelayRoom`).** Upgraded the relay server from basic WebSocket forwarding to a stateful, zero-knowledge SQLite queue coordinator running on Cloudflare Durable Objects SQLite.
- **Strict Peer Watermark Tracking & Auto Queue Pruning.** Monotonically sequenced event queue with automatic payload purging once all active peers in a group acknowledge receipt of changes, guaranteeing zero server payload retention.
- **Hybrid Sync (HTTP REST + Real-Time WebSocket).** Added endpoints (`/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/request-snapshot`, `/sync/peers`) alongside `/ws` for 100% reliable offline queueing, backpressure handling, and immediate convergence.
- **Automated GitHub Action Cloud Builds.** Pushing a commit containing `[build]`, `[apk]`, or `[release]` automatically triggers cloud APK builds and release updates.

### Fixed & Improved
- **Group Invite Creator Preservation.** Invite links and QR codes now carry `creatorId`, `creatorName`, and permission model parameters so joining members are correctly bound to non-creator roles and cannot tamper with group settings or assume admin privileges.
- **Contributor Role Permission Enforcement.** In Contributor Mode, members can add expenses and edit/delete **only their own transactions**. Only the group creator/admin can edit or delete everyone's transactions. Group settings modifications are strictly guarded to the group admin.
- **Non-blocking Test Suite.** WebSocket cleanup and timer unreferencing to ensure clean, fast test suite runs.

## 1.4.0 — 2026-10-04

### New
- **3 Group Permission & Role Models.** Choose how group members collaborate:
  1. **👑 Admin Only (Broadcast Mode):** Only the creator/admin can add, edit, or delete transactions and modify group settings. Joined peers have a clean read-only view.
  2. **✍️ Contributor Mode:** Creator has full administrative control; joined members can add new expenses and payments, but cannot edit or delete existing ones.
  3. **🤝 Collaborative Mode (Default):** All members can add and update transactions. Deletion is strictly protected: only the author who created the transaction or the group creator can delete it.
- **Audit Trail & Attribution Tracking.** Transactions track and display both the original creator (*Created by Alice*) and the last editor (*Last updated by Bob*), synchronized across peers in real time.
- **Batched Lazy Syncing for High-Volume Groups.** Automatic chunked streaming (25 transactions per batch) with progress tracking during P2P state restoration, ensuring fault tolerance and zero relay buffer exhaustion even for groups with thousands of records.
- **WebSocket Keepalive Ping/Pong.** Relay server sends periodic 45-second heartbeat pings to keep long-lived connections open through NATs, firewalls, and mobile carrier proxies.

### Improved
- **Permission-Guarded UI.** Group screens, floating action bars, and transaction detail views dynamically adapt based on the user's role and permission model.
- **Group Settings Control.** Group creators can seamlessly switch permission models in Group Settings, instantly broadcasting the updated permissions to all connected peers.
- **Comprehensive Test Suite.** Expanded to 31 unit and integration tests covering all 3 permission models, audit trails, chunked state transfer, and P2P conflict resolution.

---

## 1.3.0 — 2026-10-04

### New
- **P2P Full Group State Hydration & Restoration (`REQUEST_STATE` & `STATE_SNAPSHOT`).** Joining or restoring a group after reinstallation automatically requests full state from active peers over the zero-knowledge E2EE relay, downloading all past transactions, splits, members, and categories without any central database.
- **Member Identity Binding on Join ("Who Are You?").** When opening an invite link or scanning a QR code, the join screen displays existing members so you can bind your device identity directly to your member record (e.g. *Ikram*), taking ownership of your past expenses and balances immediately.
- **Member Merging & Reassignment (`MERGE_MEMBERS`).** Consolidate placeholder or duplicate members in **Group Members** with automatic re-assignment of all past payments, expenses, and split shares, synchronized in real time to all peers.
- **EAS Auto-Incrementing Build Versioning.** Configured EAS preview build profile to automatically increment Android version codes, allowing seamless in-place APK updates without uninstalling or losing local SQLite data.

### Improved
- **Automatic Group Sync Key Auto-Healing.** Opening any group automatically ensures a persistent 256-bit AES-GCM encryption key is assigned and saved, preventing empty key parameters in QR codes and invite links.
- **Invite Links with Member Manifest.** Group invite links and QR codes now include member names, providing instant preview chips on the join screen before connecting.
- **Test Suite.** Expanded to 24 automated tests covering core maths, database migrations, 256-bit AES encryption, multi-device P2P state hydration, member merging, QR matrix encoding, and deep linking.

---

## 1.2.0 — 2026-10-03

### New
- **On-Device Cryptographic Accounts & Identity.** No email, password or phone number needed. Your identity and private keys are generated and stored 100% on your device.
- **End-to-End Encrypted (E2EE) Remote Sync.** Groups have a private 256-bit AES-GCM encryption key. When connected to Wi-Fi or cellular networks, expenses, payments and edits synchronize in real time across group members through a blind, zero-knowledge relay.
- **SQLite Durable Objects Relay Coordination.** Upgraded the Cloudflare Worker relay to SQLite-backed Durable Objects (`RelayRoom`), guaranteeing that all peers in a group room connect to the exact same coordinator instance worldwide for zero-latency broadcasting and event replay.
- **Native Camera QR Code Scanner.** Scan group invites directly within the app using the built-in camera QR scanner with automatic viewfinder and permission handling.
- **Universal QR Code & Deep Link Invites.** Tap **Invite** in any group header to display an ISO/IEC 18004 compliant QR code or share an invite link (`https://splitmate-relay.rn45819.workers.dev/join?...` / `splitmate://join?...`).
- **Dedicated `/join` Screen & Web Landing Page.** Opening an invite link automatically opens the group preview with a 1-tap join button, preserving the group UID and encryption keys.
- **In-App Sync Notifications & Activity Feed.** Get real-time alerts when friends record an expense, payment, or settlement, viewable in Settings and Group screens.
- **Transaction Author Badges.** Expense and payment cards clearly display who recorded each transaction (e.g. *Added by Sara*, *Recorded by Bob*).
- **Pre-configured Default Cloudflare Relay.** Pre-configured with built-in relay (`wss://splitmate-relay.rn45819.workers.dev/ws`) with automatic fallback and custom server override options in Settings.
- **Standalone Cloudflare Worker Relay.** Includes a zero-knowledge WebSocket relay server in `relay/` that can be deployed directly from GitHub or local CLI to Cloudflare Workers free tier.

### Improved
- **Relay Observability & Logging.** Configured invocation logging in `wrangler.toml` for real-time traffic observability and diagnostics in the Cloudflare dashboard.
- **Cloudflare CI/CD Deterministic Builds.** Added `relay/package-lock.json` and SQLite migration configuration for push-to-deploy Git builds in Cloudflare Workers & Pages.
- **Header Navigation UI.** Responsive, distinguished glassmorphic pill buttons (`HeaderButton`) across Home and Group screens with touch feedback and balanced mobile hit-slop.
- **Import Screen.** Enhanced with a dedicated **📷 Scan QR Code** button and **Join via Invite Link** input alongside JSON file imports.

### Fixed
- **Missing Encryption Key on Existing Groups.** Fixed an issue where groups created before E2EE sync was enabled would generate QR codes with empty `key=` query parameters.
- **JSON Import Decimal Precision.** Fixed an issue where amounts imported from JSON files were scaled down by two decimal places (e.g., 15000 became 150.00).

---

## 1.1.0 — 2026-10-03

### New
- **Sample groups to get you started.** New installs open with three example groups that show how SplitMate is used: *Murree Weekend Trip* (friends' trip, different ways of splitting), *Flat 4B — Shared Home* (three months of rent and bills) and *Dubai Family Holiday* (a trip in AED, split by family size). Remove them in one tap from the home screen, or add them again from **Settings → Getting started**.
- **Your own categories.** Tap **+ New** under Category when adding an expense to create categories like "Gym" or "School fees". Long-press one to remove it.
- **Every world currency.** Groups can now use any of about 160 currencies. Common ones are one tap away; search for the rest by name or code (e.g. "rupee", "LKR").
- **Calendar date picker.** Expense and payment dates are chosen from an in-app calendar, with quick Today and Yesterday buttons.

### Improved
- **Expense list shows everything at a glance.** Each expense shows its category icon, who paid, how it was split, each person's share, the note, and what it means for you ("You lent…", "You owe…"). Payments show who paid whom.
- **Insights reorganised.** A clear headline total, a new *Your money* section (what you paid against your share), an *At a glance* summary, categories with their change from the previous period, and spending by group.
- **Consistent look.** Messages, confirmations and the transaction details screen now match the rest of the app.
- **Typing is never hidden.** The screen scrolls so the field you are typing in stays above the keyboard.

---

## 1.0.0

- First release: offline groups, four ways to split expenses, balances and settle-up suggestions, insights, PDF and Excel reports, sharing groups as files, backups and an optional PIN lock.
