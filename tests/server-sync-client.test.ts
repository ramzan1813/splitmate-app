// The app's production HTTP sync path (HttpSyncTransport + SyncEngine) against the real Express
// server over HTTP: retry, backfill of pre-sync groups, joining, conflicts, cursor recovery.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { DB, migrate, setDb } from '../src/data/db';
import { getIdentity } from '../src/lib/identity';
import { buildDuplicateDeletes, findDuplicateTransactions } from '../relay/src/maintenance';
import * as repo from '../src/data/repo';
import { getOutboxCount } from '../src/data/outbox';
import { getSyncState, resetServerSequence } from '../src/data/syncState';
import { getSyncNotifications } from '../src/data/sync';
import { HttpSyncTransport, SyncEngine, SyncNetworkError } from '../src/data/syncEngine';
import { startTestServer, TestServer } from '../relay/test-support/testServer';
import { exportGroup, importFile, parseExport } from '../src/data/backup';

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

// ---------- Existing-data safety: look-alike transactions, partial updates, imports ----------

const expense = (groupId: number, title: string, amount: number, paidBy: number, splitIds: number[], date = '2026-10-09') =>
  repo.createTransaction(groupId, { type: 'expense', title, amount, paidBy, splitType: 'equal', splits: splitIds.map((memberId) => ({ memberId })), date });

const serverTxCount = async (groupUid: string) =>
  Number((await serverRows<{ n: number }>('SELECT count(*)::int AS n FROM transactions WHERE group_uid = $1 AND NOT is_deleted', [groupUid]))[0]!.n);

test('client sync: genuine look-alike expenses (same title, amount and day) are never merged or deleted', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Squad', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  // Two real "Chai 200" on the same day by Alice, as people really enter them.
  await expense(group.id, 'Chai', 200, alice!.id, [alice!.id, bob!.id]);
  await expense(group.id, 'Chai', 200, alice!.id, [alice!.id, bob!.id]);
  await a.engine.syncGroup(group.uid);

  const b = use(await device());
  const bGroupId = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  // Rows synced by older versions have no creation time.
  await b.db.runAsync('UPDATE transactions SET created_ts = NULL', []);
  assert.equal((await repo.getGroupSummary(bGroupId)).transactions.length, 2, 'opening the group keeps both');
  assert.equal((await getOutboxCount(group.uid)).total, 0, 'opening a group never queues deletes');

  // Alice now adds a third "Chai 200" that Bob paid: a different expense with the same title, amount and day.
  use(a);
  await expense(group.id, 'Chai', 200, bob!.id, [alice!.id, bob!.id]);
  await a.engine.syncGroup(group.uid);

  use(b);
  await b.engine.syncGroup(group.uid);
  const bTxs = await repo.getTransactions(bGroupId);
  assert.equal(bTxs.length, 3, 'the pulled expense is added, not merged into a look-alike');
  assert.equal(new Set(bTxs.map((t) => t.uid)).size, 3);
  assert.equal(await serverTxCount(group.uid), 3, 'nothing was deleted on the server');
  use(a);
  assert.equal((await repo.getGroupSummary(group.id)).transactions.length, 3);
});

test('client sync: a partial update from the server changes only the fields it carries', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Flat', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  await expense(group.id, 'Rent', 900, alice!.id, [alice!.id, bob!.id]);
  await a.engine.syncGroup(group.uid);
  const [tx] = await repo.getTransactions(group.id);

  // The server accepts PATCH-style updates; another client renames the expense only.
  const res = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: group.uid,
      deviceId: 'other-client',
      actorId: 'other-user',
      actorName: 'Other',
      mutations: [{ clientMutationId: 'partial-1', entityType: 'transaction', entityUid: tx!.uid, operation: 'update', expectedVersion: 1, payload: { title: 'Rent October' } }],
    },
  });
  assert.equal(res.body.results[0].status, 'ACCEPTED');

  await a.engine.syncGroup(group.uid);
  const [after] = await repo.getTransactions(group.id);
  assert.equal(after!.title, 'Rent October');
  assert.equal(after!.amount, 90000, 'amount kept');
  assert.equal(after!.paidBy, alice!.id, 'payer kept');
  assert.deepEqual(after!.splits.map((s) => s.share).sort(), [45000, 45000], 'splits kept');
  assert.equal(after!.serverVersion, 2);
  assert.equal((await a.engine.getGroupSyncStatus(group.uid)).phase, 'synced');
});

test('client sync: importing a shared group file on another phone creates a separate group and never touches the original', async () => {
  // Phone A (admin) and phone B share "Three"; A exports it and sends the file to C, who is not in the group.
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Three', myName: 'Alice', members: ['Bob', 'Khan'], permissionModel: 'contributor' });
  const [alice, bob] = await repo.getMembers(group.id);
  await expense(group.id, 'Dinner', 250, alice!.id, [alice!.id, bob!.id]);
  await expense(group.id, 'Chai', 160, alice!.id, [alice!.id, bob!.id]);
  await a.engine.syncGroup(group.uid);
  const b = use(await device());
  const bGroupId = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  use(a);
  const text = JSON.stringify(await exportGroup(group.id));
  const serverBefore = await serverRows('SELECT tx_uid, server_version, author_id FROM transactions WHERE group_uid = $1 ORDER BY tx_uid', [group.uid]);
  const sequenceBefore = (await serverRows<{ s: number }>('SELECT last_sequence AS s FROM groups WHERE uid = $1', [group.uid]))[0]!.s;

  // Phone C imports the file as "Khan" and syncs.
  const c = use(await device());
  const parsed = parseExport(text);
  const [cGroupId] = await importFile(parsed, { meRef: { [parsed.groups[0]!.uid]: parsed.groups[0]!.members.find((m) => m.name === 'Khan')!.ref } });
  const cGroup = await repo.getGroupSummary(cGroupId!);
  await c.engine.syncGroup(cGroup.group.uid);

  // The original group is exactly as it was on the server...
  assert.notEqual(cGroup.group.uid, group.uid);
  assert.deepEqual(await serverRows('SELECT tx_uid, server_version, author_id FROM transactions WHERE group_uid = $1 ORDER BY tx_uid', [group.uid]), serverBefore);
  assert.equal((await serverRows<{ s: number }>('SELECT last_sequence AS s FROM groups WHERE uid = $1', [group.uid]))[0]!.s, sequenceBefore, 'no change logged');
  // ...the import is its own group on the server, owned by C...
  const [cServerGroup] = await serverRows<{ creator_id: string; permission_model: string }>('SELECT creator_id, permission_model FROM groups WHERE uid = $1', [cGroup.group.uid]);
  assert.equal(cServerGroup!.creator_id, (await getIdentity()).id, 'the importer is the new group’s admin');
  assert.equal(cServerGroup!.permission_model.toLowerCase(), 'contributor');
  assert.equal(await serverTxCount(cGroup.group.uid), 2);
  assert.equal((await serverRows('SELECT 1 FROM transactions t WHERE t.group_uid = $1 AND t.tx_uid IN (SELECT tx_uid FROM transactions WHERE group_uid = $2)', [cGroup.group.uid, group.uid])).length, 0);
  // ...and phones A and B still see only their two expenses.
  use(a);
  await a.engine.syncGroup(group.uid);
  assert.equal((await repo.getTransactions(group.id)).length, 2);
  use(b);
  await b.engine.syncGroup(group.uid);
  assert.equal((await repo.getTransactions(bGroupId)).length, 2);

  // Importing the same file again on C is a third, separate group; still nothing changes in the original.
  use(c);
  const [again] = await importFile(parseExport(text));
  await c.engine.syncGroup((await repo.getGroupSummary(again!)).group.uid);
  assert.equal(await serverTxCount(group.uid), 2);
});

test('client sync: a server that lost history (restored or new database) gets this phone’s missing data back', async () => {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Restored', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  await expense(group.id, 'Rent', 900, alice!.id, [alice!.id, bob!.id]);
  await a.engine.syncGroup(group.uid);
  await expense(group.id, 'Power', 120, bob!.id, [alice!.id, bob!.id]);
  await a.engine.syncGroup(group.uid);
  const phoneCursor = (await getSyncState(group.uid))!.lastServerSequence;

  // The server's database goes back to before "Power": its row and change are gone, the sequence is lower.
  const [power] = await repo.getTransactions(group.id).then((t) => t.filter((x) => x.title === 'Power'));
  await server.pglite.query('DELETE FROM transaction_splits WHERE transaction_uid = $1', [power!.uid]);
  await server.pglite.query('DELETE FROM transactions WHERE tx_uid = $1', [power!.uid]);
  await server.pglite.query('DELETE FROM sync_changes WHERE entity_uid = $1', [power!.uid]);
  await server.pglite.query('UPDATE groups SET last_sequence = (SELECT max(sequence) FROM sync_changes WHERE group_uid = $1) WHERE uid = $1', [group.uid]);
  assert.ok(Number((await serverRows<{ s: number }>('SELECT last_sequence AS s FROM groups WHERE uid = $1', [group.uid]))[0]!.s) < phoneCursor);

  await a.engine.syncGroup(group.uid); // CURSOR_AHEAD → reconcile → re-upload → replay
  assert.equal((await a.engine.getGroupSyncStatus(group.uid)).phase, 'synced');
  assert.deepEqual(
    (await serverRows<{ title: string }>('SELECT title FROM transactions WHERE group_uid = $1 AND NOT is_deleted ORDER BY title', [group.uid])).map((r) => r.title),
    ['Power', 'Rent'],
    'the expense the server lost is uploaded again'
  );
  const phone = await repo.getTransactions(group.id);
  assert.equal(phone.length, 2, 'no duplicates on the phone');
  assert.equal((await getOutboxCount(group.uid)).total, 0);

  // A second phone joining now sees everything.
  const b = use(await device());
  const bGroupId = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  assert.equal((await repo.getTransactions(bGroupId)).length, 2);
});

test('client sync: phones broken by a v2.1.0 import are repaired, and the server copies are removed through the change log', async () => {
  // Phone A (admin) and phone B share a group with two expenses.
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Squad', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  await expense(group.id, 'Dinner', 250, alice!.id, [alice!.id, bob!.id]);
  await expense(group.id, 'Chai', 160, alice!.id, [alice!.id, bob!.id]);
  await a.engine.syncGroup(group.uid);
  const b = use(await device());
  const bGroupId = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  const bIdentity = await getIdentity();

  // The state a v2.1.0 phone ends up in after importing an old file and later re-syncing:
  //  - the imported rows: uid '' and no author
  //  - the server got them as tx_<local id> (uploaded by Bob)
  //  - the server's create for tx_<local id> came back and was inserted again (lookup by uid failed)
  const originals = await repo.getTransactions(bGroupId);
  const bMembers = await repo.getMembers(bGroupId);
  const imported: number[] = [];
  await b.db.execAsync('DROP INDEX IF EXISTS ux_transactions_group_uid'); // v2.1.0 had no such rule
  for (const t of originals) {
    const r = await b.db.runAsync(
      `INSERT INTO transactions (group_id, type, title, amount, paid_by, split_type, category, note, date, created_ts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [bGroupId, t.type, t.title, t.amount, t.paidBy, t.splitType, t.category, t.note, t.date, t.createdTs ?? null, t.createdAt, t.updatedAt]
    );
    for (const s of t.splits) await b.db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [r.lastInsertRowId, s.memberId, s.value, s.share]);
    imported.push(r.lastInsertRowId);
  }
  const name = (id: number) => bMembers.find((m) => m.id === id)!.name;
  const uploaded = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: group.uid,
      deviceId: 'phone-b',
      actorId: bIdentity.id,
      actorName: 'Bob',
      mutations: originals.map((t, i) => ({
        clientMutationId: `legacy-${i}`,
        entityType: 'transaction',
        entityUid: `tx_${imported[i]}`,
        operation: 'create',
        expectedVersion: 0,
        payload: {
          txUid: `tx_${imported[i]}`, type: t.type, title: t.title, amount: t.amount, paidByName: name(t.paidBy), splitType: t.splitType,
          category: t.category, note: t.note, date: t.date, createdTs: t.createdTs, authorId: bIdentity.id, authorName: 'Bob',
          splits: t.splits.map((s) => ({ memberName: name(s.memberId), value: s.value, share: s.share })),
        },
      })),
    },
  });
  assert.ok(uploaded.body.results.every((r: { status: string }) => r.status === 'ACCEPTED'));
  for (const [i, t] of originals.entries()) {
    const r = await b.db.runAsync(
      `INSERT INTO transactions (group_id, uid, type, title, amount, paid_by, split_type, category, note, date, author_id, author_name, created_ts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Bob', ?, ?, ?)`,
      [bGroupId, `tx_${imported[i]}`, t.type, t.title, t.amount, t.paidBy, t.splitType, t.category, t.note, t.date, bIdentity.id, t.createdTs ?? null, t.createdAt, t.updatedAt]
    );
    for (const s of t.splits) await b.db.runAsync('INSERT INTO transaction_splits (transaction_id, member_id, value, share) VALUES (?, ?, ?, ?)', [r.lastInsertRowId, s.memberId, s.value, s.share]);
  }
  assert.equal((await repo.getTransactions(bGroupId)).length, 6, 'phone B shows each expense three times');
  assert.equal((await repo.getTransactions(bGroupId)).filter((t) => !t.authorName).length, 2, 'two copies without "added by"');
  assert.equal(await serverTxCount(group.uid), 4, 'the server has each expense twice');

  // The app update: local migration 10 runs once.
  await b.db.execAsync('PRAGMA user_version = 9');
  await migrate(b.db);
  const repaired = await repo.getTransactions(bGroupId);
  assert.equal(repaired.length, 4, 'one row per server transaction');
  assert.ok(repaired.every((t) => t.uid && t.authorName), 'no empty ids, every row has its author');
  assert.equal(new Set(repaired.map((t) => t.uid)).size, 4);
  assert.equal((await getSyncState(group.uid))!.lastServerSequence, 0, 'history replays on the next sync');
  await b.engine.syncGroup(group.uid);
  assert.equal((await repo.getTransactions(bGroupId)).length, 4);
  assert.equal(await serverTxCount(group.uid), 4, 'nothing re-uploaded');

  // Server cleanup: the copies are deleted as ordinary deletes, so both phones learn about them.
  const report = await findDuplicateTransactions({ query: async (sql, params) => (await server.pglite.query(sql, params as any[])).rows as any[] });
  assert.equal(report.copies.length, 2);
  assert.ok(report.copies.every((c) => c.keep.authorName === 'Alice' && c.remove.length === 1 && c.remove[0]!.authorName === 'Bob'), 'the first upload is kept');
  for (const req of buildDuplicateDeletes(report.copies)) {
    const res = await server.call({ method: 'POST', path: '/sync/push', body: req });
    assert.ok(res.body.results.every((r: { status: string }) => r.status === 'ACCEPTED'), JSON.stringify(res.body));
  }
  // Running it again changes nothing.
  assert.equal((await findDuplicateTransactions({ query: async (sql, params) => (await server.pglite.query(sql, params as any[])).rows as any[] })).copies.length, 0);

  await b.engine.syncGroup(group.uid);
  use(a);
  await a.engine.syncGroup(group.uid);
  const aView = (await repo.getTransactions(group.id)).map((t) => [t.uid, t.title, t.authorName]).sort();
  use(b);
  const bView = (await repo.getTransactions(bGroupId)).map((t) => [t.uid, t.title, t.authorName]).sort();
  assert.equal(aView.length, 2);
  assert.deepEqual(aView, bView, 'both phones show the same two expenses, added by Alice');
  assert.equal(await serverTxCount(group.uid), 2);
});
