// Core sync service: bootstrap snapshot, cursor-based delta pull, and mutation push.
//
// Sync contract (see README "Sync contract"):
//   source of truth  Postgres; clients are replicas with an outbox
//   identity         entity uid (group uid, member_uid, tx_uid), assigned by the client
//   version          server_version per entity; updates/deletes must send expectedVersion
//   sequence         groups.last_sequence, bumped under the group row lock in the same
//                    transaction as the sync_changes insert (commit order == sequence order)
//   retry            clientMutationId is idempotent; the first outcome is replayed verbatim
//   conflict         stale expectedVersion -> CONFLICT/VERSION_MISMATCH, nothing is written
//   failure          unexpected DB errors abort the request (HTTP 503); already-processed
//                    mutations stay committed and replay on retry
import { Database, Queryable, isRetryableDbError } from './db';
import { checkPermission, GroupRow } from './permissions';
import {
  ENTITY_TYPES,
  GroupBootstrapResponse,
  OPERATIONS,
  PullChangesResponse,
  PushMutation,
  PushMutationResult,
  PushMutationsRequest,
  PushMutationsResponse,
  SPLIT_TYPES,
  ServerChange,
  SyncEntityType,
  SyncOperation,
  TX_TYPES,
} from './types';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** A deterministic CONFLICT/REJECTED outcome. Thrown to roll back any partial writes. */
class MutationRefusal extends Error {
  constructor(
    public status: 'CONFLICT' | 'REJECTED',
    public code: string,
    message: string,
    public serverVersion?: number
  ) {
    super(message);
  }
}

const conflict = (code: string, message: string, serverVersion: number) =>
  new MutationRefusal('CONFLICT', code, message, serverVersion);
const rejected = (code: string, message: string) => new MutationRefusal('REJECTED', code, message);

const MAX_MUTATIONS_PER_PUSH = 200;
const MAX_TX_ATTEMPTS = 3;
const PERMISSION_MODELS = ['ADMIN_ONLY', 'CONTRIBUTOR', 'COLLABORATIVE'];

interface PushContext {
  groupUid: string;
  deviceId: string;
  actorId: string;
  actorName?: string;
}

/**
 * The group does not exist on this server: never created here, or deleted by its admin (which erases
 * every record of it). Phones that already synced the group treat this as "deleted"; see syncEngine.
 */
const groupNotFound = (groupUid: string) => new HttpError(404, 'GROUP_NOT_FOUND', `Group ${groupUid} not found`);

/** Code for a group that exists but is hidden (is_display). Distinct from GROUP_NOT_FOUND, which phones treat as deleted. */
const GROUP_UNAVAILABLE = 'GROUP_UNAVAILABLE';

/** The live group a read may return, or an error saying it is gone (deleted) or hidden. */
async function findReadableGroup(db: Queryable, groupUid: string) {
  const [group] = await db.query('SELECT * FROM visible_groups WHERE uid = $1 AND is_deleted = false', [groupUid]);
  if (group) return group;
  const [hidden] = await db.query('SELECT 1 AS x FROM groups WHERE uid = $1 AND is_deleted = false', [groupUid]);
  if (hidden) throw new HttpError(404, GROUP_UNAVAILABLE, `Group ${groupUid} is not available`);
  throw groupNotFound(groupUid);
}

const iso = (v: Date | string | null | undefined) => (v instanceof Date ? v.toISOString() : v ?? '');
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const normName = (v: string) => v.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function getGroupBootstrap(db: Database, groupUid: string): Promise<GroupBootstrapResponse> {
  return db.transaction(async (tx) => {
    // One snapshot for every read below, so serverSequence matches the rows returned.
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const group = await findReadableGroup(tx, groupUid);

    // Only rows with is_display (and everything they depend on) visible: see migrations/004_is_display.sql.
    const members = await tx.query(
      'SELECT * FROM visible_members WHERE group_uid = $1 AND is_deleted = false ORDER BY id ASC',
      [groupUid]
    );
    const txRows = await tx.query(
      'SELECT * FROM visible_transactions WHERE group_uid = $1 AND is_deleted = false ORDER BY date DESC, id DESC',
      [groupUid]
    );
    // Base splits joined to this group's visible transactions: a visible transaction has only visible
    // splits (see visible_transactions), and filtering by group first keeps this independent of the
    // size of the whole database (visible_splits would evaluate every transaction's visibility).
    const splits = await tx.query(
      `SELECT s.transaction_uid, s.member_uid, s.value, s.share
         FROM transaction_splits s
         JOIN visible_transactions t ON t.tx_uid = s.transaction_uid
        WHERE t.group_uid = $1 AND t.is_deleted = false
        ORDER BY s.member_uid`,
      [groupUid]
    );

    const memberIdByUid = new Map<string, number>(members.map((m) => [m.member_uid, m.id]));
    const splitsByTx = new Map<string, GroupBootstrapResponse['transactions'][number]['splits']>();
    for (const s of splits) {
      const list = splitsByTx.get(s.transaction_uid) ?? [];
      list.push({
        memberId: memberIdByUid.get(s.member_uid) ?? 0,
        memberUid: s.member_uid,
        value: s.value,
        share: s.share,
      });
      splitsByTx.set(s.transaction_uid, list);
    }

    return {
      groupUid: group.uid,
      serverSequence: group.last_sequence,
      group: {
        id: group.id,
        uid: group.uid,
        name: group.name,
        description: group.description,
        currency: group.currency,
        permissionModel: group.permission_model.toLowerCase(),
        creatorId: group.creator_id,
        creatorName: group.creator_name,
        serverVersion: group.server_version,
        isDeleted: group.is_deleted,
        createdAt: iso(group.created_at),
        updatedAt: iso(group.updated_at),
      },
      members: members.map((m) => ({
        id: m.id,
        uid: m.member_uid,
        memberUid: m.member_uid,
        name: m.name,
        userId: m.user_id ?? undefined,
        role: m.role,
        isMe: false,
        serverVersion: m.server_version,
        isDeleted: m.is_deleted,
      })),
      transactions: txRows.map((t) => ({
        id: t.id,
        uid: t.tx_uid,
        groupId: group.id,
        type: t.type,
        title: t.title,
        amount: Number(t.amount),
        paidBy: memberIdByUid.get(t.paid_by_member_uid) ?? 0,
        paidByMemberUid: t.paid_by_member_uid,
        splitType: t.split_type,
        category: t.category,
        note: t.note,
        date: t.date,
        authorId: t.author_id,
        authorName: t.author_name,
        updatedById: t.updated_by_id ?? undefined,
        updatedByName: t.updated_by_name ?? undefined,
        updatedTs: t.updated_ts != null ? Number(t.updated_ts) : 0,
        createdTs: t.created_ts != null ? Number(t.created_ts) : null,
        serverVersion: t.server_version,
        isDeleted: t.is_deleted,
        createdAt: iso(t.created_at),
        updatedAt: iso(t.updated_at),
        splits: splitsByTx.get(t.tx_uid) ?? [],
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Delta pull
// ---------------------------------------------------------------------------

export async function getChangesSince(
  db: Database,
  groupUid: string,
  afterSequence: number,
  limit = 100
): Promise<PullChangesResponse> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 100), 500);
  const after = Math.max(0, Math.floor(afterSequence) || 0);
  // Read the group's sequence first: every change up to it is committed, so the cursor can safely skip
  // past hidden changes without ever jumping over one committed later.
  const group = await findReadableGroup(db, groupUid);
  const lastSequence: number = group.last_sequence ?? 0;
  if (after > lastSequence) {
    // The cursor references history this server does not have: the replica must re-bootstrap.
    throw new HttpError(409, 'CURSOR_AHEAD', `Cursor ${after} is ahead of server sequence ${lastSequence}; re-bootstrap required`);
  }

  const rows = await db.query(
    `SELECT * FROM visible_changes
      WHERE group_uid = $1 AND sequence > $2 AND sequence <= $3
      ORDER BY sequence ASC
      LIMIT $4`,
    [groupUid, after, lastSequence, safeLimit + 1]
  );
  const hasMore = rows.length > safeLimit;
  const page = hasMore ? rows.slice(0, safeLimit) : rows;

  const changes: ServerChange[] = page.map((r) => ({
    sequence: r.sequence,
    changeId: r.change_id,
    groupUid: r.group_uid,
    entityType: r.entity_type,
    entityUid: r.entity_uid,
    operation: r.operation,
    actorId: r.actor_id,
    deviceId: r.device_id,
    entityVersion: r.entity_version,
    payload: r.payload,
    createdAt: iso(r.created_at),
  }));

  // The client stores latestServerSequence as its cursor. With more visible changes to come, report the
  // last one in this page; otherwise everything up to lastSequence is delivered or hidden, so skip to it.
  const latestServerSequence = hasMore ? changes[changes.length - 1]!.sequence : lastSequence;
  return { groupUid, latestServerSequence, hasMore, changes };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export function validatePushRequest(body: any): PushMutationsRequest {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'BAD_REQUEST', 'Request body must be a JSON object');
  }
  if (!isNonEmptyString(body.groupUid) || !isNonEmptyString(body.deviceId) || !Array.isArray(body.mutations)) {
    throw new HttpError(400, 'BAD_REQUEST', 'Missing required push fields (groupUid, deviceId, mutations)');
  }
  if (body.mutations.length > MAX_MUTATIONS_PER_PUSH) {
    throw new HttpError(413, 'TOO_MANY_MUTATIONS', `At most ${MAX_MUTATIONS_PER_PUSH} mutations per push`);
  }
  return body as PushMutationsRequest;
}

export async function processPushMutations(db: Database, req: PushMutationsRequest): Promise<PushMutationsResponse> {
  const ctx: PushContext = {
    groupUid: req.groupUid,
    deviceId: req.deviceId,
    actorId: isNonEmptyString(req.actorId) ? req.actorId : req.deviceId,
    actorName: isNonEmptyString(req.actorName) ? req.actorName : undefined,
  };

  const results: PushMutationResult[] = [];
  // Sequential on purpose: the outbox is ordered (group -> members -> transactions).
  for (const mut of req.mutations) {
    results.push(await processMutation(db, ctx, mut));
  }

  await touchDevice(db, ctx);
  return { groupUid: req.groupUid, results };
}

/** Records device presence and enrolls it as a notification target for the group. */
async function touchDevice(db: Database, ctx: PushContext) {
  await db.query(
    `INSERT INTO devices (device_id, user_id, user_name, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (device_id) DO UPDATE SET
       user_id = COALESCE(EXCLUDED.user_id, devices.user_id),
       user_name = COALESCE(EXCLUDED.user_name, devices.user_name),
       last_seen_at = now()`,
    [ctx.deviceId, ctx.actorId, ctx.actorName ?? null]
  );
  // Keeps one row per account so it can be hidden (sync_users.is_display); the flag itself is never touched here.
  await db.query(
    `INSERT INTO sync_users (user_id, user_name) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET user_name = COALESCE(EXCLUDED.user_name, sync_users.user_name), updated_at = now()`,
    [ctx.actorId, ctx.actorName ?? null]
  );
  await db.query(
    `INSERT INTO device_group_subscriptions (group_uid, device_id, delivered_sequence)
     SELECT uid, $2, last_sequence FROM visible_groups WHERE uid = $1
     ON CONFLICT (group_uid, device_id) DO NOTHING`,
    [ctx.groupUid, ctx.deviceId]
  );
}

function validateMutationShape(mut: any): string | null {
  if (!mut || typeof mut !== 'object') return 'Mutation must be an object';
  if (!isNonEmptyString(mut.clientMutationId)) return 'clientMutationId is required';
  if (!ENTITY_TYPES.includes(mut.entityType)) return `entityType must be one of ${ENTITY_TYPES.join(', ')}`;
  if (!OPERATIONS.includes(mut.operation)) return `operation must be one of ${OPERATIONS.join(', ')}`;
  if (!isNonEmptyString(mut.entityUid)) return 'entityUid is required';
  if (mut.operation !== 'create' && !Number.isInteger(mut.expectedVersion)) {
    return 'expectedVersion must be an integer for update/delete';
  }
  if (mut.payload != null && typeof mut.payload !== 'object') return 'payload must be an object';
  return null;
}

async function processMutation(db: Database, ctx: PushContext, mut: PushMutation): Promise<PushMutationResult> {
  const shapeError = validateMutationShape(mut);
  if (shapeError) {
    const result: PushMutationResult = {
      clientMutationId: String((mut as any)?.clientMutationId ?? ''),
      status: 'REJECTED',
      entityUid: String((mut as any)?.entityUid ?? ''),
      error: 'VALIDATION_ERROR',
      message: shapeError,
    };
    // Without a valid clientMutationId there is nothing to key idempotency on.
    if (!isNonEmptyString((mut as any)?.clientMutationId)) return result;
    return recordOutcome(db, ctx, mut, result);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const group = await lockGroup(tx, ctx.groupUid);
        if (mut.entityType === 'group' && mut.operation === 'delete') return eraseGroup(tx, ctx, group, mut);
        // Nothing is recorded for a group that doesn't exist, so a deleted group leaves no trace.
        if (!group && !(mut.entityType === 'group' && mut.operation === 'create')) {
          return { clientMutationId: mut.clientMutationId, status: 'REJECTED', entityUid: mut.entityUid, error: 'GROUP_NOT_FOUND', message: 'Group not found or deleted' };
        }
        const prior = await findPriorOutcome(tx, mut.clientMutationId);
        if (prior) return prior;

        const { serverVersion, serverSequence } = await applyMutation(tx, ctx, group, mut);
        const result: PushMutationResult = {
          clientMutationId: mut.clientMutationId,
          status: 'ACCEPTED',
          entityUid: mut.entityUid,
          serverVersion,
          serverSequence,
        };
        await insertOutcome(tx, ctx, result);
        return result;
      });
    } catch (err) {
      if (err instanceof MutationRefusal) {
        return recordOutcome(db, ctx, mut, {
          clientMutationId: mut.clientMutationId,
          status: err.status,
          entityUid: mut.entityUid,
          serverVersion: err.serverVersion,
          error: err.code,
          message: err.message,
        });
      }
      // e.g. two devices creating the same group uid at once: retry and the loser
      // sees the committed row and gets a deterministic CONFLICT.
      if (isRetryableDbError(err) && attempt < MAX_TX_ATTEMPTS) continue;
      throw err;
    }
  }
}

/** Persists a refusal outcome in its own transaction (entity writes were rolled back). */
async function recordOutcome(
  db: Database,
  ctx: PushContext,
  mut: Pick<PushMutation, 'clientMutationId'>,
  result: PushMutationResult
): Promise<PushMutationResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await lockGroup(tx, ctx.groupUid);
        const prior = await findPriorOutcome(tx, mut.clientMutationId);
        if (prior) return prior;
        await insertOutcome(tx, ctx, result);
        return result;
      });
    } catch (err) {
      if (isRetryableDbError(err) && attempt < MAX_TX_ATTEMPTS) continue;
      throw err;
    }
  }
}

// The push path reads base tables, not the visible_* views, on purpose: locking, idempotency, version,
// uniqueness and permission checks must see hidden rows too (or a retry could apply twice, or a write could
// collide with a hidden row). None of these reads return data to a phone; is_display only governs reads.
async function lockGroup(tx: Queryable, groupUid: string): Promise<GroupRow | null> {
  const [row] = await tx.query<GroupRow>(
    'SELECT uid, creator_id, permission_model, is_deleted, server_version, last_sequence FROM groups WHERE uid = $1 FOR UPDATE',
    [groupUid]
  );
  return row ?? null;
}

async function findPriorOutcome(tx: Queryable, clientMutationId: string): Promise<PushMutationResult | null> {
  const [row] = await tx.query<{ response: PushMutationResult }>(
    'SELECT response FROM client_mutations WHERE client_mutation_id = $1',
    [clientMutationId]
  );
  return row?.response ?? null;
}

async function insertOutcome(tx: Queryable, ctx: PushContext, result: PushMutationResult) {
  await tx.query(
    `INSERT INTO client_mutations (client_mutation_id, group_uid, actor_id, device_id, status, response)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [result.clientMutationId, ctx.groupUid, ctx.actorId, ctx.deviceId, result.status, JSON.stringify(result)]
  );
}

/** Allocates the next per-group sequence and appends the change. Caller holds the group lock. */
async function appendChange(
  tx: Queryable,
  ctx: PushContext,
  entityType: SyncEntityType,
  entityUid: string,
  operation: SyncOperation,
  entityVersion: number,
  payload: unknown
): Promise<number> {
  const [row] = await tx.query<{ last_sequence: number }>(
    'UPDATE groups SET last_sequence = last_sequence + 1 WHERE uid = $1 RETURNING last_sequence',
    [ctx.groupUid]
  );
  const sequence = row!.last_sequence;
  await tx.query(
    `INSERT INTO sync_changes (group_uid, sequence, change_id, entity_type, entity_uid, operation, actor_id, device_id, entity_version, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ctx.groupUid,
      sequence,
      `chg_${crypto.randomUUID()}`,
      entityType,
      entityUid,
      operation,
      ctx.actorId,
      ctx.deviceId,
      entityVersion,
      JSON.stringify(payload ?? {}),
    ]
  );
  return sequence;
}

function assertVersion(current: number, expected: number) {
  if (current !== expected) {
    throw conflict('VERSION_MISMATCH', `Expected version ${expected}, but current is ${current}`, current);
  }
}

async function applyMutation(
  tx: Queryable,
  ctx: PushContext,
  group: GroupRow | null,
  mut: PushMutation
): Promise<{ serverVersion: number; serverSequence: number }> {
  const perm = await checkPermission(tx, group, ctx.actorId, mut.entityType, mut.operation, mut.entityUid);
  if (!perm.allowed) throw rejected('FORBIDDEN', perm.reason || 'Unauthorized mutation');

  const p = mut.payload ?? {};
  switch (mut.entityType) {
    case 'group':
      return applyGroupMutation(tx, ctx, group, mut, p);
    case 'member':
      return applyMemberMutation(tx, ctx, mut, p);
    case 'transaction':
      return applyTransactionMutation(tx, ctx, mut, p);
  }
}

// --- Groups ----------------------------------------------------------------

function normalizePermissionModel(v: unknown): string | null {
  if (v == null) return null;
  const upper = String(v).toUpperCase();
  if (!PERMISSION_MODELS.includes(upper)) {
    throw rejected('VALIDATION_ERROR', `permissionModel must be one of ${PERMISSION_MODELS.join(', ')}`);
  }
  return upper;
}

/**
 * The admin deletes the group: every record of it is erased from the server (entities, splits,
 * change log, idempotency ledger, notification targets). Deleting an already-erased group succeeds,
 * so a retried delete is idempotent. The admin's delete wins over any version: no version check.
 */
async function eraseGroup(tx: Queryable, ctx: PushContext, group: GroupRow | null, mut: PushMutation): Promise<PushMutationResult> {
  const accepted: PushMutationResult = { clientMutationId: mut.clientMutationId, status: 'ACCEPTED', entityUid: mut.entityUid };
  if (mut.entityUid !== ctx.groupUid) throw rejected('VALIDATION_ERROR', 'Group mutations must target the push groupUid');
  if (!group) return accepted;
  if (group.creator_id !== ctx.actorId) throw rejected('FORBIDDEN', 'Only the group admin can delete the group');

  const uid = group.uid;
  await tx.query('DELETE FROM transaction_splits WHERE transaction_uid IN (SELECT tx_uid FROM transactions WHERE group_uid = $1)', [uid]);
  await tx.query('DELETE FROM transactions WHERE group_uid = $1', [uid]);
  await tx.query('DELETE FROM group_members WHERE group_uid = $1', [uid]);
  await tx.query('DELETE FROM sync_changes WHERE group_uid = $1', [uid]);
  await tx.query('DELETE FROM client_mutations WHERE group_uid = $1', [uid]);
  await tx.query('DELETE FROM device_group_subscriptions WHERE group_uid = $1', [uid]);
  await tx.query('DELETE FROM webhook_subscriptions WHERE group_uid = $1', [uid]);
  await tx.query('DELETE FROM groups WHERE uid = $1', [uid]);
  return accepted;
}

async function applyGroupMutation(tx: Queryable, ctx: PushContext, group: GroupRow | null, mut: PushMutation, p: any) {
  if (mut.entityUid !== ctx.groupUid) {
    throw rejected('VALIDATION_ERROR', 'Group mutations must target the push groupUid');
  }

  if (mut.operation === 'create') {
    if (group) {
      throw conflict('ALREADY_EXISTS', 'A group with this uid already exists', group.server_version);
    }
    if (!isNonEmptyString(p.name)) throw rejected('VALIDATION_ERROR', 'Group name is required');
    const permissionModel = normalizePermissionModel(p.permissionModel) ?? 'COLLABORATIVE';
    await tx.query(
      `INSERT INTO groups (uid, name, description, currency, permission_model, creator_id, creator_name, server_version, last_sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 0)`,
      [
        mut.entityUid,
        p.name.trim(),
        typeof p.description === 'string' ? p.description : '',
        isNonEmptyString(p.currency) ? p.currency : 'USD',
        permissionModel,
        isNonEmptyString(p.creatorId) ? p.creatorId : ctx.actorId,
        isNonEmptyString(p.creatorName) ? p.creatorName : ctx.actorName || 'Admin',
      ]
    );
    const serverSequence = await appendChange(tx, ctx, 'group', mut.entityUid, 'create', 1, p);
    return { serverVersion: 1, serverSequence };
  }

  // Permission check already guarantees the group exists and is not deleted.
  const current = group!;
  assertVersion(current.server_version, mut.expectedVersion);
  const nextVersion = current.server_version + 1;

  if (mut.operation === 'update') {
    if (p.name !== undefined && !isNonEmptyString(p.name)) {
      throw rejected('VALIDATION_ERROR', 'Group name cannot be empty');
    }
    await tx.query(
      `UPDATE groups
          SET name = COALESCE($1, name),
              description = COALESCE($2, description),
              currency = COALESCE($3, currency),
              permission_model = COALESCE($4, permission_model),
              server_version = $5,
              updated_at = now()
        WHERE uid = $6`,
      [
        isNonEmptyString(p.name) ? p.name.trim() : null,
        typeof p.description === 'string' ? p.description : null,
        isNonEmptyString(p.currency) ? p.currency : null,
        normalizePermissionModel(p.permissionModel),
        nextVersion,
        mut.entityUid,
      ]
    );
    const serverSequence = await appendChange(tx, ctx, 'group', mut.entityUid, 'update', nextVersion, p);
    return { serverVersion: nextVersion, serverSequence };
  }

  // Group deletes never reach here: eraseGroup handles them.
  throw rejected('VALIDATION_ERROR', `Unsupported group operation ${mut.operation}`);
}

// --- Members ---------------------------------------------------------------

interface MemberRow {
  member_uid: string;
  group_uid: string;
  name: string;
  server_version: number;
  is_deleted: boolean;
}

async function findMemberByName(tx: Queryable, groupUid: string, name: string): Promise<MemberRow | null> {
  const [row] = await tx.query<MemberRow>(
    `SELECT member_uid, group_uid, name, server_version, is_deleted FROM group_members
      WHERE group_uid = $1 AND lower(trim(name)) = $2 AND is_deleted = false
      ORDER BY id ASC LIMIT 1`,
    [groupUid, normName(name)]
  );
  return row ?? null;
}

async function insertMember(
  tx: Queryable,
  ctx: PushContext,
  memberUid: string,
  name: string,
  userId: string | null,
  role: string,
  payload: unknown
): Promise<number> {
  await tx.query(
    `INSERT INTO group_members (member_uid, group_uid, name, user_id, role, server_version)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [memberUid, ctx.groupUid, name, userId, role]
  );
  return appendChange(tx, ctx, 'member', memberUid, 'create', 1, payload);
}

async function applyMemberMutation(tx: Queryable, ctx: PushContext, mut: PushMutation, p: any) {
  const [existing] = await tx.query<MemberRow>(
    'SELECT member_uid, group_uid, name, server_version, is_deleted FROM group_members WHERE member_uid = $1',
    [mut.entityUid]
  );
  if (existing && existing.group_uid !== ctx.groupUid) {
    throw rejected('VALIDATION_ERROR', 'Member uid belongs to a different group');
  }

  if (mut.operation === 'create') {
    if (existing) {
      throw conflict('ALREADY_EXISTS', 'A member with this uid already exists', existing.server_version);
    }
    if (!isNonEmptyString(p.name)) throw rejected('VALIDATION_ERROR', 'Member name is required');
    const name = p.name.trim();
    const sameName = await findMemberByName(tx, ctx.groupUid, name);
    if (sameName) {
      // Members are matched by name on clients; a second member with the same name would
      // make balances ambiguous. The client adopts the existing member's uid on pull.
      throw conflict(
        'DUPLICATE_MEMBER_NAME',
        `Member "${sameName.name}" already exists in this group as ${sameName.member_uid}`,
        sameName.server_version
      );
    }
    const serverSequence = await insertMember(
      tx,
      ctx,
      mut.entityUid,
      name,
      isNonEmptyString(p.userId) ? p.userId : null,
      isNonEmptyString(p.role) ? p.role : 'MEMBER',
      p
    );
    return { serverVersion: 1, serverSequence };
  }

  if (!existing || existing.is_deleted) {
    throw conflict(
      mut.operation === 'delete' ? 'ALREADY_DELETED' : 'MEMBER_NOT_FOUND',
      mut.operation === 'delete' ? 'Member was already deleted' : 'Member not found or deleted',
      existing?.server_version ?? 0
    );
  }
  assertVersion(existing.server_version, mut.expectedVersion);
  const nextVersion = existing.server_version + 1;

  if (mut.operation === 'update') {
    const newName = isNonEmptyString(p.newName) ? p.newName.trim() : isNonEmptyString(p.name) ? p.name.trim() : null;
    if (!newName) throw rejected('VALIDATION_ERROR', 'Member name is required');
    const clash = await findMemberByName(tx, ctx.groupUid, newName);
    if (clash && clash.member_uid !== existing.member_uid) {
      throw conflict('DUPLICATE_MEMBER_NAME', `Member "${clash.name}" already exists in this group`, existing.server_version);
    }
    await tx.query(
      'UPDATE group_members SET name = $1, server_version = $2, updated_at = now() WHERE member_uid = $3',
      [newName, nextVersion, mut.entityUid]
    );
    const serverSequence = await appendChange(tx, ctx, 'member', mut.entityUid, 'update', nextVersion, p);
    return { serverVersion: nextVersion, serverSequence };
  }

  await tx.query(
    'UPDATE group_members SET is_deleted = true, deleted_at = now(), server_version = $1, updated_at = now() WHERE member_uid = $2',
    [nextVersion, mut.entityUid]
  );
  const serverSequence = await appendChange(tx, ctx, 'member', mut.entityUid, 'delete', nextVersion, {});
  return { serverVersion: nextVersion, serverSequence };
}

// --- Transactions ----------------------------------------------------------

interface ResolvedSplit {
  memberUid: string;
  memberName?: string;
  value: number;
  share: number;
}

/**
 * Resolves a member reference (uid first, then name) within the group. Clients identify
 * members by name in transaction payloads; a name with no member yet is created as a real,
 * change-logged member so every device learns about it.
 */
async function resolveMemberRef(tx: Queryable, ctx: PushContext, uid: unknown, name: unknown, field: string): Promise<string> {
  if (isNonEmptyString(uid)) {
    const [row] = await tx.query<MemberRow>(
      'SELECT member_uid, group_uid, name, server_version, is_deleted FROM group_members WHERE member_uid = $1',
      [uid]
    );
    if (row && row.group_uid === ctx.groupUid && !row.is_deleted) return row.member_uid;
    if (!isNonEmptyString(name)) throw rejected('UNKNOWN_MEMBER', `${field} references unknown member ${uid}`);
  }
  if (!isNonEmptyString(name)) throw rejected('VALIDATION_ERROR', `${field} must reference a member by uid or name`);

  const byName = await findMemberByName(tx, ctx.groupUid, name);
  if (byName) return byName.member_uid;

  const memberUid = `mem_${crypto.randomUUID()}`;
  await insertMember(tx, ctx, memberUid, name.trim(), null, 'MEMBER', { uid: memberUid, name: name.trim(), isMe: false });
  return memberUid;
}

function validateSplitsInput(splits: unknown): any[] {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw rejected('VALIDATION_ERROR', 'splits must be a non-empty array');
  }
  for (const s of splits) {
    if (!s || typeof s !== 'object') throw rejected('VALIDATION_ERROR', 'Each split must be an object');
    if (!Number.isSafeInteger(s.share) || s.share < 0) {
      throw rejected('VALIDATION_ERROR', 'Each split share must be a non-negative integer amount in minor units');
    }
    if (s.value !== undefined && (typeof s.value !== 'number' || !Number.isFinite(s.value))) {
      throw rejected('VALIDATION_ERROR', 'Split value must be a finite number');
    }
  }
  return splits;
}

async function resolveSplits(tx: Queryable, ctx: PushContext, splits: any[]): Promise<ResolvedSplit[]> {
  const resolved: ResolvedSplit[] = [];
  const seen = new Set<string>();
  for (const s of splits) {
    const memberUid = await resolveMemberRef(tx, ctx, s.memberUid, s.memberName, 'split');
    if (seen.has(memberUid)) throw rejected('VALIDATION_ERROR', 'A member appears more than once in splits');
    seen.add(memberUid);
    resolved.push({ memberUid, memberName: s.memberName, value: s.value ?? 1, share: s.share });
  }
  return resolved;
}

function assertSharesBalance(amount: number, splits: { share: number }[]) {
  const total = splits.reduce((sum, s) => sum + s.share, 0);
  if (total !== amount) {
    throw rejected('SPLIT_TOTAL_MISMATCH', `Split shares total ${total} but transaction amount is ${amount}`);
  }
}

function validateTxFields(p: any, isCreate: boolean) {
  const has = (k: string) => p[k] !== undefined && p[k] !== null;
  if (isCreate || has('type')) {
    if (!TX_TYPES.includes(p.type ?? 'expense')) throw rejected('VALIDATION_ERROR', `type must be one of ${TX_TYPES.join(', ')}`);
  }
  if (isCreate || has('title')) {
    if (!isNonEmptyString(p.title)) throw rejected('VALIDATION_ERROR', 'title is required');
  }
  if (isCreate || has('amount')) {
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) {
      throw rejected('VALIDATION_ERROR', 'amount must be a positive integer in minor units (cents)');
    }
  }
  if (has('splitType') && !SPLIT_TYPES.includes(p.splitType)) {
    throw rejected('VALIDATION_ERROR', `splitType must be one of ${SPLIT_TYPES.join(', ')}`);
  }
  if (has('date') && !/^\d{4}-\d{2}-\d{2}/.test(String(p.date))) {
    throw rejected('VALIDATION_ERROR', 'date must be formatted YYYY-MM-DD');
  }
  if (isCreate && has('createdTs') && !(Number.isSafeInteger(p.createdTs) && p.createdTs > 0)) {
    throw rejected('VALIDATION_ERROR', 'createdTs must be a positive integer timestamp in milliseconds');
  }
}

async function insertSplits(tx: Queryable, txUid: string, splits: ResolvedSplit[]) {
  for (const s of splits) {
    await tx.query(
      'INSERT INTO transaction_splits (transaction_uid, member_uid, value, share) VALUES ($1, $2, $3, $4)',
      [txUid, s.memberUid, s.value, s.share]
    );
  }
}

/**
 * Change-log payload: the client's payload plus the server-resolved member uids and the stored
 * creation time (immutable; phones overwrite their copy with it, so every device shows the same time).
 */
function txChangePayload(p: any, payerMemberUid: string | undefined, splits: ResolvedSplit[] | undefined, createdTs: number | null) {
  return {
    ...p,
    createdTs,
    ...(payerMemberUid ? { paidByMemberUid: payerMemberUid } : {}),
    ...(splits
      ? {
          splits: splits.map((s, i) => ({ ...(p.splits?.[i] ?? {}), memberUid: s.memberUid, value: s.value, share: s.share })),
        }
      : {}),
  };
}

async function applyTransactionMutation(tx: Queryable, ctx: PushContext, mut: PushMutation, p: any) {
  const [existing] = await tx.query<{ group_uid: string; server_version: number; is_deleted: boolean; amount: number; created_ts: number | null }>(
    'SELECT group_uid, server_version, is_deleted, amount, created_ts FROM transactions WHERE tx_uid = $1',
    [mut.entityUid]
  );
  if (existing && existing.group_uid !== ctx.groupUid) {
    throw rejected('VALIDATION_ERROR', 'Transaction uid belongs to a different group');
  }

  if (mut.operation === 'create') {
    if (existing) {
      throw conflict('ALREADY_EXISTS', 'A transaction with this uid already exists', existing.server_version);
    }
    validateTxFields(p, true);
    const splitsInput = validateSplitsInput(p.splits);
    assertSharesBalance(p.amount, splitsInput);

    const payerMemberUid = await resolveMemberRef(tx, ctx, p.paidByMemberUid, p.paidByName, 'paidBy');
    const splits = await resolveSplits(tx, ctx, splitsInput);
    // Older apps don't send it; store unknown rather than inventing a time the creator's phone doesn't have.
    const createdTs: number | null = p.createdTs ?? null;

    await tx.query(
      `INSERT INTO transactions (tx_uid, group_uid, type, title, amount, paid_by_member_uid, split_type, category, note, date,
                                 author_id, author_name, updated_by_id, updated_by_name, updated_ts, created_ts, server_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 1)`,
      [
        mut.entityUid,
        ctx.groupUid,
        p.type ?? 'expense',
        p.title.trim(),
        p.amount,
        payerMemberUid,
        p.splitType ?? 'equal',
        isNonEmptyString(p.category) ? p.category : 'General',
        typeof p.note === 'string' ? p.note : '',
        isNonEmptyString(p.date) ? p.date : new Date().toISOString().slice(0, 10),
        isNonEmptyString(p.authorId) ? p.authorId : ctx.actorId,
        isNonEmptyString(p.authorName) ? p.authorName : ctx.actorName || 'User',
        p.updatedById ?? null,
        p.updatedByName ?? null,
        Number.isSafeInteger(p.updatedTs) ? p.updatedTs : Date.now(),
        createdTs,
      ]
    );
    await insertSplits(tx, mut.entityUid, splits);

    const serverSequence = await appendChange(tx, ctx, 'transaction', mut.entityUid, 'create', 1, txChangePayload(p, payerMemberUid, splits, createdTs));
    return { serverVersion: 1, serverSequence };
  }

  if (!existing || existing.is_deleted) {
    throw conflict(
      mut.operation === 'delete' ? 'ALREADY_DELETED' : 'TRANSACTION_NOT_FOUND',
      mut.operation === 'delete' ? 'Transaction was already deleted' : 'Transaction does not exist or was deleted',
      existing?.server_version ?? 0
    );
  }
  assertVersion(existing.server_version, mut.expectedVersion);
  const nextVersion = existing.server_version + 1;

  if (mut.operation === 'update') {
    validateTxFields(p, false);
    const finalAmount: number = p.amount ?? existing.amount;
    const hasNewSplits = Array.isArray(p.splits) && p.splits.length > 0;
    let splits: ResolvedSplit[] | undefined;
    if (hasNewSplits) {
      const splitsInput = validateSplitsInput(p.splits);
      assertSharesBalance(finalAmount, splitsInput);
      splits = await resolveSplits(tx, ctx, splitsInput);
    } else if (finalAmount !== existing.amount) {
      throw rejected('SPLITS_REQUIRED', 'Changing the amount requires the recalculated splits');
    }

    let payerMemberUid: string | undefined;
    if (isNonEmptyString(p.paidByMemberUid) || isNonEmptyString(p.paidByName)) {
      payerMemberUid = await resolveMemberRef(tx, ctx, p.paidByMemberUid, p.paidByName, 'paidBy');
    }

    await tx.query(
      `UPDATE transactions
          SET type = COALESCE($1, type),
              title = COALESCE($2, title),
              amount = $3,
              paid_by_member_uid = COALESCE($4, paid_by_member_uid),
              split_type = COALESCE($5, split_type),
              category = COALESCE($6, category),
              note = COALESCE($7, note),
              date = COALESCE($8, date),
              updated_by_id = $9,
              updated_by_name = $10,
              updated_ts = $11,
              server_version = $12,
              updated_at = now()
        WHERE tx_uid = $13`,
      [
        p.type ?? null,
        isNonEmptyString(p.title) ? p.title.trim() : null,
        finalAmount,
        payerMemberUid ?? null,
        p.splitType ?? null,
        isNonEmptyString(p.category) ? p.category : null,
        typeof p.note === 'string' ? p.note : null,
        isNonEmptyString(p.date) ? p.date : null,
        ctx.actorId,
        ctx.actorName ?? null,
        Date.now(),
        nextVersion,
        mut.entityUid,
      ]
    );
    if (splits) {
      await tx.query('DELETE FROM transaction_splits WHERE transaction_uid = $1', [mut.entityUid]);
      await insertSplits(tx, mut.entityUid, splits);
    }

    const serverSequence = await appendChange(
      tx,
      ctx,
      'transaction',
      mut.entityUid,
      'update',
      nextVersion,
      txChangePayload(p, payerMemberUid, splits, existing.created_ts != null ? Number(existing.created_ts) : null)
    );
    return { serverVersion: nextVersion, serverSequence };
  }

  // Tombstone; splits are kept for audit and excluded from snapshots via is_deleted.
  await tx.query(
    'UPDATE transactions SET is_deleted = true, deleted_at = now(), server_version = $1, updated_at = now() WHERE tx_uid = $2',
    [nextVersion, mut.entityUid]
  );
  const serverSequence = await appendChange(tx, ctx, 'transaction', mut.entityUid, 'delete', nextVersion, {});
  return { serverVersion: nextVersion, serverSequence };
}
