// Core Synchronization Service for SplitMate Server
import { ServerDB } from './db';
import { checkServerPermission } from './permissions';
import { serverRealtimeHub } from './realtimeHub';
import {
  GroupBootstrapResponse,
  PullChangesResponse,
  PushMutationResult,
  PushMutationsRequest,
  PushMutationsResponse,
  ServerChange,
} from './types';

export interface ServerPushRequest {
  groupUid: string;
  deviceId: string;
  actorId?: string;
  actorName?: string;
  mutations: Array<{
    clientMutationId: string;
    entityType: 'group' | 'member' | 'transaction';
    entityUid: string;
    operation: 'create' | 'update' | 'delete';
    expectedVersion: number;
    payload: any;
  }>;
}

const nowIso = () => new Date().toISOString();

/** Generates unique random IDs */
function newServerId(prefix = 'chg') {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

/** Registers device presence */
function touchDevice(db: ServerDB, deviceId: string, userId?: string, userName?: string) {
  const now = nowIso();
  db.run(
    `INSERT INTO devices (device_id, user_id, user_name, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       user_id = COALESCE(excluded.user_id, devices.user_id),
       user_name = COALESCE(excluded.user_name, devices.user_name),
       last_seen_at = excluded.last_seen_at`,
    [deviceId, userId ?? null, userName ?? null, now, now]
  );
}

/** Record a server change entry in the monotonic change log */
function appendChangeLog(
  db: ServerDB,
  groupUid: string,
  entityType: 'group' | 'member' | 'transaction',
  entityUid: string,
  operation: 'create' | 'update' | 'delete',
  actorId: string,
  deviceId: string,
  entityVersion: number,
  payload: any
): number {
  const changeId = newServerId('chg');
  const res = db.run(
    `INSERT INTO sync_changes (change_id, group_uid, entity_type, entity_uid, operation, actor_id, device_id, entity_version, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [changeId, groupUid, entityType, entityUid, operation, actorId, deviceId, entityVersion, JSON.stringify(payload), nowIso()]
  );
  return res.lastInsertRowId;
}

/** Returns the highest server sequence for a group */
export function getLatestServerSequence(db: ServerDB, groupUid: string): number {
  const row = db.get<{ max_seq: number | null }>('SELECT MAX(sequence) as max_seq FROM sync_changes WHERE group_uid = ?', [groupUid]);
  return row?.max_seq ?? 0;
}

/** Bootstrap Group: Returns full snapshot with matching point-in-time server cursor */
export function getGroupBootstrap(db: ServerDB, groupUid: string): GroupBootstrapResponse {
  const group = db.get<{
    id: number;
    uid: string;
    name: string;
    description: string;
    currency: string;
    permission_model: string;
    creator_id: string;
    creator_name: string;
    sync_key: string;
    server_version: number;
    is_deleted: number;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM groups WHERE uid = ? AND is_deleted = 0', [groupUid]);

  if (!group) {
    throw new Error(`Group ${groupUid} not found`);
  }

  const members = db.all<{
    id: number;
    member_uid: string;
    name: string;
    user_id: string | null;
    role: string;
    server_version: number;
    is_deleted: number;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM group_members WHERE group_uid = ? AND is_deleted = 0 ORDER BY id ASC', [groupUid]);

  const txRows = db.all<{
    id: number;
    tx_uid: string;
    type: 'expense' | 'payment';
    title: string;
    amount: number;
    paid_by_member_uid: string;
    split_type: any;
    category: string;
    note: string;
    date: string;
    author_id: string;
    author_name: string;
    updated_by_id: string | null;
    updated_by_name: string | null;
    updated_ts: number;
    server_version: number;
    is_deleted: number;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM transactions WHERE group_uid = ? AND is_deleted = 0 ORDER BY date DESC, id DESC', [groupUid]);

  const splits = db.all<{
    transaction_uid: string;
    member_uid: string;
    value: number;
    share: number;
  }>(
    `SELECT s.transaction_uid, s.member_uid, s.value, s.share
     FROM transaction_splits s
     JOIN transactions t ON t.tx_uid = s.transaction_uid
     WHERE t.group_uid = ? AND t.is_deleted = 0`,
    [groupUid]
  );

  const splitsByTx = new Map<string, Array<{ memberId: number; value: number; share: number }>>();
  const memberUidToId = new Map(members.map((m) => [m.member_uid, m.id]));

  for (const s of splits) {
    if (!splitsByTx.has(s.transaction_uid)) splitsByTx.set(s.transaction_uid, []);
    const memberId = memberUidToId.get(s.member_uid) ?? 0;
    splitsByTx.get(s.transaction_uid)!.push({
      memberId,
      value: s.value,
      share: s.share,
    });
  }

  const serverSequence = getLatestServerSequence(db, groupUid);

  return {
    groupUid: group.uid,
    serverSequence,
    group: {
      id: group.id,
      uid: group.uid,
      name: group.name,
      description: group.description,
      currency: group.currency,
      permissionModel: group.permission_model.toLowerCase() as any,
      creatorId: group.creator_id,
      creatorName: group.creator_name,
      syncKey: group.sync_key,
      serverVersion: group.server_version,
      isDeleted: Boolean(group.is_deleted),
      createdAt: group.created_at,
      updatedAt: group.updated_at,
    },
    members: members.map((m) => ({
      id: m.id,
      uid: m.member_uid,
      memberUid: m.member_uid,
      name: m.name,
      isMe: false,
      serverVersion: m.server_version,
      isDeleted: Boolean(m.is_deleted),
    })),
    transactions: txRows.map((t) => ({
      id: t.id,
      uid: t.tx_uid,
      groupId: group.id,
      type: t.type,
      title: t.title,
      amount: t.amount,
      paidBy: memberUidToId.get(t.paid_by_member_uid) ?? 0,
      splitType: t.split_type,
      category: t.category,
      note: t.note,
      date: t.date,
      authorId: t.author_id,
      authorName: t.author_name,
      updatedById: t.updated_by_id ?? undefined,
      updatedByName: t.updated_by_name ?? undefined,
      updatedTs: t.updated_ts,
      serverVersion: t.server_version,
      isDeleted: Boolean(t.is_deleted),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      splits: splitsByTx.get(t.tx_uid) || [],
    })),
  };
}

/** Pull Changes: Incremental delta sync after a server sequence cursor */
export function getChangesSince(
  db: ServerDB,
  groupUid: string,
  afterSequence: number,
  limit = 100
): PullChangesResponse {
  const safeLimit = Math.min(Math.max(1, limit), 500);
  const rows = db.all<{
    sequence: number;
    change_id: string;
    group_uid: string;
    entity_type: 'group' | 'member' | 'transaction';
    entity_uid: string;
    operation: 'create' | 'update' | 'delete';
    actor_id: string;
    device_id: string;
    entity_version: number;
    payload: string;
    created_at: string;
  }>(
    `SELECT * FROM sync_changes
     WHERE group_uid = ? AND sequence > ?
     ORDER BY sequence ASC
     LIMIT ?`,
    [groupUid, afterSequence, safeLimit + 1]
  );

  const hasMore = rows.length > safeLimit;
  const resultRows = hasMore ? rows.slice(0, safeLimit) : rows;
  const latestSequence = getLatestServerSequence(db, groupUid);

  const changes: ServerChange[] = resultRows.map((r) => ({
    sequence: r.sequence,
    changeId: r.change_id,
    groupUid: r.group_uid,
    entityType: r.entity_type,
    entityUid: r.entity_uid,
    operation: r.operation,
    actorId: r.actor_id,
    deviceId: r.device_id,
    entityVersion: r.entity_version,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
  }));

  return {
    groupUid,
    latestServerSequence: latestSequence,
    hasMore,
    changes,
  };
}

/** Push Mutations: Process batched client mutations with idempotency, permission, and version checking */
export function processPushMutations(db: ServerDB, req: ServerPushRequest): PushMutationsResponse {
  const actorId = req.actorId || req.deviceId;
  touchDevice(db, req.deviceId, actorId, req.actorName);
  const results: PushMutationResult[] = [];

  for (const mut of req.mutations) {
    const result = db.transaction(() => processSingleMutation(db, req, mut));
    results.push(result);
  }

  // If any mutation was accepted and created a new change sequence, broadcast realtime notification
  const hasNewChanges = results.some((r) => r.status === 'ACCEPTED' && (r.serverSequence ?? 0) > 0);
  if (hasNewChanges) {
    const latestSeq = getLatestServerSequence(db, req.groupUid);
    serverRealtimeHub.publish(req.groupUid, {
      type: 'CHANGES_AVAILABLE',
      groupUid: req.groupUid,
      latestSequence: latestSeq,
      actorId,
      timestamp: nowIso(),
    });
  }

  return {
    groupUid: req.groupUid,
    results,
  };
}

function processSingleMutation(
  db: ServerDB,
  req: ServerPushRequest,
  mut: ServerPushRequest['mutations'][0]
): PushMutationResult {
  const groupUid = req.groupUid;
  const deviceId = req.deviceId;
  const actorId = req.actorId || req.deviceId;
  const now = nowIso();

  // 1. Idempotency check
  const existingMut = db.get<{
    status: 'ACCEPTED' | 'CONFLICT' | 'REJECTED';
    response_payload: string;
  }>('SELECT status, response_payload FROM client_mutations WHERE client_mutation_id = ?', [mut.clientMutationId]);

  if (existingMut) {
    return JSON.parse(existingMut.response_payload) as PushMutationResult;
  }

  // 2. Permission check
  const permCheck = checkServerPermission(
    db,
    { groupUid, actorId, deviceId },
    mut.entityType,
    mut.operation,
    mut.entityUid
  );

  if (!permCheck.allowed) {
    const rejectRes: PushMutationResult = {
      clientMutationId: mut.clientMutationId,
      status: 'REJECTED',
      entityUid: mut.entityUid,
      error: 'FORBIDDEN',
      message: permCheck.reason || 'Unauthorized mutation',
    };
    db.run(
      'INSERT INTO client_mutations (client_mutation_id, group_uid, actor_id, device_id, status, response_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [mut.clientMutationId, groupUid, actorId, deviceId, 'REJECTED', JSON.stringify(rejectRes), now]
    );
    return rejectRes;
  }

  // 3. Process Entity Mutation with Optimistic Concurrency
  try {
    let resultingVersion = 1;
    let resultingSequence = 0;

    // --- A. Group Mutations ---
    if (mut.entityType === 'group') {
      if (mut.operation === 'create') {
        const p = mut.payload;
        db.run(
          `INSERT INTO groups (uid, name, description, currency, permission_model, creator_id, creator_name, sync_key, server_version, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
           ON CONFLICT(uid) DO NOTHING`,
          [
            mut.entityUid,
            p.name,
            p.description || '',
            p.currency || 'USD',
            p.permissionModel || 'COLLABORATIVE',
            p.creatorId || actorId,
            p.creatorName || req.actorName || 'Admin',
            p.syncKey || '',
            now,
            now,
          ]
        );
        resultingVersion = 1;
        resultingSequence = appendChangeLog(db, groupUid, 'group', mut.entityUid, 'create', actorId, deviceId, 1, p);
      } else if (mut.operation === 'update') {
        const existing = db.get<{ server_version: number; is_deleted: number }>('SELECT server_version, is_deleted FROM groups WHERE uid = ?', [mut.entityUid]);
        if (!existing || existing.is_deleted) {
          return recordConflict(db, mut, req, 0, 'GROUP_NOT_FOUND', 'Group does not exist or has been deleted');
        }
        if (existing.server_version !== mut.expectedVersion) {
          return recordConflict(db, mut, req, existing.server_version, 'VERSION_MISMATCH', `Expected version ${mut.expectedVersion}, but current is ${existing.server_version}`);
        }
        const p = mut.payload;
        resultingVersion = existing.server_version + 1;
        db.run(
          `UPDATE groups
           SET name = COALESCE(?, name),
               description = COALESCE(?, description),
               currency = COALESCE(?, currency),
               permission_model = COALESCE(?, permission_model),
               server_version = ?,
               updated_at = ?
           WHERE uid = ?`,
          [p.name ?? null, p.description ?? null, p.currency ?? null, p.permissionModel ?? null, resultingVersion, now, mut.entityUid]
        );
        resultingSequence = appendChangeLog(db, groupUid, 'group', mut.entityUid, 'update', actorId, deviceId, resultingVersion, p);
      } else if (mut.operation === 'delete') {
        const existing = db.get<{ server_version: number; is_deleted: number }>('SELECT server_version, is_deleted FROM groups WHERE uid = ?', [mut.entityUid]);
        if (!existing || existing.is_deleted) {
          return recordConflict(db, mut, req, 0, 'ALREADY_DELETED', 'Group was already deleted');
        }
        if (existing.server_version !== mut.expectedVersion) {
          return recordConflict(db, mut, req, existing.server_version, 'VERSION_MISMATCH', `Expected version ${mut.expectedVersion}, but current is ${existing.server_version}`);
        }
        resultingVersion = existing.server_version + 1;
        db.run('UPDATE groups SET is_deleted = 1, deleted_at = ?, server_version = ?, updated_at = ? WHERE uid = ?', [now, resultingVersion, now, mut.entityUid]);
        resultingSequence = appendChangeLog(db, groupUid, 'group', mut.entityUid, 'delete', actorId, deviceId, resultingVersion, {});
      }
    }

    // --- B. Member Mutations ---
    else if (mut.entityType === 'member') {
      if (mut.operation === 'create') {
        const p = mut.payload;
        db.run(
          `INSERT INTO group_members (group_uid, member_uid, name, user_id, role, server_version, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
           ON CONFLICT(member_uid) DO NOTHING`,
          [groupUid, mut.entityUid, p.name, p.userId || null, p.role || 'MEMBER', now, now]
        );
        resultingVersion = 1;
        resultingSequence = appendChangeLog(db, groupUid, 'member', mut.entityUid, 'create', actorId, deviceId, 1, p);
      } else if (mut.operation === 'update') {
        const existing = db.get<{ server_version: number; is_deleted: number }>('SELECT server_version, is_deleted FROM group_members WHERE member_uid = ? AND group_uid = ?', [mut.entityUid, groupUid]);
        if (!existing || existing.is_deleted) {
          return recordConflict(db, mut, req, 0, 'MEMBER_NOT_FOUND', 'Member not found or deleted');
        }
        if (existing.server_version !== mut.expectedVersion) {
          return recordConflict(db, mut, req, existing.server_version, 'VERSION_MISMATCH', `Expected version ${mut.expectedVersion}, but current is ${existing.server_version}`);
        }
        const p = mut.payload;
        resultingVersion = existing.server_version + 1;
        db.run('UPDATE group_members SET name = COALESCE(?, name), server_version = ?, updated_at = ? WHERE member_uid = ?', [p.newName || p.name || null, resultingVersion, now, mut.entityUid]);
        resultingSequence = appendChangeLog(db, groupUid, 'member', mut.entityUid, 'update', actorId, deviceId, resultingVersion, p);
      } else if (mut.operation === 'delete') {
        const existing = db.get<{ server_version: number; is_deleted: number }>('SELECT server_version, is_deleted FROM group_members WHERE member_uid = ? AND group_uid = ?', [mut.entityUid, groupUid]);
        if (!existing || existing.is_deleted) {
          return recordConflict(db, mut, req, 0, 'ALREADY_DELETED', 'Member was already deleted');
        }
        if (existing.server_version !== mut.expectedVersion) {
          return recordConflict(db, mut, req, existing.server_version, 'VERSION_MISMATCH', `Expected version ${mut.expectedVersion}, but current is ${existing.server_version}`);
        }
        resultingVersion = existing.server_version + 1;
        db.run('UPDATE group_members SET is_deleted = 1, deleted_at = ?, server_version = ?, updated_at = ? WHERE member_uid = ?', [now, resultingVersion, now, mut.entityUid]);
        resultingSequence = appendChangeLog(db, groupUid, 'member', mut.entityUid, 'delete', actorId, deviceId, resultingVersion, {});
      }
    }

    // --- C. Transaction Mutations ---
    else if (mut.entityType === 'transaction') {
      if (mut.operation === 'create') {
        const p = mut.payload;
        // Resolve or verify payer member UID
        let payerMemberUid = p.paidByMemberUid || p.paidBy;
        if (!payerMemberUid) {
          const payerName = p.paidByName || req.actorName || 'Member';
          const mem = db.get<{ member_uid: string }>('SELECT member_uid FROM group_members WHERE group_uid = ? AND LOWER(name) = LOWER(?) AND is_deleted = 0', [groupUid, payerName]);
          if (mem) {
            payerMemberUid = mem.member_uid;
          } else {
            payerMemberUid = `mem_${newServerId('m')}`;
            db.run('INSERT INTO group_members (group_uid, member_uid, name, role, server_version, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)', [groupUid, payerMemberUid, payerName, 'MEMBER', now, now]);
          }
        }

        db.run(
          `INSERT INTO transactions (group_uid, tx_uid, type, title, amount, paid_by_member_uid, split_type, category, note, date, author_id, author_name, updated_by_id, updated_by_name, updated_ts, server_version, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
           ON CONFLICT(tx_uid) DO NOTHING`,
          [
            groupUid,
            mut.entityUid,
            p.type || 'expense',
            p.title || 'Expense',
            p.amount || 100,
            payerMemberUid,
            p.splitType || 'equal',
            p.category || 'General',
            p.note || '',
            p.date || now.slice(0, 10),
            p.authorId || actorId,
            p.authorName || req.actorName || 'User',
            p.updatedById || null,
            p.updatedByName || null,
            p.updatedTs || Date.now(),
            now,
            now,
          ]
        );

        // Insert transaction splits
        if (Array.isArray(p.splits)) {
          for (const s of p.splits) {
            let sMemberUid = s.memberUid;
            if (!sMemberUid && s.memberName) {
              const mem = db.get<{ member_uid: string }>('SELECT member_uid FROM group_members WHERE group_uid = ? AND LOWER(name) = LOWER(?) AND is_deleted = 0', [groupUid, s.memberName]);
              if (mem) {
                sMemberUid = mem.member_uid;
              } else {
                sMemberUid = `mem_${newServerId('m')}`;
                db.run('INSERT INTO group_members (group_uid, member_uid, name, role, server_version, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)', [groupUid, sMemberUid, s.memberName, 'MEMBER', now, now]);
              }
            }
            if (sMemberUid) {
              db.run(
                `INSERT INTO transaction_splits (transaction_uid, member_uid, value, share)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(transaction_uid, member_uid) DO UPDATE SET value = excluded.value, share = excluded.share`,
                [mut.entityUid, sMemberUid, s.value ?? 1, s.share ?? 0]
              );
            }
          }
        }

        resultingVersion = 1;
        resultingSequence = appendChangeLog(db, groupUid, 'transaction', mut.entityUid, 'create', actorId, deviceId, 1, p);
      } else if (mut.operation === 'update') {
        const existing = db.get<{ server_version: number; is_deleted: number }>('SELECT server_version, is_deleted FROM transactions WHERE tx_uid = ? AND group_uid = ?', [mut.entityUid, groupUid]);
        if (!existing || existing.is_deleted) {
          return recordConflict(db, mut, req, 0, 'TRANSACTION_NOT_FOUND', 'Transaction does not exist or was deleted');
        }
        if (existing.server_version !== mut.expectedVersion) {
          return recordConflict(db, mut, req, existing.server_version, 'VERSION_MISMATCH', `Expected version ${mut.expectedVersion}, but current is ${existing.server_version}`);
        }

        const p = mut.payload;
        resultingVersion = existing.server_version + 1;

        let payerMemberUid = p.paidByMemberUid;
        if (!payerMemberUid && p.paidByName) {
          const mem = db.get<{ member_uid: string }>('SELECT member_uid FROM group_members WHERE group_uid = ? AND LOWER(name) = LOWER(?) AND is_deleted = 0', [groupUid, p.paidByName]);
          if (mem) payerMemberUid = mem.member_uid;
        }

        db.run(
          `UPDATE transactions
           SET title = COALESCE(?, title),
               amount = COALESCE(?, amount),
               paid_by_member_uid = COALESCE(?, paid_by_member_uid),
               split_type = COALESCE(?, split_type),
               category = COALESCE(?, category),
               note = COALESCE(?, note),
               date = COALESCE(?, date),
               updated_by_id = ?,
               updated_by_name = ?,
               updated_ts = ?,
               server_version = ?,
               updated_at = ?
           WHERE tx_uid = ?`,
          [
            p.title ?? null,
            p.amount ?? null,
            payerMemberUid ?? null,
            p.splitType ?? null,
            p.category ?? null,
            p.note ?? null,
            p.date ?? null,
            actorId,
            req.actorName || null,
            Date.now(),
            resultingVersion,
            now,
            mut.entityUid,
          ]
        );

        if (Array.isArray(p.splits) && p.splits.length > 0) {
          db.run('DELETE FROM transaction_splits WHERE transaction_uid = ?', [mut.entityUid]);
          for (const s of p.splits) {
            let sMemberUid = s.memberUid;
            if (!sMemberUid && s.memberName) {
              const mem = db.get<{ member_uid: string }>('SELECT member_uid FROM group_members WHERE group_uid = ? AND LOWER(name) = LOWER(?) AND is_deleted = 0', [groupUid, s.memberName]);
              if (mem) sMemberUid = mem.member_uid;
            }
            if (sMemberUid) {
              db.run('INSERT INTO transaction_splits (transaction_uid, member_uid, value, share) VALUES (?, ?, ?, ?)', [mut.entityUid, sMemberUid, s.value ?? 1, s.share ?? 0]);
            }
          }
        }

        resultingSequence = appendChangeLog(db, groupUid, 'transaction', mut.entityUid, 'update', actorId, deviceId, resultingVersion, p);
      } else if (mut.operation === 'delete') {
        const existing = db.get<{ server_version: number; is_deleted: number }>('SELECT server_version, is_deleted FROM transactions WHERE tx_uid = ? AND group_uid = ?', [mut.entityUid, groupUid]);
        if (!existing || existing.is_deleted) {
          return recordConflict(db, mut, req, 0, 'ALREADY_DELETED', 'Transaction was already deleted');
        }
        if (existing.server_version !== mut.expectedVersion) {
          return recordConflict(db, mut, req, existing.server_version, 'VERSION_MISMATCH', `Expected version ${mut.expectedVersion}, but current is ${existing.server_version}`);
        }

        resultingVersion = existing.server_version + 1;
        db.run('UPDATE transactions SET is_deleted = 1, deleted_at = ?, server_version = ?, updated_at = ? WHERE tx_uid = ?', [now, resultingVersion, now, mut.entityUid]);
        db.run('DELETE FROM transaction_splits WHERE transaction_uid = ?', [mut.entityUid]);
        resultingSequence = appendChangeLog(db, groupUid, 'transaction', mut.entityUid, 'delete', actorId, deviceId, resultingVersion, {});
      }
    }

    const acceptRes: PushMutationResult = {
      clientMutationId: mut.clientMutationId,
      status: 'ACCEPTED',
      entityUid: mut.entityUid,
      serverVersion: resultingVersion,
      serverSequence: resultingSequence,
    };

    db.run(
      'INSERT INTO client_mutations (client_mutation_id, group_uid, actor_id, device_id, status, response_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [mut.clientMutationId, groupUid, actorId, deviceId, 'ACCEPTED', JSON.stringify(acceptRes), now]
    );

    return acceptRes;
  } catch (err: any) {
    const errorRes: PushMutationResult = {
      clientMutationId: mut.clientMutationId,
      status: 'REJECTED',
      entityUid: mut.entityUid,
      error: 'SERVER_ERROR',
      message: err?.message || 'Database error processing mutation',
    };
    db.run(
      'INSERT INTO client_mutations (client_mutation_id, group_uid, actor_id, device_id, status, response_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [mut.clientMutationId, groupUid, actorId, deviceId, 'REJECTED', JSON.stringify(errorRes), now]
    );
    return errorRes;
  }
}

function recordConflict(
  db: ServerDB,
  mut: ServerPushRequest['mutations'][0],
  req: ServerPushRequest,
  currentVersion: number,
  errorCode: string,
  message: string
): PushMutationResult {
  const conflictRes: PushMutationResult = {
    clientMutationId: mut.clientMutationId,
    status: 'CONFLICT',
    entityUid: mut.entityUid,
    serverVersion: currentVersion,
    error: errorCode,
    message,
  };
  db.run(
    'INSERT INTO client_mutations (client_mutation_id, group_uid, actor_id, device_id, status, response_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [mut.clientMutationId, req.groupUid, req.actorId || req.deviceId, req.deviceId, 'CONFLICT', JSON.stringify(conflictRes), nowIso()]
  );
  return conflictRes;
}
