import { DB, getDb } from './db';
import { SyncState, SyncStatus } from './types';

interface SyncStateRow {
  group_uid: string;
  device_id: string;
  last_server_sequence: number;
  last_sync_at: string | null;
  sync_status: string;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
}

const mapSyncStateRow = (r: SyncStateRow): SyncState => ({
  groupUid: r.group_uid,
  deviceId: r.device_id,
  lastServerSequence: r.last_server_sequence,
  lastSyncAt: r.last_sync_at,
  syncStatus: r.sync_status as SyncStatus,
  errorDetail: r.error_detail,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Retrieves the current synchronization state and cursor for a group. */
export async function getSyncState(groupUid: string, dbInstance?: DB): Promise<SyncState | null> {
  const db = dbInstance ?? (await getDb());
  const row = await db.getFirstAsync<SyncStateRow>(`SELECT * FROM sync_state WHERE group_uid = ?`, [groupUid]);
  return row ? mapSyncStateRow(row) : null;
}

/** Initializes or ensures sync state entry for a group. */
export async function initSyncState(groupUid: string, deviceId: string, dbInstance?: DB): Promise<SyncState> {
  const db = dbInstance ?? (await getDb());
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO sync_state (group_uid, device_id, last_server_sequence, last_sync_at, sync_status, error_detail, created_at, updated_at)
     VALUES (?, ?, 0, NULL, 'idle', NULL, ?, ?)
     ON CONFLICT(group_uid) DO UPDATE SET
       device_id = CASE WHEN excluded.device_id != '' THEN excluded.device_id ELSE sync_state.device_id END,
       updated_at = excluded.updated_at`,
    [groupUid, deviceId, now, now]
  );
  const state = await getSyncState(groupUid, db);
  if (!state) throw new Error(`Failed to initialize sync state for group ${groupUid}`);
  return state;
}

/** Updates the server sequence cursor after successful transactional application of remote changes. */
export async function updateServerSequence(groupUid: string, serverSequence: number, lastSyncAt?: string, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  const now = lastSyncAt || new Date().toISOString();
  await db.runAsync(
    `UPDATE sync_state
     SET last_server_sequence = MAX(last_server_sequence, ?),
         last_sync_at = ?,
         sync_status = 'idle',
         error_detail = NULL,
         updated_at = ?
     WHERE group_uid = ?`,
    [serverSequence, now, now, groupUid]
  );
}

/** Sets the current sync status and optional error details for a group. */
export async function setSyncStatus(groupUid: string, status: SyncStatus, errorDetail?: string | null, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE sync_state
     SET sync_status = ?,
         error_detail = ?,
         updated_at = ?
     WHERE group_uid = ?`,
    [status, errorDetail ?? null, now, groupUid]
  );
}

/** Retrieves all active sync states across all groups. */
export async function getAllSyncStates(dbInstance?: DB): Promise<SyncState[]> {
  const db = dbInstance ?? (await getDb());
  const rows = await db.getAllAsync<SyncStateRow>(`SELECT * FROM sync_state ORDER BY updated_at DESC`, []);
  return rows.map(mapSyncStateRow);
}
