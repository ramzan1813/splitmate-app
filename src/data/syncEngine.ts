// Mobile Synchronization Engine
// Orchestrates: Local Mutation -> SQLite -> Outbox -> Push -> Backend -> Pull -> Transactional SQLite Application.
import { DB, getDb } from './db';
import { getDeviceId, getIdentity } from '../lib/identity';
import {
  clearAcknowledgedOutboxMutations,
  getPendingOutboxMutations,
  markOutboxMutationConflict,
  markOutboxMutationFailed,
  markOutboxMutationInFlight,
  removeOutboxMutation,
} from './outbox';
import {
  getSyncState,
  initSyncState,
  setSyncStatus,
  updateServerSequence,
} from './syncState';
import {
  GroupBootstrapResponse,
  PullChangesResponse,
  PushMutationsRequest,
  PushMutationsResponse,
  RealtimeNotification,
  ServerChange,
  SyncStatus,
} from './types';
import { listGroups } from './repo';

export interface SyncTransport {
  push(request: PushMutationsRequest): Promise<PushMutationsResponse>;
  pull(groupUid: string, afterSequence: number, limit?: number): Promise<PullChangesResponse>;
  bootstrap(groupUid: string): Promise<GroupBootstrapResponse>;
}

export interface RealtimeClient {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  subscribeGroup(groupUid: string): void;
  unsubscribeGroup(groupUid: string): void;
  onNotification(handler: (notification: RealtimeNotification) => void): () => void;
}

export class MemoryRealtimeClient implements RealtimeClient {
  private connected = true;
  private subscribedGroups = new Set<string>();
  private handlers = new Set<(notification: RealtimeNotification) => void>();
  private unsubscribers = new Map<string, () => void>();

  constructor(private hub: { subscribe(groupUid: string, cb: (notif: RealtimeNotification) => void): () => void }) {}

  connect(): void {
    this.connected = true;
    for (const groupUid of this.subscribedGroups) {
      this.attach(groupUid);
    }
  }

  disconnect(): void {
    this.connected = false;
    for (const unsub of this.unsubscribers.values()) {
      unsub();
    }
    this.unsubscribers.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribeGroup(groupUid: string): void {
    this.subscribedGroups.add(groupUid);
    if (this.connected) {
      this.attach(groupUid);
    }
  }

  unsubscribeGroup(groupUid: string): void {
    this.subscribedGroups.delete(groupUid);
    const unsub = this.unsubscribers.get(groupUid);
    if (unsub) {
      unsub();
      this.unsubscribers.delete(groupUid);
    }
  }

  private attach(groupUid: string) {
    if (this.unsubscribers.has(groupUid)) return;
    const unsub = this.hub.subscribe(groupUid, (notif) => {
      if (!this.connected) return;
      for (const h of this.handlers) {
        try {
          h(notif);
        } catch {}
      }
    });
    this.unsubscribers.set(groupUid, unsub);
  }

  onNotification(handler: (notification: RealtimeNotification) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

/** Default HTTP Sync Transport for mobile production environment */
export class HttpSyncTransport implements SyncTransport {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || 'https://splitmate-api.example.com').replace(/\/+$/, '');
  }

  public setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  async push(request: PushMutationsRequest): Promise<PushMutationsResponse> {
    const res = await fetch(`${this.baseUrl}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(`Push failed with HTTP ${res.status}`);
    }
    return res.json();
  }

  async pull(groupUid: string, afterSequence: number, limit = 100): Promise<PullChangesResponse> {
    const res = await fetch(`${this.baseUrl}/sync/changes/${groupUid}?after=${afterSequence}&limit=${limit}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Pull failed with HTTP ${res.status}`);
    }
    return res.json();
  }

  async bootstrap(groupUid: string): Promise<GroupBootstrapResponse> {
    const res = await fetch(`${this.baseUrl}/sync/bootstrap/${groupUid}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Bootstrap failed with HTTP ${res.status}`);
    }
    return res.json();
  }
}

type SyncChangeListener = (groupUid: string) => void;

export class SyncEngine {
  private transport: SyncTransport;
  private realtimeClient?: RealtimeClient;
  private realtimeUnsub?: () => void;
  private customDb?: DB;
  private isSyncing = new Map<string, boolean>();
  private retryBackoff = new Map<string, number>(); // ms
  private listeners = new Set<SyncChangeListener>();
  private onlineStatus = true;

  constructor(transport?: SyncTransport, realtime?: RealtimeClient, db?: DB) {
    this.transport = transport || new HttpSyncTransport();
    this.customDb = db;
    if (realtime) {
      this.setRealtimeClient(realtime);
    }
  }

  public setTransport(transport: SyncTransport) {
    this.transport = transport;
  }

  public getTransport(): SyncTransport {
    return this.transport;
  }

  public setDb(db: DB) {
    this.customDb = db;
  }

  public async getEngineDb(): Promise<DB> {
    return this.customDb ?? (await getDb());
  }

  public setRealtimeClient(realtime: RealtimeClient) {
    if (this.realtimeUnsub) {
      this.realtimeUnsub();
      this.realtimeUnsub = undefined;
    }
    this.realtimeClient = realtime;
    this.realtimeUnsub = this.realtimeClient.onNotification(async (notif) => {
      try {
        await this.handleRealtimeNotification(notif);
      } catch {
        // Ignored; cursor synchronization will catch up on next sync
      }
    });
  }

  public getRealtimeClient(): RealtimeClient | undefined {
    return this.realtimeClient;
  }

  /**
   * Processes an incoming realtime notification.
   * Realtime notifications mean "changes may be available" — they do NOT carry data.
   * Pulls incremental changes strictly after lastServerSequence and applies them transactionally to SQLite.
   */
  public async handleRealtimeNotification(notification: RealtimeNotification): Promise<number> {
    if (!this.onlineStatus) {
      return 0;
    }

    const pulled = await this.pullRemoteChanges(notification.groupUid);
    if (pulled > 0) {
      this.notify(notification.groupUid);
    }
    return pulled;
  }

  public setOnline(online: boolean) {
    const prev = this.onlineStatus;
    this.onlineStatus = online;
    if (online) {
      this.realtimeClient?.connect();
      if (!prev) {
        // Reconnected: trigger cursor synchronization across all groups to catch up on any missed changes
        this.syncAllGroups().catch(() => {});
      }
    } else {
      this.realtimeClient?.disconnect();
    }
  }

  public isOnline(): boolean {
    return this.onlineStatus;
  }

  public subscribe(listener: SyncChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(groupUid: string) {
    for (const l of this.listeners) {
      try {
        l(groupUid);
      } catch {}
    }
  }

  /** Synchronizes all local groups sequentially */
  public async syncAllGroups(): Promise<Record<string, { pushed: number; pulled: number; conflicts: number }>> {
    const results: Record<string, { pushed: number; pulled: number; conflicts: number }> = {};
    const groups = await listGroups();
    for (const g of groups) {
      if (g.uid) {
        try {
          results[g.uid] = await this.syncGroup(g.uid);
        } catch {
          results[g.uid] = { pushed: 0, pulled: 0, conflicts: 0 };
        }
      }
    }
    return results;
  }

  /** Full sync cycle for a group: Push Outbox -> Pull Server Changes -> Apply Transactionally to SQLite */
  public async syncGroup(groupUid: string): Promise<{ pushed: number; pulled: number; conflicts: number }> {
    const db = await this.getEngineDb();

    if (!this.onlineStatus) {
      await setSyncStatus(groupUid, 'offline', null, db);
      return { pushed: 0, pulled: 0, conflicts: 0 };
    }

    if (this.isSyncing.get(groupUid)) {
      return { pushed: 0, pulled: 0, conflicts: 0 };
    }

    this.isSyncing.set(groupUid, true);
    await setSyncStatus(groupUid, 'syncing', null, db);

    let pushed = 0;
    let conflicts = 0;
    let pulled = 0;

    try {
      const deviceId = await getDeviceId();
      let state = await getSyncState(groupUid, db);
      if (!state) {
        state = await initSyncState(groupUid, deviceId, db);
      }

      this.realtimeClient?.subscribeGroup(groupUid);

      // 1. Push pending local outbox mutations
      const pushRes = await this.pushPendingMutations(groupUid, deviceId);
      pushed = pushRes.accepted;
      conflicts = pushRes.conflicts;

      // 2. Pull remote server changes
      pulled = await this.pullRemoteChanges(groupUid);

      // Reset backoff on successful sync
      this.retryBackoff.set(groupUid, 0);
      await setSyncStatus(groupUid, conflicts > 0 ? 'conflict' : 'idle', null, db);

      if (pushed > 0 || pulled > 0) {
        this.notify(groupUid);
      }

      return { pushed, pulled, conflicts };
    } catch (err: any) {
      // Calculate exponential backoff
      const currentDelay = this.retryBackoff.get(groupUid) || 1000;
      const nextDelay = Math.min(currentDelay * 2, 30000);
      this.retryBackoff.set(groupUid, nextDelay);

      const errorMessage = err?.message || 'Synchronization failed';
      await setSyncStatus(groupUid, 'error', errorMessage, db);
      throw err;
    } finally {
      this.isSyncing.set(groupUid, false);
    }
  }

  /** Flushes pending mutations from the local outbox to the server */
  public async pushPendingMutations(groupUid: string, deviceId: string): Promise<{ accepted: number; conflicts: number; rejected: number }> {
    const db = await this.getEngineDb();
    const pending = await getPendingOutboxMutations(groupUid, db);
    if (pending.length === 0) {
      return { accepted: 0, conflicts: 0, rejected: 0 };
    }

    const mutationIds = pending.map((m) => m.clientMutationId);
    await markOutboxMutationInFlight(mutationIds, db);

    const identity = await getIdentity();
    const pushReq: PushMutationsRequest = {
      groupUid,
      deviceId,
      actorId: identity.id,
      actorName: identity.name,
      mutations: pending.map((m) => ({
        clientMutationId: m.clientMutationId,
        entityType: m.entityType,
        entityUid: m.entityUid,
        operation: m.operation,
        expectedVersion: m.expectedVersion,
        payload: m.payload,
      })),
    };

    let accepted = 0;
    let conflicts = 0;
    let rejected = 0;

    try {
      const resp = await this.transport.push(pushReq);
      for (const res of resp.results) {
        if (res.status === 'ACCEPTED') {
          accepted++;
          // Update entity server version if higher
          if (res.serverVersion) {
            await this.updateLocalEntityVersion(db, groupUid, res.entityUid, res.serverVersion);
          }
          await removeOutboxMutation(res.clientMutationId, db);
        } else if (res.status === 'CONFLICT') {
          conflicts++;
          await markOutboxMutationConflict(res.clientMutationId, res.message || res.error || 'Conflict detected', db);
        } else {
          rejected++;
          await markOutboxMutationFailed(res.clientMutationId, res.message || res.error || 'Mutation rejected', db);
        }
      }
    } catch (err: any) {
      for (const id of mutationIds) {
        await markOutboxMutationFailed(id, err?.message || 'Network error during push', db);
      }
      throw err;
    }

    return { accepted, conflicts, rejected };
  }

  /** Pulls changes strictly after lastServerSequence and applies them transactionally to SQLite */
  public async pullRemoteChanges(groupUid: string): Promise<number> {
    const db = await this.getEngineDb();
    const deviceId = await getDeviceId();
    let state = await getSyncState(groupUid, db);
    if (!state) {
      state = await initSyncState(groupUid, deviceId, db);
    }

    const afterSequence = state.lastServerSequence;
    const delta = await this.transport.pull(groupUid, afterSequence, 100);

    if (!delta.changes || delta.changes.length === 0) {
      return 0;
    }

    let appliedCount = 0;

    // Transactional application: all changes or none
    await db.withTransactionAsync(async () => {
      for (const change of delta.changes) {
        await this.applySingleServerChange(db, groupUid, change);
        appliedCount++;
      }

      // Advance server sequence cursor only after all mutations are safely applied
      await updateServerSequence(groupUid, delta.latestServerSequence, undefined, db);
    });

    return appliedCount;
  }

  private async applySingleServerChange(db: DB, groupUid: string, change: ServerChange): Promise<void> {
    const nowIso = new Date().toISOString();
    const isDelete = change.operation === 'delete';

    // 1. Group Change
    if (change.entityType === 'group') {
      const p = change.payload as any;
      if (isDelete) {
        await db.runAsync('UPDATE groups SET is_deleted = 1, deleted_at = ?, server_version = ? WHERE uid = ?', [change.createdAt || nowIso, change.entityVersion, groupUid]);
      } else {
        await db.runAsync(
          `INSERT INTO groups (uid, name, description, currency, permission_model, creator_id, creator_name, sync_key, server_version, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(uid) DO UPDATE SET
             name = COALESCE(excluded.name, groups.name),
             description = COALESCE(excluded.description, groups.description),
             currency = COALESCE(excluded.currency, groups.currency),
             permission_model = COALESCE(excluded.permission_model, groups.permission_model),
             server_version = excluded.server_version,
             is_deleted = 0,
             deleted_at = NULL,
             updated_at = excluded.updated_at`,
          [
            groupUid,
            p.name || 'Group',
            p.description || '',
            p.currency || 'USD',
            p.permissionModel || 'collaborative',
            change.actorId,
            p.creatorName || '',
            p.syncKey || '',
            change.entityVersion,
            change.createdAt || nowIso,
            nowIso,
          ]
        );
      }
    }

    // 2. Member Change
    else if (change.entityType === 'member') {
      const p = change.payload as any;
      const groupRow = await db.getFirstAsync<{ id: number }>('SELECT id FROM groups WHERE uid = ?', [groupUid]);
      if (!groupRow) return;

      if (isDelete) {
        await db.runAsync('UPDATE members SET is_deleted = 1, deleted_at = ?, server_version = ? WHERE uid = ? AND group_id = ?', [
          change.createdAt || nowIso,
          change.entityVersion,
          change.entityUid,
          groupRow.id,
        ]);
      } else {
        const existing =
          (await db.getFirstAsync<{ id: number; is_me: number }>('SELECT id, is_me FROM members WHERE uid = ? AND group_id = ?', [
            change.entityUid,
            groupRow.id,
          ])) ||
          (await db.getFirstAsync<{ id: number; is_me: number }>('SELECT id, is_me FROM members WHERE group_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))', [
            groupRow.id,
            p.name,
          ]));

        if (existing) {
          await db.runAsync(
            'UPDATE members SET uid = ?, name = ?, server_version = ?, is_deleted = 0, deleted_at = NULL WHERE id = ?',
            [change.entityUid, p.newName || p.name, change.entityVersion, existing.id]
          );
        } else {
          await db.runAsync(
            'INSERT INTO members (group_id, uid, name, is_me, server_version, is_deleted, created_at) VALUES (?, ?, ?, 0, ?, 0, ?)',
            [groupRow.id, change.entityUid, p.name, change.entityVersion, change.createdAt || nowIso]
          );
        }
      }
    }

    // 3. Transaction Change
    else if (change.entityType === 'transaction') {
      const p = change.payload as any;
      const groupRow = await db.getFirstAsync<{ id: number }>('SELECT id FROM groups WHERE uid = ?', [groupUid]);
      if (!groupRow) return;

      if (isDelete) {
        const tx = await db.getFirstAsync<{ id: number }>('SELECT id FROM transactions WHERE uid = ? AND group_id = ?', [change.entityUid, groupRow.id]);
        if (tx) {
          await db.runAsync('UPDATE transactions SET is_deleted = 1, deleted_at = ?, server_version = ? WHERE id = ?', [
            change.createdAt || nowIso,
            change.entityVersion,
            tx.id,
          ]);
          await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [tx.id]);
        }
      } else {
        // Resolve payer member
        const members = await db.getAllAsync<{ id: number; name: string; uid: string }>('SELECT id, name, uid FROM members WHERE group_id = ? AND is_deleted = 0', [groupRow.id]);
        const memberUidMap = new Map(members.map((m) => [m.uid, m.id]));
        const memberNameMap = new Map(members.map((m) => [m.name.toLowerCase().trim(), m.id]));

        let payerId = p.paidByMemberUid ? memberUidMap.get(p.paidByMemberUid) : undefined;
        if (!payerId && p.paidByName) {
          payerId = memberNameMap.get(p.paidByName.toLowerCase().trim());
        }
        if (!payerId) {
          const newMemUid = p.paidByMemberUid || `mem_${Date.now()}`;
          const r = await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, server_version, is_deleted, created_at) VALUES (?, ?, ?, 0, 1, 0, ?)', [
            groupRow.id,
            newMemUid,
            p.paidByName || 'Member',
            nowIso,
          ]);
          payerId = r.lastInsertRowId;
          memberUidMap.set(newMemUid, payerId);
          memberNameMap.set((p.paidByName || 'Member').toLowerCase().trim(), payerId);
        }

        const existingTx = await db.getFirstAsync<{ id: number }>('SELECT id FROM transactions WHERE uid = ? AND group_id = ?', [change.entityUid, groupRow.id]);

        let txId: number;
        if (existingTx) {
          txId = existingTx.id;
          await db.runAsync(
            `UPDATE transactions
             SET type = ?, title = ?, amount = ?, paid_by = ?, split_type = ?, category = ?, note = ?, date = ?, author_id = ?, author_name = ?, server_version = ?, is_deleted = 0, deleted_at = NULL, updated_at = ?
             WHERE id = ?`,
            [
              p.type || 'expense',
              p.title,
              p.amount,
              payerId,
              p.splitType || 'equal',
              p.category || 'General',
              p.note || '',
              p.date || nowIso.slice(0, 10),
              p.authorId || change.actorId,
              p.authorName || '',
              change.entityVersion,
              nowIso,
              txId,
            ]
          );
          await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [txId]);
        } else {
          const ins = await db.runAsync(
            `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name, server_version, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [
              groupRow.id,
              change.entityUid,
              p.type || 'expense',
              p.title,
              p.amount,
              payerId,
              p.splitType || 'equal',
              p.category || 'General',
              p.note || '',
              p.date || nowIso.slice(0, 10),
              p.authorId || change.actorId,
              p.authorName || '',
              change.entityVersion,
              change.createdAt || nowIso,
              nowIso,
            ]
          );
          txId = ins.lastInsertRowId;
        }

        // Apply splits
        if (Array.isArray(p.splits)) {
          for (const s of p.splits) {
            let sMemberId = s.memberUid ? memberUidMap.get(s.memberUid) : undefined;
            if (!sMemberId && s.memberName) {
              sMemberId = memberNameMap.get(s.memberName.toLowerCase().trim());
            }
            if (!sMemberId) {
              const newMemUid = s.memberUid || `mem_${Date.now()}`;
              const r = await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, server_version, is_deleted, created_at) VALUES (?, ?, ?, 0, 1, 0, ?)', [
                groupRow.id,
                newMemUid,
                s.memberName || 'Member',
                nowIso,
              ]);
              sMemberId = r.lastInsertRowId;
              memberUidMap.set(newMemUid, sMemberId);
              memberNameMap.set((s.memberName || 'Member').toLowerCase().trim(), sMemberId);
            }
            await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [
              txId,
              sMemberId,
              s.value ?? 1,
              s.share ?? 0,
            ]);
          }
        }
      }
    }
  }

  private async updateLocalEntityVersion(db: DB, groupUid: string, entityUid: string, version: number) {
    if (entityUid === groupUid) {
      await db.runAsync('UPDATE groups SET server_version = ? WHERE uid = ?', [version, groupUid]);
    } else {
      await db.runAsync('UPDATE members SET server_version = ? WHERE uid = ?', [version, entityUid]);
      await db.runAsync('UPDATE transactions SET server_version = ? WHERE uid = ?', [version, entityUid]);
    }
  }
}

export const syncEngine = new SyncEngine();
