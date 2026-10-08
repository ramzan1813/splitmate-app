import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { getDb, migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { computeShares, distribute, groupCashTotals, memberStats, suggestSettlements } from '../src/data/logic';
import { exportAll, exportGroup, findExisting, importFile, parseExport } from '../src/data/backup';
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
  await db.execAsync('ALTER TABLE transactions DROP COLUMN created_ts; ALTER TABLE groups DROP COLUMN removal; PRAGMA user_version = 6;');
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

test('export -> import round trip, duplicates and "me"', async () => {
  const { g, b } = await seed();
  const file = await exportGroup(g.id);
  const text = JSON.stringify(file);
  const parsed = parseExport(text);
  assert.equal(parsed.groups[0]!.transactions.length, 5);
  assert.deepEqual(await findExisting(parsed), { [file.groups[0]!.uid]: g.id });

  // import as copy, choosing Bilal as me
  const [copyId] = await importFile(parsed, { onDuplicate: 'copy', meRef: { [file.groups[0]!.uid]: b } });
  assert.deepEqual(
    (await repo.getTransactions(copyId!)).map((t) => [t.title, t.createdTs]),
    (await repo.getTransactions(g.id)).map((t) => [t.title, t.createdTs]),
    'export/import keeps each transaction’s creation time'
  );
  const copy = await repo.getGroupSummary(copyId!);
  assert.equal(copy.group.name, 'Trip (copy)');
  assert.notEqual(copy.group.uid, file.groups[0]!.uid);
  assert.equal(copy.members.find((m) => m.isMe)!.name, 'Bilal');
  assert.deepEqual(copy.stats.map((s) => s.balance), (await repo.getGroupSummary(g.id)).stats.map((s) => s.balance));

  // replace keeps one group with that uid
  await importFile(parsed, { onDuplicate: 'replace' });
  const all = await repo.listGroups();
  assert.equal(all.length, 2);

  // full backup restore with erase
  const backup = await exportAll();
  await importFile(parseExport(JSON.stringify(backup)), { onDuplicate: 'replace', eraseFirst: true });
  assert.equal((await repo.listGroups()).length, 2);
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
