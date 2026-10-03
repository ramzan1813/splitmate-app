# SplitMate E2EE Relay Server (Cloudflare Worker)

A lightweight, zero-knowledge WebSocket relay server that routes end-to-end encrypted sync messages between group members.

## Security & Privacy
- **Zero Plaintext:** All payloads sent through the relay are encrypted on the sender's phone using AES-GCM with the group's private encryption key before transmission.
- **Zero Database Storage:** The server acts as an ephemeral relay and does not store unencrypted group data or personal information.
- **Zero Account Data:** Rooms are identified only by SHA-256 room hashes.

## Free 1-Command Deployment to Cloudflare

1. Install Wrangler (Cloudflare CLI) if you haven't already:
   ```bash
   npm install -g wrangler
   ```

2. Login to your free Cloudflare account:
   ```bash
   wrangler login
   ```

3. Deploy from this folder:
   ```bash
   cd relay
   npm run deploy
   ```

4. Cloudflare will give you a worker URL, e.g.:
   `https://splitmate-relay.<your-subdomain>.workers.dev`

5. In the SplitMate app, go to **Settings → Sync Relay Server** and set your WebSocket URL:
   `wss://splitmate-relay.<your-subdomain>.workers.dev/ws`
