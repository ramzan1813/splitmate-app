import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestServer } from '../relay/test-support/testServer';

const GROUP = 'grp_integrity';
let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

async function push(mutations: any[], actorId = 'usr_alice') {
  const res = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: { groupUid: GROUP, deviceId: `dev_${actorId}`, actorId, mutations },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.results as any[];
}

const groupCreate = { clientMutationId: 'm_g', entityType: 'group', entityUid: GROUP, operation: 'create', expectedVersion: 0, payload: { name: 'Integrity', creatorId: 'usr_alice' } };
const member = (uid: string, name: string) => ({ clientMutationId: `m_${uid}`, entityType: 'member', entityUid: uid, operation: 'create', expectedVersion: 0, payload: { name } });

async function lastSequence() {
  const { rows } = await server.pglite.query<{ last_sequence: number }>('SELECT last_sequence FROM groups WHERE uid = $1', [GROUP]);
  return rows[0]!.last_sequence;
}

test('integrity: shares that do not sum to the amount are rejected and nothing is written', async () => {
  await push([groupCreate, member('mem_alice', 'Alice')]);
  const before = await lastSequence();

  const [res] = await push([
    {
      clientMutationId: 'm_bad',
      entityType: 'transaction',
      entityUid: 'tx_bad',
      operation: 'create',
      expectedVersion: 0,
      // "Zed" does not exist yet: it would be auto-created if the transaction were accepted.
      payload: { type: 'expense', title: 'Bad', amount: 1000, paidByName: 'Zed', splits: [{ memberName: 'Zed', value: 1, share: 999 }] },
    },
  ]);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.error, 'SPLIT_TOTAL_MISMATCH');
  assert.equal(await lastSequence(), before, 'a rejected mutation must not consume a sequence');

  const members = await server.pglite.query('SELECT 1 FROM group_members WHERE name = $1', ['Zed']);
  assert.equal(members.rows.length, 0, 'auto-created members roll back with the rejected transaction');

  // Retrying the same mutation replays the stored outcome.
  const [replay] = await push([{ clientMutationId: 'm_bad', entityType: 'transaction', entityUid: 'tx_bad', operation: 'create', expectedVersion: 0, payload: {} }]);
  assert.deepEqual(replay, res);
});

test('integrity: payer referenced by name is created as a change-logged member every device receives', async () => {
  await push([groupCreate]);
  const [res] = await push([
    {
      clientMutationId: 'm_tx',
      entityType: 'transaction',
      entityUid: 'tx_1',
      operation: 'create',
      expectedVersion: 0,
      payload: { type: 'expense', title: 'Taxi', amount: 900, paidByName: 'Bob', splits: [{ memberName: 'Bob', value: 1, share: 900 }] },
    },
  ]);
  assert.equal(res.status, 'ACCEPTED');
  const pull = await server.call({ method: 'GET', path: `/sync/changes/${GROUP}`, query: { after: '1' } });
  assert.deepEqual(pull.body.changes.map((c: any) => [c.entityType, c.operation]), [['member', 'create'], ['transaction', 'create']]);
  const memberUid = pull.body.changes[0].entityUid;
  assert.equal(pull.body.changes[1].payload.paidByMemberUid, memberUid);
  assert.equal(pull.body.changes[1].payload.splits[0].memberUid, memberUid);
});

test('integrity: changing the amount without recalculated splits is rejected', async () => {
  await push([groupCreate, member('mem_alice', 'Alice')]);
  await push([
    {
      clientMutationId: 'm_tx',
      entityType: 'transaction',
      entityUid: 'tx_1',
      operation: 'create',
      expectedVersion: 0,
      payload: { type: 'expense', title: 'Hotel', amount: 5000, paidByMemberUid: 'mem_alice', splits: [{ memberUid: 'mem_alice', value: 1, share: 5000 }] },
    },
  ]);
  const [res] = await push([
    { clientMutationId: 'm_upd', entityType: 'transaction', entityUid: 'tx_1', operation: 'update', expectedVersion: 1, payload: { amount: 6000 } },
  ]);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.error, 'SPLITS_REQUIRED');
  const { rows } = await server.pglite.query<{ amount: number; server_version: number }>('SELECT amount, server_version FROM transactions WHERE tx_uid = $1', ['tx_1']);
  assert.deepEqual(rows[0], { amount: 5000, server_version: 1 });
});

test('integrity: a second member with the same name is a CONFLICT, not a silent duplicate', async () => {
  await push([groupCreate, member('mem_bob_1', 'Bob')]);
  const [res] = await push([member('mem_bob_2', ' bob ')], 'usr_bob');
  assert.equal(res.status, 'CONFLICT');
  assert.equal(res.error, 'DUPLICATE_MEMBER_NAME');
  const { rows } = await server.pglite.query('SELECT member_uid FROM group_members WHERE group_uid = $1', [GROUP]);
  assert.equal(rows.length, 1);
});

test('integrity: re-creating an existing group is a CONFLICT that leaves the original untouched', async () => {
  await push([groupCreate]);
  const [res] = await push([{ ...groupCreate, clientMutationId: 'm_g2', payload: { name: 'Hijack', creatorId: 'usr_mallory' } }], 'usr_mallory');
  assert.equal(res.status, 'CONFLICT');
  assert.equal(res.error, 'ALREADY_EXISTS');
  const { rows } = await server.pglite.query<{ name: string; creator_id: string }>('SELECT name, creator_id FROM groups WHERE uid = $1', [GROUP]);
  assert.deepEqual(rows[0], { name: 'Integrity', creator_id: 'usr_alice' });
});

test('integrity: paging reports the last delivered sequence as the cursor, never the group maximum', async () => {
  await push([groupCreate, member('mem_a', 'A'), member('mem_b', 'B'), member('mem_c', 'C'), member('mem_d', 'D')]);

  const seen: number[] = [];
  let after = 0;
  for (let page = 0; page < 10; page++) {
    const res = await server.call({ method: 'GET', path: `/sync/changes/${GROUP}`, query: { after: String(after), limit: '2' } });
    assert.equal(res.status, 200);
    seen.push(...res.body.changes.map((c: any) => c.sequence));
    after = res.body.latestServerSequence;
    if (!res.body.hasMore) break;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5], 'a client using latestServerSequence as its cursor receives every change once');
});

test('integrity: a cursor ahead of the server requires re-bootstrap (409) instead of silently returning nothing', async () => {
  await push([groupCreate]);
  const res = await server.call({ method: 'GET', path: `/sync/changes/${GROUP}`, query: { after: '50' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'CURSOR_AHEAD');
});

test('integrity: concurrent pushes to one group get unique, gap-free sequences', async () => {
  await push([groupCreate]);
  await Promise.all(
    ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => push([member(`mem_${n}`, n)], `usr_${n}`))
  );
  const { rows } = await server.pglite.query<{ sequence: number }>('SELECT sequence FROM sync_changes WHERE group_uid = $1 ORDER BY sequence', [GROUP]);
  assert.deepEqual(rows.map((r) => r.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await lastSequence(), 7);
});

test('integrity: malformed requests get 4xx responses', async () => {
  const noFields = await server.call({ method: 'POST', path: '/sync/push', body: { deviceId: 'd' } });
  assert.equal(noFields.status, 400);
  const badAfter = await server.call({ method: 'GET', path: `/sync/changes/${GROUP}`, query: { after: '-1' } });
  assert.equal(badAfter.status, 400);
  const [shape] = await push([{ clientMutationId: 'm_x', entityType: 'invoice', entityUid: 'x', operation: 'create', payload: {} }]);
  assert.equal(shape.status, 'REJECTED');
  assert.equal(shape.error, 'VALIDATION_ERROR');
  const missing = await server.call({ method: 'GET', path: '/sync/bootstrap/grp_missing' });
  assert.equal(missing.status, 404);
});

test('join page: invite parameters are HTML-escaped', async () => {
  const res = await server.call({ method: 'GET', path: '/join', query: { name: '<script>alert(1)</script>', cur: 'EUR' } });
  assert.equal(res.status, 200);
  assert.ok(!String(res.body).includes('<script>alert(1)</script>'));
  assert.ok(String(res.body).includes('&lt;script&gt;'));
});
