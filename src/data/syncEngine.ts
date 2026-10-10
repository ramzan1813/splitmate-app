// Mobile Synchronization Engine
// Orchestrates: Local Mutation -> SQLite -> Outbox -> Push -> Backend -> Pull -> Transactional SQLite Application.
//
// Source of truth: the server. Each group has a server-assigned, gapless change sequence; the
// device keeps a cursor (sync_state.last_server_sequence) advanced in the same SQLite
// transaction that applies the changes. Entities are identified by uid and carry a server
// version; updates/deletes send expectedVersion and the server answers CONFLICT on mismatch.
//
// Triggers (no polling, no timers): app start, app returning to the foreground, opening a group,
// pull-to-refresh, and every committed local write (signalLocalChange). A failed push leaves
// the mutations pending; the next trigger retries them, and the server deduplicates by
// clientMutationId. Conflicts and rejections stay in the outbox until the user resolves them.
import { DB, getDb } from './db';
import { getDeviceId, getIdentity, getServerUrl } from '../lib/identity';
import { money } from '../lib/format';
import {
  discardUnresolvedOutboxMutations,
  enqueueOutboxMutation,
  getOutboxCount,
  getPendingOutboxMutations,
  markOutboxMutationConflict,
  markOutboxMutationFailed,
  markOutboxMutationInFlight,
  getUnresolvedOutboxMutations,
  removeOutboxMutation,
  requeueOutboxMutations,
  resetInFlightOutboxMutations,
} from './outbox';
import {
  getSyncState,
  hasServerHistory,
  hasUploadMarker,
  initSyncState,
  resetAllSyncBindings,
  resetServerSequence,
  resetSyncBinding,
  setSyncStatus,
  setUploadMarker,
  updateServerSequence,
} from './syncState';
import {
  GroupBootstrapResponse,
  OutboxMutation,
  PullChangesResponse,
  PushMutationsRequest,
  PushMutationsResponse,
  RealtimeNotification,
  ServerChange,
} from './types';
import { addMember, buildTxSyncPayload, newUid, purgeGroupLocal, setMe, unhideGroup } from './repo';
import { recordSyncNotification } from './sync';

// ---------- Transport ----------

/** The server answered with an HTTP error status. */
export class SyncHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

/** The server could not be reached (offline, DNS, refused, timed out). */
export class SyncNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncNetworkError';
  }
}

const isNotFound = (err: unknown) => err instanceof SyncHttpError && err.status === 404;
/** The sync server itself (not a proxy or a wrong URL) says the group does not exist. */
const isGroupNotFound = (err: unknown) => err instanceof SyncHttpError && err.status === 404 && err.code === 'GROUP_NOT_FOUND';

export interface SyncTransport {
  push(request: PushMutationsRequest): Promise<PushMutationsResponse>;
  pull(groupUid: string, afterSequence: number, limit?: number): Promise<PullChangesResponse>;
  bootstrap(groupUid: string): Promise<GroupBootstrapResponse>;
  /** Identifies the server the cursors belong to; a change resets them. Optional for test transports. */
  serverId?(): Promise<string>;
}

/** A source of "changes available" signals (e.g. push notifications) that triggers a sync. */
export interface RealtimeClient {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  subscribeGroup(groupUid: string): void;
  unsubscribeGroup(groupUid: string): void;
  onNotification(handler: (notification: RealtimeNotification) => void): () => void;
}

// A request that never answers would keep the group in 'syncing' forever; failing it surfaces
// the problem as an offline/error state and the next trigger retries.
const REQUEST_TIMEOUT_MS = 20_000;

/** HTTP transport for the EvenUp sync server. Reads the server URL from settings on every call. */
export class HttpSyncTransport implements SyncTransport {
  constructor(private resolveBaseUrl: () => Promise<string> = getServerUrl) {}

  async serverId(): Promise<string> {
    return this.resolveBaseUrl();
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = (await this.resolveBaseUrl()).replace(/\/+$/, '');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : undefined;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: controller?.signal,
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'AbortError' ? 'request timed out' : err instanceof Error ? err.message : String(err);
      console.warn(`[SyncTransport] Network error reaching ${base}${path}:`, reason);
      throw new SyncNetworkError(`Cannot reach server ${base}: ${reason}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      let body: { error?: string; message?: string } | null = null;
      try {
        body = await res.json();
      } catch {}
      throw new SyncHttpError(res.status, body?.error || `HTTP_${res.status}`, body?.message || `Server returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  push(request: PushMutationsRequest): Promise<PushMutationsResponse> {
    return this.request('/sync/push', { method: 'POST', body: JSON.stringify(request) });
  }

  pull(groupUid: string, afterSequence: number, limit = 100): Promise<PullChangesResponse> {
    return this.request(`/sync/changes/${encodeURIComponent(groupUid)}?after=${afterSequence}&limit=${limit}`);
  }

  bootstrap(groupUid: string): Promise<GroupBootstrapResponse> {
    return this.request(`/sync/bootstrap/${encodeURIComponent(groupUid)}`);
  }
}

// ---------- Status ----------

export type SyncPhase = 'syncing' | 'synced' | 'pending' | 'offline' | 'error' | 'conflict' | 'never';

export interface GroupSyncStatus {
  phase: SyncPhase;
  /** Local changes not yet accepted by the server. */
  pending: number;
  /** Changes the server refused (version conflict or rejection), waiting for the user. */
  unresolved: number;
  lastSyncAt: string | null;
  error: string | null;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
}

const ZERO: SyncResult = { pushed: 0, pulled: 0, conflicts: 0 };
const MAX_MUTATIONS_PER_PUSH = 200; // server limit
const PULL_PAGE_SIZE = 100;
const SERVER_BINDING_SETTING = 'sync.server_binding';

type GroupListener = (groupUid: string) => void;

const normName = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export class SyncEngine {
  private transport: SyncTransport;
  private realtimeClient?: RealtimeClient;
  private realtimeUnsub?: () => void;
  private customDb?: DB;
  private inFlight = new Map<string, Promise<SyncResult>>();
  private rerunRequested = new Set<string>();
  private listeners = new Set<GroupListener>();
  private statusListeners = new Set<GroupListener>();
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
        // Status already records the failure; the next trigger catches up from the cursor.
      }
    });
  }

  public getRealtimeClient(): RealtimeClient | undefined {
    return this.realtimeClient;
  }

  /**
   * A notification means "changes may be available" — it carries no data. Runs a normal sync
   * cycle (push first, so pending local edits are never overwritten before they are sent).
   */
  public async handleRealtimeNotification(notification: RealtimeNotification): Promise<number> {
    if (!this.onlineStatus) return 0;
    const result = await this.syncGroup(notification.groupUid);
    return result.pulled;
  }

  public setOnline(online: boolean) {
    const prev = this.onlineStatus;
    this.onlineStatus = online;
    if (online) {
      this.realtimeClient?.connect();
      if (!prev) {
        // Reconnected: catch up every group from its cursor.
        this.syncAllGroups().catch(() => {});
      }
    } else {
      this.realtimeClient?.disconnect();
    }
  }

  public isOnline(): boolean {
    return this.onlineStatus;
  }

  /** Called when a group's local data changed because of pulled server changes or local mutations. */
  public subscribe(listener: GroupListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called whenever a group's sync status may have changed. */
  public subscribeStatus(listener: GroupListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Notify listeners that local data for a group has changed (e.g. from local committed mutation). */
  public notifyLocalChange(groupUid: string) {
    this.emit(this.listeners, groupUid);
  }

  private emit(set: Set<GroupListener>, groupUid: string) {
    for (const l of set) {
      try {
        l(groupUid);
      } catch {}
    }
  }

  public isSyncing(groupUid: string): boolean {
    return this.inFlight.has(groupUid);
  }

  public async getGroupSyncStatus(groupUid: string): Promise<GroupSyncStatus> {
    const db = await this.getEngineDb();
    const state = await getSyncState(groupUid, db);
    const counts = await getOutboxCount(groupUid, db);
    const pending = counts.pending + counts.sending;
    const unresolved = counts.conflict + counts.failed;
    const base = { pending, unresolved, lastSyncAt: state?.lastSyncAt ?? null, error: state?.errorDetail ?? null };
    if (this.inFlight.has(groupUid)) return { ...base, phase: 'syncing' };
    if (unresolved > 0) return { ...base, phase: 'conflict' };
    if (state?.syncStatus === 'offline') return { ...base, phase: 'offline' };
    if (state?.syncStatus === 'error') return { ...base, phase: 'error' };
    if (pending > 0) return { ...base, phase: 'pending' };
    if (state?.lastSyncAt) return { ...base, phase: 'synced' };
    return { ...base, phase: 'never' };
  }

  /** Synchronizes every local group (including deleted ones with unsent deletes), one at a time. */
  public async syncAllGroups(): Promise<Record<string, SyncResult>> {
    const db = await this.getEngineDb();
    const rows = await db.getAllAsync<{ uid: string }>(
      `SELECT uid FROM groups WHERE uid != '' UNION SELECT DISTINCT group_uid AS uid FROM outbox_mutations`,
      []
    );
    const results: Record<string, SyncResult> = {};
    for (const { uid } of rows) {
      try {
        results[uid] = await this.syncGroup(uid);
      } catch {
        results[uid] = { ...ZERO };
      }
    }
    return results;
  }

  /**
   * Full sync cycle for a group: upload backfill (once) -> push outbox -> pull changes.
   * A call made while a cycle is running joins it and schedules one more cycle afterwards,
   * so a write committed mid-sync is still pushed.
   */
  public syncGroup(groupUid: string): Promise<SyncResult> {
    const running = this.inFlight.get(groupUid);
    if (running) {
      this.rerunRequested.add(groupUid);
      return running;
    }
    const run = (async () => {
      const total = { ...ZERO };
      do {
        this.rerunRequested.delete(groupUid);
        const r = await this.runCycle(groupUid);
        total.pushed += r.pushed;
        total.pulled += r.pulled;
        total.conflicts += r.conflicts;
      } while (this.rerunRequested.has(groupUid));
      return total;
    })().finally(() => {
      this.inFlight.delete(groupUid);
      this.rerunRequested.delete(groupUid);
      this.emit(this.statusListeners, groupUid);
    });
    this.inFlight.set(groupUid, run);
    this.emit(this.statusListeners, groupUid);
    return run;
  }

  private async runCycle(groupUid: string): Promise<SyncResult> {
    const db = await this.getEngineDb();
    const deviceId = await getDeviceId();
    const group = await db.getFirstAsync<{ name: string; removal: string | null }>('SELECT name, removal FROM groups WHERE uid = ?', [groupUid]);
    // Not on this phone (left, deleted, or never joined) and nothing to send: never pull it back in.
    if (!group && (await getOutboxCount(groupUid, db)).total === 0) return { ...ZERO };
    if (!(await getSyncState(groupUid, db))) await initSyncState(groupUid, deviceId, db);

    if (!this.onlineStatus) {
      await setSyncStatus(groupUid, 'offline', null, db);
      return { ...ZERO };
    }

    await setSyncStatus(groupUid, 'syncing', null, db);
    try {
      await this.ensureServerBinding(db);
      if (group?.removal === 'leave' || group?.removal === 'delete') return await this.finishRemoval(groupUid, group.removal, deviceId, db);
      await this.ensureUploaded(groupUid, db);
      this.realtimeClient?.subscribeGroup(groupUid);

      const push = await this.pushPendingMutations(groupUid, deviceId);
      let pulled: number;
      try {
        pulled = await this.pullRemoteChanges(groupUid);
      } catch (err) {
        // The server had this group and now has no record of it: its admin deleted it.
        if (isGroupNotFound(err) && (await hasServerHistory(groupUid, db))) {
          await this.removeDeletedGroup(groupUid, group?.name ?? '', db);
          return { pushed: push.accepted, pulled: 0, conflicts: push.conflicts };
        }
        throw err;
      }

      const counts = await getOutboxCount(groupUid, db);
      await setSyncStatus(groupUid, counts.conflict + counts.failed > 0 ? 'conflict' : 'idle', null, db);
      if (pulled > 0 || push.accepted > 0) this.emit(this.listeners, groupUid);
      return { pushed: push.accepted, pulled, conflicts: push.conflicts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setSyncStatus(groupUid, err instanceof SyncNetworkError ? 'offline' : 'error', message, db);
      throw err;
    }
  }

  /**
   * A group hidden by leave/delete: send what is queued, then erase it from this phone.
   * leave: this phone's unsent changes are pushed first (they belong to the group everyone else keeps).
   * delete: the admin's delete is pushed; if the server refuses it, the group comes back with a notice.
   */
  private async finishRemoval(groupUid: string, removal: 'leave' | 'delete', deviceId: string, db: DB): Promise<SyncResult> {
    const push = await this.pushPendingMutations(groupUid, deviceId);
    if (removal === 'delete') {
      const refused = (await getUnresolvedOutboxMutations(groupUid, db)).find((m) => m.entityType === 'group' && m.operation === 'delete');
      if (refused) {
        await db.withTransactionAsync(async () => {
          await unhideGroup(db, groupUid);
          await removeOutboxMutation(refused.clientMutationId, db);
          await recordSyncNotification(db, { groupUid, authorName: '', title: "Group wasn't deleted", message: refused.errorMessage || 'The server refused the delete.' });
        });
        this.emit(this.listeners, groupUid);
        return { pushed: push.accepted, pulled: 0, conflicts: push.conflicts };
      }
    }
    const counts = await getOutboxCount(groupUid, db);
    if (counts.pending + counts.sending === 0) {
      await purgeGroupLocal(groupUid, db);
      this.realtimeClient?.unsubscribeGroup(groupUid);
      this.emit(this.listeners, groupUid);
    }
    return { pushed: push.accepted, pulled: 0, conflicts: push.conflicts };
  }

  /**
   * The admin deleted the group: erase this phone's copy and say so. Changes this phone had not yet
   * sent can no longer be saved anywhere; the notice states how many were lost.
   */
  private async removeDeletedGroup(groupUid: string, name: string, db: DB) {
    const counts = await getOutboxCount(groupUid, db);
    await purgeGroupLocal(groupUid, db);
    const lost = counts.total > 0 ? ` ${counts.total} change${counts.total === 1 ? '' : 's'} from this phone had not synced and could not be saved.` : '';
    await recordSyncNotification(db, {
      groupUid,
      authorName: '',
      title: 'Group deleted',
      message: `The admin deleted "${name || 'a group'}". It has been removed from this phone.${lost}`,
    });
    this.realtimeClient?.unsubscribeGroup(groupUid);
    this.emit(this.listeners, groupUid);
  }

  /** Cursors and upload markers belong to one server; switching servers re-syncs from scratch. */
  private async ensureServerBinding(db: DB) {
    if (!this.transport.serverId) return;
    const current = await this.transport.serverId();
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SERVER_BINDING_SETTING]);
    if (row?.value === current) return;
    if (row) await resetAllSyncBindings(db);
    await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      SERVER_BINDING_SETTING,
      current,
    ]);
  }

  /**
   * Groups created before the sync engine (or synced only through the old relay) have data the
   * server has never seen. Compare with the server once and queue whatever it is missing.
   */
  private async ensureUploaded(groupUid: string, db: DB) {
    if (await hasUploadMarker(groupUid, db)) return;

    const group = await db.getFirstAsync<{
      id: number;
      name: string;
      description: string;
      currency: string;
      permission_model: string;
      creator_id: string;
      creator_name: string;
      is_deleted: number;
    }>('SELECT * FROM groups WHERE uid = ?', [groupUid]);
    const queuedCreate = await db.getFirstAsync<{ id: number }>(
      `SELECT id FROM outbox_mutations WHERE group_uid = ? AND entity_type = 'group' AND operation = 'create' LIMIT 1`,
      [groupUid]
    );
    if (!group || queuedCreate) {
      await setUploadMarker(groupUid, db);
      return;
    }

    let snapshot: GroupBootstrapResponse | null = null;
    try {
      snapshot = await this.transport.bootstrap(groupUid);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    await db.withTransactionAsync(async () => {
      if (!snapshot) {
        // The server has never seen this group. Its current local state supersedes any queued edits.
        await db.runAsync('DELETE FROM outbox_mutations WHERE group_uid = ?', [groupUid]);
        if (!group.is_deleted) await this.queueFullUpload(db, groupUid, group);
      } else {
        await this.queueMissingUploads(db, groupUid, group.id, snapshot);
      }
      await setUploadMarker(groupUid, db);
    });
  }

  private async queueFullUpload(
    db: DB,
    groupUid: string,
    group: { id: number; name: string; description: string; currency: string; permission_model: string; creator_id: string; creator_name: string }
  ) {
    const enqueue = (m: Omit<Parameters<typeof enqueueOutboxMutation>[0], 'clientMutationId' | 'groupUid' | 'expectedVersion' | 'operation'>) =>
      enqueueOutboxMutation({ ...m, clientMutationId: `mut_${newUid()}`, groupUid, operation: 'create', expectedVersion: 0 }, db);

    await enqueue({
      entityType: 'group',
      entityUid: groupUid,
      payload: {
        uid: groupUid,
        name: group.name,
        description: group.description,
        currency: group.currency,
        permissionModel: group.permission_model,
        creatorId: group.creator_id,
        creatorName: group.creator_name,
      },
    });
    const members = await db.getAllAsync<{ uid: string; name: string; is_me: number }>(
      'SELECT uid, name, is_me FROM members WHERE group_id = ? AND is_deleted = 0 ORDER BY id',
      [group.id]
    );
    for (const m of members) {
      await enqueue({ entityType: 'member', entityUid: m.uid, payload: { uid: m.uid, name: m.name, isMe: !!m.is_me } });
    }
    const txs = await db.getAllAsync<{ id: number }>('SELECT id FROM transactions WHERE group_id = ? AND is_deleted = 0 ORDER BY id', [group.id]);
    for (const t of txs) {
      const payload = await buildTxSyncPayload(db, t.id);
      await enqueue({ entityType: 'transaction', entityUid: payload.txUid, payload });
    }
    // Every entity is created at server version 1; later edits must expect that.
    await db.runAsync('UPDATE groups SET server_version = 1 WHERE id = ?', [group.id]);
    await db.runAsync('UPDATE members SET server_version = 1 WHERE group_id = ?', [group.id]);
    await db.runAsync('UPDATE transactions SET server_version = 1 WHERE group_id = ?', [group.id]);
  }

  /** The server already has the group (another member uploaded it): send only what it lacks. */
  private async queueMissingUploads(db: DB, groupUid: string, groupId: number, snapshot: GroupBootstrapResponse) {
    const queuedCreates = new Set(
      (
        await db.getAllAsync<{ entity_uid: string }>(`SELECT entity_uid FROM outbox_mutations WHERE group_uid = ? AND operation = 'create'`, [groupUid])
      ).map((r) => r.entity_uid)
    );
    const serverMembersByName = new Map(snapshot.members.map((m) => [normName(m.name), m]));
    const serverNameByUid = new Map(snapshot.members.map((m) => [m.uid, m.name]));

    const members = await db.getAllAsync<{ id: number; uid: string; name: string; is_me: number }>(
      'SELECT id, uid, name, is_me FROM members WHERE group_id = ? AND is_deleted = 0 ORDER BY id',
      [groupId]
    );
    for (const m of members) {
      const onServer = serverMembersByName.get(normName(m.name));
      if (onServer) {
        // Same person, server identity wins so later renames/deletes target the right row.
        await db.runAsync('UPDATE members SET uid = ?, server_version = ? WHERE id = ?', [onServer.uid, onServer.serverVersion, m.id]);
      } else if (!queuedCreates.has(m.uid)) {
        await enqueueOutboxMutation(
          {
            clientMutationId: `mut_${newUid()}`,
            groupUid,
            entityType: 'member',
            entityUid: m.uid,
            operation: 'create',
            expectedVersion: 0,
            payload: { uid: m.uid, name: m.name, isMe: !!m.is_me },
          },
          db
        );
      }
    }

    const serverTxs = new Map(snapshot.transactions.map((t) => [t.uid, t]));
    const claimedRemoteUids = new Set<string>();
    const txs = await db.getAllAsync<{ id: number; uid: string }>('SELECT id, uid FROM transactions WHERE group_id = ? AND is_deleted = 0 ORDER BY id', [groupId]);
    for (const t of txs) {
      const payload = await buildTxSyncPayload(db, t.id);
      let remote = serverTxs.get(payload.txUid);

      // If no match by exact UID, check if this is an imported or unlinked transaction
      // that already exists on the server (matched by title, amount, date, payer, and creation timestamp)
      if (!remote) {
        for (const cand of snapshot.transactions) {
          if (claimedRemoteUids.has(cand.uid)) continue;
          const sameType = (cand.type || 'expense') === (payload.type || 'expense');
          const sameTitle = normName(cand.title) === normName(payload.title);
          const sameAmount = cand.amount === payload.amount;
          const sameDate = cand.date === payload.date;
          const candPayerName = normName(serverNameByUid.get(cand.paidByMemberUid ?? '') || '');
          const samePayer = candPayerName === normName(payload.paidByName);
          const candTs = cand.createdTs;
          const localTs = payload.createdTs;
          const sameTs = candTs && localTs ? Math.abs(candTs - localTs) < 2000 : true;

          if (sameType && sameTitle && sameAmount && sameDate && samePayer && sameTs) {
            remote = cand;
            claimedRemoteUids.add(cand.uid);
            await db.runAsync(
              `UPDATE transactions SET uid = ?, server_version = ?, author_id = COALESCE(NULLIF(author_id, ''), ?), author_name = COALESCE(NULLIF(author_name, ''), ?) WHERE id = ?`,
              [cand.uid, cand.serverVersion, cand.authorId || '', cand.authorName || '', t.id]
            );
            break;
          }
        }
      } else {
        claimedRemoteUids.add(remote.uid);
      }

      if (!remote) {
        if (!queuedCreates.has(payload.txUid)) {
          await enqueueOutboxMutation(
            {
              clientMutationId: `mut_${newUid()}`,
              groupUid,
              entityType: 'transaction',
              entityUid: payload.txUid,
              operation: 'create',
              expectedVersion: 0,
              payload,
            },
            db
          );
        }
        continue;
      }
      // Both copies exist. The server's copy is authoritative and will be pulled; if this
      // device's copy differs, say so instead of replacing it silently.
      const localSplits = payload.splits.map((s) => `${normName(s.memberName)}:${s.share}`).sort().join('|');
      const remoteSplits = remote.splits.map((s) => `${normName(serverNameByUid.get(s.memberUid ?? ''))}:${s.share}`).sort().join('|');
      const differs =
        remote.amount !== payload.amount ||
        remote.title !== payload.title ||
        remote.date !== payload.date ||
        normName(serverNameByUid.get(remote.paidByMemberUid ?? '')) !== normName(payload.paidByName) ||
        remoteSplits !== localSplits;
      if (differs) {
        await recordSyncNotification(db, {
          groupUid,
          authorName: 'EvenUp',
          title: 'Kept the server version',
          message: `Your copy of "${payload.title}" (${payload.amount / 100}) differed from the group's shared copy (${remote.amount / 100}). The shared copy was kept.`,
        });
      }
    }
  }

  /** Flushes pending mutations from the local outbox to the server, in order. */
  public async pushPendingMutations(groupUid: string, deviceId: string): Promise<{ accepted: number; conflicts: number; rejected: number }> {
    const db = await this.getEngineDb();
    await resetInFlightOutboxMutations(groupUid, db);
    const pending = await getPendingOutboxMutations(groupUid, db);
    const totals = { accepted: 0, conflicts: 0, rejected: 0 };
    if (pending.length === 0) return totals;

    const identity = await getIdentity();
    for (let i = 0; i < pending.length; i += MAX_MUTATIONS_PER_PUSH) {
      const batch = pending.slice(i, i + MAX_MUTATIONS_PER_PUSH);
      const ids = batch.map((m) => m.clientMutationId);
      await markOutboxMutationInFlight(ids, db);

      let resp: PushMutationsResponse;
      try {
        resp = await this.transport.push({
          groupUid,
          deviceId,
          actorId: identity.id,
          actorName: identity.name,
          mutations: batch.map((m) => ({
            clientMutationId: m.clientMutationId,
            entityType: m.entityType,
            entityUid: m.entityUid,
            operation: m.operation,
            expectedVersion: m.expectedVersion,
            payload: m.payload,
          })),
        });
      } catch (err) {
        // Transient: keep them queued (in order) for the next trigger.
        await requeueOutboxMutations(ids, err instanceof Error ? err.message : 'Push failed', db);
        throw err;
      }

      const byId = new Map(batch.map((m) => [m.clientMutationId, m]));
      const answered = new Set<string>();
      for (const res of resp.results) {
        const mutation = byId.get(res.clientMutationId);
        if (!mutation) continue;
        answered.add(res.clientMutationId);
        if (res.status === 'ACCEPTED') {
          totals.accepted++;
          if (res.serverVersion) await this.updateLocalEntityVersion(db, groupUid, res.entityUid, res.serverVersion);
          await removeOutboxMutation(res.clientMutationId, db);
        } else if (res.status === 'CONFLICT' && (await this.adoptExistingMember(db, mutation, res.error, res.message))) {
          totals.accepted++;
        } else if (res.status === 'CONFLICT') {
          totals.conflicts++;
          await markOutboxMutationConflict(res.clientMutationId, res.message || res.error || 'Conflict detected', db);
        } else {
          totals.rejected++;
          await markOutboxMutationFailed(res.clientMutationId, res.message || res.error || 'Mutation rejected', db);
        }
      }
      const unanswered = ids.filter((id) => !answered.has(id));
      await requeueOutboxMutations(unanswered, 'Server did not answer this mutation', db);
    }
    return totals;
  }

  /**
   * Another device already added a member with this name. Members are identified by name within
   * a group, so this is the same person: adopt the server's uid instead of keeping a conflict.
   */
  private async adoptExistingMember(db: DB, mutation: OutboxMutation, code?: string, message?: string): Promise<boolean> {
    if (mutation.entityType !== 'member' || mutation.operation !== 'create' || code !== 'DUPLICATE_MEMBER_NAME') return false;
    const serverUid = /\bas (\S+)$/.exec(message ?? '')?.[1];
    if (!serverUid) return false;
    await db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE members SET uid = ? WHERE uid = ?', [serverUid, mutation.entityUid]);
      await db.runAsync('UPDATE outbox_mutations SET entity_uid = ? WHERE entity_uid = ?', [serverUid, mutation.entityUid]);
      await removeOutboxMutation(mutation.clientMutationId, db);
    });
    return true;
  }

  /** Pulls changes after the cursor, page by page, each page applied in one SQLite transaction. */
  public async pullRemoteChanges(groupUid: string): Promise<number> {
    const db = await this.getEngineDb();
    const deviceId = await getDeviceId();
    const myId = (await getIdentity()).id;
    let applied = 0;
    let cursorReset = false;

    for (;;) {
      const state = (await getSyncState(groupUid, db)) ?? (await initSyncState(groupUid, deviceId, db));
      const after = state.lastServerSequence;
      let delta: PullChangesResponse;
      try {
        delta = await this.transport.pull(groupUid, after, PULL_PAGE_SIZE);
      } catch (err) {
        // The server has less history than this phone (its database was restored, replaced or
        // reset), so it may also lack rows this phone already sent. Forget the cursor and the
        // upload marker: the next cycle compares with the server (ensureUploaded), uploads what it
        // is missing, then replays its change log from 0 onto the linked rows.
        if (!cursorReset && err instanceof SyncHttpError && err.code === 'CURSOR_AHEAD') {
          cursorReset = true;
          await resetSyncBinding(groupUid, db);
          this.rerunRequested.add(groupUid);
          break;
        }
        throw err;
      }

      if (delta.changes.length === 0) {
        await updateServerSequence(groupUid, delta.latestServerSequence, undefined, db);
        break;
      }

      // Replaying history from the start (first sync, server switch) should not flood notifications.
      const notify = after > 0;
      let unreconciled = false;
      await db.withTransactionAsync(async () => {
        // The group's binding was reset (e.g. CURSOR_AHEAD recovery or a server switch) while this
        // cycle waited on the network. Applying the server's changes before ensureUploaded has
        // linked this phone's rows would add second copies of them. Stop without moving the cursor;
        // the next cycle reconciles first and then pulls.
        if (!(await hasUploadMarker(groupUid, db))) {
          unreconciled = true;
          return;
        }
        for (const change of delta.changes) {
          await this.applyServerChange(db, groupUid, change, notify && change.actorId !== myId);
        }
        // Advance the cursor only together with the applied changes.
        await updateServerSequence(groupUid, delta.latestServerSequence, undefined, db);
      });
      if (unreconciled) {
        this.rerunRequested.add(groupUid);
        break;
      }
      applied += delta.changes.length;
      if (!delta.hasMore) break;
    }
    return applied;
  }

  private async applyServerChange(db: DB, groupUid: string, change: ServerChange, notify: boolean): Promise<void> {
    const nowIso = new Date().toISOString();
    const at = change.createdAt || nowIso;
    const isDelete = change.operation === 'delete';
    const p = (change.payload ?? {}) as any;
    const note = async (authorName: string, title: string, message: string) => {
      if (notify) await recordSyncNotification(db, { groupUid, authorName, title, message });
    };

    if (change.entityType === 'group') {
      const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM groups WHERE uid = ?', [groupUid]);
      if (isDelete) {
        await db.runAsync('UPDATE groups SET is_deleted = 1, deleted_at = ?, server_version = ? WHERE uid = ?', [at, change.entityVersion, groupUid]);
        await note('', 'Group deleted', 'The group creator deleted this group.');
      } else if (existing) {
        await db.runAsync(
          `UPDATE groups SET
             name = COALESCE(?, name), description = COALESCE(?, description), currency = COALESCE(?, currency),
             permission_model = COALESCE(?, permission_model), server_version = ?, is_deleted = 0, deleted_at = NULL, updated_at = ?
           WHERE id = ?`,
          [p.name ?? null, p.description ?? null, p.currency ?? null, p.permissionModel ?? null, change.entityVersion, nowIso, existing.id]
        );
        if (change.operation === 'update') await note('', 'Group updated', 'Group settings were changed.');
      } else {
        await db.runAsync(
          `INSERT INTO groups (uid, name, description, currency, permission_model, creator_id, creator_name, server_version, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            groupUid,
            p.name || 'Group',
            p.description || '',
            p.currency || 'USD',
            p.permissionModel || 'collaborative',
            p.creatorId || change.actorId,
            p.creatorName || '',
            change.entityVersion,
            at,
            nowIso,
          ]
        );
        // It came from the server, so there is nothing to upload.
        await setUploadMarker(groupUid, db);
      }
      return;
    }

    const groupRow = await db.getFirstAsync<{ id: number; currency: string }>('SELECT id, currency FROM groups WHERE uid = ?', [groupUid]);
    if (!groupRow) throw new Error(`Change ${change.sequence} references group ${groupUid}, which is not on this device`);

    if (change.entityType === 'member') {
      const byUid = await db.getFirstAsync<{ id: number; name: string }>('SELECT id, name FROM members WHERE uid = ? AND group_id = ?', [
        change.entityUid,
        groupRow.id,
      ]);
      if (isDelete) {
        if (byUid) {
          await db.runAsync('UPDATE members SET is_deleted = 1, deleted_at = ?, server_version = ? WHERE id = ?', [at, change.entityVersion, byUid.id]);
          await note('', 'Member removed', `${byUid.name} was removed from the group.`);
        }
        return;
      }
      const name = p.newName || p.name;
      const existing =
        byUid ??
        (await db.getFirstAsync<{ id: number; name: string }>(
          'SELECT id, name FROM members WHERE group_id = ? AND is_deleted = 0 AND LOWER(TRIM(name)) = LOWER(TRIM(?))',
          [groupRow.id, p.name]
        ));
      if (existing) {
        await db.runAsync('UPDATE members SET uid = ?, name = ?, user_id = COALESCE(?, user_id), server_version = ?, is_deleted = 0, deleted_at = NULL WHERE id = ?', [
          change.entityUid,
          name,
          p.userId ?? null,
          change.entityVersion,
          existing.id,
        ]);
        if (change.operation === 'update' && existing.name !== name) await note('', 'Member renamed', `${existing.name} is now ${name}.`);
      } else {
        await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, user_id, server_version, is_deleted, created_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)', [
          groupRow.id,
          change.entityUid,
          name,
          p.userId ?? null,
          change.entityVersion,
          at,
        ]);
        await note('', 'Member added', `${name} joined the group.`);
      }
      return;
    }

    // Transactions
    // The uid is the transaction's only identity: two expenses with the same title, amount and day
    // are separate records, so a change is never matched to a look-alike row.
    const existingTx = await db.getFirstAsync<{ id: number; title: string }>('SELECT id, title FROM transactions WHERE uid = ? AND group_id = ?', [
      change.entityUid,
      groupRow.id,
    ]);
    if (isDelete) {
      if (existingTx) {
        await db.runAsync('UPDATE transactions SET is_deleted = 1, deleted_at = ?, server_version = ? WHERE id = ?', [at, change.entityVersion, existingTx.id]);
        await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [existingTx.id]);
        await note('', 'Transaction deleted', `"${existingTx.title}" was deleted.`);
      }
      return;
    }

    const resolveMember = async (uid: string | undefined, name: string | undefined): Promise<number> => {
      if (uid) {
        const m = await db.getFirstAsync<{ id: number }>('SELECT id FROM members WHERE uid = ? AND group_id = ?', [uid, groupRow.id]);
        if (m) return m.id;
      }
      if (name) {
        const m = await db.getFirstAsync<{ id: number }>(
          'SELECT id FROM members WHERE group_id = ? AND is_deleted = 0 AND LOWER(TRIM(name)) = LOWER(TRIM(?))',
          [groupRow.id, name]
        );
        if (m) return m.id;
      }
      // The server always logs member creation before use; this is a guard for older payloads.
      const r = await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, server_version, is_deleted, created_at) VALUES (?, ?, ?, 0, 1, 0, ?)', [
        groupRow.id,
        uid || `mem_${newUid()}`,
        name || 'Member',
        nowIso,
      ]);
      return r.lastInsertRowId;
    };

    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    const hasPayer = Boolean(text(p.paidByMemberUid) || text(p.paidByName));
    const hasSplits = Array.isArray(p.splits) && p.splits.length > 0;
    const rawCreatedTs = p.createdTs;
    const createdTs =
      typeof rawCreatedTs === 'number' && Number.isSafeInteger(rawCreatedTs) && rawCreatedTs > 0
        ? rawCreatedTs
        : typeof rawCreatedTs === 'string' && /^\d+$/.test(rawCreatedTs) && Number(rawCreatedTs) > 0
          ? Number(rawCreatedTs)
          : null;
    let txId: number;
    if (existingTx) {
      // Updates may be partial (the server applies them field by field with COALESCE and logs the
      // fields it received), so a field the change doesn't carry keeps its current value. The
      // author never changes after creation; it decides who may edit in CONTRIBUTOR groups.
      txId = existingTx.id;
      const payerId = hasPayer ? await resolveMember(p.paidByMemberUid, p.paidByName) : null;
      await db.runAsync(
        `UPDATE transactions
         SET type = COALESCE(?, type), title = COALESCE(?, title), amount = COALESCE(?, amount), paid_by = COALESCE(?, paid_by),
             split_type = COALESCE(?, split_type), category = COALESCE(?, category), note = COALESCE(?, note), date = COALESCE(?, date),
             author_id = COALESCE(?, author_id), author_name = COALESCE(?, author_name),
             updated_by_id = ?, updated_by_name = ?, updated_ts = COALESCE(?, updated_ts),
             server_version = ?, is_deleted = 0, deleted_at = NULL, updated_at = ?
         WHERE id = ?`,
        [
          p.type === 'expense' || p.type === 'payment' ? p.type : null,
          text(p.title),
          typeof p.amount === 'number' ? p.amount : null,
          payerId,
          text(p.splitType),
          text(p.category),
          typeof p.note === 'string' ? p.note : null,
          text(p.date),
          text(p.authorId),
          text(p.authorName),
          p.updatedById || (change.operation === 'update' ? change.actorId : ''),
          p.updatedByName || '',
          typeof p.updatedTs === 'number' && p.updatedTs > 0 ? p.updatedTs : null,
          change.entityVersion,
          nowIso,
          txId,
        ]
      );
      // The server's stored creation time is authoritative; older servers don't send it.
      if ('createdTs' in p) await db.runAsync('UPDATE transactions SET created_ts = ? WHERE id = ?', [createdTs, txId]);
      if (hasSplits) await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [txId]);
    } else {
      if (!text(p.title) || typeof p.amount !== 'number' || !hasSplits) {
        // Only a partial update of a transaction this phone never received (e.g. one the server
        // hides): there is nothing to build it from. Record it visibly instead of failing every sync.
        await recordSyncNotification(db, {
          groupUid,
          authorName: 'EvenUp',
          title: 'Incomplete change skipped',
          message: `An edit arrived for a transaction this phone doesn't have (${change.entityUid}), so it couldn't be applied.`,
        });
        return;
      }
      const ins = await db.runAsync(
        `INSERT INTO transactions (type, title, amount, paid_by, split_type, category, note, date, author_id, author_name,
                                   updated_by_id, updated_by_name, updated_ts, server_version, group_id, uid, created_ts, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          p.type || 'expense',
          p.title,
          p.amount,
          await resolveMember(p.paidByMemberUid, p.paidByName),
          p.splitType || 'equal',
          p.category || 'General',
          p.note || '',
          p.date || nowIso.slice(0, 10),
          p.authorId || change.actorId,
          p.authorName || '',
          p.updatedById || '',
          p.updatedByName || '',
          p.updatedTs || 0,
          change.entityVersion,
          groupRow.id,
          change.entityUid,
          createdTs,
          at,
          nowIso,
        ]
      );
      txId = ins.lastInsertRowId;
    }
    for (const s of hasSplits ? p.splits : []) {
      const memberId = await resolveMember(s.memberUid, s.memberName);
      await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [
        txId,
        memberId,
        s.value ?? 1,
        s.share ?? 0,
      ]);
    }

    const amount = typeof p.amount === 'number' ? money(p.amount, groupRow.currency) : '';
    if (existingTx)
      await note(p.updatedByName || '', 'Transaction edited', `${p.updatedByName || 'Someone'} edited "${text(p.title) ?? existingTx.title}"${amount ? ` (${amount})` : ''}.`);
    else await note(p.authorName || '', 'Transaction added', `${p.authorName || 'Someone'} added "${p.title}" (${amount}).`);
  }

  private async updateLocalEntityVersion(db: DB, groupUid: string, entityUid: string, version: number) {
    if (entityUid === groupUid) {
      await db.runAsync('UPDATE groups SET server_version = ? WHERE uid = ?', [version, groupUid]);
    } else {
      await db.runAsync('UPDATE members SET server_version = ? WHERE uid = ?', [version, entityUid]);
      await db.runAsync('UPDATE transactions SET server_version = ? WHERE uid = ?', [version, entityUid]);
    }
  }

  // ---------- Joining and conflict resolution ----------

  /** Fetches the server's current copy of a group (for the join preview). */
  public fetchGroupSnapshot(groupUid: string, customServerUrl?: string): Promise<GroupBootstrapResponse> {
    if (customServerUrl) {
      const tempTransport = new HttpSyncTransport(async () => customServerUrl);
      return tempTransport.bootstrap(groupUid);
    }
    return this.transport.bootstrap(groupUid);
  }

  /**
   * Writes a server snapshot into SQLite as the group's complete state (replacing any local copy)
   * and moves the cursor to the snapshot's sequence. Returns the local group id.
   */
  private async writeSnapshot(db: DB, snap: GroupBootstrapResponse, deviceId: string): Promise<number> {
    const nowIso = new Date().toISOString();
    const g = snap.group;
    const local = await db.getFirstAsync<{ id: number }>('SELECT id FROM groups WHERE uid = ?', [snap.groupUid]);
    let groupId: number;
    let me: { uid: string; name: string } | null = null;
    if (local) {
      groupId = local.id;
      me = await db.getFirstAsync<{ uid: string; name: string }>('SELECT uid, name FROM members WHERE group_id = ? AND is_me = 1', [groupId]);
      await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id IN (SELECT id FROM transactions WHERE group_id = ?)', [groupId]);
      await db.runAsync('DELETE FROM transactions WHERE group_id = ?', [groupId]);
      await db.runAsync('DELETE FROM members WHERE group_id = ?', [groupId]);
      await db.runAsync(
        `UPDATE groups SET name = ?, description = ?, currency = ?, permission_model = ?, creator_id = ?, creator_name = ?,
                server_version = ?, is_deleted = 0, deleted_at = NULL, updated_at = ? WHERE id = ?`,
        [g.name, g.description ?? '', g.currency, g.permissionModel, g.creatorId, g.creatorName, g.serverVersion, nowIso, groupId]
      );
    } else {
      const r = await db.runAsync(
        `INSERT INTO groups (uid, name, description, currency, permission_model, creator_id, creator_name, server_version, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [g.uid, g.name, g.description ?? '', g.currency, g.permissionModel, g.creatorId, g.creatorName, g.serverVersion, g.createdAt || nowIso, nowIso]
      );
      groupId = r.lastInsertRowId;
    }

    const identity = await getIdentity();
    const memberIds = new Map<string, number>();
    for (const m of snap.members) {
      const isMe = me ? m.uid === me.uid || normName(m.name) === normName(me.name) : false;
      const r = await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, user_id, server_version, is_deleted, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', [
        groupId,
        m.uid,
        m.name,
        isMe ? 1 : 0,
        m.userId ?? (isMe ? identity.id : null),
        m.serverVersion,
        nowIso,
      ]);
      memberIds.set(m.uid, r.lastInsertRowId);
    }
    const memberId = (uid: string | undefined, what: string) => {
      const id = uid ? memberIds.get(uid) : undefined;
      if (!id) throw new Error(`Server snapshot is inconsistent: ${what} references unknown member ${uid}`);
      return id;
    };
    for (const t of snap.transactions) {
      const r = await db.runAsync(
        `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name,
                                   updated_by_id, updated_by_name, updated_ts, created_ts, server_version, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          groupId,
          t.uid,
          t.type,
          t.title,
          t.amount,
          memberId(t.paidByMemberUid, `"${t.title}" payer`),
          t.splitType,
          t.category,
          t.note ?? '',
          t.date,
          t.authorId ?? '',
          t.authorName ?? '',
          t.updatedById ?? '',
          t.updatedByName ?? '',
          t.updatedTs != null ? Number(t.updatedTs) : 0,
          t.createdTs != null && Number(t.createdTs) > 0 ? Number(t.createdTs) : null,
          t.serverVersion,
          t.createdAt || nowIso,
          t.updatedAt || nowIso,
        ]
      );
      for (const s of t.splits) {
        await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [
          r.lastInsertRowId,
          memberId(s.memberUid, `"${t.title}" split`),
          s.value,
          s.share,
        ]);
      }
    }

    await initSyncState(snap.groupUid, deviceId, db);
    await resetServerSequence(snap.groupUid, snap.serverSequence, db);
    await updateServerSequence(snap.groupUid, snap.serverSequence, undefined, db);
    await setUploadMarker(snap.groupUid, db);
    return groupId;
  }

  /**
   * Joins a group from the server's snapshot and binds "me" to the chosen member name
   * (adding a new member when the name is not in the group). Returns the local group id.
   */
  public async joinGroup(snapshot: GroupBootstrapResponse, myName: string): Promise<number> {
    const db = await this.getEngineDb();
    const deviceId = await getDeviceId();
    let groupId = 0;
    await db.withTransactionAsync(async () => {
      groupId = await this.writeSnapshot(db, snapshot, deviceId);
    });
    const chosen = snapshot.members.find((m) => normName(m.name) === normName(myName));
    if (chosen) {
      const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM members WHERE group_id = ? AND uid = ?', [groupId, chosen.uid]);
      await setMe(groupId, row!.id);
    } else {
      await setMe(groupId, await addMember(groupId, myName));
    }
    this.emit(this.listeners, snapshot.groupUid);
    this.syncGroup(snapshot.groupUid).catch(() => {});
    return groupId;
  }

  /**
   * Explicit user decision after a conflict or rejection: drop this device's refused changes and
   * replace the local copy of the group with the server's. Refuses while unsent changes remain,
   * so nothing that has not reached the server is lost.
   */
  public async acceptServerVersion(groupUid: string): Promise<void> {
    await this.syncGroup(groupUid);
    const db = await this.getEngineDb();
    const counts = await getOutboxCount(groupUid, db);
    if (counts.pending + counts.sending > 0) {
      throw new Error('Some changes have not reached the server yet. Try again when you are online.');
    }
    const snapshot = await this.transport.bootstrap(groupUid);
    const deviceId = await getDeviceId();
    await db.withTransactionAsync(async () => {
      await discardUnresolvedOutboxMutations(groupUid, db);
      await this.writeSnapshot(db, snapshot, deviceId);
    });
    await setSyncStatus(groupUid, 'idle', null, db);
    this.emit(this.listeners, groupUid);
    this.emit(this.statusListeners, groupUid);
  }
}

export const syncEngine = new SyncEngine();
