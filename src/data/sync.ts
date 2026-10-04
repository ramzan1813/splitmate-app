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
      // In contributor: only creator can edit existing transactions
      if (permModel === 'contributor' && existingTx && !isCreator) return;

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
          // In admin_only & contributor: only creator can delete
          // In collaborative: creator OR tx author can delete
          const canDelete = isCreator || (permModel === 'collaborative' && Boolean(existingTx.author_id) && existingTx.author_id === event.authorId);
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

// ---------- Live WebSocket Sync Client ----------

class SyncManager {
  private sockets = new Map<string, WebSocket>();
  private activeGroupKeys = new Map<string, string>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private isConnecting = new Map<string, boolean>();

  public async syncAllGroups() {
    try {
      const groups = await listGroups();
      for (const g of groups) {
        if (g.uid && g.syncKey) {
          this.connectGroup(g.uid, g.syncKey);
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
      await createSyncEvent(groupUid, 'REQUEST_STATE', { requestedAt: Date.now() });
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

      if (typeof WebSocket === 'undefined') {
        this.isConnecting.set(groupUid, false);
        return;
      }

      const ws = new WebSocket(wsUrl);

      ws.onopen = async () => {
        this.sockets.set(groupUid, ws);
        this.isConnecting.set(groupUid, false);
        // Flush any unsynced local events
        await this.flushPendingEvents(groupUid);
        // Request latest state snapshot from any online peer
        await createSyncEvent(groupUid, 'REQUEST_STATE', { requestedAt: Date.now() });
      };

      ws.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'SYNC_EVENT' && msg.payload) {
            const currentKey = this.activeGroupKeys.get(groupUid) || syncKey;
            const decrypted = await decryptWithKey(msg.payload, currentKey);
            const event = JSON.parse(decrypted) as SyncEvent;
            await applyRemoteSyncEvent(event);
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

    const ws = this.sockets.get(groupUid);
    try {
      const serialized = JSON.stringify(event);
      const encrypted = await encryptWithKey(serialized, syncKey);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: event.eventId, payload: encrypted }));
        // Mark locally as synced
        const db = await getDb();
        await db.runAsync('UPDATE sync_events SET synced = 1 WHERE event_id = ?', [event.eventId]);
      }
    } catch {
      // Will be flushed on reconnect
    }
  }

  private async flushPendingEvents(groupUid: string) {
    const syncKey = this.activeGroupKeys.get(groupUid);
    if (!syncKey) return;

    const db = await getDb();
    const unsynced = await db.getAllAsync<{ id: number; event_id: string; payload: string; action: SyncAction; author_id: string; author_name: string; timestamp: number }>(
      'SELECT * FROM sync_events WHERE group_uid = ? AND synced = 0 ORDER BY timestamp ASC',
      [groupUid]
    );

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
      await this.broadcastEvent(groupUid, event);
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
