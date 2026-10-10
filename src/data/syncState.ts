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

// A group's "upload marker" says its full local history is already in the outbox or on the server.
// Groups without it (created before the sync engine existed) get backfilled on their first sync.
const uploadMarkerKey = (groupUid: string) => `sync.uploaded.${groupUid}`;

export async function hasUploadMarker(groupUid: string, dbInstance?: DB): Promise<boolean> {
  const db = dbInstance ?? (await getDb());
  return !!(await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [uploadMarkerKey(groupUid)]));
}

export async function setUploadMarker(groupUid: string, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [uploadMarkerKey(groupUid), new Date().toISOString()]
  );
}

/** True once this phone has received the group's history from the server (it existed there). */
export async function hasServerHistory(groupUid: string, dbInstance?: DB): Promise<boolean> {
  const db = dbInstance ?? (await getDb());
  const row = await db.getFirstAsync<{ s: number }>('SELECT last_server_sequence AS s FROM sync_state WHERE group_uid = ?', [groupUid]);
  return (row?.s ?? 0) > 0;
}

/** Forgets every group's server cursor and upload marker (used when the server URL changes). */
export async function resetAllSyncBindings(dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  await db.runAsync(`DELETE FROM settings WHERE key LIKE 'sync.uploaded.%'`, []);
  await db.runAsync(`UPDATE sync_state SET last_server_sequence = 0, updated_at = ?`, [new Date().toISOString()]);
}

/**
 * Forgets one group's server cursor and upload marker. Used when the server has less history than
 * this phone (CURSOR_AHEAD): the next sync compares with the server again, links the rows it
 * already has, uploads only what it lacks, and replays the change log onto the linked rows.
 */
export async function resetSyncBinding(groupUid: string, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  await db.runAsync('DELETE FROM settings WHERE key = ?', [uploadMarkerKey(groupUid)]);
  await db.runAsync('UPDATE sync_state SET last_server_sequence = 0, updated_at = ? WHERE group_uid = ?', [new Date().toISOString(), groupUid]);
}

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

/**
 * Sets the cursor to an exact value (unlike updateServerSequence, which only moves forward).
 * Used after a bootstrap and when the server reports the cursor is ahead of its history.
 */
export async function resetServerSequence(groupUid: string, serverSequence: number, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  await db.runAsync(`UPDATE sync_state SET last_server_sequence = ?, updated_at = ? WHERE group_uid = ?`, [
    serverSequence,
    new Date().toISOString(),
    groupUid,
  ]);
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
