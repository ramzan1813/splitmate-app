import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { getDb, migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { canSettle, computeShares, distribute, getSettlementCauses, groupCashTotals, memberStats, suggestSettlements, calculateDirectDebts } from '../src/data/logic';
import { onLocalChange } from '../src/data/sync';
import { exportAll, exportGroup, findNameClashes, importFile, parseExport } from '../src/data/backup';
import { getIdentity } from '../src/lib/identity';
import { computeInsights, periodRange } from '../src/data/insights';
import { buildXlsx } from '../src/lib/xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import { createSampleGroups, getSampleGroupIds, removeSampleGroups } from '../src/data/samples';
import { CURRENCIES, searchCurrencies } from '../src/lib/currencies';
import { currencySymbol, money, prettyTime, txWhen } from '../src/lib/format';

beforeEach(async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);
});

const fmt = (c: number) => (c / 100).toFixed(2);

async function seed() {
  const g = await repo.createGroup({ name: 'Trip', currency: 'PKR', myName: 'Owner', members: ['Bilal', 'Sara'] });
  const [o, b, s] = (await repo.getMembers(g.id)).map((m) => m.id) as [number, number, number];
  await repo.createTransaction(g.id, { type: 'expense', title: 'Hotel', amount: 300, paidBy: o, splitType: 'equal', splits: [{ memberId: o }, { memberId: b }, { memberId: s }], category: 'Stay', date: '2026-10-01' });
  await repo.createTransaction(g.id, { type: 'expense', title: 'Food', amount: 100, paidBy: b, splitType: 'unequal', splits: [{ memberId: o, value: 50 }, { memberId: b, value: 30 }, { memberId: s, value: 20 }], category: 'Food', date: '2026-10-02' });
  await repo.createTransaction(g.id, { type: 'expense', title: 'Fuel', amount: 200, paidBy: s, splitType: 'percent', splits: [{ memberId: o, value: 50 }, { memberId: s, value: 50 }], category: 'Fuel', date: '2026-09-20' });
  await repo.createTransaction(g.id, { type: 'expense', title: 'Tickets', amount: 90, paidBy: o, splitType: 'shares', splits: [{ memberId: b, value: 2 }, { memberId: s, value: 1 }], category: 'Entertainment', date: '2026-10-03' });
  await repo.createTransaction(g.id, { type: 'payment', amount: 50, paidBy: b, to: o, date: '2026-10-04' });
  return { g, o, b, s };
}

test('split math', () => {
  assert.deepEqual(distribute(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(computeShares(6000, 'shares', [{ memberId: 1, value: 2 }, { memberId: 2, value: 1 }]).map((x) => x.share), [4000, 2000]);
  assert.throws(() => computeShares(1000, 'percent', [{ memberId: 1, value: 50 }]), /100/);
  assert.throws(() => computeShares(1000, 'unequal', [{ memberId: 1, value: 500 }]), /add up/);
  assert.throws(() => computeShares(100, 'equal', [{ memberId: 1 }, { memberId: 1 }]), /Duplicate/);
});

test('settlements clear every balance', () => {
  const members = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const stats = memberStats(members, [
    { type: 'expense', amount: 3000, paidBy: 1, splits: [{ memberId: 1, value: 1, share: 1000 }, { memberId: 2, value: 1, share: 1000 }, { memberId: 3, value: 1, share: 1000 }] },
  ]);
  const bal = Object.fromEntries(stats.map((s) => [s.memberId, s.balance]));
  for (const p of suggestSettlements(stats)) {
    bal[p.from] += p.amount;
    bal[p.to] -= p.amount;
  }
  assert.ok(Object.values(bal).every((v) => v === 0));
});

test('group summary balances', async () => {
  const { g } = await seed();
  const s = await repo.getGroupSummary(g.id);
  const bal = Object.fromEntries(s.stats.map((x) => [x.name, x.balance]));
  assert.deepEqual(bal, { Owner: 9000, Bilal: -4000, Sara: -5000 });
  assert.equal(s.totals.totalExpenses, 69000);
  assert.equal(s.totals.totalPayments, 5000);
  assert.equal(s.totals.groupBalance, 5000 - 69000, 'group balance = payments in - expenses out');
  assert.equal(s.myMemberId, s.members[0]!.id);
  assert.equal(s.transactions.length, 5);
  const list = await repo.listGroups();
  assert.equal(list[0]!.myBalance, 9000);
});

test('validation errors', async () => {
  const { g, o } = await seed();
  await assert.rejects(repo.createTransaction(g.id, { type: 'expense', title: 'x', amount: 100, paidBy: o, splitType: 'unequal', splits: [{ memberId: o, value: 10 }] }), /add up/);
  await assert.rejects(repo.createTransaction(g.id, { type: 'payment', amount: 10, paidBy: o, to: o }), /different/);
  await assert.rejects(repo.createTransaction(g.id, { type: 'expense', title: '', amount: 10, paidBy: o, splits: [{ memberId: o }] }), /title/);
  await assert.rejects(repo.createTransaction(g.id, { type: 'expense', title: 'x', amount: 10, paidBy: 9999, splits: [{ memberId: o }] }), /who paid/);
  await assert.rejects(repo.createGroup({ name: ' ', myName: 'me' }), /required/);
});

test('group balance: payments in minus expenses out, zero or negative when nothing extra was paid in', () => {
  const exp = (amount: number) => ({ type: 'expense' as const, amount });
  const pay = (amount: number) => ({ type: 'payment' as const, amount });
  assert.deepEqual(groupCashTotals([]), { totalExpenses: 0, totalPayments: 0, balance: 0 });
  assert.deepEqual(groupCashTotals([pay(10000), exp(2500), exp(1500)]), { totalExpenses: 4000, totalPayments: 10000, balance: 6000 });
  assert.equal(groupCashTotals([pay(4000), exp(4000)]).balance, 0, 'everything paid in was spent');
  assert.equal(groupCashTotals([pay(1000), exp(3500)]).balance, -2500, 'overspent → negative');
});

test('group balance: deleted transactions no longer count', async () => {
  const { g, o, b } = await seed();
  const extraId = await repo.createTransaction(g.id, { type: 'payment', amount: 700, paidBy: o, to: b });
  assert.equal((await repo.getGroupSummary(g.id)).totals.groupBalance, 5000 + 70000 - 69000);
  await repo.deleteTransaction(g.id, extraId);
  assert.equal((await repo.getGroupSummary(g.id)).totals.groupBalance, 5000 - 69000);
});

test('transaction time: shown with the date, and with the day it was added when that differs', () => {
  const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime();
  const nb = ' '; // the time never splits across lines
  assert.equal(prettyTime(at(2026, 10, 6, 0, 5)), `12:05${nb}AM`);
  assert.equal(prettyTime(at(2026, 10, 6, 12, 0)), `12:00${nb}PM`);
  assert.equal(prettyTime(at(2026, 10, 6, 15, 42)), `3:42${nb}PM`);
  assert.equal(txWhen('2026-10-06', at(2026, 10, 6, 15, 42)), `6 Oct 2026 · 3:42${nb}PM`);
  assert.equal(txWhen('2026-08-25', at(2026, 10, 6, 9, 7)), `25 Aug 2026 · added 6 Oct 2026, 9:07${nb}AM`, 'back-dated entry');
  assert.equal(txWhen('2026-10-06', null), '6 Oct 2026', 'unknown time: date only');
});

test('transaction time: set once on create, kept on edit, and orders each day newest first', async () => {
  const { g, o, b } = await seed();
  const db = await getDb();
  const txs = await repo.getTransactions(g.id);
  assert.ok(txs.every((t) => typeof t.createdTs === 'number' && t.createdTs > 0), 'new transactions record when they were created');

  // Same date, different creation times (and one unknown): newest first, unknown last.
  const ids: number[] = [];
  for (const title of ['First', 'Second', 'Third', 'Unknown']) {
    ids.push(await repo.createTransaction(g.id, { type: 'expense', title, amount: 10, paidBy: o, splitType: 'equal', splits: [{ memberId: o }, { memberId: b }], date: '2026-11-01' }));
  }
  const base = Date.UTC(2026, 10, 1, 8);
  await db.runAsync('UPDATE transactions SET created_ts = ? WHERE id = ?', [base + 3_600_000, ids[0]!]);
  await db.runAsync('UPDATE transactions SET created_ts = ? WHERE id = ?', [base + 3 * 3_600_000, ids[1]!]);
  await db.runAsync('UPDATE transactions SET created_ts = ? WHERE id = ?', [base + 2 * 3_600_000, ids[2]!]);
  await db.runAsync('UPDATE transactions SET created_ts = NULL WHERE id = ?', [ids[3]!]);
  const day = (await repo.getTransactions(g.id)).filter((t) => t.date === '2026-11-01').map((t) => t.title);
  assert.deepEqual(day, ['Second', 'Third', 'First', 'Unknown']);

  const before = (await repo.getTransactions(g.id)).find((t) => t.id === ids[0])!.createdTs;
  await repo.updateTransaction(g.id, ids[0]!, { type: 'expense', title: 'First (edited)', amount: 20, paidBy: o, splitType: 'equal', splits: [{ memberId: o }, { memberId: b }], date: '2026-11-01' });
  assert.equal((await repo.getTransactions(g.id)).find((t) => t.id === ids[0])!.createdTs, before, 'editing never moves the creation time');
});

test('transaction time: upgrading the app derives it like the server does', async () => {
  const { g, o, b } = await seed();
  const db = await getDb();
  const [edited, untouched] = (await repo.getTransactions(g.id)).slice(0, 2);
  await repo.updateTransaction(g.id, edited!.id, { type: 'payment', amount: 60, paidBy: b, to: o, date: edited!.date });
  const untouchedUpdatedTs = (await db.getFirstAsync<{ updated_ts: number }>('SELECT updated_ts FROM transactions WHERE id = ?', [untouched!.id]))!.updated_ts;

  // Roll back to the schema before creation times existed, then upgrade again.
  await db.execAsync('ALTER TABLE transactions DROP COLUMN created_ts; ALTER TABLE groups DROP COLUMN removal; ALTER TABLE members DROP COLUMN user_id; PRAGMA user_version = 6;');
  await migrate(db);
  const after = Object.fromEntries((await repo.getTransactions(g.id)).map((t) => [t.id, t.createdTs]));
  assert.equal(after[untouched!.id], untouchedUpdatedTs, 'never edited: its last-change time is its creation time');
  assert.equal(after[edited!.id], null, 'edited before the upgrade: creation time unknown, shown as date only');
});

test('edit/delete transaction and members', async () => {
  const { g, o, b, s } = await seed();
  const txs = await repo.getTransactions(g.id);
  const food = txs.find((t) => t.title === 'Food')!;
  await repo.updateTransaction(g.id, food.id, { type: 'expense', title: 'Dinner', amount: 120, paidBy: b, splitType: 'equal', splits: [{ memberId: o }, { memberId: b }, { memberId: s }] });
  const updated = (await repo.getTransactions(g.id)).find((t) => t.id === food.id)!;
  assert.equal(updated.title, 'Dinner');
  assert.deepEqual(updated.splits.map((x) => x.share), [4000, 4000, 4000]);
  await repo.deleteTransaction(g.id, food.id);
  assert.equal((await repo.getTransactions(g.id)).length, 4);
  const z = await repo.addMember(g.id, 'Zain');
  await repo.renameMember(g.id, z, 'Zain A');
  await repo.deleteMember(g.id, z);
  await assert.rejects(repo.deleteMember(g.id, s), /transactions/);
  // "Me" is fixed once chosen (the creator here): it can't be switched, removed or merged away
  await assert.rejects(repo.setMe(g.id, b), /already chosen/);
  await assert.rejects(repo.deleteMember(g.id, o), /remove yourself/);
  await assert.rejects(repo.mergeMembers(g.id, o, b), /merge yourself/);
  assert.equal((await repo.getGroupSummary(g.id)).myMemberId, o);
  await repo.setMe(g.id, o); // choosing the same member again is a no-op
  await repo.deleteGroup(g.id);
  assert.equal((await repo.listGroups()).length, 0);
});

test('members: an older group with no "me" lets you choose once', async () => {
  const { g, o, b } = await seed();
  const db = await getDb();
  await db.runAsync('UPDATE members SET is_me = 0 WHERE group_id = ?', [g.id]);
  assert.equal((await repo.getGroupSummary(g.id)).myMemberId, null);

  await repo.setMe(g.id, b);
  assert.equal((await repo.getGroupSummary(g.id)).myMemberId, b);
  await assert.rejects(repo.setMe(g.id, o), /already chosen/);
});

test('export -> import: the file has no ids and every import is a new group owned by the importer', async () => {
  const { g, b } = await seed();
  const original = await repo.getGroupSummary(g.id);
  const originalRows = await repo.getTransactions(g.id);
  const file = await exportGroup(g.id);
  const text = JSON.stringify(file);
  assert.ok(!text.includes(original.group.uid), 'the group uid is not in the file');
  for (const t of originalRows) assert.ok(!text.includes(t.uid), 'no transaction uid in the file');
  for (const m of original.members) assert.ok(!text.includes(m.memberUid!), 'no member uid in the file');

  const parsed = parseExport(text);
  assert.equal(parsed.groups[0]!.transactions.length, 5);
  const key = parsed.groups[0]!.uid;
  assert.deepEqual(await findNameClashes(parsed), { [key]: true }, 'same name as a group on this phone');

  // Choosing Bilal as me.
  const [copyId] = await importFile(parsed, { meRef: { [key]: b } });
  const copy = await repo.getGroupSummary(copyId!);
  assert.equal(copy.group.name, 'Trip (copy)');
  assert.notEqual(copy.group.uid, original.group.uid, 'a new group uid');
  const copyRows = await repo.getTransactions(copyId!);
  assert.ok(copyRows.every((t) => !originalRows.some((o) => o.uid === t.uid)), 'new transaction uids');
  assert.ok(copy.members.every((m) => !original.members.some((o) => o.memberUid === m.memberUid)), 'new member uids');
  assert.equal(copy.group.creatorId, (await getIdentity()).id, 'the importer owns the new group');
  assert.equal(copy.group.permissionModel, original.group.permissionModel);
  assert.equal(copy.members.find((m) => m.isMe)!.name, 'Bilal');
  assert.deepEqual(copyRows.map((t) => [t.title, t.createdTs, t.authorName]), originalRows.map((t) => [t.title, t.createdTs, t.authorName]), 'history kept');
  assert.deepEqual(copy.stats.map((s) => s.balance), original.stats.map((s) => s.balance));

  // Importing the same file again adds another independent group; the original never changes.
  await importFile(parseExport(text));
  assert.equal((await repo.listGroups()).length, 3);
  assert.deepEqual(await repo.getTransactions(g.id), originalRows, 'original group untouched');

  // A full backup imports as new groups next to the existing ones.
  await importFile(parseExport(JSON.stringify(await exportAll())));
  assert.equal((await repo.listGroups()).length, 6);
  assert.deepEqual(await repo.getTransactions(g.id), originalRows);
});

test('import ignores ids in files from older versions', async () => {
  const { g } = await seed();
  const original = await repo.getGroupSummary(g.id);
  const rows = await repo.getTransactions(g.id);
  // Old exports carried the group, member and transaction uids.
  const old = await exportGroup(g.id);
  old.groups[0]!.uid = original.group.uid;
  old.groups[0]!.members.forEach((m, i) => Object.assign(m, { uid: original.members[i]!.memberUid }));
  old.groups[0]!.transactions.forEach((t, i) => Object.assign(t, { uid: [...rows].reverse()[i]!.uid }));
  const [id] = await importFile(parseExport(JSON.stringify(old)));
  const imported = await repo.getGroupSummary(id!);
  assert.notEqual(imported.group.uid, original.group.uid);
  assert.ok((await repo.getTransactions(id!)).every((t) => !rows.some((o) => o.uid === t.uid)));
  assert.deepEqual(await repo.getTransactions(g.id), rows, 'original group untouched');
});

test('files store normal amounts and import with exact currency precision', async () => {
  const { g } = await seed();
  const file = await exportGroup(g.id);
  assert.equal(file.version, 2);
  const food = file.groups[0]!.transactions.find((t) => t.title === 'Food')!;
  assert.equal(food.amount, 100);
  assert.deepEqual(food.splits.map((s) => [s.value, s.share]), [[50, 50], [30, 30], [20, 20]]);

  const group = (version: number, t: unknown) =>
    JSON.stringify({ format: 'splitmate', version, kind: 'group', groups: [{ uid: 'y', name: 'G', currency: 'PKR', members: [{ ref: 1, name: 'A' }, { ref: 2, name: 'B' }], transactions: [t] }] });
  const tx = { type: 'expense', title: 'Rent', amount: 1500, paidBy: 1, splitType: 'equal', date: '2026-01-01', splits: [{ member: 1, value: 1, share: 750 }, { member: 2, value: 1, share: 750 }] };
  assert.equal(parseExport(group(2, tx)).groups[0]!.transactions[0]!.amount, 150000); // Rs 1,500.00 -> 150000 cents
  assert.equal(parseExport(group(1, tx)).groups[0]!.transactions[0]!.amount, 150000); // Rs 1,500.00 -> 150000 cents
  const largeTx = { ...tx, amount: 15000, splits: [{ member: 1, value: 1, share: 7500 }, { member: 2, value: 1, share: 7500 }] };
  assert.equal(parseExport(group(2, largeTx)).groups[0]!.transactions[0]!.amount, 1500000); // 15,000 -> 1,500,000 cents ($15,000.00)
  const decimals = { ...tx, amount: '1500.50', splits: [{ member: 1, value: 1, share: 750.25 }, { member: 2, value: 1, share: 750.25 }] };
  assert.equal(parseExport(group(2, decimals)).groups[0]!.transactions[0]!.amount, 150050);
  assert.throws(() => parseExport(group(2, { ...tx, amount: 1500.123 })), /2 decimal/);
  assert.throws(() => parseExport(group(2, { ...tx, amount: 0 })), /greater than zero/);
});

test('custom categories', async () => {
  assert.deepEqual(await repo.getCustomCategories(), []);
  await repo.addCustomCategory('  Gym ');
  await repo.addCustomCategory('gym');
  await repo.addCustomCategory('Food'); // built-in, ignored
  assert.deepEqual(await repo.getCustomCategories(), ['Gym']);
  await assert.rejects(repo.addCustomCategory(' '), /name/);
  await repo.removeCustomCategory('Gym');
  assert.deepEqual(await repo.getCustomCategories(), []);
});

test('sample groups', async () => {
  const mine = await repo.createGroup({ name: 'My own', myName: 'Ali' });
  await createSampleGroups('Ali', new Date(2026, 0, 15));
  const groups = await repo.listGroups();
  assert.equal(groups.length, 4);
  const ids = await getSampleGroupIds();
  assert.equal(ids.length, 3);
  for (const id of ids) {
    const s = await repo.getGroupSummary(id);
    assert.equal(s.members.find((m) => m.isMe)!.name, 'Ali');
    assert.ok(s.transactions.length >= 6);
    assert.ok(s.transactions.every((t) => t.date <= '2026-01-15'));
    assert.equal(s.stats.reduce((a, x) => a + x.balance, 0), 0);
  }
  const flat = await repo.getGroupSummary(ids[1]!);
  assert.equal(flat.transactions.filter((t) => t.title === 'Monthly rent').length, 3);
  await removeSampleGroups();
  assert.deepEqual((await repo.listGroups()).map((g) => g.id), [mine.id]);
  assert.deepEqual(await getSampleGroupIds(), []);
});

test('currencies', async () => {
  assert.ok(CURRENCIES.length > 150);
  assert.equal(new Set(CURRENCIES).size, CURRENCIES.length);
  assert.deepEqual(searchCurrencies('lkr').map((c) => c.code), ['LKR']);
  assert.ok(searchCurrencies('rupee').some((c) => c.code === 'NPR'));
  assert.equal(currencySymbol('PKR'), 'Rs ');
  assert.equal(money(150000, 'KES'), 'KSh 1,500.00');
  const g = await repo.createGroup({ name: 'Nairobi', currency: 'KES', myName: 'Me' });
  assert.equal(g.currency, 'KES');
});

test('import accepts group files from older versions that have no transaction author', async () => {
  // Shape of a real export from an earlier app version: no authorId/authorName, some createdTs null.
  const legacy = {
    format: 'splitmate', version: 2, kind: 'group', exportedAt: '2026-10-09T19:54:52.675Z',
    groups: [{
      uid: '1a10608a883-9b4020dc-9da16e50', name: 'Three Man Squad', description: 'Internal khata update', currency: 'PKR', createdAt: '2026-10-04T08:29:53.155Z',
      members: [{ ref: 71, name: 'Ramzan Khan', isMe: true }, { ref: 73, name: 'Ikram', isMe: false }, { ref: 142, name: 'Arslan', isMe: false }],
      transactions: [
        { type: 'expense', title: 'Dinner', amount: 250, paidBy: 71, splitType: 'equal', category: 'Food', note: 'Qurban Hotel', date: '2026-10-03', createdAt: '2026-10-04T08:39:01.119Z', createdTs: null, splits: [{ member: 71, value: 1, share: 125 }, { member: 73, value: 1, share: 125 }] },
        { type: 'expense', title: 'Fuel', amount: 250, paidBy: 71, splitType: 'equal', category: 'Fuel', note: 'Line one\r\nLine two', date: '2026-10-09', createdAt: '2026-10-09T18:53:37.327Z', createdTs: 1791572017326, splits: [{ member: 142, value: 1, share: 250 }] },
      ],
    }],
  };
  const [id] = await importFile(parseExport(JSON.stringify(legacy)));
  const summary = await repo.getGroupSummary(id!);
  assert.equal(summary.members.find((m) => m.isMe)!.name, 'Ramzan Khan');
  const txs = await repo.getTransactions(id!);
  assert.deepEqual(txs.map((t) => t.title).sort(), ['Dinner', 'Fuel']);
  assert.ok(txs.every((t) => t.authorId === '' && t.authorName === ''), 'missing author is stored as unknown, not NULL');
});

test('import rejects bad or malicious files', () => {
  assert.throws(() => parseExport('not json'), /invalid JSON/);
  assert.throws(() => parseExport('{"format":"other"}'), /not a SplitMate/);
  assert.throws(() => parseExport(JSON.stringify({ format: 'splitmate', version: 99, groups: [] })), /newer version/);
  const base = { format: 'splitmate', version: 1, kind: 'group', groups: [{ uid: 'x', name: 'G', currency: 'USD', members: [{ ref: 1, name: 'A' }, { ref: 2, name: 'B' }], transactions: [] as unknown[] }] };
  const withTx = (t: unknown) => JSON.stringify({ ...base, groups: [{ ...base.groups[0], transactions: [t] }] });
  const good = { type: 'expense', title: 'x', amount: 100, paidBy: 1, splitType: 'equal', date: '2026-01-01', splits: [{ member: 1, value: 1, share: 50 }, { member: 2, value: 1, share: 50 }] };
  assert.equal(parseExport(withTx(good)).groups[0]!.transactions.length, 1);
  assert.throws(() => parseExport(withTx({ ...good, splits: [{ member: 1, value: 1, share: 10 }] })), /add up/);
  assert.throws(() => parseExport(withTx({ ...good, paidBy: 7 })), /Unknown payer/);
  assert.throws(() => parseExport(withTx({ ...good, amount: -5 })), /positive amount/);
  assert.throws(() => parseExport(withTx({ ...good, date: "'; DROP TABLE x" })), /date/);
  assert.throws(() => parseExport(withTx({ ...good, type: 'payment' })), /payment/);
  // prototype-pollution style keys are just ignored data
  const evil = JSON.parse(withTx(good));
  evil.__proto__ = { polluted: true };
  parseExport(JSON.stringify(evil));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('insights', async () => {
  const { g } = await seed();
  const groups = [{ id: g.id, name: g.name, currency: g.currency, members: await repo.getMembers(g.id) }];
  const txs = await repo.getTransactions(g.id);
  const today = new Date(2026, 9, 10); // 10 Oct 2026
  const r = computeInsights(groups, txs, 'month', fmt, today);
  assert.equal(r.from, '2026-10-01');
  assert.equal(r.total, 49000); // Hotel 300 + Food 100 + Tickets 90
  assert.equal(r.count, 3);
  assert.equal(r.byCategory[0]!.name, 'Stay');
  assert.equal(r.prevTotal, 20000); // Fuel in September
  assert.equal(r.changePct, 145);
  assert.equal(r.myPaid, 39000);
  assert.equal(r.myShare, 15000);
  const you = r.byPerson.find((p) => p.isMe)!;
  assert.equal(you.categories[0]!.name, 'Stay');
  assert.ok(r.messages.some((m) => m.startsWith('Stay is where most money goes')));
  assert.ok(r.messages.some((m) => m.includes('up 145%')));
  assert.equal(r.byMonth.at(-1)!.amount, 49000);
  assert.equal(r.byMonth.at(-2)!.amount, 20000);
  assert.equal(r.topExpenses[0]!.title, 'Hotel');
  assert.deepEqual(r.byGroup.map((x) => [x.name, x.amount, x.count]), [['Trip', 49000, 3]]);
  assert.deepEqual(r.settled, { amount: 5000, count: 1 });
  const all = computeInsights(groups, txs, 'all', fmt, today);
  assert.equal(all.total, 69000);
  assert.equal(all.changePct, null);
  assert.deepEqual(periodRange('30d', today), { from: '2026-09-11', to: '2026-10-10', days: 30, prev: { from: '2026-08-12', to: '2026-09-10' } });
  const empty = computeInsights(groups, [], 'month', fmt, today);
  assert.equal(empty.total, 0);
  assert.equal(empty.messages.length, 0);
});

test('xlsx writer produces a valid workbook', () => {
  const bytes = buildXlsx([{ name: 'Sum/mary?', rows: [['Title <&>'], ['A', 1.5]], bold: [0] }, { name: 'Sum/mary?', rows: [[1]] }]);
  const files = unzipSync(bytes);
  assert.ok(files['xl/workbook.xml']);
  const wb = strFromU8(files['xl/workbook.xml']!);
  assert.match(wb, /name="Sum mary"/);
  assert.match(wb, /name="Sum mary 2"/);
  assert.match(strFromU8(files['xl/worksheets/sheet1.xml']!), /Title &lt;&amp;&gt;/);
});

test('member types (real vs dummy) and permission-based member addition', async () => {
  // 1. Collaborative group: Creator has userId & isMe; added members are dummy users (userId null)
  const gCollab = await repo.createGroup({ name: 'Collab Group', myName: 'Alice', members: ['Bob'], permissionModel: 'collaborative' });
  const summaryCollab = await repo.getGroupSummary(gCollab.id);
  assert.equal(summaryCollab.canAddMember, true);
  const aliceMem = summaryCollab.members.find((m) => m.name === 'Alice')!;
  const bobMem = summaryCollab.members.find((m) => m.name === 'Bob')!;
  assert.equal(aliceMem.isMe, true);
  assert.ok(aliceMem.userId); // Real user (creator identity)
  assert.equal(bobMem.isMe, false);
  assert.equal(bobMem.userId, undefined); // Dummy user

  // Adding a member in collaborative mode succeeds and creates a dummy user
  const charlieId = await repo.addMember(gCollab.id, 'Charlie');
  const membersAfter = await repo.getMembers(gCollab.id);
  const charlieMem = membersAfter.find((m) => m.id === charlieId)!;
  assert.equal(charlieMem.name, 'Charlie');
  assert.equal(charlieMem.userId, undefined); // Dummy user

  // 2. Contributor group: canAddMember is true for creator, but false for non-creator
  const gContrib = await repo.createGroup({ name: 'Contrib Group', myName: 'Alice', members: ['Bob'], permissionModel: 'contributor' });
  const summaryAdmin = await repo.getGroupSummary(gContrib.id);
  assert.equal(summaryAdmin.canAddMember, true);
  assert.equal(summaryAdmin.isCreator, true);

  // Non-admin permission check
  const nonAdminPerms = repo.getGroupPermissions(gContrib, 'other_user_id');
  assert.equal(nonAdminPerms.canAdd, true); // Can add expenses
  assert.equal(nonAdminPerms.canAddMember, false); // CANNOT add members

  // 4. Default permission model when omitted is 'collaborative'
  const gDefault = await repo.createGroup({ name: 'Default Group', myName: 'Alice', members: ['Bob'] });
  const summaryDefault = await repo.getGroupSummary(gDefault.id);
  assert.equal(summaryDefault.group.permissionModel, 'collaborative');

  // Dummy member merges into real user
  const bobMemDef = summaryDefault.members.find((m) => m.name === 'Bob')!;
  const aliceMemDef = summaryDefault.members.find((m) => m.name === 'Alice')!;
  assert.equal(bobMemDef.userId, undefined); // Dummy
  assert.ok(aliceMemDef.userId); // Real user
  await repo.mergeMembers(gDefault.id, bobMemDef.id, aliceMemDef.id);
  const membersAfterMerge = await repo.getMembers(gDefault.id);
  assert.equal(membersAfterMerge.length, 1);
  assert.equal(membersAfterMerge[0].id, aliceMemDef.id);
});

test('member dashboard: accurate calculation of paid, benefit, payments, and pairwise balances', async () => {
  const g = await repo.createGroup({ name: 'Trip to Dubai', currency: 'AED', myName: 'Ramzan', members: ['Ikram', 'Salman'] });
  const members = await repo.getMembers(g.id);
  const ramzanId = members.find((m) => m.name === 'Ramzan')!.id;
  const ikramId = members.find((m) => m.name === 'Ikram')!.id;
  const salmanId = members.find((m) => m.name === 'Salman')!.id;

  // Expense 1: Ramzan paid AED 2000 split equally among all 3
  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Hotel Booking',
    amount: 2000,
    paidBy: ramzanId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId }, { memberId: ikramId }, { memberId: salmanId }],
    category: 'Accommodation',
    date: '2026-10-09',
  });

  // Expense 2: Ikram paid AED 600 split equally between Ramzan and Ikram
  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Dinner',
    amount: 600,
    paidBy: ikramId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId }, { memberId: ikramId }],
    category: 'Food',
    date: '2026-10-09',
  });

  // Payment 1: Salman paid Ramzan AED 500
  await repo.createTransaction(g.id, {
    type: 'payment',
    title: 'Payment',
    amount: 500,
    paidBy: salmanId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId, value: 1, share: 500 }],
    category: 'Payment',
    date: '2026-10-09',
  });

  const summary = await repo.getGroupSummary(g.id);
  const ramzanStat = summary.stats.find((s) => s.memberId === ramzanId)!;
  const ikramStat = summary.stats.find((s) => s.memberId === ikramId)!;
  const salmanStat = summary.stats.find((s) => s.memberId === salmanId)!;

  // Ramzan:
  // Paid expenses: 2000.00 (200000 cents)
  // Benefit: (2000/3 = 666.67) + (600/2 = 300.00) = 966.67 (96667 cents)
  // Payment received: 500.00 (50000 cents)
  // Net balance = totalPaid (200000) - totalBenefit (96667) + paymentsMade (0) - paymentsReceived (50000) = +53333 cents (+533.33)
  assert.equal(ramzanStat.totalPaid, 200000);
  assert.equal(ramzanStat.totalBenefit, 96667);
  assert.equal(ramzanStat.paymentsReceived, 50000);
  assert.equal(ramzanStat.balance, 53333);

  // Ikram:
  // Paid expenses: 600.00 (60000 cents)
  // Benefit: 666.67 + 300.00 = 966.67 (96667 cents)
  // Net balance = 60000 - 96667 = -36667 cents (-366.67)
  assert.equal(ikramStat.totalPaid, 60000);
  assert.equal(ikramStat.totalBenefit, 96667);
  assert.equal(ikramStat.balance, -36667);

  // Salman:
  // Paid expenses: 0
  // Benefit: 666.67 (66666 cents due to split rounding remainder)
  // Payments made: 500.00 (50000 cents)
  // Net balance = 0 - 66666 + 50000 = -16666 cents (-166.66)
  assert.equal(salmanStat.totalPaid, 0);
  assert.equal(salmanStat.paymentsMade, 50000);
  assert.equal(salmanStat.balance, -16666);

  // Test Member Dashboard Filter lists:
  const txs = summary.transactions;
  const ramzanPaid = txs.filter((t) => t.type === 'expense' && t.paidBy === ramzanId);
  const ramzanShared = txs.filter((t) => t.type === 'expense' && t.splits.some((s) => s.memberId === ramzanId));
  const ramzanPayments = txs.filter((t) => t.type === 'payment' && (t.paidBy === ramzanId || t.splits.some((s) => s.memberId === ramzanId)));
  const ramzanAll = txs.filter((t) => t.paidBy === ramzanId || t.splits.some((s) => s.memberId === ramzanId));

  assert.equal(ramzanPaid.length, 1);
  assert.equal(ramzanShared.length, 2);
  assert.equal(ramzanPayments.length, 1);
  assert.equal(ramzanAll.length, 3);

  // Category shares for Ramzan (Benefit / Share mode):
  const catShares: Record<string, { value: number; count: number }> = {};
  const paidCatShares: Record<string, { value: number; count: number }> = {};

  for (const t of txs) {
    if (t.type === 'expense') {
      // Paid mode
      if (t.paidBy === ramzanId) {
        const cur = paidCatShares[t.category] || { value: 0, count: 0 };
        paidCatShares[t.category] = { value: cur.value + t.amount, count: cur.count + 1 };
      }
      // Share mode
      const sp = t.splits.find((s) => s.memberId === ramzanId);
      if (sp) {
        const cur = catShares[t.category] || { value: 0, count: 0 };
        catShares[t.category] = { value: cur.value + sp.share, count: cur.count + 1 };
      }
    }
  }

  assert.equal(catShares['Accommodation'].value, 66667);
  assert.equal(catShares['Accommodation'].count, 1);
  assert.equal(catShares['Food'].value, 30000);
  assert.equal(catShares['Food'].count, 1);

  const totalCategoryShare = Object.values(catShares).reduce((acc, c) => acc + c.value, 0);
  assert.equal(totalCategoryShare, 96667);
  assert.equal(totalCategoryShare, ramzanStat.totalBenefit);

  // Paid mode breakdown for Ramzan
  assert.equal(paidCatShares['Accommodation'].value, 200000);
  assert.equal(paidCatShares['Accommodation'].count, 1);
  assert.equal(paidCatShares['Food'], undefined); // Ramzan didn't pay for Food

  const totalPaidShare = Object.values(paidCatShares).reduce((acc, c) => acc + c.value, 0);
  assert.equal(totalPaidShare, 200000);
  assert.equal(totalPaidShare, ramzanStat.totalPaid);

  // Category percentage calculations
  const accommodationPct = (catShares['Accommodation'].value / totalCategoryShare) * 100;
  const foodPct = (catShares['Food'].value / totalCategoryShare) * 100;
  assert.equal(Math.round(accommodationPct + foodPct), 100);

  // Filter transactions by selected category
  const filteredByAccommodation = ramzanAll.filter((t) => t.category === 'Accommodation');
  assert.equal(filteredByAccommodation.length, 1);
  assert.equal(filteredByAccommodation[0].title, 'Hotel Booking');

  const filteredByFood = ramzanAll.filter((t) => t.category === 'Food');
  assert.equal(filteredByFood.length, 1);
  assert.equal(filteredByFood[0].title, 'Dinner');
});

test('settlement breakdown: accurately isolates transactions causing person-to-person debt', async () => {
  const g = await repo.createGroup({ name: 'Dubai Tour', currency: 'AED', myName: 'Khan', members: ['Imran', 'Sana'] });
  const members = await repo.getMembers(g.id);
  const khan = members.find((m) => m.name === 'Khan')!;
  const imran = members.find((m) => m.name === 'Imran')!;
  const sana = members.find((m) => m.name === 'Sana')!;

  // 1. Khan pays 300 AED for Dinner (equal split between all 3: 100 AED each)
  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Dinner at Marina',
    amount: 300,
    paidBy: khan.id,
    splitType: 'equal',
    category: 'Food',
    splits: [
      { memberId: khan.id },
      { memberId: imran.id },
      { memberId: sana.id },
    ],
  });

  // 2. Imran pays 50 AED for Taxi, split equally between Khan and Imran (25 AED each)
  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Taxi to Mall',
    amount: 50,
    paidBy: imran.id,
    splitType: 'equal',
    category: 'Travel',
    splits: [
      { memberId: khan.id },
      { memberId: imran.id },
    ],
  });

  const summary = await repo.getGroupSummary(g.id);
  const txs = await repo.getTransactions(g.id);

  // Suggested settlement for Imran -> Khan
  const imranToKhan = summary.settlements.find((s) => s.from === imran.id && s.to === khan.id);
  assert.ok(imranToKhan);
  // Imran owes 100 from dinner, but Khan owes 25 from taxi => net debt is 75 AED (7500 cents)
  assert.equal(imranToKhan.amount, 7500);

  // Test getSettlementCauses
  const { directCauses, directTotal } = getSettlementCauses(imranToKhan, txs);
  assert.equal(directCauses.length, 2);

  const dinnerCause = directCauses.find((c) => c.transaction.title === 'Dinner at Marina');
  assert.ok(dinnerCause);
  assert.equal(dinnerCause.shareAmount, 10000);
  assert.equal(dinnerCause.impact, 10000); // added to debt

  const taxiCause = directCauses.find((c) => c.transaction.title === 'Taxi to Mall');
  assert.ok(taxiCause);
  assert.equal(taxiCause.shareAmount, 2500);
  assert.equal(taxiCause.impact, -2500); // reduced debt

      assert.equal(directTotal, 7500);
      assert.equal(directTotal, imranToKhan.amount);
    });

test('opening a group never deletes transactions that only look alike', async () => {
  const { g } = await seed();
  const db = await getDb();

  // Rows with the same title, amount, date and payer may be separate real expenses; only their uid identifies them.
  const orig = (await repo.getTransactions(g.id)).find((t) => t.title === 'Hotel')!;
  assert.ok(orig);

  // Insert two duplicate ghost rows
  const ghost1 = await db.runAsync(
    'INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, date, author_id, author_name, created_ts, server_version, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)',
    [g.id, 'tx_ghost_1', orig.type, orig.title, orig.amount, orig.paidBy, orig.splitType, orig.category, orig.date, '', '', orig.createdTs, orig.createdAt, orig.updatedAt]
  );
  const ghost2 = await db.runAsync(
    'INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, date, author_id, author_name, created_ts, server_version, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)',
    [g.id, 'tx_ghost_2', orig.type, orig.title, orig.amount, orig.paidBy, orig.splitType, orig.category, orig.date, '', '', orig.createdTs, orig.createdAt, orig.updatedAt]
  );

  // Before deduplication, there are 7 transactions (5 original + 2 ghosts)
  const rawTxs = await db.getAllAsync<{ id: number; title: string }>('SELECT id, title FROM transactions WHERE group_id = ? AND is_deleted = 0', [g.id]);
  assert.equal(rawTxs.length, 7);

  const summary = await repo.getGroupSummary(g.id);
  assert.equal(summary.transactions.length, 7);
  assert.equal(summary.transactions.filter((t) => t.title === 'Hotel').length, 3);
  const outbox = await db.getAllAsync<{ operation: string }>(`SELECT operation FROM outbox_mutations WHERE operation = 'delete'`, []);
  assert.equal(outbox.length, 0, 'reading a group queues no deletes');
});

test('calculateDirectDebts matches pairwise bilateral debts', () => {
  // Scenario matching user's Three Man Squad:
  // Members: Ramzan (id: 1), Arslan (id: 2), Ikram (id: 3)
  // Chai: 200 total paid by Arslan (2), shared equally between Arslan (2) and Ikram (3) -> Ikram owes Arslan 100
  // Delivery: 1240 total paid by Ikram (3), split for Arslan (2) -> Arslan owes Ikram 1240
  // Direct bilateral balance: Arslan owes Ikram (1240 - 100) = 1140.
  const members = [
    { id: 1, name: 'Ramzan' },
    { id: 2, name: 'Arslan' },
    { id: 3, name: 'Ikram' },
  ];

  const transactions = [
    {
      type: 'expense' as const,
      amount: 20000, // 200.00
      paidBy: 2, // Arslan
      splits: [
        { memberId: 2, share: 10000 },
        { memberId: 3, share: 10000 },
      ],
    },
    {
      type: 'expense' as const,
      amount: 124000, // 1240.00
      paidBy: 3, // Ikram
      splits: [
        { memberId: 2, share: 124000 },
      ],
    },
  ];

  const directDebts = calculateDirectDebts(members, transactions);
  assert.equal(directDebts.length, 1);
  assert.equal(directDebts[0]!.from, 2, 'Arslan owes Ikram');
  assert.equal(directDebts[0]!.to, 3, 'Ikram is owed');
  assert.equal(directDebts[0]!.amount, 114000, 'Direct debt should be exactly 1140.00 (114000 cents)');
});

test('editing transaction to exclude 3rd member updates excluded member balance immediately', async () => {
  const g = await repo.createGroup({ name: 'Exclusion Test', currency: 'PKR', myName: 'Ramzan', members: ['Arslan', 'Ikram'] });
  const members = await repo.getMembers(g.id);
  const [ramzan, arslan, ikram] = members;

  // Create an expense with 3 equal shares of 300 PKR (100 PKR each) paid by Ramzan
  const txId = await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Dinner',
    amount: 300,
    paidBy: ramzan!.id,
    splitType: 'equal',
    splits: [{ memberId: ramzan!.id }, { memberId: arslan!.id }, { memberId: ikram!.id }],
    category: 'Food',
    date: '2026-10-10',
  });

  // Check initial balances: Ramzan +200, Arslan -100, Ikram -100
  let summary = await repo.getGroupSummary(g.id);
  let ikramStat = summary.stats.find((s) => s.memberId === ikram!.id)!;
  assert.equal(ikramStat.balance, -10000, 'Ikram owes 100 PKR initially');

  // Edit transaction: exclude Ikram, only Ramzan and Arslan split (150 PKR each)
  await repo.updateTransaction(g.id, txId, {
    type: 'expense',
    title: 'Dinner (2 people)',
    amount: 300,
    paidBy: ramzan!.id,
    splitType: 'equal',
    splits: [{ memberId: ramzan!.id }, { memberId: arslan!.id }],
    category: 'Food',
    date: '2026-10-10',
  });

  // Check updated balances immediately in SQLite getGroupSummary
  summary = await repo.getGroupSummary(g.id);
  ikramStat = summary.stats.find((s) => s.memberId === ikram.id)!;
  const arslanStat = summary.stats.find((s) => s.memberId === arslan.id)!;
  const ramzanStat = summary.stats.find((s) => s.memberId === ramzan.id)!;

  assert.equal(ikramStat.balance, 0, 'Ikram balance must be 0 after being excluded');
  assert.equal(ikramStat.totalBenefit, 0, 'Ikram benefit must be 0 after being excluded');
  assert.equal(arslanStat.balance, -15000, 'Arslan balance must be -150 PKR');
  assert.equal(ramzanStat.balance, 15000, 'Ramzan balance must be +150 PKR');
});

test('onLocalChange notifies multiple subscribers without discarding existing handlers', async () => {
  const g = await repo.createGroup({ name: 'Notification Test', currency: 'PKR', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(g.id);

  let notifiedA = 0;
  let notifiedB = 0;

  const unsubA = onLocalChange((uid) => {
    if (uid === g.uid) notifiedA++;
  });
  const unsubB = onLocalChange((uid) => {
    if (uid === g.uid) notifiedB++;
  });

  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Snacks',
    amount: 50,
    paidBy: alice.id,
    splitType: 'equal',
    splits: [{ memberId: alice.id }, { memberId: bob.id }],
    category: 'Food',
    date: '2026-10-10',
  });

  assert.equal(notifiedA, 1, 'First subscriber was notified');
  assert.equal(notifiedB, 1, 'Second subscriber was notified');

  unsubA();
  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Coffee',
    amount: 20,
    paidBy: alice.id,
    splitType: 'equal',
    splits: [{ memberId: alice.id }, { memberId: bob.id }],
    category: 'Food',
    date: '2026-10-10',
  });

  assert.equal(notifiedA, 1, 'Unsubscribed handler not called again');
  assert.equal(notifiedB, 2, 'Still subscribed handler called');
  unsubB();
});

test('group summary populates directSettlements and matches pairwise direct debt calculation', async () => {
  const g = await repo.createGroup({ name: 'Three Man Squad Test', currency: 'PKR', myName: 'Ramzan Khan', members: ['Ikram', 'Arslan'] });
  const members = await repo.getMembers(g.id);
  const ramzan = members.find((m) => m.name === 'Ramzan Khan')!;
  const ikram = members.find((m) => m.name === 'Ikram')!;
  const arslan = members.find((m) => m.name === 'Arslan')!;

  // 1. Ikram pays 1240 for Arslan
  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Delivery',
    amount: 1240,
    paidBy: ikram.id,
    splitType: 'unequal',
    splits: [{ memberId: arslan.id, value: 1240 }],
    category: 'Food',
    date: '2026-10-10',
  });

  // 2. Arslan pays 200 for Chai (shared between Arslan and Ikram: 100 each)
  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Chai',
    amount: 200,
    paidBy: arslan.id,
    splitType: 'equal',
    splits: [{ memberId: arslan.id }, { memberId: ikram.id }],
    category: 'Food',
    date: '2026-10-10',
  });

  // 3. Ramzan pays 700 for Lunch (shared between Ramzan and Arslan: 350 each)
  await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Lunch',
    amount: 700,
    paidBy: ramzan.id,
    splitType: 'equal',
    splits: [{ memberId: ramzan.id }, { memberId: arslan.id }],
    category: 'Food',
    date: '2026-10-10',
  });

  const summary = await repo.getGroupSummary(g.id);
  assert.ok(summary.directSettlements, 'directSettlements must be populated in group summary');
  assert.ok(summary.directSettlements.length > 0, 'directSettlements must not be empty');

  // Arslan owes Ikram 1240 - 100 = 1140 (114000 cents)
  const arslanToIkram = summary.directSettlements.find((ds) => ds.from === arslan.id && ds.to === ikram.id);
  assert.ok(arslanToIkram, 'Arslan must directly owe Ikram');
  assert.equal(arslanToIkram.amount, 114000, 'Arslan owes Ikram exactly 1140 PKR');

  // Arslan owes Ramzan 350 (35000 cents)
  const arslanToRamzan = summary.directSettlements.find((ds) => ds.from === arslan.id && ds.to === ramzan.id);
  assert.ok(arslanToRamzan, 'Arslan must directly owe Ramzan');
  assert.equal(arslanToRamzan.amount, 35000, 'Arslan owes Ramzan exactly 350 PKR');

  // Check calculations for each member in direct mode:
  // Ikram: total receivable = 114000, total owed = 0 => net direct = +114000 (gets back 1140 PKR)
  const ikramCredits = summary.directSettlements.filter((ds) => ds.to === ikram.id).reduce((s, ds) => s + ds.amount, 0);
  const ikramDebts = summary.directSettlements.filter((ds) => ds.from === ikram.id).reduce((s, ds) => s + ds.amount, 0);
  assert.equal(ikramCredits - ikramDebts, 114000, 'Ikram net direct must be +1140 PKR');

  // Arslan: total receivable = 0, total owed = 114000 + 35000 = 149000 => net direct = -149000 (owes 1490 PKR)
  const arslanCredits = summary.directSettlements.filter((ds) => ds.to === arslan.id).reduce((s, ds) => s + ds.amount, 0);
  const arslanDebts = summary.directSettlements.filter((ds) => ds.from === arslan.id).reduce((s, ds) => s + ds.amount, 0);
  assert.equal(arslanCredits - arslanDebts, -149000, 'Arslan net direct must be -1490 PKR');

  // Ramzan: total receivable = 35000, total owed = 0 => net direct = +35000 (gets back 350 PKR)
  const ramzanCredits = summary.directSettlements.filter((ds) => ds.to === ramzan.id).reduce((s, ds) => s + ds.amount, 0);
  const ramzanDebts = summary.directSettlements.filter((ds) => ds.from === ramzan.id).reduce((s, ds) => s + ds.amount, 0);
  assert.equal(ramzanCredits - ramzanDebts, 35000, 'Ramzan net direct must be +350 PKR');
});




test('settle button: admin settles any row, members only their own, nobody where they cannot add', () => {
  // Three Man Squad: Ramzan 1, Ikram 2, Arslan 3 (rows from the Settle up tab).
  const arslanPaysIkram = { from: 3, to: 2 };
  const ramzanPaysArslan = { from: 1, to: 3 };
  const ikramPaysRamzan = { from: 2, to: 1 };
  const ramzan = { isCreator: false, canAdd: true, myMemberId: 1 };
  assert.equal(canSettle(ramzan, arslanPaysIkram), false, 'not his row');
  assert.equal(canSettle(ramzan, ramzanPaysArslan), true, 'he pays');
  assert.equal(canSettle(ramzan, ikramPaysRamzan), true, 'he receives');

  const admin = { isCreator: true, canAdd: true, myMemberId: 2 };
  assert.ok([arslanPaysIkram, ramzanPaysArslan, ikramPaysRamzan].every((s) => canSettle(admin, s)), 'admin settles every row');

  assert.equal(canSettle({ isCreator: false, canAdd: true, myMemberId: null }, ramzanPaysArslan), false, '"me" not chosen yet');
  assert.equal(canSettle({ isCreator: false, canAdd: false, myMemberId: 1 }, ramzanPaysArslan), false, 'ADMIN_ONLY member cannot record payments');
});
