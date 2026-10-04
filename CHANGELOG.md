# Changelog

Release notes for each version. The release workflow copies the section matching the version in `app.json` into the GitHub Release.

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
- **Automatic Group Sync Key Auto-Healing.** Opening any group automatically ensures a persistent 256-bit AES-GCM encryption key is assigned and saved, preventing empty key parameters in QR codes and invite links.
- **Relay Observability & Logging.** Configured invocation logging in `wrangler.toml` for real-time traffic observability and diagnostics in the Cloudflare dashboard.
- **Cloudflare CI/CD Deterministic Builds.** Added `relay/package-lock.json` and SQLite migration configuration for push-to-deploy Git builds in Cloudflare Workers & Pages.
- **Header Navigation UI.** Responsive, distinguished glassmorphic pill buttons (`HeaderButton`) across Home and Group screens with touch feedback and balanced mobile hit-slop.
- **P2P Full Group State Hydration & Restoration (`REQUEST_STATE` & `STATE_SNAPSHOT`).** When a peer joins or restores a group after reinstalling, the app automatically requests full state from active peers over the zero-knowledge E2EE relay, downloading all past transactions, splits, members, and categories without any cloud database.
- **Member Identity Binding on Join.** When scanning a QR code or opening an invite, the join screen displays existing members so you can bind your device identity directly to your member record (e.g. *Ikram*), immediately taking ownership of your past expenses and balances.
- **Member Merging & Reassignment.** Merge duplicate or placeholder member records directly inside **Group Members** with full re-assignment of all past payments, expenses, and split shares, synchronized in real time to all peers (`MERGE_MEMBERS`).
- **Test Suite.** Expanded to 24 automated tests covering core maths, database migrations, 256-bit AES encryption, multi-device P2P state hydration, member merging, QR matrix encoding, and deep linking.

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
