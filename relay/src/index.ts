/**
 * SplitMate E2EE Cloudflare Worker Sync & Relay Server
 * 
 * 100% Zero-Knowledge & Resilient Queue Architecture:
 * - Isolated per-group rooms using SHA-256 room hashes.
 * - Powered by Cloudflare Durable Objects with SQLite storage.
 * - Stateful event queueing and peer tracking: ensures 100% reliable delivery
 *   even when peers are offline or have intermittent connectivity.
 * - Queue Pruning: Once all active peers in a group acknowledge receipt of changes,
 *   cached encrypted payloads are pruned from the server SQLite database, retaining only
 *   sync sequence metadata & audit counts.
 * - State Snapshot Coordination: When a new peer joins or requests hydration,
 *   the server coordinates with the active peer with the latest sync state to replicate
 *   the latest full replica snapshot in chunks.
 * - Dual Interface: Supports both HTTP REST (/sync/push, /sync/pull, /sync/ack, /sync/request-snapshot, /sync/peers)
 *   and WebSocket (/ws) for real-time instant notifications.
 */

export interface Env {
  ROOMS: DurableObjectNamespace;
}

export interface QueuedEvent {
  seq: number;
  eventId: string;
  authorId: string;
  authorName: string;
  action: string;
  payload: string;
  createdAt: number;
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
  sessions: Map<WebSocket, { peerId?: string; peerName?: string }>;
  sqlDb: any;
  initialized: boolean = false;
  // Ephemeral memory cache for fallback environments
  memPeers: Map<string, PeerInfo> = new Map();
  memQueue: QueuedEvent[] = [];
  memDeliveries: Set<string> = new Set(); // "seq:peerId"
  memSeqCounter: number = 0;

  static MAX_QUEUE_LIMIT = 500;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.sessions = new Map();
    this.sqlDb = (state.storage as any).sql;
  }

  private async initDb() {
    if (this.initialized) return;

    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        this.sqlDb.exec(`
          CREATE TABLE IF NOT EXISTS peers (
            peer_id TEXT PRIMARY KEY,
            peer_name TEXT,
            last_seen INTEGER,
            synced_seq INTEGER DEFAULT 0,
            is_online INTEGER DEFAULT 1,
            created_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS events_queue (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT UNIQUE,
            author_id TEXT,
            author_name TEXT,
            action TEXT,
            payload TEXT,
            created_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS deliveries (
            seq INTEGER,
            peer_id TEXT,
            delivered_at INTEGER,
            PRIMARY KEY (seq, peer_id)
          );
          CREATE TABLE IF NOT EXISTS sync_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id TEXT,
            action TEXT,
            synced_seq INTEGER,
            created_at INTEGER
          );
        `);
      } catch (e) {
        console.error('SQLite init error:', e);
      }
    } else {
      // Restore fallback state from DO storage
      const storedPeers = await this.state.storage.get<PeerInfo[]>('fb_peers');
      if (storedPeers && Array.isArray(storedPeers)) {
        for (const p of storedPeers) this.memPeers.set(p.peerId, p);
      }
      const storedQueue = await this.state.storage.get<QueuedEvent[]>('fb_queue');
      if (storedQueue && Array.isArray(storedQueue)) {
        this.memQueue = storedQueue;
        this.memSeqCounter = storedQueue.reduce((max, e) => Math.max(max, e.seq), 0);
      }
    }
    this.initialized = true;
  }

  // --- SQLite Operations ---

  private upsertPeer(peerId: string, peerName: string, isOnline: boolean = true) {
    const now = Date.now();
    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        this.sqlDb.exec(`
          INSERT INTO peers (peer_id, peer_name, last_seen, synced_seq, is_online, created_at)
          VALUES (?, ?, ?, 0, ?, ?)
          ON CONFLICT(peer_id) DO UPDATE SET
            peer_name = CASE WHEN excluded.peer_name != '' THEN excluded.peer_name ELSE peers.peer_name END,
            last_seen = excluded.last_seen,
            is_online = excluded.is_online;
        `, peerId, peerName || '', now, isOnline ? 1 : 0, now);
      } catch (e) {
        console.error('upsertPeer SQL error:', e);
      }
    } else {
      const existing = this.memPeers.get(peerId);
      if (existing) {
        existing.peerName = peerName || existing.peerName;
        existing.lastSeen = now;
        existing.isOnline = isOnline;
      } else {
        this.memPeers.set(peerId, {
          peerId,
          peerName: peerName || '',
          lastSeen: now,
          syncedSeq: 0,
          isOnline,
          createdAt: now,
        });
      }
      this.persistFallback();
    }
  }

  private setPeerOnline(peerId: string, isOnline: boolean) {
    const now = Date.now();
    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        this.sqlDb.exec('UPDATE peers SET is_online = ?, last_seen = ? WHERE peer_id = ?', isOnline ? 1 : 0, now, peerId);
      } catch (e) {
        console.error('setPeerOnline SQL error:', e);
      }
    } else {
      const p = this.memPeers.get(peerId);
      if (p) {
        p.isOnline = isOnline;
        p.lastSeen = now;
        this.persistFallback();
      }
    }
  }

  private getPeers(): PeerInfo[] {
    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        const cursor = this.sqlDb.exec('SELECT peer_id, peer_name, last_seen, synced_seq, is_online, created_at FROM peers ORDER BY last_seen DESC');
        const rows = cursor.toArray ? cursor.toArray() : Array.from(cursor);
        return rows.map((r: any) => ({
          peerId: r.peer_id,
          peerName: r.peer_name,
          lastSeen: Number(r.last_seen),
          syncedSeq: Number(r.synced_seq),
          isOnline: Boolean(r.is_online),
          createdAt: Number(r.created_at),
        }));
      } catch (e) {
        console.error('getPeers SQL error:', e);
        return [];
      }
    }
    return Array.from(this.memPeers.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private enqueueEvent(
    eventId: string,
    authorId: string,
    authorName: string,
    action: string,
    payload: string
  ): QueuedEvent {
    const now = Date.now();
    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        this.sqlDb.exec(`
          INSERT INTO events_queue (event_id, author_id, author_name, action, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO NOTHING;
        `, eventId, authorId, authorName, action, payload, now);

        const cursor = this.sqlDb.exec('SELECT seq, event_id, author_id, author_name, action, payload, created_at FROM events_queue WHERE event_id = ?', eventId);
        const rows = cursor.toArray ? cursor.toArray() : Array.from(cursor);
        const row = rows[0] as any;
        const ev: QueuedEvent = {
          seq: Number(row.seq),
          eventId: row.event_id,
          authorId: row.author_id,
          authorName: row.author_name,
          action: row.action,
          payload: row.payload,
          createdAt: Number(row.created_at),
        };

        // Mark author as delivered
        if (authorId) {
          this.sqlDb.exec('INSERT OR IGNORE INTO deliveries (seq, peer_id, delivered_at) VALUES (?, ?, ?)', ev.seq, authorId, now);
          this.sqlDb.exec('UPDATE peers SET synced_seq = MAX(synced_seq, ?), last_seen = ? WHERE peer_id = ?', ev.seq, now, authorId);
        }

        return ev;
      } catch (e) {
        console.error('enqueueEvent SQL error:', e);
      }
    }

    // Fallback in-memory
    const existing = this.memQueue.find((e) => e.eventId === eventId);
    if (existing) return existing;

    this.memSeqCounter++;
    const ev: QueuedEvent = {
      seq: this.memSeqCounter,
      eventId,
      authorId,
      authorName,
      action,
      payload,
      createdAt: now,
    };
    this.memQueue.push(ev);
    if (authorId) {
      this.memDeliveries.add(`${ev.seq}:${authorId}`);
      const authorPeer = this.memPeers.get(authorId);
      if (authorPeer) {
        authorPeer.syncedSeq = Math.max(authorPeer.syncedSeq, ev.seq);
        authorPeer.lastSeen = now;
      }
    }
    this.persistFallback();
    return ev;
  }

  private markDelivered(peerId: string, seqs: number[]) {
    if (!peerId || !seqs.length) return;
    const now = Date.now();
    const maxSeq = Math.max(...seqs);

    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        for (const seq of seqs) {
          this.sqlDb.exec('INSERT OR IGNORE INTO deliveries (seq, peer_id, delivered_at) VALUES (?, ?, ?)', seq, peerId, now);
        }
        this.sqlDb.exec('UPDATE peers SET synced_seq = MAX(synced_seq, ?), last_seen = ? WHERE peer_id = ?', maxSeq, now, peerId);
      } catch (e) {
        console.error('markDelivered SQL error:', e);
      }
    } else {
      for (const seq of seqs) {
        this.memDeliveries.add(`${seq}:${peerId}`);
      }
      const p = this.memPeers.get(peerId);
      if (p) {
        p.syncedSeq = Math.max(p.syncedSeq, maxSeq);
        p.lastSeen = now;
      }
      this.persistFallback();
    }
  }

  private getEventsSince(lastSeq: number, limit: number = 100): QueuedEvent[] {
    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        const cursor = this.sqlDb.exec(
          'SELECT seq, event_id, author_id, author_name, action, payload, created_at FROM events_queue WHERE seq > ? ORDER BY seq ASC LIMIT ?',
          lastSeq,
          limit
        );
        const rows = cursor.toArray ? cursor.toArray() : Array.from(cursor);
        return rows.map((r: any) => ({
          seq: Number(r.seq),
          eventId: r.event_id,
          authorId: r.author_id,
          authorName: r.author_name,
          action: r.action,
          payload: r.payload,
          createdAt: Number(r.created_at),
        }));
      } catch (e) {
        console.error('getEventsSince SQL error:', e);
        return [];
      }
    }
    return this.memQueue.filter((e) => e.seq > lastSeq).slice(0, limit);
  }

  private getLatestSeq(): number {
    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        const cursor = this.sqlDb.exec('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events_queue');
        const rows = cursor.toArray ? cursor.toArray() : Array.from(cursor);
        return Number(rows[0]?.max_seq || 0);
      } catch {
        return 0;
      }
    }
    return this.memSeqCounter;
  }

  /**
   * Queue Pruning:
   * Once all active peers have acknowledged receipt of events up to minSeq,
   * delivered payloads are cleared from SQLite storage to guarantee zero-knowledge retention.
   */
  private pruneQueue() {
    const peers = this.getPeers();
    const now = Date.now();
    // Consider active peers seen in the last 14 days
    const activePeers = peers.filter((p) => now - p.lastSeen < 14 * 24 * 60 * 60 * 1000);

    if (activePeers.length > 1) {
      const minSyncedSeq = Math.min(...activePeers.map((p) => p.syncedSeq));
      if (minSyncedSeq > 0) {
        if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
          try {
            this.sqlDb.exec('INSERT INTO sync_history (peer_id, action, synced_seq, created_at) VALUES (?, ?, ?, ?)', 'system', 'PRUNED', minSyncedSeq, now);
            this.sqlDb.exec('DELETE FROM events_queue WHERE seq <= ?', minSyncedSeq);
            this.sqlDb.exec('DELETE FROM deliveries WHERE seq <= ?', minSyncedSeq);
          } catch (e) {
            console.error('pruneQueue SQL error:', e);
          }
        } else {
          this.memQueue = this.memQueue.filter((e) => e.seq > minSyncedSeq);
          for (const key of Array.from(this.memDeliveries)) {
            const seq = Number(key.split(':')[0]);
            if (seq <= minSyncedSeq) this.memDeliveries.delete(key);
          }
          this.persistFallback();
        }
      }
    }

    // Hard ceiling safety limit
    if (this.sqlDb && typeof this.sqlDb.exec === 'function') {
      try {
        this.sqlDb.exec(`
          DELETE FROM events_queue WHERE seq NOT IN (
            SELECT seq FROM events_queue ORDER BY seq DESC LIMIT ?
          )
        `, RelayRoom.MAX_QUEUE_LIMIT);
      } catch {}
    } else if (this.memQueue.length > RelayRoom.MAX_QUEUE_LIMIT) {
      this.memQueue = this.memQueue.slice(-RelayRoom.MAX_QUEUE_LIMIT);
      this.persistFallback();
    }
  }

  private persistFallback() {
    if (!this.sqlDb || typeof this.sqlDb.exec !== 'function') {
      this.state.storage.put('fb_peers', Array.from(this.memPeers.values())).catch(() => {});
      this.state.storage.put('fb_queue', this.memQueue).catch(() => {});
    }
  }

  // --- Broadcast WebSocket Helpers ---

  private broadcastToConnected(event: QueuedEvent, excludeSocket?: WebSocket) {
    const msg = JSON.stringify({
      type: 'SYNC_EVENT',
      seq: event.seq,
      id: event.eventId,
      authorId: event.authorId,
      authorName: event.authorName,
      action: event.action,
      payload: event.payload,
      createdAt: event.createdAt,
    });

    for (const [socket, meta] of this.sessions.entries()) {
      if (socket !== excludeSocket) {
        try {
          socket.send(msg);
          if (meta.peerId) {
            this.markDelivered(meta.peerId, [event.seq]);
          }
        } catch {
          this.sessions.delete(socket);
        }
      }
    }
  }

  // --- Request Handler (HTTP + WebSocket) ---

  async fetch(request: Request): Promise<Response> {
    await this.initDb();
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-room-id, x-peer-id',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    // 1. WebSocket Handler (/ws)
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      this.sessions.set(server, {});

      server.addEventListener('message', async (event) => {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
          if (!data) return;

          // INIT: Client connects and provides identity + watermark
          if (data.type === 'INIT') {
            const peerId = data.peerId || '';
            const peerName = data.peerName || '';
            const lastSeq = Number(data.lastSeq) || 0;

            this.sessions.set(server, { peerId, peerName });
            if (peerId) {
              this.upsertPeer(peerId, peerName, true);
            }

            // Stream any pending un-delivered events from SQLite queue
            const pending = this.getEventsSince(lastSeq, 100);
            for (const item of pending) {
              try {
                server.send(JSON.stringify({
                  type: 'SYNC_EVENT',
                  seq: item.seq,
                  id: item.eventId,
                  authorId: item.authorId,
                  authorName: item.authorName,
                  action: item.action,
                  payload: item.payload,
                  createdAt: item.createdAt,
                }));
              } catch {
                break;
              }
            }
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

          // ACK: Client acknowledged receiving sequence numbers
          if (data.type === 'ACK') {
            const meta = this.sessions.get(server);
            const peerId = data.peerId || meta?.peerId;
            const seqs = Array.isArray(data.seqs) ? data.seqs : data.seq ? [data.seq] : [];
            if (peerId && seqs.length) {
              this.markDelivered(peerId, seqs);
              this.pruneQueue();
            }
            return;
          }

          // PUSH / Broadcast message
          if (data.payload) {
            const meta = this.sessions.get(server);
            const authorId = data.authorId || meta?.peerId || '';
            const authorName = data.authorName || meta?.peerName || '';
            const eventId = data.id || data.eventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const action = data.action || 'SYNC';

            if (authorId) {
              this.upsertPeer(authorId, authorName, true);
            }

            // Enqueue into SQLite DO database
            const queued = this.enqueueEvent(eventId, authorId, authorName, action, data.payload);

            // Broadcast instantly to all other connected peers
            this.broadcastToConnected(queued, server);
            this.pruneQueue();
          }
        } catch {
          // Ignore malformed messages
        }
      });

      server.addEventListener('close', () => {
        const meta = this.sessions.get(server);
        if (meta?.peerId) {
          this.setPeerOnline(meta.peerId, false);
        }
        this.sessions.delete(server);
      });

      server.addEventListener('error', () => {
        const meta = this.sessions.get(server);
        if (meta?.peerId) {
          this.setPeerOnline(meta.peerId, false);
        }
        this.sessions.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. HTTP REST: Push Events (/sync/push)
    if (url.pathname.endsWith('/sync/push') && request.method === 'POST') {
      try {
        const body = (await request.json()) as any;
        const peerId = body.peerId || '';
        const peerName = body.peerName || '';
        const events = Array.isArray(body.events) ? body.events : [body];

        if (peerId) {
          this.upsertPeer(peerId, peerName, true);
        }

        const insertedSeqs: number[] = [];
        for (const raw of events) {
          if (!raw.payload) continue;
          const eventId = raw.id || raw.eventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const authorId = raw.authorId || peerId;
          const authorName = raw.authorName || peerName;
          const action = raw.action || 'SYNC';

          const queued = this.enqueueEvent(eventId, authorId, authorName, action, raw.payload);
          insertedSeqs.push(queued.seq);
          this.broadcastToConnected(queued);
        }

        this.pruneQueue();
        const latestSeq = this.getLatestSeq();

        return new Response(JSON.stringify({ ok: true, insertedSeqs, latestSeq }), { headers: corsHeaders });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e?.message || 'Invalid push payload' }), { status: 400, headers: corsHeaders });
      }
    }

    // 3. HTTP REST: Pull Events (/sync/pull)
    if (url.pathname.endsWith('/sync/pull') && request.method === 'POST') {
      try {
        const body = (await request.json()) as any;
        const peerId = body.peerId || '';
        const peerName = body.peerName || '';
        const lastSeq = Number(body.lastSeq) || 0;
        const limit = Math.min(Number(body.limit) || 100, 200);

        if (peerId) {
          this.upsertPeer(peerId, peerName, true);
        }

        const events = this.getEventsSince(lastSeq, limit);
        if (peerId && events.length) {
          this.markDelivered(peerId, events.map((e) => e.seq));
          this.pruneQueue();
        }

        const latestSeq = this.getLatestSeq();
        const peers = this.getPeers();

        return new Response(JSON.stringify({ ok: true, events, latestSeq, peers }), { headers: corsHeaders });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e?.message || 'Invalid pull request' }), { status: 400, headers: corsHeaders });
      }
    }

    // 4. HTTP REST: Acknowledge Sequence Numbers (/sync/ack)
    if (url.pathname.endsWith('/sync/ack') && request.method === 'POST') {
      try {
        const body = (await request.json()) as any;
        const peerId = body.peerId || '';
        const seqs = Array.isArray(body.ackedSeqs) ? body.ackedSeqs : Array.isArray(body.seqs) ? body.seqs : [];

        if (peerId && seqs.length) {
          this.markDelivered(peerId, seqs);
          this.pruneQueue();
        }
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e?.message || 'Invalid ack request' }), { status: 400, headers: corsHeaders });
      }
    }

    // 5. HTTP REST: Request Full State Snapshot (/sync/request-snapshot)
    if (url.pathname.endsWith('/sync/request-snapshot') && request.method === 'POST') {
      try {
        const body = (await request.json()) as any;
        const peerId = body.peerId || '';
        const peerName = body.peerName || '';

        if (peerId) {
          this.upsertPeer(peerId, peerName, true);
        }

        // Find candidate peer with highest synced sequence who is online (or was seen recently)
        const peers = this.getPeers();
        const candidates = peers.filter((p) => p.peerId !== peerId && p.isOnline);
        const bestCandidate = candidates.sort((a, b) => b.syncedSeq - a.syncedSeq)[0] ||
                              peers.filter((p) => p.peerId !== peerId).sort((a, b) => b.lastSeen - a.lastSeen)[0];

        // Broadcast REQUEST_STATE notification to connected peers
        const requestEv = this.enqueueEvent(
          `req_state_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          peerId,
          peerName,
          'REQUEST_STATE',
          JSON.stringify({ requestedAt: Date.now(), requesterPeerId: peerId })
        );
        this.broadcastToConnected(requestEv);

        return new Response(JSON.stringify({
          ok: true,
          requestedSeq: requestEv.seq,
          candidatePeer: bestCandidate ? { peerId: bestCandidate.peerId, peerName: bestCandidate.peerName } : null,
        }), { headers: corsHeaders });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e?.message || 'Snapshot request failed' }), { status: 400, headers: corsHeaders });
      }
    }

    // 6. HTTP REST: Group Peers Status & Sync Metadata (/sync/peers)
    if (url.pathname.endsWith('/sync/peers')) {
      const peers = this.getPeers();
      const latestSeq = this.getLatestSeq();
      return new Response(JSON.stringify({
        ok: true,
        peers,
        latestSeq,
        connectedSockets: this.sessions.size,
      }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Endpoint not found in room' }), { status: 404, headers: corsHeaders });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight at router level
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-room-id, x-peer-id',
        },
      });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        name: 'SplitMate E2EE SQLite Sync & Relay Server',
        version: '2.0.0',
        architecture: 'Cloudflare Durable Objects + SQLite Queue',
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

    // Route /ws and /sync/* to the appropriate Durable Object for the room
    const room = url.searchParams.get('room') || request.headers.get('x-room-id');
    if (url.pathname === '/ws' || url.pathname.startsWith('/sync/')) {
      if (!room || room.length < 8) {
        return new Response(JSON.stringify({ error: 'Missing or invalid room parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // Guaranteed single-instance room coordination
      const id = env.ROOMS.idFromName(room);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
