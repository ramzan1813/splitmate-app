# SplitMate E2EE Relay Server (Cloudflare Worker)

A lightweight, zero-knowledge WebSocket relay server that routes end-to-end encrypted (E2EE) sync messages between SplitMate group members.

---

## 🔒 Security & Privacy Architecture
- **Zero Plaintext:** All payloads sent through the relay are encrypted on the user's phone using AES-GCM-256 with the group's private encryption key before transmission.
- **Zero Database Storage:** The server acts as an ephemeral relay and does not store unencrypted group data, transactions, personal names, or balances.
- **Zero Account Data:** Rooms are identified only by SHA-256 room hashes derived from group IDs. The server never knows who is communicating or what they are splitting.

---

## 🚀 Deploying from GitHub via Cloudflare Dashboard (Recommended)

You can deploy this relay directly from your GitHub repository with Cloudflare's continuous deployment (CI/CD). Every time you push changes to your repository, Cloudflare will automatically build and update your relay.

### Step 1: Connect Repository in Cloudflare Dashboard
1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. In the left sidebar, navigate to **Compute (Workers & Pages)** (or **Workers & Pages**).
3. Click **Create Application** (or **Create** button) → select the **Workers** tab.
4. Click **Connect to Git** (or **Import from Git**).
5. Authorize GitHub and select your repository: `splitmate-app` (or your repo name).

---

### Step 2: Configure Build & Deployment Settings
Fill in the deployment form with the following settings:

| Field Name | Value to Enter | Description |
|---|---|---|
| **Project Name** | `splitmate-relay` | Your worker's name (determines your worker URL) |
| **Production Branch** | `main` *(or `feat/sync-relay`)* | The branch Cloudflare will deploy from |
| **Root Directory** | `relay` | Specifies that the worker code is in the `relay/` subfolder |
| **Build Command** | `npx wrangler deploy --dry-run` *(or leave default)* | Validates the worker configuration during build |
| **Deploy Command** | `npx wrangler deploy` *(or `npm run deploy`)* | Deploys the worker to Cloudflare's edge network |

Click **Save and Deploy**.

---

### Step 3: Get Your Live Relay URL
1. Once Cloudflare finishes the build (usually takes ~15 seconds), Cloudflare will display your live deployment URL, for example:
   ```text
   https://splitmate-relay.<your-subdomain>.workers.dev
   ```
2. Verify it is running by opening `https://splitmate-relay.<your-subdomain>.workers.dev/health` in your browser. You will see:
   ```json
   {"status":"ok","name":"SplitMate E2EE Relay","version":"1.0.0"}
   ```

---

### Step 4: Connect the Relay in SplitMate App
1. Replace `https://` with `wss://` and add `/ws` at the end of your worker URL:
   ```text
   wss://splitmate-relay.<your-subdomain>.workers.dev/ws
   ```
2. Open the **SplitMate** mobile app.
3. Tap the **Settings** tab (gear icon in the header or bottom bar).
4. Under **Sync Relay Server (E2EE)**, paste your WebSocket URL.
5. Tap **Save Relay URL**.

Your app is now connected to your personal, free, high-speed E2EE synchronization relay!

---

## 💻 Optional: Deploy via Local CLI (Alternative)

If you ever want to test or deploy from your local terminal instead of GitHub:

```bash
# 1. Install Wrangler
npm install -g wrangler

# 2. Login to Cloudflare
wrangler login

# 3. Deploy
cd relay
npm run deploy
```
