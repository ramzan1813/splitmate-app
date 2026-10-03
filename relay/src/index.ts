/**
 * SplitMate E2EE Cloudflare Worker Relay Server
 * 
 * 100% Zero-Knowledge:
 * - Rooms are identified by room hashes (SHA-256 of group ID).
 * - All forwarded messages are encrypted AES-GCM payloads.
 * - Zero plaintext data, zero passwords, and zero analytics are stored on the server.
 */

export interface Env {
  // Can be extended with Durable Objects or KV if persistent room history is desired.
}

// In-memory room connection pool and message backlog (ephemeral)
const rooms = new Map<string, Set<WebSocket>>();
const roomQueues = new Map<string, Array<{ id: string; payload: string; timestamp: number }>>();
const MAX_QUEUE_SIZE = 100;

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', name: 'SplitMate E2EE Relay', version: '1.0.0' }), {
        headers: { 'Content-Type': 'application/json' },
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

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();

      // Add connection to the room
      if (!rooms.has(room)) {
        rooms.set(room, new Set());
      }
      const roomSockets = rooms.get(room)!;
      roomSockets.add(server);

      // Send recent queued events upon joining
      const recentQueue = roomQueues.get(room) || [];
      for (const item of recentQueue) {
        server.send(JSON.stringify({ type: 'SYNC_EVENT', payload: item.payload }));
      }

      server.addEventListener('message', (event) => {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
          if (!data || !data.payload) return;

          // Store in room history queue
          if (!roomQueues.has(room)) roomQueues.set(room, []);
          const q = roomQueues.get(room)!;
          q.push({ id: data.id || Math.random().toString(), payload: data.payload, timestamp: Date.now() });
          if (q.length > MAX_QUEUE_SIZE) q.shift();

          // Broadcast encrypted blob to all other connected peers in the room
          const messageStr = JSON.stringify({ type: 'SYNC_EVENT', payload: data.payload });
          for (const socket of roomSockets) {
            if (socket !== server && socket.readyState === WebSocket.OPEN) {
              socket.send(messageStr);
            }
          }
        } catch {
          // Ignore invalid JSON payloads
        }
      });

      server.addEventListener('close', () => {
        roomSockets.delete(server);
        if (roomSockets.size === 0) {
          rooms.delete(room);
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not Found', { status: 404 });
  },
};
