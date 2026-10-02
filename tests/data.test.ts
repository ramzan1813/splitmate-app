import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { computeShares, distribute, memberStats, suggestSettlements } from '../src/data/logic';
import { exportAll, exportGroup, findExisting, importFile, parseExport } from '../src/data/backup';
import { computeInsights, periodRange } from '../src/data/insights';
import { buildXlsx } from '../src/lib/xlsx';
import { unzipSync, strFromU8 } from 'fflate';

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
  await repo.setMe(g.id, b);
  assert.equal((await repo.getGroupSummary(g.id)).myMemberId, b);
  await repo.deleteGroup(g.id);
  assert.equal((await repo.listGroups()).length, 0);
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
  assert.throws(() => parseExport(withTx({ ...good, amount: -5 })), /whole number/);
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
