import { DB, getDb } from './db';
import { OutboxMutation, OutboxStatus, SyncEntityType, SyncOperation } from './types';

interface OutboxRow {
  id: number;
  client_mutation_id: string;
  group_uid: string;
  entity_type: string;
  entity_uid: string;
  operation: string;
  expected_version: number;
  payload: string;
  created_at: string;
  retry_count: number;
  status: string;
  error_message: string | null;
}

const mapOutboxRow = (r: OutboxRow): OutboxMutation => ({
  id: r.id,
  clientMutationId: r.client_mutation_id,
  groupUid: r.group_uid,
  entityType: r.entity_type as SyncEntityType,
  entityUid: r.entity_uid,
  operation: r.operation as SyncOperation,
  expectedVersion: r.expected_version,
  payload: JSON.parse(r.payload),
  createdAt: r.created_at,
  retryCount: r.retry_count,
  status: r.status as OutboxStatus,
  errorMessage: r.error_message ?? undefined,
});

/** Enqueues a new mutation into the local outbox. Can participate in an existing SQLite transaction. */
export async function enqueueOutboxMutation<T = unknown>(
  input: {
    clientMutationId: string;
    groupUid: string;
    entityType: SyncEntityType;
    entityUid: string;
    operation: SyncOperation;
    expectedVersion: number;
    payload: T;
  },
  dbInstance?: DB
): Promise<OutboxMutation<T>> {
  const db = dbInstance ?? (await getDb());
  const now = new Date().toISOString();
  const payloadStr = JSON.stringify(input.payload);

  const res = await db.runAsync(
    `INSERT INTO outbox_mutations (client_mutation_id, group_uid, entity_type, entity_uid, operation, expected_version, payload, created_at, retry_count, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL)
     ON CONFLICT(client_mutation_id) DO UPDATE SET
       payload = excluded.payload,
       expected_version = excluded.expected_version,
       status = 'pending'`,
    [
      input.clientMutationId,
      input.groupUid,
      input.entityType,
      input.entityUid,
      input.operation,
      input.expectedVersion,
      payloadStr,
      now,
    ]
  );

  return {
    id: res.lastInsertRowId,
    clientMutationId: input.clientMutationId,
    groupUid: input.groupUid,
    entityType: input.entityType,
    entityUid: input.entityUid,
    operation: input.operation,
    expectedVersion: input.expectedVersion,
    payload: input.payload,
    createdAt: now,
    retryCount: 0,
    status: 'pending',
  };
}

/** Retrieves all pending mutations for a group or globally, in FIFO creation order. */
export async function getPendingOutboxMutations(groupUid?: string, dbInstance?: DB): Promise<OutboxMutation[]> {
  const db = dbInstance ?? (await getDb());
  const sql = groupUid
    ? `SELECT * FROM outbox_mutations WHERE group_uid = ? AND status = 'pending' ORDER BY id ASC`
    : `SELECT * FROM outbox_mutations WHERE status = 'pending' ORDER BY id ASC`;
  const params = groupUid ? [groupUid] : [];
  const rows = await db.getAllAsync<OutboxRow>(sql, params);
  return rows.map(mapOutboxRow);
}

/** Retrieves outbox mutations filtered by status. */
export async function getOutboxMutationsByStatus(status: OutboxStatus, groupUid?: string, dbInstance?: DB): Promise<OutboxMutation[]> {
  const db = dbInstance ?? (await getDb());
  const sql = groupUid
    ? `SELECT * FROM outbox_mutations WHERE group_uid = ? AND status = ? ORDER BY id ASC`
    : `SELECT * FROM outbox_mutations WHERE status = ? ORDER BY id ASC`;
  const params = groupUid ? [groupUid, status] : [status];
  const rows = await db.getAllAsync<OutboxRow>(sql, params);
  return rows.map(mapOutboxRow);
}

/** Marks a set of mutations as in-flight (sending). */
export async function markOutboxMutationInFlight(clientMutationIds: string[], dbInstance?: DB): Promise<void> {
  if (clientMutationIds.length === 0) return;
  const db = dbInstance ?? (await getDb());
  const placeholders = clientMutationIds.map(() => '?').join(',');
  await db.runAsync(`UPDATE outbox_mutations SET status = 'sending' WHERE client_mutation_id IN (${placeholders})`, clientMutationIds);
}

/** Marks a mutation as failed, recording error detail and incrementing retry count. */
export async function markOutboxMutationFailed(clientMutationId: string, errorMessage: string, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  await db.runAsync(
    `UPDATE outbox_mutations SET status = 'failed', retry_count = retry_count + 1, error_message = ? WHERE client_mutation_id = ?`,
    [errorMessage, clientMutationId]
  );
}

/**
 * Returns mutations to 'pending' after a transient failure (network down, server 5xx) so the next
 * sync retries them. Safe because the server deduplicates by clientMutationId.
 */
export async function requeueOutboxMutations(clientMutationIds: string[], errorMessage: string, dbInstance?: DB): Promise<void> {
  if (clientMutationIds.length === 0) return;
  const db = dbInstance ?? (await getDb());
  const placeholders = clientMutationIds.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE outbox_mutations SET status = 'pending', retry_count = retry_count + 1, error_message = ? WHERE client_mutation_id IN (${placeholders})`,
    [errorMessage, ...clientMutationIds]
  );
}

/** Recovers mutations left 'sending' by a push that never completed (e.g. the app was killed mid-request). */
export async function resetInFlightOutboxMutations(groupUid: string, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  await db.runAsync(`UPDATE outbox_mutations SET status = 'pending' WHERE group_uid = ? AND status = 'sending'`, [groupUid]);
}

/** Lists mutations the server refused (conflict or rejected) so the user can review them. */
export async function getUnresolvedOutboxMutations(groupUid: string, dbInstance?: DB): Promise<OutboxMutation[]> {
  const db = dbInstance ?? (await getDb());
  const rows = await db.getAllAsync<OutboxRow>(
    `SELECT * FROM outbox_mutations WHERE group_uid = ? AND status IN ('conflict', 'failed') ORDER BY id ASC`,
    [groupUid]
  );
  return rows.map(mapOutboxRow);
}

/**
 * Drops this device's refused mutations for a group. Only called on an explicit user decision,
 * together with rebuilding the group from the server (SyncEngine.acceptServerVersion).
 */
export async function discardUnresolvedOutboxMutations(groupUid: string, dbInstance?: DB): Promise<number> {
  const db = dbInstance ?? (await getDb());
  const res = await db.runAsync(`DELETE FROM outbox_mutations WHERE group_uid = ? AND status IN ('conflict', 'failed')`, [groupUid]);
  return res.changes;
}

/** Marks a mutation as conflict, indicating server version mismatch. */
export async function markOutboxMutationConflict(clientMutationId: string, errorMessage: string, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  await db.runAsync(
    `UPDATE outbox_mutations SET status = 'conflict', error_message = ? WHERE client_mutation_id = ?`,
    [errorMessage, clientMutationId]
  );
}

/** Removes a specific mutation from the outbox (e.g. after acknowledged sync or discarded conflict). */
export async function removeOutboxMutation(clientMutationId: string, dbInstance?: DB): Promise<void> {
  const db = dbInstance ?? (await getDb());
  await db.runAsync(`DELETE FROM outbox_mutations WHERE client_mutation_id = ?`, [clientMutationId]);
}

/** Returns the count of outbox mutations grouped by status. */
export async function getOutboxCount(groupUid?: string, dbInstance?: DB): Promise<{ pending: number; sending: number; failed: number; conflict: number; total: number }> {
  const db = dbInstance ?? (await getDb());
  const sql = groupUid
    ? `SELECT status, COUNT(*) as c FROM outbox_mutations WHERE group_uid = ? GROUP BY status`
    : `SELECT status, COUNT(*) as c FROM outbox_mutations GROUP BY status`;
  const params = groupUid ? [groupUid] : [];
  const rows = await db.getAllAsync<{ status: string; c: number }>(sql, params);

  const counts = { pending: 0, sending: 0, failed: 0, conflict: 0, total: 0 };
  for (const r of rows) {
    if (r.status === 'pending') counts.pending = r.c;
    else if (r.status === 'sending') counts.sending = r.c;
    else if (r.status === 'failed') counts.failed = r.c;
    else if (r.status === 'conflict') counts.conflict = r.c;
    counts.total += r.c;
  }
  return counts;
}
