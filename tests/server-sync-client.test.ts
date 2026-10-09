// The app's production HTTP sync path (HttpSyncTransport + SyncEngine) against the real Express
// server over HTTP: retry, backfill of pre-sync groups, joining, conflicts, cursor recovery.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { DB, migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { getOutboxCount } from '../src/data/outbox';
import { getSyncState, resetServerSequence } from '../src/data/syncState';
import { getSyncNotifications } from '../src/data/sync';
import { HttpSyncTransport, SyncEngine, SyncNetworkError } from '../src/data/syncEngine';
import { startTestServer, TestServer } from '../relay/test-support/testServer';

interface Device {
  db: DB;
  engine: SyncEngine;
  /** Base URL this device's transport talks to (switchable to simulate going offline). */
  url: string;
}

let server: TestServer;

async function device(): Promise<Device> {
  const db = createNodeDb(':memory:');
  await migrate(db);
  const d: Device = { db, url: '', engine: undefined as unknown as SyncEngine };
  d.url = server.baseUrl;
  d.engine = new SyncEngine(new HttpSyncTransport(async () => d.url), undefined, db);
  return d;
}

/** Repository functions use the global DB; point it at the device we act as. */
function use(d: Device) {
  setDb(d.db);
  return d;
}

const serverRows = async <T = any>(sql: string, params: unknown[] = []) => (await server.pglite.query<T>(sql, params as any[])).rows;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

test('client sync: a push that cannot reach the server stays queued and is delivered by the next sync', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Trip', myName: 'Alice', members: ['Bob'] });

  a.url = 'http://127.0.0.1:9'; // nothing listens here
  await assert.rejects(a.engine.syncGroup(group.uid), SyncNetworkError);
  const offline = await a.engine.getGroupSyncStatus(group.uid);
  assert.equal(offline.phase, 'offline');
  assert.ok(offline.pending >= 3, 'group + two members still queued');
  assert.equal((await getOutboxCount(group.uid)).failed, 0, 'a network error is not a permanent failure');

  a.url = server.baseUrl;
  const res = await a.engine.syncGroup(group.uid);
  assert.ok(res.pushed >= 3);
  assert.equal((await getOutboxCount(group.uid)).total, 0);
  assert.equal((await a.engine.getGroupSyncStatus(group.uid)).phase, 'synced');
  assert.equal((await serverRows('SELECT name FROM groups WHERE uid = $1', [group.uid]))[0]?.name, 'Trip');
});

test('client sync: a group created before the sync engine is uploaded in full on first sync', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Old Flat', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  await repo.createTransaction(group.id, { type: 'expense', title: 'Rent', amount: 900, paidBy: alice!.id, splitType: 'equal', splits: [{ memberId: alice!.id }, { memberId: bob!.id }] });
  // Simulate a pre-v2 install: nothing queued, no upload marker, edits bumped local versions.
  await a.db.runAsync('DELETE FROM outbox_mutations', []);
  await a.db.runAsync(`DELETE FROM settings WHERE key LIKE 'sync.uploaded.%'`, []);
  await a.db.runAsync('UPDATE transactions SET server_version = 4', []);

  await a.engine.syncGroup(group.uid);

  const txs = await serverRows<{ title: string; amount: number }>('SELECT title, amount FROM transactions WHERE group_uid = $1', [group.uid]);
  assert.deepEqual(txs, [{ title: 'Rent', amount: 90000 }]);
  assert.equal((await serverRows('SELECT 1 FROM group_members WHERE group_uid = $1 AND is_deleted = false', [group.uid])).length, 2);

  // Local versions now match the server, so a later edit is accepted rather than conflicting.
  const tx = (await repo.getTransactions(group.id))[0]!;
  await repo.updateTransaction(group.id, tx.id, { type: 'expense', title: 'Rent', amount: 950, paidBy: alice!.id, splitType: 'equal', splits: [{ memberId: alice!.id }, { memberId: bob!.id }] });
  const res = await a.engine.syncGroup(group.uid);
  assert.equal(res.conflicts, 0);
  assert.equal((await serverRows<{ amount: number }>('SELECT amount FROM transactions WHERE group_uid = $1', [group.uid]))[0]?.amount, 95000);
});

test('client sync: a second phone joins from the server and both see each other’s expenses', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Dinner Club', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  await repo.createTransaction(group.id, { type: 'expense', title: 'Pizza', amount: 30, paidBy: alice!.id, splitType: 'equal', splits: [{ memberId: alice!.id }, { memberId: bob!.id }] });
  await a.engine.syncGroup(group.uid);

  const b = use(await device());
  const snapshot = await b.engine.fetchGroupSnapshot(group.uid);
  const bGroupId = await b.engine.joinGroup(snapshot, 'Bob');
  const bSummary = await repo.getGroupSummary(bGroupId);
  assert.equal(bSummary.totals.totalExpenses, 3000);
  const bMe = bSummary.members.find((m) => m.isMe);
  assert.equal(bMe?.name, 'Bob', 'joining as an existing member binds "me" to it');
  assert.equal(bSummary.members.length, 2, 'no duplicate member created on join');

  await repo.createTransaction(bGroupId, { type: 'expense', title: 'Drinks', amount: 12, paidBy: bMe!.id, splitType: 'equal', splits: bSummary.members.map((m) => ({ memberId: m.id })) });
  await b.engine.syncGroup(group.uid);

  use(a);
  const pulled = await a.engine.syncGroup(group.uid);
  assert.equal(pulled.pulled, 1);
  const aSummary = await repo.getGroupSummary(group.id);
  assert.equal(aSummary.totals.totalExpenses, 4200);
  const notes = await getSyncNotifications(group.uid);
  assert.ok(notes.some((n) => n.message.includes('Drinks')), 'the other member’s expense is announced');
});

test('client sync: concurrent edits conflict visibly and the user can take the server version', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Ski', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  const splits = [{ memberId: alice!.id }, { memberId: bob!.id }];
  await repo.createTransaction(group.id, { type: 'expense', title: 'Lift pass', amount: 100, paidBy: alice!.id, splitType: 'equal', splits });
  await a.engine.syncGroup(group.uid);

  const b = use(await device());
  const bGroupId = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  await b.engine.syncGroup(group.uid);

  // Both edit the same expense from the same version.
  use(a);
  const aTx = (await repo.getTransactions(group.id))[0]!;
  await repo.updateTransaction(group.id, aTx.id, { type: 'expense', title: 'Lift pass', amount: 120, paidBy: alice!.id, splitType: 'equal', splits });
  use(b);
  const bMembers = await repo.getMembers(bGroupId);
  const bTx = (await repo.getTransactions(bGroupId))[0]!;
  await repo.updateTransaction(bGroupId, bTx.id, { type: 'expense', title: 'Lift pass', amount: 80, paidBy: bMembers[0]!.id, splitType: 'equal', splits: bMembers.map((m) => ({ memberId: m.id })) });

  use(a);
  assert.equal((await a.engine.syncGroup(group.uid)).conflicts, 0);
  use(b);
  const bRes = await b.engine.syncGroup(group.uid);
  assert.equal(bRes.conflicts, 1);
  const status = await b.engine.getGroupSyncStatus(group.uid);
  assert.equal(status.phase, 'conflict');
  assert.equal(status.unresolved, 1, 'the refused edit is kept, not discarded');
  assert.equal((await repo.getTransactions(bGroupId))[0]!.amount, 12000, 'the other member’s accepted edit is shown');

  await b.engine.acceptServerVersion(group.uid);
  assert.equal((await b.engine.getGroupSyncStatus(group.uid)).phase, 'synced');
  assert.equal((await getOutboxCount(group.uid)).total, 0);
  assert.equal((await repo.getTransactions(bGroupId))[0]!.amount, 12000);
  assert.equal((await repo.getGroupSummary(bGroupId)).members.find((m) => m.isMe)?.name, 'Bob', '"me" survives the rebuild');
});

test('client sync: two phones adding the same member name end up with one member', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Band', myName: 'Alice', members: ['Bob'] });
  await a.engine.syncGroup(group.uid);
  const b = use(await device());
  const bGroupId = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  await b.engine.syncGroup(group.uid);

  use(a);
  await repo.addMember(group.id, 'Dave');
  await a.engine.syncGroup(group.uid);
  use(b);
  await repo.addMember(bGroupId, 'Dave');
  const res = await b.engine.syncGroup(group.uid);

  assert.equal(res.conflicts, 0);
  const daveOnB = (await repo.getMembers(bGroupId)).filter((m) => m.name === 'Dave');
  assert.equal(daveOnB.length, 1);
  const daveOnServer = await serverRows<{ member_uid: string }>(`SELECT member_uid FROM group_members WHERE group_uid = $1 AND name = 'Dave'`, [group.uid]);
  assert.equal(daveOnServer.length, 1);
  assert.equal(daveOnB[0]!.uid, daveOnServer[0]!.member_uid, 'the phone adopts the server’s member id');
});

test('client sync: merging members is sent to the server', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'House', myName: 'Alice', members: ['Bob', 'Robert'] });
  const members = await repo.getMembers(group.id);
  const [alice, bob, robert] = members;
  await repo.createTransaction(group.id, { type: 'expense', title: 'Groceries', amount: 60, paidBy: robert!.id, splitType: 'equal', splits: members.map((m) => ({ memberId: m.id })) });
  await a.engine.syncGroup(group.uid);

  await repo.mergeMembers(group.id, robert!.id, bob!.id);
  const res = await a.engine.syncGroup(group.uid);
  assert.equal(res.conflicts, 0);

  const live = await serverRows<{ name: string }>('SELECT name FROM group_members WHERE group_uid = $1 AND is_deleted = false ORDER BY name', [group.uid]);
  assert.deepEqual(live.map((m) => m.name), ['Alice', 'Bob']);
  const bobUid = (await repo.getMembers(group.id)).find((m) => m.id === bob!.id)!.uid;
  const [tx] = await serverRows<{ paid_by_member_uid: string }>('SELECT paid_by_member_uid FROM transactions WHERE group_uid = $1', [group.uid]);
  assert.equal(tx?.paid_by_member_uid, bobUid);
  const shares = await serverRows<{ member_uid: string; share: number }>('SELECT member_uid, share FROM transaction_splits ORDER BY member_uid', []);
  assert.equal(shares.reduce((s, r) => s + r.share, 0), 6000, 'shares still add up to the amount');
  assert.equal(shares.length, 2);
  assert.ok(alice);
});

test('client sync: a cursor ahead of the server replays the change log instead of failing', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Reset', myName: 'Alice', members: ['Bob'] });
  await a.engine.syncGroup(group.uid);
  const seq = (await getSyncState(group.uid))!.lastServerSequence;

  await resetServerSequence(group.uid, seq + 500);
  await a.engine.syncGroup(group.uid);
  assert.equal((await getSyncState(group.uid))!.lastServerSequence, seq);
  assert.equal((await a.engine.getGroupSyncStatus(group.uid)).phase, 'synced');
});

test('client sync: a write made while a sync is running is pushed by the same call', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Busy', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);

  const first = a.engine.syncGroup(group.uid);
  await repo.createTransaction(group.id, { type: 'expense', title: 'Taxi', amount: 15, paidBy: alice!.id, splitType: 'equal', splits: [{ memberId: alice!.id }, { memberId: bob!.id }] });
  const second = a.engine.syncGroup(group.uid); // joins the running sync and requests another cycle
  await Promise.all([first, second]);

  assert.equal((await getOutboxCount(group.uid)).total, 0);
  assert.equal((await serverRows('SELECT 1 FROM transactions WHERE group_uid = $1', [group.uid])).length, 1);
});

test('client sync: every phone shows the same creation time and order, including offline adds and edits', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 50)); // distinct millisecond timestamps
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Times', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  const splits = [{ memberId: alice!.id }, { memberId: bob!.id }];
  const add = (gid: number, title: string, paidBy: number, s = splits) =>
    repo.createTransaction(gid, { type: 'expense', title, amount: 10, paidBy, splitType: 'equal', splits: s, date: '2026-10-06' });
  await add(group.id, 'Breakfast', alice!.id);
  await tick();
  await add(group.id, 'Lunch', alice!.id);
  await a.engine.syncGroup(group.uid);

  const b = use(await device());
  const bGroupId = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  const bMembers = await repo.getMembers(bGroupId);
  // Bob adds one while offline; it reaches the server much later.
  b.url = 'http://127.0.0.1:9';
  await tick();
  await add(bGroupId, 'Dinner', bMembers[1]!.id, bMembers.map((m) => ({ memberId: m.id })));
  await assert.rejects(b.engine.syncGroup(group.uid), SyncNetworkError);
  b.url = server.baseUrl;
  await tick();
  await b.engine.syncGroup(group.uid);

  // Bob edits Alice's breakfast: the creation time must not move.
  const bBreakfast = (await repo.getTransactions(bGroupId)).find((t) => t.title === 'Breakfast')!;
  await repo.updateTransaction(bGroupId, bBreakfast.id, { type: 'expense', title: 'Brunch', amount: 10, paidBy: bMembers[0]!.id, splitType: 'equal', splits: bMembers.map((m) => ({ memberId: m.id })) });
  await b.engine.syncGroup(group.uid);
  const bView = (await repo.getTransactions(bGroupId)).map((t) => [t.uid, t.title, t.createdTs]);

  use(a);
  await a.engine.syncGroup(group.uid);
  const aView = (await repo.getTransactions(group.id)).map((t) => [t.uid, t.title, t.createdTs]);

  assert.deepEqual(aView.map((r) => r[1]), ['Dinner', 'Lunch', 'Brunch'], 'same day: newest first');
  assert.ok(aView.every((r) => typeof r[2] === 'number' && r[2] > 0), 'every transaction has a real creation time');
  assert.deepEqual(aView, bView, 'both phones agree on every time and on the order');
  assert.equal(aView[2]![2], bBreakfast.createdTs, 'editing kept the original creation time');
  for (const [uid, , ts] of aView) {
    const [row] = await serverRows<{ created_ts: number }>('SELECT created_ts FROM transactions WHERE tx_uid = $1', [uid]);
    assert.equal(row!.created_ts, ts, 'the server stores the creating phone’s time');
  }

  // Re-downloading the group from the server keeps the times.
  use(b);
  await b.engine.acceptServerVersion(group.uid);
  assert.deepEqual((await repo.getTransactions((await repo.listGroups())[0]!.id)).map((t) => [t.uid, t.title, t.createdTs]), aView);
});
