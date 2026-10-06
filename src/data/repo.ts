// All reads/writes of app data. Money is stored as integer cents.
import { DB, getDb, Param } from './db';
import { computeShares, memberStats, suggestSettlements } from './logic';
import { AppError, Group, GroupListItem, GroupSummary, Member, Split, Transaction, TxInput, TxType } from './types';
import { CATEGORIES } from '../lib/theme';
import { CURRENCIES } from '../lib/currencies';
import { getIdentity } from '../lib/identity';
import { signalLocalChange, SyncTxPayload } from './sync';
import { enqueueOutboxMutation } from './outbox';
import { setUploadMarker } from './syncState';
import { getSetting, setSetting } from './settings';

export const LIMITS = { name: 80, title: 120, note: 1000, description: 300, category: 40, maxAmount: 1_000_000_000 };

const now = () => new Date().toISOString();

export function newUid() {
  const rnd = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${Date.now().toString(16)}-${rnd()}-${rnd()}`;
}

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

const toCents = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError('Invalid amount');
  const c = Math.round(n * 100);
  if (Math.abs(c) > LIMITS.maxAmount * 100) throw new AppError('Amount is too large');
  return c;
};

// ---------- row mappers ----------
interface GroupRow {
  id: number;
  uid: string;
  name: string;
  description: string;
  currency: string;
  permission_model?: string;
  creator_id?: string;
  creator_name?: string;
  server_version?: number;
  is_deleted?: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}
const mapGroup = (g: GroupRow): Group => ({
  id: g.id,
  uid: g.uid,
  name: g.name,
  description: g.description,
  currency: g.currency,
  permissionModel: (g.permission_model as Group['permissionModel']) || 'collaborative',
  creatorId: g.creator_id || '',
  creatorName: g.creator_name || '',
  serverVersion: g.server_version ?? 1,
  isDeleted: Boolean(g.is_deleted),
  deletedAt: g.deleted_at ?? undefined,
  createdAt: g.created_at,
  updatedAt: g.updated_at,
});

interface MemberRow {
  id: number;
  group_id: number;
  name: string;
  is_me: number;
  uid?: string;
  server_version?: number;
  is_deleted?: number;
  deleted_at?: string | null;
  created_at: string;
}
const mapMember = (m: MemberRow): Member => ({
  id: m.id,
  name: m.name,
  isMe: Boolean(m.is_me),
  uid: m.uid || `mem_${m.id}`,
  memberUid: m.uid || `mem_${m.id}`,
  serverVersion: m.server_version ?? 1,
  isDeleted: Boolean(m.is_deleted),
  deletedAt: m.deleted_at ?? undefined,
});

interface TxRow {
  id: number;
  uid?: string;
  group_id: number;
  type: 'expense' | 'payment';
  title: string;
  amount: number;
  paid_by: number;
  split_type: Transaction['splitType'];
  category: string;
  note: string;
  date: string;
  author_id?: string;
  author_name?: string;
  updated_by_id?: string;
  updated_by_name?: string;
  updated_ts?: number;
  server_version?: number;
  is_deleted?: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export function getGroupPermissions(group: Group, currentUserId: string) {
  const isCreator = !group.creatorId || group.creatorId === currentUserId;
  const model = group.permissionModel || 'collaborative';

  if (model === 'admin_only') {
    return {
      isCreator,
      canAdd: isCreator,
      canEditTx: (_tx?: { authorId?: string }) => isCreator,
      canDeleteTx: (_tx?: { authorId?: string }) => isCreator,
    };
  }

  if (model === 'contributor') {
    return {
      isCreator,
      canAdd: true,
      canEditTx: (tx?: { authorId?: string }) => isCreator || (Boolean(tx?.authorId) && tx?.authorId === currentUserId),
      canDeleteTx: (tx?: { authorId?: string }) => isCreator || (Boolean(tx?.authorId) && tx?.authorId === currentUserId),
    };
  }

  // 'collaborative'
  return {
    isCreator,
    canAdd: true,
    canEditTx: (_tx?: { authorId?: string }) => true,
    canDeleteTx: (tx?: { authorId?: string }) => isCreator || (Boolean(tx?.authorId) && tx?.authorId === currentUserId),
  };
}

async function touch(groupId: number) {
  const db = await getDb();
  await db.runAsync('UPDATE groups SET updated_at = ? WHERE id = ?', [now(), groupId]);
}

// ---------- categories ----------
const CUSTOM_CATEGORIES_KEY = 'customCategories';

/** Categories the user created, shared by all groups (built-in ones are CATEGORIES in lib/theme). */
export async function getCustomCategories(): Promise<string[]> {
  try {
    const list: unknown = JSON.parse((await getSetting(CUSTOM_CATEGORIES_KEY)) || '[]');
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/** Adds a category and returns its stored name (an existing name with different casing is reused). */
export async function addCustomCategory(rawName: string): Promise<string> {
  const name = clean(rawName, LIMITS.category);
  if (!name) throw new AppError('Enter a category name');
  const same = (c: string) => c.toLowerCase() === name.toLowerCase();
  const builtIn = CATEGORIES.find(same);
  if (builtIn) return builtIn;
  const list = await getCustomCategories();
  const existing = list.find(same);
  if (existing) return existing;
  await setSetting(CUSTOM_CATEGORIES_KEY, JSON.stringify([...list, name]));
  return name;
}

/** Removes a category from the picker. Expenses already using it keep their category. */
export async function removeCustomCategory(name: string) {
  const list = await getCustomCategories();
  await setSetting(CUSTOM_CATEGORIES_KEY, JSON.stringify(list.filter((c) => c !== name)));
}

// ---------- groups ----------
export async function getGroup(id: number): Promise<Group> {
  const db = await getDb();
  const g = await db.getFirstAsync<GroupRow>('SELECT * FROM groups WHERE id = ? AND is_deleted = 0', [id]);
  if (!g) throw new AppError('Group not found');
  return mapGroup(g);
}

export async function getMembers(groupId: number): Promise<Member[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MemberRow>(
    'SELECT * FROM members WHERE group_id = ? AND is_deleted = 0 ORDER BY id',
    [groupId]
  );
  return rows.map(mapMember);
}

export async function getTransactions(groupId?: number): Promise<Transaction[]> {
  const db = await getDb();
  const where = groupId ? 'WHERE t.group_id = ? AND t.is_deleted = 0' : 'WHERE t.is_deleted = 0';
  const params: Param[] = groupId ? [groupId] : [];
  const rows = await db.getAllAsync<TxRow>(`SELECT t.* FROM transactions t ${where} ORDER BY t.date DESC, t.id DESC`, params);
  const splits = await db.getAllAsync<{ transaction_id: number; member_id: number; value: number; share: number }>(
    `SELECT s.* FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id ${where}`,
    params
  );
  const byTx = new Map<number, Split[]>();
  for (const s of splits) {
    if (!byTx.has(s.transaction_id)) byTx.set(s.transaction_id, []);
    byTx.get(s.transaction_id)!.push({ memberId: s.member_id, value: s.value, share: s.share });
  }
  return rows.map((t) => ({
    id: t.id,
    uid: t.uid || `tx_${t.id}`,
    groupId: t.group_id,
    type: t.type,
    title: t.title,
    amount: t.amount,
    paidBy: t.paid_by,
    splitType: t.split_type,
    category: t.category,
    note: t.note,
    date: t.date,
    authorId: t.author_id,
    authorName: t.author_name,
    updatedById: t.updated_by_id,
    updatedByName: t.updated_by_name,
    updatedTs: t.updated_ts,
    serverVersion: t.server_version ?? 1,
    isDeleted: Boolean(t.is_deleted),
    deletedAt: t.deleted_at ?? undefined,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    splits: byTx.get(t.id) || [],
  }));
}

export async function listGroups(): Promise<GroupListItem[]> {
  const db = await getDb();
  const groups = (await db.getAllAsync<GroupRow>('SELECT * FROM groups WHERE is_deleted = 0 ORDER BY updated_at DESC, id DESC', [])).map(mapGroup);
  const out: GroupListItem[] = [];
  for (const g of groups) {
    const members = await getMembers(g.id);
    const txs = await getTransactions(g.id);
    const stats = memberStats(members, txs);
    const me = members.find((m) => m.isMe);
    out.push({
      ...g,
      memberCount: members.length,
      totalExpenses: txs.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0),
      myBalance: me ? (stats.find((s) => s.memberId === me.id)?.balance ?? 0) : 0,
      hasMe: !!me,
    });
  }
  return out;
}

export async function getGroupSummary(id: number): Promise<GroupSummary> {
  const group = await getGroup(id);
  const members = await getMembers(id);
  const transactions = await getTransactions(id);
  const stats = memberStats(members, transactions);
  const identity = await getIdentity();
  const perms = getGroupPermissions(group, identity.id);

  const categories: Record<string, number> = {};
  let totalExpenses = 0;
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    totalExpenses += t.amount;
    categories[t.category] = (categories[t.category] || 0) + t.amount;
  }
  return {
    group,
    members,
    stats,
    settlements: suggestSettlements(stats),
    totals: {
      totalExpenses,
      expenseCount: transactions.filter((t) => t.type === 'expense').length,
      paymentCount: transactions.filter((t) => t.type === 'payment').length,
    },
    categories: Object.entries(categories)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
    myMemberId: members.find((m) => m.isMe)?.id ?? null,
    myIdentityId: identity.id,
    isCreator: perms.isCreator,
    canAdd: perms.canAdd,
    transactions,
  };
}

export async function createGroup(input: {
  name: string;
  description?: string;
  currency?: string;
  permissionModel?: Group['permissionModel'];
  myName: string;
  members?: string[];
}) {
  const name = clean(input.name, LIMITS.name);
  if (!name) throw new AppError('Group name is required');
  const myName = clean(input.myName, LIMITS.name) || 'Me';
  const currency = CURRENCIES.includes(String(input.currency)) ? String(input.currency) : 'USD';
  const permissionModel = input.permissionModel || 'collaborative';
  const creatorId = (await getIdentity()).id;
  const creatorName = myName;
  const groupUid = newUid();
  const others = (input.members || [])
    .map((m) => clean(m, LIMITS.name))
    .filter((m) => Boolean(m) && m.toLowerCase() !== myName.toLowerCase());

  const db = await getDb();
  let gid = 0;
  await db.withTransactionAsync(async () => {
    const ts = now();
    const r = await db.runAsync(
      'INSERT INTO groups (uid, name, description, currency, permission_model, creator_id, creator_name, server_version, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)',
      [groupUid, name, clean(input.description, LIMITS.description), currency, permissionModel, creatorId, creatorName, ts, ts]
    );
    gid = r.lastInsertRowId;
    const myMemberUid = `mem_${newUid()}`;
    await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, server_version, is_deleted, created_at) VALUES (?, ?, ?, 1, 1, 0, ?)', [gid, myMemberUid, myName, ts]);

    // Enqueue group create mutation into local outbox
    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid,
        entityType: 'group',
        entityUid: groupUid,
        operation: 'create',
        expectedVersion: 0,
        payload: {
          uid: groupUid,
          name,
          description: clean(input.description, LIMITS.description),
          currency,
          permissionModel,
          creatorId,
          creatorName,
        },
      },
      db
    );

    // Enqueue initial creator member mutation
    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid,
        entityType: 'member',
        entityUid: myMemberUid,
        operation: 'create',
        expectedVersion: 0,
        payload: { uid: myMemberUid, name: myName, isMe: true },
      },
      db
    );

    for (const n of others) {
      const otherUid = `mem_${newUid()}`;
      await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, server_version, is_deleted, created_at) VALUES (?, ?, ?, 0, 1, 0, ?)', [gid, otherUid, n, ts]);
      await enqueueOutboxMutation(
        {
          clientMutationId: `mut_${newUid()}`,
          groupUid,
          entityType: 'member',
          entityUid: otherUid,
          operation: 'create',
          expectedVersion: 0,
          payload: { uid: otherUid, name: n, isMe: false },
        },
        db
      );
    }
    // Everything this group contains is in the outbox, so it never needs a backfill.
    await setUploadMarker(groupUid, db);
  });
  signalLocalChange(groupUid);
  return getGroup(gid);
}

/** Builds the server payload for a stored transaction from its current local rows. */
export async function buildTxSyncPayload(db: DB, txId: number): Promise<SyncTxPayload> {
  const t = await db.getFirstAsync<TxRow & { payer_name: string; payer_uid: string }>(
    `SELECT t.*, m.name AS payer_name, m.uid AS payer_uid FROM transactions t JOIN members m ON m.id = t.paid_by WHERE t.id = ?`,
    [txId]
  );
  if (!t) throw new AppError('Transaction not found');
  const splits = await db.getAllAsync<{ name: string; uid: string; value: number; share: number }>(
    'SELECT m.name, m.uid, s.value, s.share FROM transaction_splits s JOIN members m ON m.id = s.member_id WHERE s.transaction_id = ? ORDER BY m.id',
    [txId]
  );
  return {
    txUid: t.uid || `tx_${t.id}`,
    type: t.type,
    title: t.title,
    amount: t.amount,
    paidByName: t.payer_name,
    paidByMemberUid: t.payer_uid || undefined,
    splitType: t.split_type,
    category: t.category,
    note: t.note,
    date: t.date,
    authorId: t.author_id,
    authorName: t.author_name,
    ...(t.updated_by_id ? { updatedById: t.updated_by_id, updatedByName: t.updated_by_name } : {}),
    splits: splits.map((s) => ({ memberName: s.name, memberUid: s.uid || undefined, value: s.value, share: s.share })),
    updatedTs: t.updated_ts || Date.parse(t.updated_at) || Date.now(),
  };
}

export async function mergeMembers(groupId: number, sourceMemberId: number, targetMemberId: number) {
  if (sourceMemberId === targetMemberId) throw new AppError('Cannot merge a member into themselves');
  const group = await getGroup(groupId);
  const source = await getMemberRow(groupId, sourceMemberId);
  await getMemberRow(groupId, targetMemberId);
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    // Every live transaction the source member pays or shares in changes and must reach the server.
    const affected = await db.getAllAsync<{ id: number; server_version: number }>(
      `SELECT DISTINCT t.id, t.server_version FROM transactions t
        LEFT JOIN transaction_splits s ON s.transaction_id = t.id
        WHERE t.group_id = ? AND t.is_deleted = 0 AND (t.paid_by = ? OR s.member_id = ?)`,
      [groupId, sourceMemberId, sourceMemberId]
    );

    // 1. Reassign transactions where source was paid_by
    await db.runAsync('UPDATE transactions SET paid_by = ? WHERE group_id = ? AND paid_by = ?', [targetMemberId, groupId, sourceMemberId]);

    // 2. Reassign transaction splits
    const sourceSplits = await db.getAllAsync<{ transaction_id: number; value: number; share: number }>(
      'SELECT s.transaction_id, s.value, s.share FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.group_id = ? AND s.member_id = ?',
      [groupId, sourceMemberId]
    );

    for (const s of sourceSplits) {
      const existingTargetSplit = await db.getFirstAsync<{ value: number; share: number }>(
        'SELECT value, share FROM transaction_splits WHERE transaction_id = ? AND member_id = ?',
        [s.transaction_id, targetMemberId]
      );
      if (existingTargetSplit) {
        await db.runAsync(
          'UPDATE transaction_splits SET value = ?, share = ? WHERE transaction_id = ? AND member_id = ?',
          [existingTargetSplit.value + s.value, existingTargetSplit.share + s.share, s.transaction_id, targetMemberId]
        );
        await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ? AND member_id = ?', [s.transaction_id, sourceMemberId]);
      } else {
        await db.runAsync('UPDATE transaction_splits SET member_id = ? WHERE transaction_id = ? AND member_id = ?', [targetMemberId, s.transaction_id, sourceMemberId]);
      }
    }

    // 3. Queue the rewritten transactions, then remove the source member (soft delete, like deleteMember)
    const ts = now();
    for (const tx of affected) {
      await db.runAsync('UPDATE transactions SET server_version = server_version + 1, updated_at = ? WHERE id = ?', [ts, tx.id]);
      const payload = await buildTxSyncPayload(db, tx.id);
      await enqueueOutboxMutation(
        {
          clientMutationId: `mut_${newUid()}`,
          groupUid: group.uid,
          entityType: 'transaction',
          entityUid: payload.txUid,
          operation: 'update',
          expectedVersion: tx.server_version ?? 1,
          payload,
        },
        db
      );
    }
    await db.runAsync('UPDATE members SET is_deleted = 1, deleted_at = ? WHERE id = ? AND group_id = ?', [ts, sourceMemberId, groupId]);
    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: group.uid,
        entityType: 'member',
        entityUid: source.uid || `mem_${sourceMemberId}`,
        operation: 'delete',
        expectedVersion: source.server_version ?? 1,
        payload: { memberName: source.name },
      },
      db
    );
    await touch(groupId);
  });
  signalLocalChange(group.uid);
}

export async function updateGroup(
  id: number,
  input: { name?: string; description?: string; currency?: string; permissionModel?: Group['permissionModel'] }
) {
  const g = await getGroup(id);
  const identity = await getIdentity();
  if (g.creatorId && g.creatorId !== identity.id) {
    throw new AppError('Only the group creator can modify group settings and permissions.');
  }

  const name = input.name !== undefined ? clean(input.name, LIMITS.name) : g.name;
  if (!name) throw new AppError('Group name is required');
  const description = input.description !== undefined ? clean(input.description, LIMITS.description) : g.description;
  const currency = input.currency && CURRENCIES.includes(input.currency) ? input.currency : g.currency;
  const permissionModel = input.permissionModel || g.permissionModel || 'collaborative';

  const db = await getDb();
  const ts = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE groups SET name = ?, description = ?, currency = ?, permission_model = ?, server_version = server_version + 1, updated_at = ? WHERE id = ?',
      [name, description, currency, permissionModel, ts, id]
    );

    // Enqueue group update mutation into outbox
    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: g.uid,
        entityType: 'group',
        entityUid: g.uid,
        operation: 'update',
        expectedVersion: g.serverVersion ?? 1,
        payload: { name, description, currency, permissionModel },
      },
      db
    );
  });

  signalLocalChange(g.uid);
  return getGroup(id);
}

export async function deleteGroup(id: number) {
  const db = await getDb();
  const g = await db.getFirstAsync<GroupRow>('SELECT * FROM groups WHERE id = ?', [id]);
  if (!g) return;

  const ts = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE groups SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?', [ts, ts, id]);
    await db.runAsync('UPDATE members SET is_deleted = 1, deleted_at = ? WHERE group_id = ?', [ts, id]);
    await db.runAsync('UPDATE transactions SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE group_id = ?', [ts, ts, id]);

    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: g.uid,
        entityType: 'group',
        entityUid: g.uid,
        operation: 'delete',
        expectedVersion: g.server_version ?? 1,
        payload: { groupUid: g.uid },
      },
      db
    );
  });
  signalLocalChange(g.uid);
}

// ---------- members ----------
export async function addMember(groupId: number, rawName: string) {
  const group = await getGroup(groupId);
  const name = clean(rawName, LIMITS.name);
  if (!name) throw new AppError('Member name is required');
  const db = await getDb();
  const ts = now();
  const memberUid = `mem_${newUid()}`;
  let memberId = 0;

  await db.withTransactionAsync(async () => {
    const r = await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, server_version, is_deleted, created_at) VALUES (?, ?, ?, 0, 1, 0, ?)', [groupId, memberUid, name, ts]);
    memberId = r.lastInsertRowId;
    await touch(groupId);

    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: group.uid,
        entityType: 'member',
        entityUid: memberUid,
        operation: 'create',
        expectedVersion: 0,
        payload: { uid: memberUid, name },
      },
      db
    );
  });

  signalLocalChange(group.uid);

  return memberId;
}

async function getMemberRow(groupId: number, memberId: number) {
  const db = await getDb();
  const m = await db.getFirstAsync<MemberRow>('SELECT * FROM members WHERE id = ? AND group_id = ? AND is_deleted = 0', [memberId, groupId]);
  if (!m) throw new AppError('Member not found');
  return m;
}

export async function renameMember(groupId: number, memberId: number, rawName: string) {
  const group = await getGroup(groupId);
  const oldRow = await getMemberRow(groupId, memberId);
  const oldName = oldRow.name;
  const name = clean(rawName, LIMITS.name);
  if (!name) throw new AppError('Member name is required');
  if (oldName.trim().toLowerCase() === name.trim().toLowerCase()) return;

  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE members SET name = ?, server_version = server_version + 1 WHERE id = ?', [name, memberId]);
    // Also update any transaction audit trail records that reference the old name
    await db.runAsync('UPDATE transactions SET author_name = ? WHERE group_id = ? AND author_name = ?', [name, groupId, oldName]);
    await db.runAsync('UPDATE transactions SET updated_by_name = ? WHERE group_id = ? AND updated_by_name = ?', [name, groupId, oldName]);
    await touch(groupId);

    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: group.uid,
        entityType: 'member',
        entityUid: oldRow.uid || `mem_${memberId}`,
        operation: 'update',
        expectedVersion: oldRow.server_version ?? 1,
        payload: { oldName, newName: name },
      },
      db
    );
  });

  signalLocalChange(group.uid);
}

/** Marks which member is the phone's owner (or nobody when memberId is null). */
export async function setMe(groupId: number, memberId: number | null) {
  if (memberId !== null) await getMemberRow(groupId, memberId);
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE members SET is_me = 0 WHERE group_id = ?', [groupId]);
    if (memberId !== null) await db.runAsync('UPDATE members SET is_me = 1 WHERE id = ?', [memberId]);
  });
}

export async function deleteMember(groupId: number, memberId: number) {
  const group = await getGroup(groupId);
  const m = await getMemberRow(groupId, memberId);
  const db = await getDb();
  const used =
    (await db.getFirstAsync('SELECT 1 AS x FROM transactions WHERE paid_by = ? AND is_deleted = 0 LIMIT 1', [memberId])) ||
    (await db.getFirstAsync('SELECT 1 AS x FROM transaction_splits ts JOIN transactions t ON t.id = ts.transaction_id WHERE ts.member_id = ? AND t.is_deleted = 0 LIMIT 1', [memberId]));
  if (used) throw new AppError('This member has transactions. Delete or edit those transactions first.');
  const count = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM members WHERE group_id = ? AND is_deleted = 0', [groupId]);
  if ((count?.c ?? 0) <= 1) throw new AppError('A group needs at least one member');

  const ts = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE members SET is_deleted = 1, deleted_at = ? WHERE id = ?', [ts, memberId]);
    await touch(groupId);

    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: group.uid,
        entityType: 'member',
        entityUid: m.uid || `mem_${memberId}`,
        operation: 'delete',
        expectedVersion: m.server_version ?? 1,
        payload: { memberName: m.name },
      },
      db
    );
  });

  signalLocalChange(group.uid);
}

// ---------- transactions ----------
async function validateTx(groupId: number, body: TxInput) {
  const memberIds = new Set((await getMembers(groupId)).map((m) => m.id));
  const type = body.type === 'payment' ? 'payment' : 'expense';
  const amount = toCents(body.amount);
  if (amount <= 0) throw new AppError('Amount must be greater than zero');
  const paidBy = Number(body.paidBy);
  if (!memberIds.has(paidBy)) throw new AppError('Select who paid');
  const date = String(body.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new AppError('Invalid date');
  const note = clean(body.note, LIMITS.note);

  if (type === 'payment') {
    const to = Number(body.to ?? body.splits?.[0]?.memberId);
    if (!memberIds.has(to)) throw new AppError('Select who received the payment');
    if (to === paidBy) throw new AppError('Payer and receiver must be different');
    return { type, title: clean(body.title, LIMITS.title) || 'Payment', amount, paidBy, splitType: 'unequal' as const, category: 'Payment', note, date, shares: [{ memberId: to, value: amount, share: amount }] };
  }

  const title = clean(body.title, LIMITS.title);
  if (!title) throw new AppError('Enter a title for the expense');
  const splitType = body.splitType || 'equal';
  let splits = (body.splits || []).map((s) => ({ memberId: Number(s.memberId), value: s.value }));
  for (const s of splits) if (!memberIds.has(s.memberId)) throw new AppError('Split includes an unknown member');
  if (splitType === 'unequal') splits = splits.map((s) => ({ ...s, value: toCents(s.value ?? 0) }));
  if (splitType !== 'equal') splits = splits.filter((s) => Number(s.value) > 0);
  const shares = computeShares(amount, splitType, splits);
  return { type, title, amount, paidBy, splitType, category: clean(body.category, LIMITS.category) || 'General', note, date, shares };
}

export async function createTransaction(groupId: number, body: TxInput) {
  const group = await getGroup(groupId);
  const identity = await getIdentity();
  const perms = getGroupPermissions(group, identity.id);
  if (!perms.canAdd) {
    throw new AppError('Only the group admin can add expenses in this group.');
  }

  const members = await getMembers(groupId);
  const memberMap = new Map(members.map((m) => [m.id, m.name]));
  const memberUids = new Map(members.map((m) => [m.id, m.uid]));
  const myMember = members.find((m) => m.isMe);
  const myDisplayName = myMember?.name || identity.name || 'Me';
  const t = await validateTx(groupId, body);
  const db = await getDb();
  let id = 0;
  const txUid = `tx_${newUid()}`;
  const updatedTs = Date.now();
  const payload: SyncTxPayload = {
    txUid,
    type: t.type as TxType,
    title: t.title,
    amount: t.amount,
    paidByName: memberMap.get(t.paidBy) || 'Unknown',
    paidByMemberUid: memberUids.get(t.paidBy),
    splitType: t.splitType,
    category: t.category,
    note: t.note,
    date: t.date,
    authorId: identity.id,
    authorName: myDisplayName,
    splits: t.shares.map((s) => ({ memberName: memberMap.get(s.memberId) || 'Unknown', memberUid: memberUids.get(s.memberId), value: s.value, share: s.share })),
    updatedTs,
  };

  await db.withTransactionAsync(async () => {
    const ts = now();
    const r = await db.runAsync(
      `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name, updated_ts, server_version, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      [groupId, txUid, t.type, t.title, t.amount, t.paidBy, t.splitType, t.category, t.note, t.date, identity.id, myDisplayName, updatedTs, ts, ts]
    );
    id = r.lastInsertRowId;
    for (const s of t.shares) {
      await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [id, s.memberId, s.value, s.share]);
    }

    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: group.uid,
        entityType: 'transaction',
        entityUid: txUid,
        operation: 'create',
        expectedVersion: 0,
        payload,
      },
      db
    );
  });
  await touch(groupId);
  signalLocalChange(group.uid);

  return id;
}

export async function updateTransaction(groupId: number, txId: number, body: TxInput) {
  const group = await getGroup(groupId);
  const identity = await getIdentity();
  const db = await getDb();
  const existing = await db.getFirstAsync<TxRow>('SELECT * FROM transactions WHERE id = ? AND group_id = ? AND is_deleted = 0', [txId, groupId]);
  if (!existing) throw new AppError('Transaction not found');
  const perms = getGroupPermissions(group, identity.id);
  if (!perms.canEditTx({ authorId: existing.author_id })) {
    throw new AppError('You do not have permission to edit this transaction.');
  }

  const members = await getMembers(groupId);
  const memberMap = new Map(members.map((m) => [m.id, m.name]));
  const memberUids = new Map(members.map((m) => [m.id, m.uid]));
  const myMember = members.find((m) => m.isMe);
  const myDisplayName = myMember?.name || identity.name || 'Me';
  const t = await validateTx(groupId, { ...body, type: existing.type });
  const txUid = existing.uid || `tx_${txId}`;
  const updatedTs = Date.now();
  const payload: SyncTxPayload = {
    txUid,
    type: t.type as TxType,
    title: t.title,
    amount: t.amount,
    paidByName: memberMap.get(t.paidBy) || 'Unknown',
    paidByMemberUid: memberUids.get(t.paidBy),
    splitType: t.splitType,
    category: t.category,
    note: t.note,
    date: t.date,
    authorId: existing.author_id,
    authorName: existing.author_name,
    updatedById: identity.id,
    updatedByName: myDisplayName,
    splits: t.shares.map((s) => ({ memberName: memberMap.get(s.memberId) || 'Unknown', memberUid: memberUids.get(s.memberId), value: s.value, share: s.share })),
    updatedTs,
  };

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE transactions SET title = ?, amount = ?, paid_by = ?, split_type = ?, category = ?, note = ?, date = ?, updated_by_id = ?, updated_by_name = ?, updated_ts = ?, server_version = server_version + 1, updated_at = ? WHERE id = ?',
      [t.title, t.amount, t.paidBy, t.splitType, t.category, t.note, t.date, identity.id, myDisplayName, updatedTs, now(), txId]
    );
    await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [txId]);
    for (const s of t.shares) {
      await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [txId, s.memberId, s.value, s.share]);
    }

    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: group.uid,
        entityType: 'transaction',
        entityUid: txUid,
        operation: 'update',
        expectedVersion: existing.server_version ?? 1,
        payload,
      },
      db
    );
  });
  await touch(groupId);
  signalLocalChange(group.uid);
}

export async function deleteTransaction(groupId: number, txId: number) {
  const group = await getGroup(groupId);
  const identity = await getIdentity();
  const db = await getDb();
  const existing = await db.getFirstAsync<TxRow>('SELECT uid, author_id, server_version FROM transactions WHERE id = ? AND group_id = ? AND is_deleted = 0', [txId, groupId]);
  if (!existing) throw new AppError('Transaction not found');
  const perms = getGroupPermissions(group, identity.id);
  if (!perms.canDeleteTx({ authorId: existing.author_id })) {
    throw new AppError('You do not have permission to delete this transaction.');
  }

  const ts = now();
  await db.withTransactionAsync(async () => {
    const r = await db.runAsync('UPDATE transactions SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ? AND group_id = ?', [ts, ts, txId, groupId]);
    if (!r.changes) throw new AppError('Transaction not found');
    await touch(groupId);

    await enqueueOutboxMutation(
      {
        clientMutationId: `mut_${newUid()}`,
        groupUid: group.uid,
        entityType: 'transaction',
        entityUid: existing.uid || `tx_${txId}`,
        operation: 'delete',
        expectedVersion: existing.server_version ?? 1,
        payload: { txUid: existing.uid || `tx_${txId}`, authorId: existing.author_id },
      },
      db
    );
  });

  signalLocalChange(group.uid);
}

/** Wipes every group, member, transaction and setting. */
export async function eraseAllData() {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM outbox_mutations', []);
    await db.runAsync('DELETE FROM sync_state', []);
    await db.runAsync('DELETE FROM sync_notifications', []);
    await db.runAsync('DELETE FROM transaction_splits', []);
    await db.runAsync('DELETE FROM transactions', []);
    await db.runAsync('DELETE FROM members', []);
    await db.runAsync('DELETE FROM groups', []);
    await db.runAsync('DELETE FROM settings', []);
  });
}

