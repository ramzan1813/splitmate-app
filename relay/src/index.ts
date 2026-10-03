/**
 * SplitMate E2EE Cloudflare Worker Relay Server
 * 
 * 100% Zero-Knowledge:
 * - Rooms are isolated using SHA-256 room hashes.
 * - Managed via Cloudflare Durable Objects for guaranteed single-instance room coordination.
 * - All forwarded messages are encrypted AES-GCM payloads.
 * - Zero plaintext data, zero passwords, and zero analytics are stored on the server.
 */

export interface Env {
  ROOMS: DurableObjectNamespace;
}

export class RelayRoom {
  state: DurableObjectState;
  sessions: Set<WebSocket>;
  queue: Array<{ id: string; payload: string; timestamp: number }>;
  static MAX_QUEUE_SIZE = 50;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.sessions = new Set();
    this.queue = [];
  }

  async fetch(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    this.sessions.add(server);

    // Send recent queued events upon joining
    for (const item of this.queue) {
      try {
        server.send(JSON.stringify({ type: 'SYNC_EVENT', payload: item.payload }));
      } catch {
        // ignore
      }
    }

    server.addEventListener('message', (event) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
        if (!data || !data.payload) return;

        // Store in ephemeral room history queue
        this.queue.push({ id: data.id || Math.random().toString(), payload: data.payload, timestamp: Date.now() });
        if (this.queue.length > RelayRoom.MAX_QUEUE_SIZE) this.queue.shift();

        // Broadcast encrypted blob to all other connected peers in the room
        const messageStr = JSON.stringify({ type: 'SYNC_EVENT', payload: data.payload });
        for (const socket of Array.from(this.sessions)) {
          if (socket !== server) {
            try {
              socket.send(messageStr);
            } catch {
              this.sessions.delete(socket);
            }
          }
        }
      } catch {
        // Ignore invalid JSON payloads
      }
    });

    server.addEventListener('close', () => {
      this.sessions.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', name: 'SplitMate E2EE Relay', version: '1.0.0' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/join') {
      const search = url.searchParams;
      const groupName = search.get('name') ? decodeURIComponent(search.get('name')!) : 'SplitMate Group';
      const currency = search.get('cur') || 'USD';
      const deepLink = `splitmate://join?${search.toString()}`;

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join SplitMate Group</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #F8FAFC; margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; box-sizing: border-box; }
    .card { background: #1E293B; border-radius: 20px; padding: 32px 24px; max-width: 400px; width: 100%; text-align: center; border: 1px solid #334155; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    h1 { font-size: 22px; margin: 0 0 8px; color: #fff; }
    p { color: #94A3B8; font-size: 14px; line-height: 1.5; margin: 0 0 20px; }
    .info-box { background: #0F172A; border-radius: 12px; padding: 14px; margin-bottom: 20px; text-align: left; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
    .info-row:last-child { margin-bottom: 0; }
    .info-label { color: #94A3B8; }
    .info-val { font-weight: 700; color: #F8FAFC; }
    .btn { display: block; background: #0F766E; color: #fff; text-decoration: none; padding: 14px 20px; border-radius: 12px; font-weight: 700; font-size: 15px; margin-bottom: 10px; border: none; cursor: pointer; width: 100%; box-sizing: border-box; }
    .btn-outline { background: transparent; border: 1px solid #475569; color: #CBD5E1; }
    .badge { display: inline-block; background: rgba(16, 185, 129, 0.15); color: #10B981; font-weight: 700; padding: 4px 10px; border-radius: 20px; font-size: 12px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 40px; margin-bottom: 8px;">🤝</div>
    <div class="badge">🔒 End-to-End Encrypted</div>
    <h1>Join ${groupName}</h1>
    <p>You were invited to sync expenses in SplitMate.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Group Name:</span><span class="info-val">${groupName}</span></div>
      <div class="info-row"><span class="info-label">Currency:</span><span class="info-val">${currency}</span></div>
    </div>
    <a href="${deepLink}" class="btn">📱 Open in SplitMate App</a>
    <button class="btn btn-outline" onclick="navigator.clipboard.writeText('${deepLink}'); alert('Invite link copied!');">📋 Copy App Link</button>
  </div>
  <script>
    window.location.href = "${deepLink}";
  </script>
</body>
</html>`;

      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      const room = url.searchParams.get('room');
      if (!room || room.length < 8) {
        return new Response('Missing or invalid room parameter', { status: 400 });
      }

      // Route all WebSockets for this room to the exact same Durable Object instance
      const id = env.ROOMS.idFromName(room);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
