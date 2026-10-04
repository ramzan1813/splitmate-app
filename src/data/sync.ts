// End-to-End Encrypted Remote Synchronization Engine for SplitMate.
// Handles change-event creation, encryption, relay broadcast, conflict resolution, and notification dispatch.
import { getDb, Param } from './db';
import { Group, Member, Split, SyncAction, SyncEvent, SyncNotification, Transaction, TxType } from './types';
import { decryptWithKey, encryptWithKey, generateRandomHex, sha256Hex } from '../lib/crypto';
import { getIdentity } from '../lib/identity';
import { money } from '../lib/format';

type SyncListener = (event: SyncEvent, groupUid: string) => void;
const listeners = new Set<SyncListener>();

export function subscribeToSync(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners(event: SyncEvent, groupUid: string) {
  for (const l of listeners) {
    try {
      l(event, groupUid);
    } catch {
      // Ignore listener exceptions
    }
  }
}

/** Record a new outgoing sync event locally and broadcast if connected. */
export async function createSyncEvent<T>(groupUid: string, action: SyncAction, payload: T): Promise<SyncEvent<T>> {
  const db = await getDb();
  const identity = await getIdentity();
  const eventId = `evt_${Date.now().toString(16)}_${generateRandomHex(8)}`;
  const timestamp = Date.now();
  const ts = new Date().toISOString();

  const event: SyncEvent<T> = {
    eventId,
    groupUid,
    authorId: identity.id,
    authorName: identity.name,
    timestamp,
    action,
    payload,
  };

  await db.runAsync(
    `INSERT INTO sync_events (event_id, group_uid, author_id, author_name, timestamp, action, payload, synced, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [eventId, groupUid, identity.id, identity.name, timestamp, action, JSON.stringify(payload), ts]
  );

  // Trigger broadcast through active sync manager
  syncManager.broadcastEvent(groupUid, event);

  return event;
}

import { exportGroupSnapshot, exportGroupSnapshotBatches, applyGroupSnapshot, mergeMembersByName, listGroups, GroupSnapshotPayload } from './repo';

/** Payload schema for transaction sync events. */
export interface SyncTxPayload {
  txUid: string;
  type: TxType;
  title: string;
  amount: number; // in cents
  paidByName: string;
  splitType: Transaction['splitType'];
  category: string;
  note: string;
  date: string;
  splits: { memberName: string; value: number; share: number }[];
  authorId?: string;
  authorName?: string;
  updatedById?: string;
  updatedByName?: string;
  updatedTs: number;
}

/** Apply a received decrypted remote event into local SQLite. */
export async function applyRemoteSyncEvent(event: SyncEvent): Promise<boolean> {
  const db = await getDb();
  const identity = await getIdentity();

  // Skip self events
  if (event.authorId === identity.id) return false;

  // Check if event was already processed
  const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM sync_events WHERE event_id = ?', [event.eventId]);
  if (existing) return false;

  const group = await db.getFirstAsync<{ id: number; uid: string; name: string; currency: string; creator_id: string; permission_model: Group['permissionModel'] }>(
    'SELECT id, uid, name, currency, creator_id, permission_model FROM groups WHERE uid = ?',
    [event.groupUid]
  );
  if (!group) return false; // Group not found locally

  const nowIso = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    // 1. Process Event Action
    if (event.action === 'REQUEST_STATE') {
      // Peer requested full group state: schedule sending batched chunks immediately
      setTimeout(async () => {
        try {
          const batches = await exportGroupSnapshotBatches(group.id, 25);
          for (let i = 0; i < batches.length; i++) {
            const chunk = batches[i]!;
            await createSyncEvent(group.uid, 'STATE_SNAPSHOT', chunk);
            if (batches.length > 1 && i < batches.length - 1) {
              await new Promise((r) => setTimeout(r, 20));
            }
          }
        } catch {
          // ignore snapshot export errors
        }
      }, 50);
    } else if (event.action === 'JOIN_GROUP') {
      const payload = event.payload as { memberName?: string; identityId?: string };
      const newMemberName = (payload?.memberName || event.authorName || '').trim();
      if (newMemberName) {
        const existingMember = await db.getFirstAsync<{ id: number }>('SELECT id FROM members WHERE group_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))', [
          group.id,
          newMemberName,
        ]);
        if (!existingMember) {
          await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [group.id, newMemberName, nowIso]);
        }
        const msg = `${newMemberName} joined the group`;
        await db.runAsync(
          'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
          [group.uid, newMemberName, group.name, msg, nowIso]
        );
      }

      // Automatically send full snapshot to newly joined peer so they immediately get all history
      setTimeout(async () => {
        try {
          const batches = await exportGroupSnapshotBatches(group.id, 25);
          for (let i = 0; i < batches.length; i++) {
            const chunk = batches[i]!;
            await createSyncEvent(group.uid, 'STATE_SNAPSHOT', chunk);
            if (batches.length > 1 && i < batches.length - 1) {
              await new Promise((r) => setTimeout(r, 20));
            }
          }
        } catch {
          // ignore snapshot export errors
        }
      }, 50);
    } else if (event.action === 'RENAME_MEMBER') {
      const payload = event.payload as { oldName: string; newName: string };
      if (payload?.oldName && payload?.newName) {
        await db.runAsync('UPDATE members SET name = ? WHERE group_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))', [
          payload.newName,
          group.id,
          payload.oldName,
        ]);
        await db.runAsync('UPDATE transactions SET author_name = ? WHERE group_id = ? AND LOWER(TRIM(author_name)) = LOWER(TRIM(?))', [
          payload.newName,
          group.id,
          payload.oldName,
        ]);
        await db.runAsync('UPDATE transactions SET updated_by_name = ? WHERE group_id = ? AND LOWER(TRIM(updated_by_name)) = LOWER(TRIM(?))', [
          payload.newName,
          group.id,
          payload.oldName,
        ]);
        const msg = `${event.authorName} renamed "${payload.oldName}" to "${payload.newName}"`;
        await db.runAsync(
          'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
          [group.uid, event.authorName, group.name, msg, nowIso]
        );
      }
    } else if (event.action === 'ADD_MEMBER') {
      const payload = event.payload as { name: string };
      if (payload?.name) {
        const cleanName = payload.name.trim();
        const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM members WHERE group_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))', [
          group.id,
          cleanName,
        ]);
        if (!existing) {
          await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [group.id, cleanName, nowIso]);
          const msg = `${event.authorName} added member "${cleanName}"`;
          await db.runAsync(
            'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
            [group.uid, event.authorName, group.name, msg, nowIso]
          );
        }
      }
    } else if (event.action === 'DELETE_MEMBER') {
      const payload = event.payload as { memberName: string };
      if (payload?.memberName) {
        const mem = await db.getFirstAsync<{ id: number }>('SELECT id FROM members WHERE group_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))', [
          group.id,
          payload.memberName.trim(),
        ]);
        if (mem) {
          const used =
            (await db.getFirstAsync('SELECT 1 AS x FROM transactions WHERE paid_by = ? LIMIT 1', [mem.id])) ||
            (await db.getFirstAsync('SELECT 1 AS x FROM transaction_splits WHERE member_id = ? LIMIT 1', [mem.id]));
          // If member is used in transactions, keep them as a dummy record for history
          if (!used) {
            await db.runAsync('DELETE FROM members WHERE id = ? AND group_id = ?', [mem.id, group.id]);
          }
        }
      }
    } else if (event.action === 'STATE_SNAPSHOT') {
      const payload = event.payload as GroupSnapshotPayload;
      if (payload && Array.isArray(payload.transactions)) {
        const res = await applyGroupSnapshot(group.id, payload);
        const chunkInfo = payload.totalChunks && payload.totalChunks > 1
          ? ` (chunk ${(payload.chunkIndex ?? 0) + 1}/${payload.totalChunks})`
          : '';
        const msg = `${event.authorName} synchronized group history${chunkInfo} (${res.added} added, ${res.updated} updated)`;
        await db.runAsync(
          'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
          [group.uid, event.authorName, group.name, msg, nowIso]
        );
      }
    } else if (event.action === 'UPDATE_GROUP') {
      const payload = event.payload as { name?: string; description?: string; currency?: string; permissionModel?: Group['permissionModel'] };
      if (payload && (!group.creator_id || group.creator_id === event.authorId)) {
        await db.runAsync(
          "UPDATE groups SET name = COALESCE(NULLIF(?, ''), name), description = COALESCE(NULLIF(?, ''), description), currency = COALESCE(NULLIF(?, ''), currency), permission_model = COALESCE(NULLIF(?, ''), permission_model), updated_at = ? WHERE id = ?",
          [payload.name || '', payload.description || '', payload.currency || '', payload.permissionModel || '', nowIso, group.id]
        );
        const msg = `${event.authorName} updated group settings (${payload.permissionModel || group.permission_model})`;
        await db.runAsync(
          'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
          [group.uid, event.authorName, group.name, msg, nowIso]
        );
      }
    } else if (event.action === 'MERGE_MEMBERS') {
      const payload = event.payload as { sourceMemberName: string; targetMemberName: string };
      if (payload?.sourceMemberName && payload?.targetMemberName) {
        await mergeMembersByName(group.id, payload.sourceMemberName, payload.targetMemberName);
        const msg = `${event.authorName} merged member "${payload.sourceMemberName}" into "${payload.targetMemberName}"`;
        await db.runAsync(
          'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
          [group.uid, event.authorName, group.name, msg, nowIso]
        );
      }
    } else if (event.action === 'UPSERT_TX') {
      const payload = event.payload as SyncTxPayload;
      if (!payload || !payload.txUid) return;

      // Permission check for admin_only / contributor mode
      const isCreator = !group.creator_id || group.creator_id === event.authorId;
      const permModel = group.permission_model || 'collaborative';

      // Check if transaction with this txUid exists
      const existingTx = await db.getFirstAsync<{ id: number; author_id: string; updated_ts: number }>(
        'SELECT id, author_id, updated_ts FROM transactions WHERE group_id = ? AND uid = ?',
        [group.id, payload.txUid]
      );

      // Permission Enforcement:
      // In admin_only: only creator can add or edit
      if (permModel === 'admin_only' && !isCreator) return;
      // In contributor: only creator can edit other members' transactions; contributors can edit their own
      if (permModel === 'contributor' && existingTx && !isCreator && existingTx.author_id !== event.authorId) return;

      // Ensure members exist in group
      const members = await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM members WHERE group_id = ?', [group.id]);
      const nameMap = new Map<string, number>(members.map((m) => [m.name.toLowerCase().trim(), m.id]));

      // Get or create payer member
      let payerId = nameMap.get(payload.paidByName.toLowerCase().trim());
      if (!payerId) {
        const res = await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [
          group.id,
          payload.paidByName,
          nowIso,
        ]);
        payerId = res.lastInsertRowId;
        nameMap.set(payload.paidByName.toLowerCase().trim(), payerId);
      }

      // Conflict Resolution: Last-Write-Wins based on timestamp
      if (existingTx && (existingTx.updated_ts || 0) >= payload.updatedTs) {
        return; // Local version is newer or equal, ignore older remote update
      }

      let txId: number;
      if (existingTx) {
        txId = existingTx.id;
        await db.runAsync(
          `UPDATE transactions SET type = ?, title = ?, amount = ?, paid_by = ?, split_type = ?, category = ?, note = ?, date = ?, author_id = ?, author_name = ?, updated_by_id = ?, updated_by_name = ?, updated_ts = ?, updated_at = ?
           WHERE id = ?`,
          [
            payload.type,
            payload.title,
            payload.amount,
            payerId,
            payload.splitType,
            payload.category,
            payload.note,
            payload.date,
            payload.authorId || existingTx.author_id,
            payload.authorName || '',
            payload.updatedById || event.authorId,
            payload.updatedByName || event.authorName,
            payload.updatedTs,
            nowIso,
            txId,
          ]
        );
        await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [txId]);
      } else {
        const ins = await db.runAsync(
          `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name, updated_by_id, updated_by_name, updated_ts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            group.id,
            payload.txUid,
            payload.type,
            payload.title,
            payload.amount,
            payerId,
            payload.splitType,
            payload.category,
            payload.note,
            payload.date,
            payload.authorId || event.authorId,
            payload.authorName || event.authorName,
            payload.updatedById || '',
            payload.updatedByName || '',
            payload.updatedTs,
            nowIso,
            nowIso,
          ]
        );
        txId = ins.lastInsertRowId;
      }

      // Insert splits
      for (const split of payload.splits) {
        let memberId = nameMap.get(split.memberName.toLowerCase().trim());
        if (!memberId) {
          const res = await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [
            group.id,
            split.memberName,
            nowIso,
          ]);
          memberId = res.lastInsertRowId;
          nameMap.set(split.memberName.toLowerCase().trim(), memberId);
        }
        await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [
          txId,
          memberId,
          split.value,
          split.share,
        ]);
      }

      // 2. Create in-app notification
      const actionDesc = existingTx ? 'updated' : payload.type === 'payment' ? 'recorded a payment of' : 'added';
      const msg = `${event.authorName} ${actionDesc} ${payload.title} (${money(payload.amount, group.currency)})`;
      await db.runAsync(
        'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
        [group.uid, event.authorName, group.name, msg, nowIso]
      );
    } else if (event.action === 'DELETE_TX') {
      const payload = event.payload as { txUid: string; authorId?: string };
      if (payload?.txUid) {
        const existingTx = await db.getFirstAsync<{ id: number; author_id: string }>('SELECT id, author_id FROM transactions WHERE group_id = ? AND uid = ?', [
          group.id,
          payload.txUid,
        ]);
        if (existingTx) {
          const isCreator = !group.creator_id || group.creator_id === event.authorId;
          const permModel = group.permission_model || 'collaborative';
          const isTxAuthor = Boolean(existingTx.author_id) && existingTx.author_id === event.authorId;
          // In admin_only: only creator can delete
          // In contributor & collaborative: creator OR tx author can delete
          const canDelete = isCreator || (permModel !== 'admin_only' && isTxAuthor);
          if (canDelete) {
            await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [existingTx.id]);
            await db.runAsync('DELETE FROM transactions WHERE id = ?', [existingTx.id]);
          }
        }
      }
    }

    // 3. Save sync event record as processed
    await db.runAsync(
      `INSERT INTO sync_events (event_id, group_uid, author_id, author_name, timestamp, action, payload, synced, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [event.eventId, event.groupUid, event.authorId, event.authorName, event.timestamp, event.action, JSON.stringify(event.payload), nowIso]
    );
  });

  notifyListeners(event, group.uid);
  return true;
}

/** Get unread notifications for groups. */
export async function getSyncNotifications(groupUid?: string): Promise<SyncNotification[]> {
  const db = await getDb();
  const where = groupUid ? 'WHERE group_uid = ?' : '';
  const params: Param[] = groupUid ? [groupUid] : [];
  const rows = await db.getAllAsync<{
    id: number;
    group_uid: string;
    author_name: string;
    title: string;
    message: string;
    read: number;
    created_at: string;
  }>(`SELECT * FROM sync_notifications ${where} ORDER BY id DESC LIMIT 50`, params);

  return rows.map((r) => ({
    id: r.id,
    groupUid: r.group_uid,
    authorName: r.author_name,
    title: r.title,
    message: r.message,
    read: !!r.read,
    createdAt: r.created_at,
  }));
}

/** Mark all notifications as read. */
export async function markNotificationsRead(groupUid?: string): Promise<void> {
  const db = await getDb();
  if (groupUid) {
    await db.runAsync('UPDATE sync_notifications SET read = 1 WHERE group_uid = ?', [groupUid]);
  } else {
    await db.runAsync('UPDATE sync_notifications SET read = 1', []);
  }
}

// ---------- Hybrid SQLite Queue & WebSocket Sync Client ----------

class SyncManager {
  private sockets = new Map<string, WebSocket>();
  private activeGroupKeys = new Map<string, string>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private isConnecting = new Map<string, boolean>();
  private lastSeenSeqs = new Map<string, number>();
  private syncPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Background polling every 12 seconds for offline resilience
    if (typeof setInterval !== 'undefined') {
      this.syncPollTimer = setInterval(() => {
        this.syncAllGroups().catch(() => {});
      }, 12000);
      if (this.syncPollTimer && typeof (this.syncPollTimer as any).unref === 'function') {
        (this.syncPollTimer as any).unref();
      }
    }
  }

  private getHttpBaseUrl(relayUrl: string): string {
    return relayUrl.replace(/^ws(s)?:/i, 'http$1:').replace(/\/ws\/?$/i, '');
  }

  public async syncAllGroups() {
    try {
      const groups = await listGroups();
      for (const g of groups) {
        if (g.uid && g.syncKey) {
          this.activeGroupKeys.set(g.uid, g.syncKey);
          await this.pullGroup(g.uid).catch(() => {});
          await this.flushPendingEvents(g.uid).catch(() => {});
          this.connectGroup(g.uid, g.syncKey).catch(() => {});
        }
      }
    } catch {
      // ignore errors during background sync init
    }
  }

  public async requestState(groupUid: string) {
    const key = this.activeGroupKeys.get(groupUid);
    if (key) {
      await this.connectGroup(groupUid, key);
      try {
        const identity = await getIdentity();
        const roomHash = await sha256Hex(`splitmate_room_${groupUid}`);
        const httpUrl = this.getHttpBaseUrl(identity.relayUrl);
        await fetch(`${httpUrl}/sync/request-snapshot?room=${roomHash}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerId: identity.id, peerName: identity.name }),
        });
      } catch {
        // Fallback to local broadcast
      }
      await createSyncEvent(groupUid, 'REQUEST_STATE', { requestedAt: Date.now() });
    }
  }

  /** Pull latest queued events from SQLite server for group */
  public async pullGroup(groupUid: string): Promise<number> {
    const syncKey = this.activeGroupKeys.get(groupUid);
    if (!syncKey) return 0;

    try {
      const identity = await getIdentity();
      const roomHash = await sha256Hex(`splitmate_room_${groupUid}`);
      const httpUrl = this.getHttpBaseUrl(identity.relayUrl);
      const lastSeq = this.lastSeenSeqs.get(groupUid) || 0;

      const resp = await fetch(`${httpUrl}/sync/pull?room=${roomHash}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: identity.id, peerName: identity.name, lastSeq, limit: 100 }),
      });

      if (!resp.ok) return 0;
      const data = (await resp.json()) as { ok: boolean; events?: any[]; latestSeq?: number };
      if (!data.ok || !Array.isArray(data.events) || data.events.length === 0) return 0;

      const ackedSeqs: number[] = [];
      let maxSeq = lastSeq;

      for (const item of data.events) {
        if (item.seq) maxSeq = Math.max(maxSeq, item.seq);
        if (item.payload) {
          try {
            const decrypted = await decryptWithKey(item.payload, syncKey);
            const event = JSON.parse(decrypted) as SyncEvent;
            await applyRemoteSyncEvent(event);
            if (item.seq) ackedSeqs.push(item.seq);
          } catch {
            // ignore decryption / format errors
          }
        }
      }

      this.lastSeenSeqs.set(groupUid, maxSeq);

      // Send ack to server SQLite
      if (ackedSeqs.length > 0) {
        fetch(`${httpUrl}/sync/ack?room=${roomHash}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerId: identity.id, ackedSeqs }),
        }).catch(() => {});
      }

      return ackedSeqs.length;
    } catch {
      return 0;
    }
  }

  public async connectGroup(groupUid: string, syncKey: string) {
    if (!syncKey) return;
    this.activeGroupKeys.set(groupUid, syncKey);

    const existingSocket = this.sockets.get(groupUid);
    if (existingSocket && (existingSocket.readyState === WebSocket.OPEN || existingSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.isConnecting.get(groupUid)) return;
    this.isConnecting.set(groupUid, true);

    try {
      const identity = await getIdentity();
      const roomHash = await sha256Hex(`splitmate_room_${groupUid}`);
      const wsUrl = `${identity.relayUrl}?room=${roomHash}`;

      // Also pull HTTP queue first
      await this.pullGroup(groupUid).catch(() => {});

      if (typeof WebSocket === 'undefined') {
        this.isConnecting.set(groupUid, false);
        return;
      }

      const ws = new WebSocket(wsUrl);

      ws.onopen = async () => {
        this.sockets.set(groupUid, ws);
        this.isConnecting.set(groupUid, false);

        // Send INIT message with identity and watermark
        const lastSeq = this.lastSeenSeqs.get(groupUid) || 0;
        try {
          ws.send(JSON.stringify({ type: 'INIT', peerId: identity.id, peerName: identity.name, lastSeq }));
        } catch {}

        // Flush any unsynced local events
        await this.flushPendingEvents(groupUid);
      };

      ws.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'SYNC_EVENT' && msg.payload) {
            const currentKey = this.activeGroupKeys.get(groupUid) || syncKey;
            const decrypted = await decryptWithKey(msg.payload, currentKey);
            const event = JSON.parse(decrypted) as SyncEvent;
            await applyRemoteSyncEvent(event);
            if (msg.seq) {
              const prev = this.lastSeenSeqs.get(groupUid) || 0;
              this.lastSeenSeqs.set(groupUid, Math.max(prev, msg.seq));
              try {
                ws.send(JSON.stringify({ type: 'ACK', seq: msg.seq, peerId: identity.id }));
              } catch {}
            }
          }
        } catch {
          // Ignore parse/decryption errors
        }
      };

      ws.onclose = () => {
        this.sockets.delete(groupUid);
        this.isConnecting.set(groupUid, false);
        this.scheduleReconnect(groupUid);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      this.isConnecting.set(groupUid, false);
      this.scheduleReconnect(groupUid);
    }
  }

  public disconnectGroup(groupUid: string) {
    const ws = this.sockets.get(groupUid);
    if (ws) {
      ws.close();
      this.sockets.delete(groupUid);
    }
    const timer = this.reconnectTimers.get(groupUid);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(groupUid);
    }
    this.activeGroupKeys.delete(groupUid);
  }

  public isConnected(groupUid: string): boolean {
    const ws = this.sockets.get(groupUid);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
  }

  public async broadcastEvent(groupUid: string, event: SyncEvent) {
    const syncKey = this.activeGroupKeys.get(groupUid);
    if (!syncKey) return;

    try {
      const identity = await getIdentity();
      const roomHash = await sha256Hex(`splitmate_room_${groupUid}`);
      const serialized = JSON.stringify(event);
      const encrypted = await encryptWithKey(serialized, syncKey);

      let pushedSuccessfully = false;

      // 1. Send via WebSocket if open
      const ws = this.sockets.get(groupUid);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'PUSH',
            id: event.eventId,
            action: event.action,
            authorId: event.authorId,
            authorName: event.authorName,
            payload: encrypted,
          }));
          pushedSuccessfully = true;
        } catch {
          // fallback to HTTP
        }
      }

      // 2. Also persist to SQLite DO server via HTTP REST push
      const httpUrl = this.getHttpBaseUrl(identity.relayUrl);
      const resp = await fetch(`${httpUrl}/sync/push?room=${roomHash}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId: identity.id,
          peerName: identity.name,
          events: [
            {
              id: event.eventId,
              action: event.action,
              authorId: event.authorId,
              authorName: event.authorName,
              timestamp: event.timestamp,
              payload: encrypted,
            },
          ],
        }),
      }).catch(() => null);

      if (resp && resp.ok) {
        pushedSuccessfully = true;
      }

      if (pushedSuccessfully) {
        const db = await getDb();
        await db.runAsync('UPDATE sync_events SET synced = 1 WHERE event_id = ?', [event.eventId]);
      }
    } catch {
      // Will be flushed on next periodic sync
    }
  }

  public async flushPendingEvents(groupUid: string) {
    const syncKey = this.activeGroupKeys.get(groupUid);
    if (!syncKey) return;

    const db = await getDb();
    const unsynced = await db.getAllAsync<{ id: number; event_id: string; payload: string; action: SyncAction; author_id: string; author_name: string; timestamp: number }>(
      'SELECT * FROM sync_events WHERE group_uid = ? AND synced = 0 ORDER BY timestamp ASC',
      [groupUid]
    );

    if (unsynced.length === 0) return;

    try {
      const identity = await getIdentity();
      const roomHash = await sha256Hex(`splitmate_room_${groupUid}`);
      const httpUrl = this.getHttpBaseUrl(identity.relayUrl);

      const pushPayloads = [];
      for (const row of unsynced) {
        const event: SyncEvent = {
          eventId: row.event_id,
          groupUid,
          authorId: row.author_id,
          authorName: row.author_name,
          timestamp: row.timestamp,
          action: row.action,
          payload: JSON.parse(row.payload),
        };
        const encrypted = await encryptWithKey(JSON.stringify(event), syncKey);
        pushPayloads.push({
          id: row.event_id,
          action: row.action,
          authorId: row.author_id,
          authorName: row.author_name,
          timestamp: row.timestamp,
          payload: encrypted,
        });
      }

      const resp = await fetch(`${httpUrl}/sync/push?room=${roomHash}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId: identity.id,
          peerName: identity.name,
          events: pushPayloads,
        }),
      }).catch(() => null);

      if (resp && resp.ok) {
        const ids = unsynced.map((u) => u.event_id);
        const placeholders = ids.map(() => '?').join(',');
        await db.runAsync(`UPDATE sync_events SET synced = 1 WHERE event_id IN (${placeholders})`, ids);
      }
    } catch {
      // ignore, will retry
    }
  }

  private scheduleReconnect(groupUid: string) {
    if (this.reconnectTimers.has(groupUid) || !this.activeGroupKeys.has(groupUid)) return;

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(groupUid);
      const key = this.activeGroupKeys.get(groupUid);
      if (key) this.connectGroup(groupUid, key);
    }, 5000);

    this.reconnectTimers.set(groupUid, timer);
  }
}

export const syncManager = new SyncManager();
