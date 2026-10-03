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
  updated_ts?: number;
  created_at: string;
  updated_at: string;
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
    transactions,
  };
}

export async function createGroup(input: { name: string; description?: string; currency?: string; myName: string; members?: string[]; syncKey?: string }) {
  const name = clean(input.name, LIMITS.name);
  if (!name) throw new AppError('Group name is required');
  const myName = clean(input.myName, LIMITS.name) || 'Me';
  const currency = CURRENCIES.includes(String(input.currency)) ? String(input.currency) : 'USD';
  const syncKey = input.syncKey || generateGroupKey();
  const others = (input.members || []).map((m) => clean(m, LIMITS.name)).filter(Boolean);
  const db = await getDb();
  let gid = 0;
  await db.withTransactionAsync(async () => {
    const ts = now();
    const r = await db.runAsync(
      'INSERT INTO groups (uid, name, description, currency, sync_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newUid(), name, clean(input.description, LIMITS.description), currency, syncKey, ts, ts]
    );
    gid = r.lastInsertRowId;
    await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 1, ?)', [gid, myName, ts]);
    for (const n of others) await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [gid, n, ts]);
  });
  return getGroup(gid);
}

export async function setGroupSyncKey(id: number, syncKey: string) {
  const db = await getDb();
  await db.runAsync('UPDATE groups SET sync_key = ?, updated_at = ? WHERE id = ?', [syncKey, now(), id]);
}

export async function updateGroup(id: number, input: { name?: string; description?: string; currency?: string }) {
  const g = await getGroup(id);
  const name = input.name !== undefined ? clean(input.name, LIMITS.name) : g.name;
  if (!name) throw new AppError('Group name is required');
  const description = input.description !== undefined ? clean(input.description, LIMITS.description) : g.description;
  const currency = input.currency && CURRENCIES.includes(input.currency) ? input.currency : g.currency;
  const db = await getDb();
  await db.runAsync('UPDATE groups SET name = ?, description = ?, currency = ?, updated_at = ? WHERE id = ?', [name, description, currency, now(), id]);
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
  await getGroup(groupId);
  const name = clean(rawName, LIMITS.name);
  if (!name) throw new AppError('Member name is required');
  const db = await getDb();
  const r = await db.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 0, ?)', [groupId, name, now()]);
  await touch(groupId);
  return r.lastInsertRowId;
}

async function getMemberRow(groupId: number, memberId: number) {
  const db = await getDb();
  const m = await db.getFirstAsync<{ id: number; name: string; is_me: number }>('SELECT * FROM members WHERE id = ? AND group_id = ?', [memberId, groupId]);
  if (!m) throw new AppError('Member not found');
  return m;
}

export async function renameMember(groupId: number, memberId: number, rawName: string) {
  await getMemberRow(groupId, memberId);
  const name = clean(rawName, LIMITS.name);
  if (!name) throw new AppError('Member name is required');
  const db = await getDb();
  await db.runAsync('UPDATE members SET name = ? WHERE id = ?', [name, memberId]);
  await touch(groupId);
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
  await getMemberRow(groupId, memberId);
  const db = await getDb();
  const used =
    (await db.getFirstAsync('SELECT 1 AS x FROM transactions WHERE paid_by = ? LIMIT 1', [memberId])) ||
    (await db.getFirstAsync('SELECT 1 AS x FROM transaction_splits WHERE member_id = ? LIMIT 1', [memberId]));
  if (used) throw new AppError('This member has transactions. Delete or edit those transactions first.');
  const count = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM members WHERE group_id = ?', [groupId]);
  if ((count?.c ?? 0) <= 1) throw new AppError('A group needs at least one member');
  await db.runAsync('DELETE FROM members WHERE id = ?', [memberId]);
  await touch(groupId);
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
  const members = await getMembers(groupId);
  const memberMap = new Map(members.map((m) => [m.id, m.name]));
  const t = await validateTx(groupId, body);
  const identity = await getIdentity();
  const db = await getDb();
  let id = 0;
  const txUid = `tx_${newUid()}`;
  const updatedTs = Date.now();
  await db.withTransactionAsync(async () => {
    const ts = now();
    const r = await db.runAsync(
      `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name, updated_ts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [groupId, txUid, t.type, t.title, t.amount, t.paidBy, t.splitType, t.category, t.note, t.date, identity.id, identity.name, updatedTs, ts, ts]
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
    splits: t.shares.map((s) => ({ memberName: memberMap.get(s.memberId) || 'Unknown', value: s.value, share: s.share })),
    updatedTs,
  };
  await createSyncEvent(group.uid, 'UPSERT_TX', payload);

  return id;
}

export async function updateTransaction(groupId: number, txId: number, body: TxInput) {
  const group = await getGroup(groupId);
  const members = await getMembers(groupId);
  const memberMap = new Map(members.map((m) => [m.id, m.name]));
  const db = await getDb();
  const existing = await db.getFirstAsync<TxRow>('SELECT * FROM transactions WHERE id = ? AND group_id = ?', [txId, groupId]);
  if (!existing) throw new AppError('Transaction not found');
  const t = await validateTx(groupId, { ...body, type: existing.type });
  const identity = await getIdentity();
  const txUid = existing.uid || `tx_${txId}`;
  const updatedTs = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE transactions SET title = ?, amount = ?, paid_by = ?, split_type = ?, category = ?, note = ?, date = ?, author_id = ?, author_name = ?, updated_ts = ?, updated_at = ? WHERE id = ?',
      [t.title, t.amount, t.paidBy, t.splitType, t.category, t.note, t.date, identity.id, identity.name, updatedTs, now(), txId]
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
    splits: t.shares.map((s) => ({ memberName: memberMap.get(s.memberId) || 'Unknown', value: s.value, share: s.share })),
    updatedTs,
  };
  await createSyncEvent(group.uid, 'UPSERT_TX', payload);
}

export async function deleteTransaction(groupId: number, txId: number) {
  const group = await getGroup(groupId);
  const db = await getDb();
  const existing = await db.getFirstAsync<TxRow>('SELECT uid FROM transactions WHERE id = ? AND group_id = ?', [txId, groupId]);
  const r = await db.runAsync('DELETE FROM transactions WHERE id = ? AND group_id = ?', [txId, groupId]);
  if (!r.changes) throw new AppError('Transaction not found');
  await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id = ?', [txId]);
  await touch(groupId);

  if (existing?.uid) {
    await createSyncEvent(group.uid, 'DELETE_TX', { txUid: existing.uid });
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
