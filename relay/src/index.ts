/**
 * SplitMate Cloudflare Worker Synchronization & Relay Coordinator
 * 
 * Architecture:
 * - Powered by Cloudflare Workers & Durable Objects with SQLite storage.
 * - Server-Authoritative Coordination for Offline-First Mobile Clients.
 * - Endpoints:
 *   - GET  /sync/bootstrap/:groupId
 *   - GET  /sync/changes/:groupId?after=<sequence>
 *   - POST /sync/push
 *   - GET  /sync/peers
 *   - GET  /ws (WebSocket Realtime Notification Channel)
 *   - GET  /join (Universal Join Deep Link Page)
 *   - GET  /health (Status & Health Check)
 */

import { ServerDB, createDurableObjectDb, createServerDb } from './db';
import { handleSyncApiRequest, ServerApiRequest } from './api';
import { serverRealtimeHub, RealtimeNotification } from './realtimeHub';
import { getLatestServerSequence } from './syncService';

export interface Env {
  ROOMS: DurableObjectNamespace;
}

export interface PeerInfo {
  peerId: string;
  peerName: string;
  lastSeen: number;
  syncedSeq: number;
  isOnline: boolean;
  createdAt: number;
}

export class RelayRoom {
  state: DurableObjectState;
  sessions: Map<WebSocket, { peerId?: string; peerName?: string; groupUid?: string }>;
  db: ServerDB;
  initialized: boolean = false;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.sessions = new Map();

    const sqlStorage = (state.storage as any)?.sql;
    if (sqlStorage && typeof sqlStorage.exec === 'function') {
      this.db = createDurableObjectDb(sqlStorage);
    } else {
      this.db = createServerDb(':memory:');
    }
  }

  private async init() {
    if (this.initialized) return;
    this.initialized = true;
  }

  // --- Realtime WebSocket Broadcasting ---

  private broadcastNotification(groupUid: string, notification: RealtimeNotification, excludeSocket?: WebSocket) {
    const msg = JSON.stringify(notification);
    for (const [socket, meta] of this.sessions.entries()) {
      if (socket !== excludeSocket && (!meta.groupUid || meta.groupUid === groupUid)) {
        try {
          socket.send(msg);
        } catch {
          this.sessions.delete(socket);
        }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.init();
      const url = new URL(request.url);

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-room-id, x-peer-id',
          },
        });
      }

      const corsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      };

      // 1. WebSocket Handler (/ws)
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const pair = new (globalThis as any).WebSocketPair();
        const client = (pair as any)[0] || Object.values(pair)[0];
        const server = (pair as any)[1] || Object.values(pair)[1];

        if (!server || !client) {
          return new Response('WebSocket pair creation failed', { status: 500 });
        }

        server.accept();
        this.sessions.set(server, {});

        server.addEventListener('message', async (event: any) => {
          try {
            const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
            if (!data) return;

            // INIT: Client connects and provides identity + group watermark
            if (data.type === 'INIT') {
              const peerId = data.peerId || '';
              const peerName = data.peerName || '';
              const groupUid = data.groupUid || url.searchParams.get('room') || '';

              this.sessions.set(server, { peerId, peerName, groupUid });
              return;
            }

            // PING / Keepalive
            if (data.type === 'PING') {
              try {
                server.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
              } catch {
                this.sessions.delete(server);
              }
              return;
            }

            // SUBSCRIBE: Subscribe to group updates
            if (data.type === 'SUBSCRIBE' && data.groupUid) {
              const meta = this.sessions.get(server) || {};
              meta.groupUid = data.groupUid;
              this.sessions.set(server, meta);
              return;
            }
          } catch {
            // Ignore malformed WebSocket messages
          }
        });

        server.addEventListener('close', () => {
          this.sessions.delete(server);
        });

        server.addEventListener('error', () => {
          this.sessions.delete(server);
        });

        return new Response(null, { status: 101, webSocket: client } as any);
      }

      // 2. REST Synchronization API Router
      let body: any = undefined;
      if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
        try {
          body = await request.json();
        } catch {
          body = undefined;
        }
      }

      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) {
        query[k] = v;
      }

      const apiReq: ServerApiRequest = {
        method: request.method as any,
        path: url.pathname,
        query,
        headers: {
          'content-type': request.headers.get('content-type') || undefined,
        },
        body,
      };

      const apiRes = handleSyncApiRequest(this.db, apiReq);

      // If mutations were pushed and accepted, broadcast realtime notification
      if (url.pathname.endsWith('/sync/push') && request.method === 'POST' && apiRes.status === 200) {
        const groupUid = body?.groupUid || (apiRes.body as any)?.groupUid;
        if (groupUid) {
          const latestSeq = getLatestServerSequence(this.db, groupUid);
          const notification: RealtimeNotification = {
            type: 'CHANGES_AVAILABLE',
            groupUid,
            latestSequence: latestSeq,
            timestamp: new Date().toISOString(),
          };
          this.broadcastNotification(groupUid, notification);
          serverRealtimeHub.publish(groupUid, notification);
        }
      }

      return new Response(JSON.stringify(apiRes.body), {
        status: apiRes.status,
        headers: {
          ...corsHeaders,
          ...apiRes.headers,
        },
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', message: err?.message || String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }
}

function createMockStorage(): any {
  const store = new Map<string, any>();
  return {
    get: async (key: string) => store.get(key),
    put: async (key: string, val: any) => store.set(key, val),
    delete: async (key: string) => store.delete(key),
    sql: null,
  };
}

const localRooms = new Map<string, RelayRoom>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight at router level
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-room-id, x-peer-id',
        },
      });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        name: 'SplitMate Offline-First Cloudflare Coordinator',
        version: '2.0.0',
        architecture: 'Cloudflare Durable Objects + SQLite Monotonic Change Engine',
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
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

    // Extract group / room identifier for Durable Object routing
    // e.g. /sync/bootstrap/:groupId, /sync/changes/:groupId, /sync/push (from body/query/headers)
    let room = url.searchParams.get('room') || request.headers.get('x-room-id');
    if (!room) {
      const match = url.pathname.match(/^\/sync\/(?:bootstrap|changes)\/([^/]+)/);
      if (match) {
        room = match[1]!;
      }
    }
    if (!room && url.pathname.startsWith('/sync/')) {
      room = 'global_sync_coordinator';
    }

    if (url.pathname === '/ws' || url.pathname.startsWith('/sync/')) {
      const targetRoom = room || 'default_room';

      if (env?.ROOMS) {
        try {
          const id = env.ROOMS.idFromName(targetRoom);
          const stub = env.ROOMS.get(id);
          return await stub.fetch(request);
        } catch (err: any) {
          console.warn('Durable Object execution error, falling back to local room:', err?.message);
        }
      }

      // Fallback local room handler
      let localRoom = localRooms.get(targetRoom);
      if (!localRoom) {
        localRoom = new RelayRoom({ storage: createMockStorage() } as any, env);
        localRooms.set(targetRoom, localRoom);
      }
      return localRoom.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
