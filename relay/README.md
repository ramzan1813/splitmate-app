# SplitMate E2EE Relay Server (Cloudflare Worker)

A lightweight, zero-knowledge WebSocket relay server that routes end-to-end encrypted (E2EE) sync messages between SplitMate group members.

---

## 🔒 Security & Privacy Architecture
- **Zero Plaintext:** All payloads sent through the relay are encrypted on the user's phone using AES-GCM-256 with the group's private encryption key before transmission.
- **Zero Database Storage:** The server acts as an ephemeral relay and does not store unencrypted group data, transactions, personal names, or balances.
- **Zero Account Data:** Rooms are identified only by SHA-256 room hashes derived from group IDs. The server never knows who is communicating or what they are splitting.

---

## 🌐 Default Built-in Relay URL

The mobile application is pre-configured with the default relay server:
- **HTTPS Health Check:** `https://splitmate-relay.rn45819.workers.dev/health`
- **Web Join Landing Page:** `https://splitmate-relay.rn45819.workers.dev/join`
- **WebSocket Sync Endpoint:** `wss://splitmate-relay.rn45819.workers.dev/ws`

---

## 🚀 Method 1: Deploy Directly from Local Terminal (Recommended & Fastest)

You can deploy the worker directly to your Cloudflare account from your computer in 3 quick steps using `npx wrangler`:

### 1. Open Terminal in the `relay` Folder
```bash
cd relay
```

### 2. Log in to Cloudflare (Only Needed Once)
Run the login command. It will open your default browser to authorize Wrangler with your free Cloudflare account:
```bash
npx wrangler login
```
*Follow the prompt in your browser to approve access.*

### 3. Deploy to Cloudflare
```bash
npx wrangler deploy
```

Wrangler will package and upload the worker to Cloudflare's global edge network in ~5 seconds and output your live URL:
```text
Uploaded splitmate-relay (2.15 KiB)
Deployed splitmate-relay triggers (https://splitmate-relay.rn45819.workers.dev)
Current Version ID: ...
```

---

## 🛠 Local Development & Live Debugging

To run and debug the relay locally on your computer:
```bash
cd relay
npx wrangler dev
```
Wrangler will start a local server at `http://localhost:8787` with live hot-reloading and console logging.

---

## 🌐 Method 2: Deploy from GitHub via Cloudflare Dashboard (CI/CD)

If you prefer Cloudflare to auto-build and deploy every time you push to GitHub:

### Step 1: Connect Repository in Cloudflare Dashboard
1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. In the left sidebar, navigate to **Compute (Workers & Pages)**.
3. Click **Create Application** → select the **Workers** tab.
4. Click **Connect to Git** (or **Import from Git**).
5. Select your repository (`splitmate-app`).

### Step 2: Configure Build Settings

| Field Name | Value to Enter |
|---|---|
| **Project Name** | `splitmate-relay` |
| **Production Branch** | `main` *(or `feat/sync-relay`)* |
| **Root Directory** | `relay` |
| **Build Command** | `npx wrangler deploy --dry-run` *(or leave blank)* |
| **Deploy Command** | `npx wrangler deploy` |

Click **Save and Deploy**.

---

## ✅ Verifying Your Deployment

1. **Test Health Endpoint:**
   Open in browser: `https://splitmate-relay.rn45819.workers.dev/health`
   You should see:
   ```json
   {"status":"ok","name":"SplitMate E2EE Relay","version":"1.0.0"}
   ```

2. **Test Join Landing Page:**
   Open in browser: `https://splitmate-relay.rn45819.workers.dev/join?name=Test%20Trip&cur=USD`
   You will see the responsive web landing page that auto-opens the SplitMate mobile app.

3. **In the SplitMate Mobile App:**
   - Go to **Settings → E2EE Remote Sync Relay**.
   - The default URL is `wss://splitmate-relay.rn45819.workers.dev/ws`.
   - If you deploy to a custom subdomain or worker name, paste your WebSocket URL and tap **Save Relay URL**.
