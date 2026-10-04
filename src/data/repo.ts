// All reads/writes of app data. Money is stored as integer cents.
import { getDb, Param } from './db';
import { computeShares, memberStats, suggestSettlements } from './logic';
import { AppError, Group, GroupListItem, GroupSummary, Member, Split, Transaction, TxInput, TxType } from './types';
import { CATEGORIES } from '../lib/theme';
import { CURRENCIES } from '../lib/currencies';
import { generateGroupKey } from '../lib/crypto';
import { getIdentity } from '../lib/identity';
import { createSyncEvent, SyncTxPayload } from './sync';

export { CURRENCIES };
export const LIMITS = { name: 80, title: 120, note: 1000, description: 300, category: 40, maxAmount: 1_000_000_000 };

const now = () => new Date().toISOString();

export function newUid() {
  const rnd = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${Date.now().toString(16)}-${rnd()}-${rnd()}`;
}

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

export const toCents = (v: unknown) => {
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
  sync_key?: string;
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
  syncKey: g.sync_key || '',
  createdAt: g.created_at,
  updatedAt: g.updated_at,
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
      canEditTx: (_tx?: { authorId?: string }) => isCreator,
      canDeleteTx: (_tx?: { authorId?: string }) => isCreator,
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

// ---------- settings ----------
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return r ? r.value : null;
}

export async function setSetting(key: string, value: string | null) {
  const db = await getDb();
  if (value === null) await db.runAsync('DELETE FROM settings WHERE key = ?', [key]);
  else await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
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
  const g = await db.getFirstAsync<GroupRow>('SELECT * FROM groups WHERE id = ?', [id]);
  if (!g) throw new AppError('Group not found');
  if (!g.sync_key) {
    const newKey = generateGroupKey();
    await db.runAsync('UPDATE groups SET sync_key = ?, updated_at = ? WHERE id = ?', [newKey, now(), id]);
    g.sync_key = newKey;
  }
  return mapGroup(g);
}

export async function getMembers(groupId: number): Promise<Member[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: number; name: string; is_me: number }>(
    'SELECT id, name, is_me FROM members WHERE group_id = ? ORDER BY id',
    [groupId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, isMe: !!r.is_me }));
}

export async function getTransactions(groupId?: number): Promise<Transaction[]> {
  const db = await getDb();
  const where = groupId ? 'WHERE t.group_id = ?' : '';
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
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    splits: byTx.get(t.id) || [],
  }));
}

export async function listGroups(): Promise<GroupListItem[]> {
  const db = await getDb();
  const groups = (await db.getAllAsync<GroupRow>('SELECT * FROM groups ORDER BY updated_at DESC, id DESC', [])).map(mapGroup);
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
  creatorId?: string;
  creatorName?: string;
  myName: string;
  members?: string[];
  syncKey?: string;
  uid?: string;
}) {
  const name = clean(input.name, LIMITS.name);
  if (!name) throw new AppError('Group name is required');
  const myName = clean(input.myName, LIMITS.name) || 'Me';
  const currency = CURRENCIES.includes(String(input.currency)) ? String(input.currency) : 'USD';
  const permissionModel = input.permissionModel || 'collaborative';
  const identity = await getIdentity();
  const creatorId = input.creatorId || identity.id;
  const creatorName = input.creatorName || myName;
  const syncKey = input.syncKey || generateGroupKey();
  const groupUid = input.uid || newUid();
  const others = (input.members || [])
    .map((m) => clean(m, LIMITS.name))
    .filter((m) => Boolean(m) && m.toLowerCase() !== myName.toLowerCase());

  const db = await getDb();
  if (input.uid) {
    const existing = await db.getFirstAsync<GroupRow>('SELECT * FROM groups WHERE uid = ?', [input.uid]);
    if (existing) {
      if (syncKey && (!existing.sync_key || existing.sync_key !== syncKey)) {
        await db.runAsync('UPDATE groups SET sync_key = ?, updated_at = ? WHERE id = ?', [syncKey, now(), existing.id]);
        existing.sync_key = syncKey;
      }
      return mapGroup(existing);
    }
  }

  let gid = 0;
  await db.withTransactionAsync(async () => {
    const ts = now();
    const r = await db.runAsync(
      'INSERT INTO groups (uid, name, description, currency, permission_model, creator_id, creator_name, sync_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [groupUid, name, clean(input.description, LIMITS.description), currency, permissionModel, creatorId, creatorName, syncKey, ts, ts]
    );
    gid = r.lastInsertRowId;
    await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 1, ?)', [gid, myName, ts]);
    for (const n of others) await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [gid, n, ts]);
  });
  return getGroup(gid);
}

export async function mergeMembers(groupId: number, sourceMemberId: number, targetMemberId: number) {
  if (sourceMemberId === targetMemberId) throw new AppError('Cannot merge a member into themselves');
  const db = await getDb();
  await db.withTransactionAsync(async () => {
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

    // 3. Delete source member
    await db.runAsync('DELETE FROM members WHERE id = ? AND group_id = ?', [sourceMemberId, groupId]);
    await touch(groupId);
  });
}

export async function mergeMembersByName(groupId: number, sourceName: string, targetName: string) {
  const members = await getMembers(groupId);
  const source = members.find((m) => m.name.toLowerCase().trim() === sourceName.toLowerCase().trim());
  const target = members.find((m) => m.name.toLowerCase().trim() === targetName.toLowerCase().trim());
  if (source && target && source.id !== target.id) {
    await mergeMembers(groupId, source.id, target.id);
  }
}

export interface GroupSnapshotChunkPayload {
  groupUid: string;
  name: string;
  description: string;
  currency: string;
  permissionModel?: Group['permissionModel'];
  creatorId?: string;
  creatorName?: string;
  chunkIndex?: number;
  totalChunks?: number;
  batchId?: string;
  members: string[];
  transactions: {
    txUid: string;
    type: TxType;
    title: string;
    amount: number;
    paidByName: string;
    splitType: Transaction['splitType'];
    category: string;
    note: string;
    date: string;
    authorId?: string;
    authorName?: string;
    updatedById?: string;
    updatedByName?: string;
    updatedTs: number;
    splits: { memberName: string; value: number; share: number }[];
  }[];
}

export type GroupSnapshotPayload = GroupSnapshotChunkPayload;

export async function exportGroupSnapshot(groupId: number): Promise<GroupSnapshotPayload> {
  const group = await getGroup(groupId);
  const members = await getMembers(groupId);
  const txs = await getTransactions(groupId);
  const memberMap = new Map(members.map((m) => [m.id, m.name]));

  return {
    groupUid: group.uid,
    name: group.name,
    description: group.description,
    currency: group.currency,
    permissionModel: group.permissionModel,
    creatorId: group.creatorId,
    creatorName: group.creatorName,
    chunkIndex: 0,
    totalChunks: 1,
    members: members.map((m) => m.name),
    transactions: txs.map((t) => ({
      txUid: t.uid || `tx_${t.id}`,
      type: t.type,
      title: t.title,
      amount: t.amount,
      paidByName: memberMap.get(t.paidBy) || 'Unknown',
      splitType: t.splitType,
      category: t.category,
      note: t.note,
      date: t.date,
      authorId: t.authorId,
      authorName: t.authorName,
      updatedById: t.updatedById,
      updatedByName: t.updatedByName,
      updatedTs: t.updatedTs || (t.createdAt ? new Date(t.createdAt).getTime() : Date.now()),
      splits: t.splits.map((s) => ({
        memberName: memberMap.get(s.memberId) || 'Unknown',
        value: s.value,
        share: s.share,
      })),
    })),
  };
}

export async function exportGroupSnapshotBatches(
  groupId: number,
  batchSize = 25
): Promise<GroupSnapshotChunkPayload[]> {
  const full = await exportGroupSnapshot(groupId);
  if (full.transactions.length <= batchSize) {
    return [{ ...full, chunkIndex: 0, totalChunks: 1, batchId: `batch_${Date.now().toString(16)}` }];
  }

  const batchId = `batch_${Date.now().toString(16)}`;
  const totalChunks = Math.ceil(full.transactions.length / batchSize);
  const chunks: GroupSnapshotChunkPayload[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const slice = full.transactions.slice(i * batchSize, (i + 1) * batchSize);
    chunks.push({
      groupUid: full.groupUid,
      name: full.name,
      description: full.description,
      currency: full.currency,
      permissionModel: full.permissionModel,
      creatorId: full.creatorId,
      creatorName: full.creatorName,
      chunkIndex: i,
      totalChunks,
      batchId,
      members: full.members,
      transactions: slice,
    });
  }

  return chunks;
}

export async function applyGroupSnapshot(groupId: number, snapshot: GroupSnapshotPayload): Promise<{ added: number; updated: number }> {
  const db = await getDb();
  let added = 0;
  let updated = 0;
  const nowIso = now();

  await db.withTransactionAsync(async () => {
    // 1. Update group metadata & permission model if present
    if (snapshot.permissionModel || snapshot.creatorId) {
      await db.runAsync(
        "UPDATE groups SET permission_model = COALESCE(NULLIF(?, ''), permission_model), creator_id = COALESCE(NULLIF(?, ''), creator_id), creator_name = COALESCE(NULLIF(?, ''), creator_name), updated_at = ? WHERE id = ?",
        [snapshot.permissionModel || '', snapshot.creatorId || '', snapshot.creatorName || '', nowIso, groupId]
      );
    }

    // 2. Ensure all members in snapshot exist
    const currentMembers = await getMembers(groupId);
    const memberNameMap = new Map<string, number>(currentMembers.map((m) => [m.name.toLowerCase().trim(), m.id]));

    for (const memName of snapshot.members) {
      const cleanName = clean(memName, LIMITS.name);
      if (cleanName && !memberNameMap.has(cleanName.toLowerCase().trim())) {
        const r = await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [groupId, cleanName, nowIso]);
        memberNameMap.set(cleanName.toLowerCase().trim(), r.lastInsertRowId);
      }
    }

    // 3. Import / Merge transactions
    for (const tx of snapshot.transactions) {
      let payerId = memberNameMap.get(tx.paidByName.toLowerCase().trim());
      if (!payerId) {
        const r = await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [groupId, tx.paidByName, nowIso]);
        payerId = r.lastInsertRowId;
        memberNameMap.set(tx.paidByName.toLowerCase().trim(), payerId);
      }

      const existingTx = await db.getFirstAsync<{ id: number; updated_ts: number }>(
        'SELECT id, updated_ts FROM transactions WHERE group_id = ? AND uid = ?',
        [groupId, tx.txUid]
      );

      if (existingTx) {
        // Last-Write-Wins: update only if snapshot is newer
        if ((tx.updatedTs || 0) > (existingTx.updated_ts || 0)) {
          await db.runAsync(
            `UPDATE transactions SET type = ?, title = ?, amount = ?, paid_by = ?, split_type = ?, category = ?, note = ?, date = ?, author_id = ?, author_name = ?, updated_by_id = ?, updated_by_name = ?, updated_ts = ?, updated_at = ?
             WHERE id = ?`,
            [
              tx.type,
              tx.title,
              tx.amount,
              payerId,
              tx.splitType,
              tx.category,
              tx.note,
              tx.date,
              tx.authorId || '',
              tx.authorName || '',
              tx.updatedById || '',
              tx.updatedByName || '',
              tx.updatedTs,
              nowIso,
              existingTx.id,
            ]
          );
          await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [existingTx.id]);
          for (const s of tx.splits) {
            let sMemberId = memberNameMap.get(s.memberName.toLowerCase().trim());
            if (!sMemberId) {
              const r = await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [groupId, s.memberName, nowIso]);
              sMemberId = r.lastInsertRowId;
              memberNameMap.set(s.memberName.toLowerCase().trim(), sMemberId);
            }
            await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [
              existingTx.id,
              sMemberId,
              s.value,
              s.share,
            ]);
          }
          updated++;
        }
      } else {
        // Insert new transaction
        const ins = await db.runAsync(
          `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name, updated_by_id, updated_by_name, updated_ts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            groupId,
            tx.txUid,
            tx.type,
            tx.title,
            tx.amount,
            payerId,
            tx.splitType,
            tx.category,
            tx.note,
            tx.date,
            tx.authorId || '',
            tx.authorName || '',
            tx.updatedById || '',
            tx.updatedByName || '',
            tx.updatedTs || Date.now(),
            nowIso,
            nowIso,
          ]
        );
        const newTxId = ins.lastInsertRowId;
        for (const s of tx.splits) {
          let sMemberId = memberNameMap.get(s.memberName.toLowerCase().trim());
          if (!sMemberId) {
            const r = await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [groupId, s.memberName, nowIso]);
            sMemberId = r.lastInsertRowId;
            memberNameMap.set(s.memberName.toLowerCase().trim(), sMemberId);
          }
          await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [
            newTxId,
            sMemberId,
            s.value,
            s.share,
          ]);
        }
        added++;
      }
    }
    await touch(groupId);
  });

  return { added, updated };
}

export async function setGroupSyncKey(id: number, syncKey: string) {
  const db = await getDb();
  await db.runAsync('UPDATE groups SET sync_key = ?, updated_at = ? WHERE id = ?', [syncKey, now(), id]);
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
  await db.runAsync(
    'UPDATE groups SET name = ?, description = ?, currency = ?, permission_model = ?, updated_at = ? WHERE id = ?',
    [name, description, currency, permissionModel, ts, id]
  );

  // Broadcast settings change event
  await createSyncEvent(g.uid, 'UPDATE_GROUP', { name, description, currency, permissionModel });
  return getGroup(id);
}

export async function deleteGroup(id: number) {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id IN (SELECT id FROM transactions WHERE group_id = ?)', [id]);
    await db.runAsync('DELETE FROM transactions WHERE group_id = ?', [id]);
    await db.runAsync('DELETE FROM members WHERE group_id = ?', [id]);
    await db.runAsync('DELETE FROM groups WHERE id = ?', [id]);
  });
}

// ---------- members ----------
export async function addMember(groupId: number, rawName: string) {
  const group = await getGroup(groupId);
  const name = clean(rawName, LIMITS.name);
  if (!name) throw new AppError('Member name is required');
  const db = await getDb();
  const r = await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [groupId, name, now()]);
  await touch(groupId);

  if (group.uid) {
    await createSyncEvent(group.uid, 'ADD_MEMBER', { name });
  }

  return r.lastInsertRowId;
}

async function getMemberRow(groupId: number, memberId: number) {
  const db = await getDb();
  const m = await db.getFirstAsync<{ id: number; name: string; is_me: number }>('SELECT * FROM members WHERE id = ? AND group_id = ?', [memberId, groupId]);
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
    await db.runAsync('UPDATE members SET name = ? WHERE id = ?', [name, memberId]);
    // Also update any transaction audit trail records that reference the old name
    await db.runAsync('UPDATE transactions SET author_name = ? WHERE group_id = ? AND author_name = ?', [name, groupId, oldName]);
    await db.runAsync('UPDATE transactions SET updated_by_name = ? WHERE group_id = ? AND updated_by_name = ?', [name, groupId, oldName]);
    await touch(groupId);
  });

  if (group.uid) {
    await createSyncEvent(group.uid, 'RENAME_MEMBER', { oldName, newName: name });
  }
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
    (await db.getFirstAsync('SELECT 1 AS x FROM transactions WHERE paid_by = ? LIMIT 1', [memberId])) ||
    (await db.getFirstAsync('SELECT 1 AS x FROM transaction_splits WHERE member_id = ? LIMIT 1', [memberId]));
  if (used) throw new AppError('This member has transactions. Delete or edit those transactions first.');
  const count = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM members WHERE group_id = ?', [groupId]);
  if ((count?.c ?? 0) <= 1) throw new AppError('A group needs at least one member');
  await db.runAsync('DELETE FROM members WHERE id = ?', [memberId]);
  await touch(groupId);

  if (group.uid) {
    await createSyncEvent(group.uid, 'DELETE_MEMBER', { memberName: m.name });
  }
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
  const myMember = members.find((m) => m.isMe);
  const myDisplayName = myMember?.name || identity.name || 'Me';
  const t = await validateTx(groupId, body);
  const db = await getDb();
  let id = 0;
  const txUid = `tx_${newUid()}`;
  const updatedTs = Date.now();
  await db.withTransactionAsync(async () => {
    const ts = now();
    const r = await db.runAsync(
      `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name, updated_ts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [groupId, txUid, t.type, t.title, t.amount, t.paidBy, t.splitType, t.category, t.note, t.date, identity.id, myDisplayName, updatedTs, ts, ts]
    );
    id = r.lastInsertRowId;
    for (const s of t.shares) {
      await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [id, s.memberId, s.value, s.share]);
    }
  });
  await touch(groupId);

  // Broadcast sync event
  const payload: SyncTxPayload = {
    txUid,
    type: t.type as TxType,
    title: t.title,
    amount: t.amount,
    paidByName: memberMap.get(t.paidBy) || 'Unknown',
    splitType: t.splitType,
    category: t.category,
    note: t.note,
    date: t.date,
    authorId: identity.id,
    authorName: myDisplayName,
    splits: t.shares.map((s) => ({ memberName: memberMap.get(s.memberId) || 'Unknown', value: s.value, share: s.share })),
    updatedTs,
  };
  await createSyncEvent(group.uid, 'UPSERT_TX', payload);

  return id;
}

export async function updateTransaction(groupId: number, txId: number, body: TxInput) {
  const group = await getGroup(groupId);
  const identity = await getIdentity();
  const db = await getDb();
  const existing = await db.getFirstAsync<TxRow>('SELECT * FROM transactions WHERE id = ? AND group_id = ?', [txId, groupId]);
  if (!existing) throw new AppError('Transaction not found');
  const perms = getGroupPermissions(group, identity.id);
  if (!perms.canEditTx({ authorId: existing.author_id })) {
    throw new AppError('You do not have permission to edit this transaction.');
  }

  const members = await getMembers(groupId);
  const memberMap = new Map(members.map((m) => [m.id, m.name]));
  const myMember = members.find((m) => m.isMe);
  const myDisplayName = myMember?.name || identity.name || 'Me';
  const t = await validateTx(groupId, { ...body, type: existing.type });
  const txUid = existing.uid || `tx_${txId}`;
  const updatedTs = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE transactions SET title = ?, amount = ?, paid_by = ?, split_type = ?, category = ?, note = ?, date = ?, updated_by_id = ?, updated_by_name = ?, updated_ts = ?, updated_at = ? WHERE id = ?',
      [t.title, t.amount, t.paidBy, t.splitType, t.category, t.note, t.date, identity.id, myDisplayName, updatedTs, now(), txId]
    );
    await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [txId]);
    for (const s of t.shares) {
      await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [txId, s.memberId, s.value, s.share]);
    }
  });
  await touch(groupId);

  const payload: SyncTxPayload = {
    txUid,
    type: t.type as TxType,
    title: t.title,
    amount: t.amount,
    paidByName: memberMap.get(t.paidBy) || 'Unknown',
    splitType: t.splitType,
    category: t.category,
    note: t.note,
    date: t.date,
    authorId: existing.author_id,
    authorName: existing.author_name,
    updatedById: identity.id,
    updatedByName: myDisplayName,
    splits: t.shares.map((s) => ({ memberName: memberMap.get(s.memberId) || 'Unknown', value: s.value, share: s.share })),
    updatedTs,
  };
  await createSyncEvent(group.uid, 'UPSERT_TX', payload);
}

export async function deleteTransaction(groupId: number, txId: number) {
  const group = await getGroup(groupId);
  const identity = await getIdentity();
  const db = await getDb();
  const existing = await db.getFirstAsync<TxRow>('SELECT uid, author_id FROM transactions WHERE id = ? AND group_id = ?', [txId, groupId]);
  if (!existing) throw new AppError('Transaction not found');
  const perms = getGroupPermissions(group, identity.id);
  if (!perms.canDeleteTx({ authorId: existing.author_id })) {
    throw new AppError('You do not have permission to delete this transaction.');
  }

  const r = await db.runAsync('DELETE FROM transactions WHERE id = ? AND group_id = ?', [txId, groupId]);
  if (!r.changes) throw new AppError('Transaction not found');
  await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [txId]);
  await touch(groupId);

  if (existing?.uid) {
    await createSyncEvent(group.uid, 'DELETE_TX', { txUid: existing.uid, authorId: existing.author_id });
  }
}

/** Wipes every group, member, transaction and setting. */
export async function eraseAllData() {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM transaction_splits', []);
    await db.runAsync('DELETE FROM transactions', []);
    await db.runAsync('DELETE FROM members', []);
    await db.runAsync('DELETE FROM groups', []);
    await db.runAsync('DELETE FROM settings', []);
  });
}
