// is_display: rows set to false in the database are never returned by the server, and hiding cascades
// (user -> their groups, transactions and linked members; group -> everything in it; member -> the
// transactions they pay or share; split -> its transaction). Phones keep what they already have.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestServer } from '../relay/test-support/testServer';
import { GroupBootstrapResponse, PullChangesResponse } from '../src/data/types';
import { createNodeDb } from './node-db';
import { migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { HttpSyncTransport, SyncEngine } from '../src/data/syncEngine';

let server: TestServer;
const GROUP = 'grp_display';

beforeEach(async () => {
  server = await startTestServer({ config: { adminApiKey: 'test-admin-key' } });
});

afterEach(async () => {
  await server.close();
});

const sql = async (text: string, params: unknown[] = []) => (await server.pglite.query<any>(text, params as any[])).rows;

async function push(mutations: unknown[], actor = { id: 'usr_ann', name: 'Ann', device: 'dev_ann' }, groupUid = GROUP) {
  const res = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: { groupUid, deviceId: actor.device, actorId: actor.id, actorName: actor.name, mutations },
  });
  assert.equal(res.status, 200);
  return res.body.results as { status: string }[];
}

const member = (uid: string, name: string, userId?: string) => ({
  clientMutationId: `m_${uid}`,
  entityType: 'member',
  entityUid: uid,
  operation: 'create',
  expectedVersion: 0,
  payload: { name, ...(userId ? { userId } : {}) },
});

/** Expense paid by `payer`, split equally between `between` (100 each). */
const expense = (uid: string, payer: string, between: string[]) => ({
  clientMutationId: `m_${uid}`,
  entityType: 'transaction',
  entityUid: uid,
  operation: 'create',
  expectedVersion: 0,
  payload: {
    type: 'expense',
    title: uid,
    amount: 100 * between.length,
    paidByMemberUid: payer,
    splits: between.map((m) => ({ memberUid: m, value: 1, share: 100 })),
  },
});

/** Ann's group: members Ann, Bob (linked to user usr_bob), Cat; tx_ann (Ann+Cat), tx_bob (paid by Bob), tx_shared (Ann+Bob). */
async function seed() {
  const results = await push([
    { clientMutationId: 'm_g', entityType: 'group', entityUid: GROUP, operation: 'create', expectedVersion: 0, payload: { name: 'Display', creatorId: 'usr_ann', creatorName: 'Ann' } },
    member('mem_ann', 'Ann', 'usr_ann'),
    member('mem_bob', 'Bob', 'usr_bob'),
    member('mem_cat', 'Cat'),
    expense('tx_ann', 'mem_ann', ['mem_ann', 'mem_cat']),
    expense('tx_bob', 'mem_bob', ['mem_bob', 'mem_cat']),
    expense('tx_shared', 'mem_ann', ['mem_ann', 'mem_bob']),
  ]);
  assert.ok(results.every((r) => r.status === 'ACCEPTED'));
}

async function bootstrap(groupUid = GROUP) {
  return server.call({ method: 'GET', path: `/sync/bootstrap/${groupUid}` });
}
async function snapshot() {
  const res = await bootstrap();
  assert.equal(res.status, 200);
  const s = res.body as GroupBootstrapResponse;
  return { members: s.members.map((m) => m.uid).sort(), transactions: s.transactions.map((t) => t.uid).sort(), splits: s.transactions.flatMap((t) => t.splits.map((x) => `${t.uid}:${x.memberUid}`)).sort() };
}
async function changes(after = 0) {
  const res = await server.call({ method: 'GET', path: `/sync/changes/${GROUP}`, query: { after: String(after) } });
  assert.equal(res.status, 200);
  return res.body as PullChangesResponse;
}
const changedEntities = async () => (await changes()).changes.map((c) => c.entityUid);

test('is_display: every table has the column, true by default, and pushes keep a sync_users row per account', async () => {
  await seed();
  const tables = ['groups', 'group_members', 'transactions', 'transaction_splits', 'sync_changes', 'client_mutations', 'devices', 'device_group_subscriptions', 'webhook_subscriptions', 'sync_users'];
  // Every data table (schema_migrations is the migration runner's own bookkeeping).
  const baseTables = (await sql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`)).map((r) => r.table_name);
  assert.deepEqual([...baseTables].sort(), [...tables].sort(), 'a new table must get is_display too');
  const cols = await sql(
    `SELECT c.table_name, c.column_default, c.is_nullable FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'is_display' ORDER BY c.table_name`
  );
  assert.deepEqual(cols.map((c) => c.table_name).sort(), [...tables].sort());
  assert.ok(cols.every((c) => c.column_default === 'true' && c.is_nullable === 'NO'));
  for (const t of tables) {
    const [{ hidden }] = await sql(`SELECT count(*)::int AS hidden FROM ${t} WHERE NOT is_display`);
    assert.equal(hidden, 0, `${t}: new rows are displayed`);
  }
  assert.deepEqual(await sql("SELECT user_id, user_name FROM sync_users WHERE user_id = 'usr_ann'"), [{ user_id: 'usr_ann', user_name: 'Ann' }]);
});

test('is_display: a hidden transaction is not returned by download or by the change feed', async () => {
  await seed();
  await sql("UPDATE transactions SET is_display = false WHERE tx_uid = 'tx_ann'");
  assert.deepEqual((await snapshot()).transactions, ['tx_bob', 'tx_shared']);
  assert.ok(!(await changedEntities()).includes('tx_ann'));
  assert.deepEqual((await snapshot()).members, ['mem_ann', 'mem_bob', 'mem_cat'], 'nothing else disappears');
});

test('is_display: a hidden split hides its whole transaction, never half of one', async () => {
  await seed();
  await sql("UPDATE transaction_splits SET is_display = false WHERE transaction_uid = 'tx_shared' AND member_uid = 'mem_bob'");
  const s = await snapshot();
  assert.deepEqual(s.transactions, ['tx_ann', 'tx_bob']);
  assert.ok(!s.splits.some((x) => x.startsWith('tx_shared')));
  assert.ok(!(await changedEntities()).includes('tx_shared'));
});

test('is_display: a hidden member hides them and every transaction they paid or share', async () => {
  await seed();
  await sql("UPDATE group_members SET is_display = false WHERE member_uid = 'mem_bob'");
  const s = await snapshot();
  assert.deepEqual(s.members, ['mem_ann', 'mem_cat']);
  assert.deepEqual(s.transactions, ['tx_ann'], 'tx_bob (Bob paid) and tx_shared (Bob shares) are hidden');
  const feed = await changedEntities();
  for (const hidden of ['mem_bob', 'tx_bob', 'tx_shared']) assert.ok(!feed.includes(hidden), hidden);
});

test('is_display: a hidden user hides the groups they created, transactions they added and members linked to them', async () => {
  await seed();
  // Bob (another account) adds an expense to Ann's group; Ann has a second group.
  await push([expense('tx_by_bob', 'mem_cat', ['mem_ann', 'mem_cat'])], { id: 'usr_bob', name: 'Bob', device: 'dev_bob' });
  await push(
    [
      { clientMutationId: 'm_g2', entityType: 'group', entityUid: 'grp_ann_2', operation: 'create', expectedVersion: 0, payload: { name: 'Second', creatorId: 'usr_ann' } },
    ],
    undefined,
    'grp_ann_2'
  );

  await sql("UPDATE sync_users SET is_display = false WHERE user_id = 'usr_bob'");
  const s = await snapshot();
  assert.ok(!s.members.includes('mem_bob'), 'member linked to the hidden user');
  assert.ok(!s.transactions.includes('tx_by_bob'), 'transaction the hidden user added');
  assert.ok(!s.transactions.includes('tx_bob') && !s.transactions.includes('tx_shared'), 'transactions of their hidden member');
  assert.deepEqual(s.transactions, ['tx_ann']);

  await sql("UPDATE sync_users SET is_display = false WHERE user_id = 'usr_ann'");
  for (const g of [GROUP, 'grp_ann_2']) {
    const res = await bootstrap(g);
    assert.equal(res.status, 404, `${g}: a group created by a hidden user is not returned`);
    assert.equal(res.body.error, 'GROUP_UNAVAILABLE');
  }
});

test('is_display: a hidden group returns nothing, with a code phones do not treat as "deleted"', async () => {
  await seed();
  await sql('UPDATE groups SET is_display = false WHERE uid = $1', [GROUP]);
  for (const path of [`/sync/bootstrap/${GROUP}`, `/sync/changes/${GROUP}`]) {
    const res = await server.call({ method: 'GET', path, query: { after: '0' } });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'GROUP_UNAVAILABLE', 'not GROUP_NOT_FOUND, which would make phones erase their copy');
    assert.ok(!JSON.stringify(res.body).includes('tx_'), 'no data in the error');
  }
  const missing = await bootstrap('grp_never_existed');
  assert.equal(missing.body.error, 'GROUP_NOT_FOUND');
});

test('is_display: the change feed skips hidden changes but its cursor still moves past them', async () => {
  await seed();
  const all = await changes();
  const last = all.latestServerSequence;
  const hiddenSeq = all.changes.find((c) => c.entityUid === 'mem_cat')!.sequence;
  await sql('UPDATE sync_changes SET is_display = false WHERE group_uid = $1 AND sequence = $2', [GROUP, hiddenSeq]);

  const feed = await changes();
  assert.ok(!feed.changes.some((c) => c.sequence === hiddenSeq), 'the hidden change row itself is skipped');
  assert.equal(feed.latestServerSequence, last, 'cursor reaches the end even though a change was skipped');

  // Hide everything after a point: a phone already up to there is told it is up to date, not stuck.
  await sql('UPDATE sync_changes SET is_display = false WHERE group_uid = $1 AND sequence > $2', [GROUP, hiddenSeq]);
  const tail = await changes(hiddenSeq);
  assert.deepEqual(tail.changes, []);
  assert.equal(tail.latestServerSequence, last);
  assert.equal(tail.hasMore, false);

  // Paging: a page holds only visible changes; the cursor is the last one delivered.
  await sql('UPDATE sync_changes SET is_display = true WHERE group_uid = $1', [GROUP]);
  await sql('UPDATE sync_changes SET is_display = false WHERE group_uid = $1 AND sequence = 2', [GROUP]);
  const page = (await server.call({ method: 'GET', path: `/sync/changes/${GROUP}`, query: { after: '0', limit: '2' } })).body as PullChangesResponse;
  assert.deepEqual(page.changes.map((c) => c.sequence), [1, 3]);
  assert.equal(page.latestServerSequence, 3);
  assert.equal(page.hasMore, true);
});

test('is_display: hidden devices, subscriptions and webhooks get no notifications and are not listed', async () => {
  await seed();
  const register = (deviceId: string) =>
    server.call({ method: 'POST', path: '/devices/register', body: { deviceId, actorId: `usr_${deviceId}`, expoPushToken: `ExponentPushToken[${deviceId}]`, groupUids: [GROUP] } });
  await register('dev_shown');
  await register('dev_hidden_device');
  await register('dev_hidden_sub');
  await sql("UPDATE devices SET is_display = false WHERE device_id = 'dev_hidden_device'");
  await sql("UPDATE device_group_subscriptions SET is_display = false WHERE device_id = 'dev_hidden_sub'");
  const listed = await register('dev_hidden_sub');
  assert.deepEqual(listed.body.groupUids, [], 'a hidden subscription is not listed back');

  const hook = await server.call({ method: 'POST', path: `/groups/${GROUP}/webhooks`, headers: { authorization: 'Bearer test-admin-key' }, body: { url: 'https://hooks.example.com/x' } });
  assert.equal(hook.status, 201);
  await sql('UPDATE webhook_subscriptions SET is_display = false');
  const hooks = await server.call({ method: 'GET', path: `/groups/${GROUP}/webhooks`, headers: { authorization: 'Bearer test-admin-key' } });
  assert.deepEqual(hooks.body.webhooks, []);

  server.outbound.length = 0;
  await push([expense('tx_more', 'mem_ann', ['mem_ann'])]);
  await server.settle();
  const pushed = server.outbound.filter((r) => r.url.includes('exp.host')).flatMap((r) => JSON.parse(r.body).map((m: { to: string }) => m.to));
  assert.deepEqual(pushed, ['ExponentPushToken[dev_shown]']);
  assert.equal(server.outbound.filter((r) => r.url.startsWith('https://hooks.example.com')).length, 0, 'hidden webhook not called');
});

test('is_display: writes still work against hidden rows (no crashes, no double-applied retries)', async () => {
  await seed();
  await sql("UPDATE transactions SET is_display = false WHERE tx_uid = 'tx_ann'");
  await sql('UPDATE client_mutations SET is_display = false');
  // Same uid as a hidden transaction: refused cleanly, not a server error.
  const [dup] = await push([{ ...expense('tx_ann', 'mem_ann', ['mem_ann']), clientMutationId: 'm_dup' }]);
  assert.equal(dup!.status, 'CONFLICT');
  // A retried mutation replays its recorded result instead of running again.
  const [retry] = await push([expense('tx_bob', 'mem_bob', ['mem_bob', 'mem_cat'])]);
  assert.equal(retry!.status, 'ACCEPTED');
  assert.equal((await sql("SELECT count(*)::int AS c FROM transactions WHERE tx_uid = 'tx_bob'"))[0].c, 1);
});

test('is_display: a phone that already has the group keeps its copy when the group is hidden', async () => {
  const db = createNodeDb(':memory:');
  await migrate(db);
  setDb(db);
  const engine = new SyncEngine(new HttpSyncTransport(async () => server.baseUrl), undefined, db);
  const group = await repo.createGroup({ name: 'Kept', myName: 'Ann', members: ['Bob'] });
  const [ann, bob] = await repo.getMembers(group.id);
  await repo.createTransaction(group.id, { type: 'expense', title: 'Lunch', amount: 20, paidBy: ann!.id, splitType: 'equal', splits: [{ memberId: ann!.id }, { memberId: bob!.id }] });
  await engine.syncGroup(group.uid);

  await sql('UPDATE groups SET is_display = false WHERE uid = $1', [group.uid]);
  await assert.rejects(engine.syncGroup(group.uid), /not available/);
  assert.deepEqual((await repo.getTransactions(group.id)).map((t) => t.title), ['Lunch'], 'local copy untouched');
  assert.equal((await engine.getGroupSyncStatus(group.uid)).phase, 'error');
});
