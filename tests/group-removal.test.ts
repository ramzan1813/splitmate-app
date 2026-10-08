// Leaving and deleting groups, against the real server over HTTP:
// a member's leave only removes the group from their phone (after sending their unsent changes);
// the admin's delete erases every record of the group on the server and on every phone.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNodeDb } from './node-db';
import { DB, migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { getSyncNotifications } from '../src/data/sync';
import { getIdentity } from '../src/lib/identity';
import { HttpSyncTransport, SyncEngine, SyncNetworkError } from '../src/data/syncEngine';
import { startTestServer, TestServer } from '../relay/test-support/testServer';

interface Device {
  db: DB;
  engine: SyncEngine;
  url: string;
}

let server: TestServer;
const OFFLINE = 'http://127.0.0.1:9'; // nothing listens here

async function device(): Promise<Device> {
  const db = createNodeDb(':memory:');
  await migrate(db);
  const d: Device = { db, url: '', engine: undefined as unknown as SyncEngine };
  d.url = server.baseUrl;
  d.engine = new SyncEngine(new HttpSyncTransport(async () => d.url), undefined, db);
  return d;
}

function use(d: Device) {
  setDb(d.db);
  return d;
}

const serverCount = async (sql: string, uid: string) => Number((await server.pglite.query<{ c: number }>(sql, [uid])).rows[0]!.c);

/** Every server row that belongs to the group, across all tables. */
async function serverRowsFor(uid: string) {
  return {
    groups: await serverCount('SELECT COUNT(*) AS c FROM groups WHERE uid = $1', uid),
    members: await serverCount('SELECT COUNT(*) AS c FROM group_members WHERE group_uid = $1', uid),
    transactions: await serverCount('SELECT COUNT(*) AS c FROM transactions WHERE group_uid = $1', uid),
    splits: await serverCount('SELECT COUNT(*) AS c FROM transaction_splits s JOIN transactions t ON t.tx_uid = s.transaction_uid WHERE t.group_uid = $1', uid),
    changes: await serverCount('SELECT COUNT(*) AS c FROM sync_changes WHERE group_uid = $1', uid),
    mutations: await serverCount('SELECT COUNT(*) AS c FROM client_mutations WHERE group_uid = $1', uid),
    subscriptions: await serverCount('SELECT COUNT(*) AS c FROM device_group_subscriptions WHERE group_uid = $1', uid),
  };
}
const NOTHING_ON_SERVER = { groups: 0, members: 0, transactions: 0, splits: 0, changes: 0, mutations: 0, subscriptions: 0 };

/** Every local row that belongs to the group, across all tables. */
async function localRowsFor(db: DB, uid: string) {
  const one = async (sql: string, p: unknown[]) => (await db.getFirstAsync<{ c: number }>(sql, p as never[]))!.c;
  return {
    groups: await one('SELECT COUNT(*) AS c FROM groups WHERE uid = ?', [uid]),
    members: await one('SELECT COUNT(*) AS c FROM members m JOIN groups g ON g.id = m.group_id WHERE g.uid = ?', [uid]),
    transactions: await one('SELECT COUNT(*) AS c FROM transactions t JOIN groups g ON g.id = t.group_id WHERE g.uid = ?', [uid]),
    outbox: await one('SELECT COUNT(*) AS c FROM outbox_mutations WHERE group_uid = ?', [uid]),
    syncState: await one('SELECT COUNT(*) AS c FROM sync_state WHERE group_uid = ?', [uid]),
    settings: await one("SELECT COUNT(*) AS c FROM settings WHERE key LIKE '%' || ?", [uid]),
  };
}
const NOTHING_LOCAL = { groups: 0, members: 0, transactions: 0, outbox: 0, syncState: 0, settings: 0 };

/** Alice creates a synced group with one expense; Bob joins it from the server. */
async function aliceAndBob() {
  const a = use(await device());
  const group = await repo.createGroup({ name: 'Flat', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = await repo.getMembers(group.id);
  await repo.createTransaction(group.id, { type: 'expense', title: 'Rent', amount: 900, paidBy: alice!.id, splitType: 'equal', splits: [{ memberId: alice!.id }, { memberId: bob!.id }] });
  await a.engine.syncGroup(group.uid);

  const b = use(await device());
  const bGroupId = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  await b.engine.syncGroup(group.uid);
  return { a, b, group, aGroupId: group.id, bGroupId };
}

const titles = async (gid: number) => (await repo.getTransactions(gid)).map((t) => t.title).sort();

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

test('group removal: only the admin can delete, and the admin cannot leave', async () => {
  const { a, b, aGroupId, bGroupId } = await aliceAndBob();

  use(b);
  const bGroup = await repo.getGroup(bGroupId);
  assert.equal(repo.isGroupAdmin(bGroup, (await getIdentity()).id), false, 'Bob joined: he is a member, not the admin');
  await assert.rejects(repo.deleteGroup(bGroupId), /Only the group admin can delete/);
  assert.equal((await repo.listGroups()).length, 1, 'refused delete changes nothing');

  use(a);
  const aGroup = await repo.getGroup(aGroupId);
  assert.equal(repo.isGroupAdmin(aGroup, (await getIdentity()).id), true);
  await assert.rejects(repo.leaveGroup(aGroupId), /admin of this group. Delete it instead/);
});

test('group removal: a member leaving removes the group from their phone only; they can rejoin', async () => {
  const { a, b, group, aGroupId, bGroupId } = await aliceAndBob();
  const before = await serverRowsFor(group.uid);

  use(b);
  await repo.leaveGroup(bGroupId);
  assert.equal((await repo.listGroups()).length, 0, 'gone from Bob’s list at once');
  assert.deepEqual(await localRowsFor(b.db, group.uid), NOTHING_LOCAL, 'nothing unsent: erased from Bob’s phone immediately');

  // A later trigger for that group (stale notification, "sync all") must not pull it back in.
  await b.engine.syncGroup(group.uid);
  assert.deepEqual(await localRowsFor(b.db, group.uid), NOTHING_LOCAL);

  assert.deepEqual(await serverRowsFor(group.uid), before, 'leaving sends nothing to the server');
  use(a);
  await a.engine.syncGroup(group.uid);
  assert.deepEqual(await titles(aGroupId), ['Rent'], 'Alice still has everything');
  assert.deepEqual((await repo.getMembers(aGroupId)).map((m) => m.name), ['Alice', 'Bob'], 'Bob stays a member of the group');

  // Rejoin with the invite.
  use(b);
  const again = await b.engine.joinGroup(await b.engine.fetchGroupSnapshot(group.uid), 'Bob');
  assert.deepEqual(await titles(again), ['Rent']);
  assert.equal((await repo.getGroupSummary(again)).members.find((m) => m.isMe)?.name, 'Bob');
});

test('group removal: leaving while offline hides the group, sends the unsent expense, then erases it', async () => {
  const { a, b, group, aGroupId, bGroupId } = await aliceAndBob();

  use(b);
  b.url = OFFLINE;
  const bMembers = await repo.getMembers(bGroupId);
  await repo.createTransaction(bGroupId, { type: 'expense', title: 'Groceries', amount: 40, paidBy: bMembers[1]!.id, splitType: 'equal', splits: bMembers.map((m) => ({ memberId: m.id })) });
  await repo.leaveGroup(bGroupId);
  assert.equal((await repo.listGroups()).length, 0, 'hidden at once, even offline');
  assert.equal((await localRowsFor(b.db, group.uid)).outbox, 1, 'the unsent expense is kept until it is delivered');
  await assert.rejects(b.engine.syncGroup(group.uid), SyncNetworkError);
  assert.equal((await localRowsFor(b.db, group.uid)).outbox, 1, 'still queued while offline');

  b.url = server.baseUrl;
  await b.engine.syncAllGroups();
  assert.deepEqual(await localRowsFor(b.db, group.uid), NOTHING_LOCAL, 'delivered, then erased from Bob’s phone');

  use(a);
  await a.engine.syncGroup(group.uid);
  assert.deepEqual(await titles(aGroupId), ['Groceries', 'Rent'], 'Bob’s expense reached the group before he left');
});

test('group removal: the admin’s delete erases every record on the server and on every phone', async () => {
  const { a, b, group, bGroupId } = await aliceAndBob();

  // Bob adds something offline that can never be delivered once the group is gone.
  use(b);
  b.url = OFFLINE;
  const bMembers = await repo.getMembers(bGroupId);
  await repo.createTransaction(bGroupId, { type: 'expense', title: 'Late bill', amount: 15, paidBy: bMembers[1]!.id, splitType: 'equal', splits: bMembers.map((m) => ({ memberId: m.id })) });

  use(a);
  await repo.deleteGroup(group.id);
  assert.equal((await repo.listGroups()).length, 0, 'gone from Alice’s list at once');
  await a.engine.syncGroup(group.uid);
  assert.deepEqual(await serverRowsFor(group.uid), NOTHING_ON_SERVER, 'nothing about the group remains on the server');
  assert.deepEqual(await localRowsFor(a.db, group.uid), NOTHING_LOCAL, 'nothing remains on Alice’s phone');
  for (const path of [`/sync/bootstrap/${group.uid}`, `/sync/changes/${group.uid}`]) {
    const res = await server.call({ method: 'GET', path, query: { after: '0' } });
    assert.equal(res.status, 404);
    assert.equal((res.body as { error: string }).error, 'GROUP_NOT_FOUND');
  }

  // Bob's phone learns on its next sync, erases its copy and says what was lost.
  use(b);
  b.url = server.baseUrl;
  await b.engine.syncGroup(group.uid);
  assert.equal((await repo.listGroups()).length, 0);
  assert.deepEqual(await localRowsFor(b.db, group.uid), NOTHING_LOCAL, 'nothing remains on Bob’s phone');
  const [notice] = await getSyncNotifications(group.uid);
  assert.equal(notice?.title, 'Group deleted');
  assert.match(notice!.message, /"Flat"/);
  assert.match(notice!.message, /1 change from this phone had not synced/, 'Bob is told his unsent change was lost');
  assert.deepEqual(await serverRowsFor(group.uid), NOTHING_ON_SERVER, 'Bob’s phone did not re-upload the deleted group');

  // A second sync is a no-op, and doesn't resurrect it either.
  await b.engine.syncAllGroups();
  assert.deepEqual(await serverRowsFor(group.uid), NOTHING_ON_SERVER);
});

test('group removal: the admin can delete while offline; it is erased everywhere once back online', async () => {
  const { a, group } = await aliceAndBob();

  use(a);
  a.url = OFFLINE;
  await repo.deleteGroup(group.id);
  assert.equal((await repo.listGroups()).length, 0, 'hidden at once');
  await assert.rejects(a.engine.syncGroup(group.uid), SyncNetworkError);
  assert.equal((await serverRowsFor(group.uid)).groups, 1, 'still on the server while Alice is offline');

  a.url = server.baseUrl;
  await a.engine.syncAllGroups();
  assert.deepEqual(await serverRowsFor(group.uid), NOTHING_ON_SERVER);
  assert.deepEqual(await localRowsFor(a.db, group.uid), NOTHING_LOCAL);
});

test('group removal: a delete the server refuses brings the group back with a notice', async () => {
  const { b, group, bGroupId } = await aliceAndBob();
  use(b);
  // Bob's copy wrongly says he is the admin; the server knows better.
  await b.db.runAsync('UPDATE groups SET creator_id = ? WHERE id = ?', [(await getIdentity()).id, bGroupId]);
  await repo.deleteGroup(bGroupId);
  await b.engine.syncGroup(group.uid);

  assert.deepEqual(await titles(bGroupId), ['Rent'], 'group and its expenses are back');
  assert.equal((await serverRowsFor(group.uid)).groups, 1, 'nothing was deleted on the server');
  const notes = await getSyncNotifications(group.uid);
  assert.ok(notes.some((n) => n.title === "Group wasn't deleted" && /Only the group admin/.test(n.message)));
});

test('group removal: groups deleted before this change are erased by the database upgrade', async () => {
  const { group } = await aliceAndBob();
  await server.pglite.query('UPDATE groups SET is_deleted = true WHERE uid = $1', [group.uid]); // the old soft delete
  await server.pglite.exec(readFileSync('relay/migrations/003_erase_deleted_groups.sql', 'utf8'));
  assert.deepEqual(await serverRowsFor(group.uid), NOTHING_ON_SERVER);
});
