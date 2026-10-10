// Export / import of groups as JSON files (for sharing a group and for full backups).
// Imported files are untrusted input: everything is validated before touching the database.
import { getDb } from './db';
import { getGroup, getMembers, getTransactions, LIMITS, newUid } from './repo';
import { CURRENCIES } from '../lib/currencies';
import { AppError, SplitType } from './types';

export const FORMAT = 'splitmate';
/**
 * Version 1 files stored money as integer cents (1500 rupees -> 150000), which was easy to misread when
 * editing or writing a file by hand. Version 2 stores money as normal amounts (1500 or 1500.5).
 * Version 1 files are still read as cents so old backups restore correctly.
 */
const FORMAT_VERSION = 2;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_GROUPS = 500;
const MAX_MEMBERS = 500;
const MAX_TX = 100_000;

/** In a file, money is in whole currency units; after parseExport it is in integer cents. */
export interface ExportedGroup {
  uid: string;
  name: string;
  description: string;
  currency: string;
  createdAt: string;
  members: { ref: number; uid?: string; name: string; isMe: boolean }[];
  transactions: {
    uid?: string;
    type: 'expense' | 'payment';
    title: string;
    amount: number;
    paidBy: number;
    splitType: SplitType;
    category: string;
    note: string;
    date: string;
    authorId?: string;
    authorName?: string;
    createdAt: string;
    /** Creation time in epoch ms; absent in files exported before it existed. */
    createdTs?: number | null;
    splits: { member: number; value: number; share: number }[];
  }[];
}

export interface ExportFile {
  format: typeof FORMAT;
  version: number;
  kind: 'group' | 'backup';
  exportedAt: string;
  groups: ExportedGroup[];
}

const fromCents = (c: number) => c / 100;

async function exportOne(groupId: number): Promise<ExportedGroup> {
  const g = await getGroup(groupId);
  const members = await getMembers(groupId);
  const txs = await getTransactions(groupId);
  return {
    uid: g.uid,
    name: g.name,
    description: g.description,
    currency: g.currency,
    createdAt: g.createdAt,
    members: members.map((m) => ({ ref: m.id, uid: m.uid, name: m.name, isMe: m.isMe })),
    transactions: [...txs].reverse().map((t) => ({
      uid: t.uid,
      type: t.type,
      title: t.title,
      amount: fromCents(t.amount),
      paidBy: t.paidBy,
      splitType: t.splitType,
      category: t.category,
      note: t.note,
      date: t.date,
      authorId: t.authorId,
      authorName: t.authorName,
      createdAt: t.createdAt,
      createdTs: t.createdTs ?? null,
      splits: t.splits.map((s) => ({ member: s.memberId, value: t.splitType === 'unequal' ? fromCents(s.value) : s.value, share: fromCents(s.share) })),
    })),
  };
}

export async function exportGroup(groupId: number): Promise<ExportFile> {
  return { format: FORMAT, version: FORMAT_VERSION, kind: 'group', exportedAt: new Date().toISOString(), groups: [await exportOne(groupId)] };
}

export async function exportAll(): Promise<ExportFile> {
  const db = await getDb();
  const ids = await db.getAllAsync<{ id: number }>('SELECT id FROM groups ORDER BY id', []);
  const groups: ExportedGroup[] = [];
  for (const { id } of ids) groups.push(await exportOne(id));
  return { format: FORMAT, version: FORMAT_VERSION, kind: 'backup', exportedAt: new Date().toISOString(), groups };
}

// ---------- validation ----------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, field: string, required = false) => {
  if (v === undefined || v === null) {
    if (required) throw new AppError(`Invalid file: missing ${field}`);
    return '';
  }
  if (typeof v !== 'string') throw new AppError(`Invalid file: ${field} must be text`);
  const s = v.trim().slice(0, max);
  if (required && !s) throw new AppError(`Invalid file: ${field} is empty`);
  return s;
};
const int = (v: unknown, field: string, min = 0) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new AppError(`Invalid file: ${field} must be a whole number`);
  return v;
};
/** Money from a file as integer cents. Standard amounts like 1500 or 12.5 are converted to cents. */
const moneyIn = (v: unknown, field: string, min = 0) => {
  const n = typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new AppError(`Invalid file: ${field} must be a positive amount`);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw new AppError(`Invalid file: ${field} can have at most 2 decimal places`);
  if (cents < min) throw new AppError(`Invalid file: ${field} must be greater than zero`);
  return cents;
};

/** Parses and validates a file's text. Throws AppError with a readable message on any problem. */
export function parseExport(text: string): ExportFile {
  if (typeof text !== 'string' || text.length === 0) throw new AppError('The file is empty');
  if (text.length > MAX_FILE_BYTES) throw new AppError('The file is too large (max 10 MB)');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError('This is not a SplitMate file (invalid JSON)');
  }
  if (!isObj(raw) || (raw.format && raw.format !== FORMAT)) throw new AppError('This is not a SplitMate file');
  if (typeof raw.version === 'number' && raw.version > FORMAT_VERSION) {
    throw new AppError('This file was made by a newer version of SplitMate. Please update the app.');
  }
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) throw new AppError('The file contains no groups');
  if (raw.groups.length > MAX_GROUPS) throw new AppError('The file contains too many groups');

  const groups: ExportedGroup[] = raw.groups.map((g: unknown, gi: number) => {
    if (!isObj(g)) throw new AppError(`Invalid file: group ${gi + 1}`);
    const name = str(g.name, LIMITS.name, 'group name', true);
    if (!Array.isArray(g.members) || g.members.length === 0) throw new AppError(`Group "${name}" has no members`);
    if (g.members.length > MAX_MEMBERS) throw new AppError(`Group "${name}" has too many members`);
    const refs = new Set<number>();
    const members = g.members.map((m: unknown) => {
      if (!isObj(m)) throw new AppError(`Invalid member in "${name}"`);
      const ref = int(m.ref, 'member ref', 1);
      if (refs.has(ref)) throw new AppError(`Duplicate member in "${name}"`);
      refs.add(ref);
      return {
        ref,
        uid: typeof m.uid === 'string' && m.uid.trim() ? m.uid.trim() : undefined,
        name: str(m.name, LIMITS.name, 'member name', true),
        isMe: m.isMe === true,
      };
    });
    if (members.filter((m) => m.isMe).length > 1) members.forEach((m) => (m.isMe = false));
    const txIn = Array.isArray(g.transactions) ? g.transactions : [];
    if (txIn.length > MAX_TX) throw new AppError(`Group "${name}" has too many transactions`);
    const transactions = txIn.map((t: unknown, ti: number) => {
      const where = `transaction ${ti + 1} in "${name}"`;
      if (!isObj(t)) throw new AppError(`Invalid ${where}`);
      const type: 'expense' | 'payment' | null = t.type === 'payment' ? 'payment' : t.type === 'expense' ? 'expense' : null;
      if (!type) throw new AppError(`Invalid type in ${where}`);
      const amount = moneyIn(t.amount, `amount in ${where}`, 1);
      if (amount > LIMITS.maxAmount * 100) throw new AppError(`Amount too large in ${where}`);
      const paidBy = int(t.paidBy, `payer in ${where}`, 1);
      if (!refs.has(paidBy)) throw new AppError(`Unknown payer in ${where}`);
      const splitType = (['equal', 'unequal', 'percent', 'shares'] as const).find((s) => s === t.splitType);
      if (!splitType) throw new AppError(`Invalid split type in ${where}`);
      const date = str(t.date, 10, `date in ${where}`, true);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new AppError(`Invalid date in ${where}`);
      if (!Array.isArray(t.splits) || t.splits.length === 0) throw new AppError(`Missing split in ${where}`);
      const seen = new Set<number>();
      const splits = t.splits.map((s: unknown) => {
        if (!isObj(s)) throw new AppError(`Invalid split in ${where}`);
        const member = int(s.member, `split member in ${where}`, 1);
        if (!refs.has(member) || seen.has(member)) throw new AppError(`Invalid split member in ${where}`);
        seen.add(member);
        let value = typeof s.value === 'number' && Number.isFinite(s.value) && s.value >= 0 ? s.value : NaN;
        if (Number.isNaN(value)) {
          if (splitType === 'equal') value = 1;
          else throw new AppError(`Invalid split value in ${where}`);
        }
        if (splitType === 'unequal') value = moneyIn(value, `split value in ${where}`, 0);
        const share = s.share !== undefined ? moneyIn(s.share, `split share in ${where}`, 0) : 0;
        return { member, value, share };
      });
      const sum = splits.reduce((a, s) => a + s.share, 0);
      if (sum !== amount) throw new AppError(`Split shares don't add up to the amount in ${where}`);
      if (type === 'payment' && (splits.length !== 1 || splits[0]!.member === paidBy)) throw new AppError(`Invalid payment in ${where}`);
      return {
        uid: typeof t.uid === 'string' && t.uid.trim() ? t.uid.trim() : undefined,
        type,
        title: str(t.title, LIMITS.title, `title in ${where}`) || (type === 'payment' ? 'Payment' : 'Expense'),
        amount,
        paidBy,
        splitType,
        category: str(t.category, LIMITS.category, 'category') || (type === 'payment' ? 'Payment' : 'General'),
        note: str(t.note, LIMITS.note, 'note'),
        date,
        authorId: typeof t.authorId === 'string' && t.authorId.trim() ? t.authorId.trim() : undefined,
        authorName: typeof t.authorName === 'string' && t.authorName.trim() ? t.authorName.trim() : undefined,
        createdAt: str(t.createdAt, 40, 'createdAt') || new Date().toISOString(),
        createdTs: Number.isSafeInteger(t.createdTs) && Number(t.createdTs) > 0 ? Number(t.createdTs) : null,
        splits,
      };
    });
    return {
      uid: str(g.uid, 80, 'group id') || newUid(),
      name,
      description: str(g.description, LIMITS.description, 'description'),
      currency: CURRENCIES.includes(String(g.currency)) ? String(g.currency) : 'USD',
      createdAt: str(g.createdAt, 40, 'createdAt') || new Date().toISOString(),
      members,
      transactions,
    } satisfies ExportedGroup;
  });
  return {
    format: FORMAT,
    version: typeof raw.version === 'number' ? raw.version : FORMAT_VERSION,
    kind: raw.kind === 'backup' ? 'backup' : 'group',
    exportedAt: String(raw.exportedAt ?? ''),
    groups,
  };
}

/** Which of the file's groups already exist on this phone (matched by uid). */
export async function findExisting(file: ExportFile): Promise<Record<string, number>> {
  const db = await getDb();
  const out: Record<string, number> = {};
  for (const g of file.groups) {
    const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM groups WHERE uid = ?', [g.uid]);
    if (row) out[g.uid] = row.id;
  }
  return out;
}

export interface ImportOptions {
  /** 'replace' overwrites a group with the same id; 'copy' imports it as a new separate group. */
  onDuplicate: 'replace' | 'copy';
  /** Optional: for each group uid, the member ref that is "me" on this phone (null = nobody). */
  meRef?: Record<string, number | null>;
  /** Erase all existing groups first (full restore). */
  eraseFirst?: boolean;
}

export async function importFile(file: ExportFile, opts: ImportOptions): Promise<number[]> {
  const db = await getDb();
  const created: number[] = [];
  await db.withTransactionAsync(async () => {
    if (opts.eraseFirst) {
      await db.runAsync('DELETE FROM transaction_splits', []);
      await db.runAsync('DELETE FROM transactions', []);
      await db.runAsync('DELETE FROM members', []);
      await db.runAsync('DELETE FROM groups', []);
    }
    for (const g of file.groups) {
      let uid = g.uid;
      const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM groups WHERE uid = ?', [uid]);
      if (existing) {
        if (opts.onDuplicate === 'replace') {
          await db.runAsync('DELETE FROM transaction_splits WHERE transaction_id IN (SELECT id FROM transactions WHERE group_id = ?)', [existing.id]);
          await db.runAsync('DELETE FROM transactions WHERE group_id = ?', [existing.id]);
          await db.runAsync('DELETE FROM members WHERE group_id = ?', [existing.id]);
          await db.runAsync('DELETE FROM groups WHERE id = ?', [existing.id]);
        } else {
          uid = newUid();
        }
      }
      const ts = new Date().toISOString();
      const name = existing && opts.onDuplicate === 'copy' ? `${g.name} (copy)`.slice(0, LIMITS.name) : g.name;
      const r = await db.runAsync('INSERT INTO groups (uid, name, description, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        uid,
        name,
        g.description,
        g.currency,
        g.createdAt,
        ts,
      ]);
      const gid = r.lastInsertRowId;
      created.push(gid);
      const meRef = opts.meRef && g.uid in opts.meRef ? opts.meRef[g.uid] : (g.members.find((m) => m.isMe)?.ref ?? null);
      const idMap = new Map<number, number>();
      for (const m of g.members) {
        const mUid = m.uid || `mem_${newUid()}`;
        const mr = await db.runAsync('INSERT INTO members (group_id, uid, name, is_me, created_at) VALUES (?, ?, ?, ?, ?)', [gid, mUid, m.name, m.ref === meRef ? 1 : 0, ts]);
        idMap.set(m.ref, mr.lastInsertRowId);
      }
      for (const t of g.transactions) {
        const tUid = t.uid || `tx_${newUid()}`;
        const tr = await db.runAsync(
          `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name, created_ts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gid, tUid, t.type, t.title, t.amount, idMap.get(t.paidBy)!, t.splitType, t.category, t.note, t.date, t.authorId ?? '', t.authorName ?? '', t.createdTs ?? null, t.createdAt, ts]
        );
        for (const s of t.splits) {
          await db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [
            tr.lastInsertRowId,
            idMap.get(s.member)!,
            s.value,
            s.share,
          ]);
        }
      }
    }
  });
  return created;
}
