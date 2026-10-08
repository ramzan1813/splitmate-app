import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestServer, TestServer } from '../relay/test-support/testServer';
import { GroupBootstrapResponse, PullChangesResponse, PushMutationsResponse } from '../src/data/types';

let server: TestServer;

// Transactions must name a payer and splits that sum to the amount (minor units).

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

test('server sync api: create group, members, and transaction via POST /sync/push', async () => {
  const pushRes = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_euro_trip',
      deviceId: 'dev_alice_phone',
      actorId: 'usr_alice',
      actorName: 'Alice',
      mutations: [
        {
          clientMutationId: 'mut_grp_1',
          entityType: 'group',
          entityUid: 'grp_euro_trip',
          operation: 'create',
          expectedVersion: 0,
          payload: {
            name: 'Euro Trip 2026',
            currency: 'EUR',
            permissionModel: 'COLLABORATIVE',
            creatorId: 'usr_alice',
            creatorName: 'Alice',
          },
        },
        {
          clientMutationId: 'mut_mem_alice',
          entityType: 'member',
          entityUid: 'mem_alice',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Alice', userId: 'usr_alice', role: 'ADMIN' },
        },
        {
          clientMutationId: 'mut_mem_bob',
          entityType: 'member',
          entityUid: 'mem_bob',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Bob', userId: 'usr_bob', role: 'MEMBER' },
        },
        {
          clientMutationId: 'mut_tx_train',
          entityType: 'transaction',
          entityUid: 'tx_train_1',
          operation: 'create',
          expectedVersion: 0,
          payload: {
            type: 'expense',
            title: 'Train to Rome',
            amount: 14000,
            paidByMemberUid: 'mem_alice',
            splitType: 'equal',
            category: 'Transport',
            date: '2026-10-05',
            splits: [
              { memberUid: 'mem_alice', value: 1, share: 7000 },
              { memberUid: 'mem_bob', value: 1, share: 7000 },
            ],
          },
        },
      ],
    },
  });

  assert.equal(pushRes.status, 200);
  const data = pushRes.body as PushMutationsResponse;
  assert.equal(data.groupUid, 'grp_euro_trip');
  assert.equal(data.results.length, 4);

  // All 4 mutations should be accepted with version 1 and increasing server sequences
  assert.equal(data.results[0]!.status, 'ACCEPTED');
  assert.equal(data.results[0]!.serverVersion, 1);
  assert.equal(data.results[0]!.serverSequence, 1);

  assert.equal(data.results[1]!.status, 'ACCEPTED');
  assert.equal(data.results[1]!.serverSequence, 2);

  assert.equal(data.results[2]!.status, 'ACCEPTED');
  assert.equal(data.results[2]!.serverSequence, 3);

  assert.equal(data.results[3]!.status, 'ACCEPTED');
  assert.equal(data.results[3]!.serverSequence, 4);
});

test('server sync api: bootstrap GET /sync/bootstrap/:groupId returns consistent snapshot and cursor', async () => {
  // 1. Seed group data
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_bootstrap_test',
      deviceId: 'dev_1',
      actorId: 'usr_alice',
      actorName: 'Alice',
      mutations: [
        {
          clientMutationId: 'mut_b_1',
          entityType: 'group',
          entityUid: 'grp_bootstrap_test',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Flat 4B', currency: 'USD', permissionModel: 'COLLABORATIVE', creatorId: 'usr_alice' },
        },
        {
          clientMutationId: 'mut_b_2',
          entityType: 'member',
          entityUid: 'mem_alice_b',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Alice', userId: 'usr_alice', role: 'ADMIN' },
        },
        {
          clientMutationId: 'mut_b_3',
          entityType: 'transaction',
          entityUid: 'tx_wifi_1',
          operation: 'create',
          expectedVersion: 0,
          payload: {
            type: 'expense',
            title: 'WiFi',
            amount: 5000,
            paidByMemberUid: 'mem_alice_b',
            splitType: 'equal',
            date: '2026-10-01',
            splits: [{ memberUid: 'mem_alice_b', value: 1, share: 5000 }],
          },
        },
      ],
    },
  });

  // 2. Fetch bootstrap
  const res = await server.call({
    method: 'GET',
    path: '/sync/bootstrap/grp_bootstrap_test',
  });

  assert.equal(res.status, 200);
  const snap = res.body as GroupBootstrapResponse;
  assert.equal(snap.groupUid, 'grp_bootstrap_test');
  assert.equal(snap.serverSequence, 3);
  assert.equal(snap.group.name, 'Flat 4B');
  assert.equal(snap.members.length, 1);
  assert.equal(snap.transactions.length, 1);
  assert.equal(snap.transactions[0]!.title, 'WiFi');
  assert.equal(snap.transactions[0]!.amount, 5000);
});

test('server sync api: incremental pull GET /sync/changes/:groupId returns only subsequent delta changes', async () => {
  // 1. Create group, payer member and first transaction (Sequence 1, 2 & 3)
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_delta_test',
      deviceId: 'dev_1',
      actorId: 'usr_alice',
      mutations: [
        {
          clientMutationId: 'mut_d_1',
          entityType: 'group',
          entityUid: 'grp_delta_test',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Delta Group', currency: 'USD', creatorId: 'usr_alice' },
        },
        {
          clientMutationId: 'mut_d_m',
          entityType: 'member',
          entityUid: 'mem_alice_d',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Alice' },
        },
        {
          clientMutationId: 'mut_d_2',
          entityType: 'transaction',
          entityUid: 'tx_snack',
          operation: 'create',
          expectedVersion: 0,
          payload: { type: 'expense', title: 'Snacks', amount: 800, date: '2026-10-05', paidByMemberUid: 'mem_alice_d', splits: [{ memberUid: 'mem_alice_d', value: 1, share: 800 }] },
        },
      ],
    },
  });

  // 2. Client has seen up to sequence 3
  let pull1 = await server.call({
    method: 'GET',
    path: '/sync/changes/grp_delta_test',
    query: { after: '3' },
  });
  assert.equal(pull1.status, 200);
  assert.equal((pull1.body as PullChangesResponse).changes.length, 0);

  // 3. New mutation occurs (Sequence 4)
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_delta_test',
      deviceId: 'dev_2',
      actorId: 'usr_bob',
      mutations: [
        {
          clientMutationId: 'mut_d_3',
          entityType: 'transaction',
          entityUid: 'tx_drinks',
          operation: 'create',
          expectedVersion: 0,
          payload: { type: 'expense', title: 'Drinks', amount: 1200, date: '2026-10-05', paidByMemberUid: 'mem_alice_d', splits: [{ memberUid: 'mem_alice_d', value: 1, share: 1200 }] },
        },
      ],
    },
  });

  // 4. Client pulls with after=3 -> receives only sequence 4
  let pull2 = await server.call({
    method: 'GET',
    path: '/sync/changes/grp_delta_test',
    query: { after: '3' },
  });
  assert.equal(pull2.status, 200);
  const delta = pull2.body as PullChangesResponse;
  assert.equal(delta.changes.length, 1);
  assert.equal(delta.changes[0]!.sequence, 4);
  assert.equal(delta.changes[0]!.entityUid, 'tx_drinks');
  assert.equal(delta.latestServerSequence, 4);
});

test('server sync api: update and delete mutations with entity version increment and tombstones', async () => {
  // 1. Initial setup
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_upd_del',
      deviceId: 'dev_1',
      actorId: 'usr_alice',
      mutations: [
        {
          clientMutationId: 'mut_u_1',
          entityType: 'group',
          entityUid: 'grp_upd_del',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Upd Del Group', creatorId: 'usr_alice' },
        },
        {
          clientMutationId: 'mut_u_m',
          entityType: 'member',
          entityUid: 'mem_alice_u',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Alice' },
        },
        {
          clientMutationId: 'mut_u_2',
          entityType: 'transaction',
          entityUid: 'tx_dinner',
          operation: 'create',
          expectedVersion: 0,
          payload: { type: 'expense', title: 'Dinner', amount: 3000, date: '2026-10-05', paidByMemberUid: 'mem_alice_u', splits: [{ memberUid: 'mem_alice_u', value: 1, share: 3000 }] },
        },
      ],
    },
  });

  // 2. Update transaction: expectedVersion = 1 -> Accepted, resultingVersion = 2
  const updateRes = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_upd_del',
      deviceId: 'dev_1',
      actorId: 'usr_alice',
      mutations: [
        {
          clientMutationId: 'mut_u_3',
          entityType: 'transaction',
          entityUid: 'tx_dinner',
          operation: 'update',
          expectedVersion: 1,
          payload: { title: 'Dinner at Italian Place', amount: 3500, splits: [{ memberUid: 'mem_alice_u', value: 1, share: 3500 }] },
        },
      ],
    },
  });

  const updResult = (updateRes.body as PushMutationsResponse).results[0]!;
  assert.equal(updResult.status, 'ACCEPTED');
  assert.equal(updResult.serverVersion, 2);

  // 3. Delete transaction: expectedVersion = 2 -> Accepted, resultingVersion = 3 (Tombstone)
  const delRes = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_upd_del',
      deviceId: 'dev_1',
      actorId: 'usr_alice',
      mutations: [
        {
          clientMutationId: 'mut_u_4',
          entityType: 'transaction',
          entityUid: 'tx_dinner',
          operation: 'delete',
          expectedVersion: 2,
          payload: {},
        },
      ],
    },
  });

  const delResult = (delRes.body as PushMutationsResponse).results[0]!;
  assert.equal(delResult.status, 'ACCEPTED');
  assert.equal(delResult.serverVersion, 3);

  // 4. Verify bootstrap excludes deleted transaction
  const snap = ((await server.call({ method: 'GET', path: '/sync/bootstrap/grp_upd_del' })).body as GroupBootstrapResponse);
  assert.equal(snap.transactions.length, 0);

  // 5. Verify incremental pull includes delete tombstone
  const pull = ((await server.call({ method: 'GET', path: '/sync/changes/grp_upd_del', query: { after: '3' } })).body as PullChangesResponse);
  assert.equal(pull.changes.length, 2);
  assert.equal(pull.changes[0]!.operation, 'update');
  assert.equal(pull.changes[1]!.operation, 'delete');
});

test('server sync api: optimistic concurrency rejects stale update with VERSION_MISMATCH', async () => {
  // 1. Create group and transaction (Version 1)
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_concurrency',
      deviceId: 'dev_alice',
      actorId: 'usr_alice',
      mutations: [
        {
          clientMutationId: 'mut_c_1',
          entityType: 'group',
          entityUid: 'grp_concurrency',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Trip', creatorId: 'usr_alice' },
        },
        {
          clientMutationId: 'mut_c_m',
          entityType: 'member',
          entityUid: 'mem_alice_c',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Alice' },
        },
        {
          clientMutationId: 'mut_c_2',
          entityType: 'transaction',
          entityUid: 'tx_hotel',
          operation: 'create',
          expectedVersion: 0,
          payload: { title: 'Hotel', amount: 10000, date: '2026-10-05', paidByMemberUid: 'mem_alice_c', splits: [{ memberUid: 'mem_alice_c', value: 1, share: 10000 }] },
        },
      ],
    },
  });

  // 2. Alice updates transaction -> Server Version becomes 2
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_concurrency',
      deviceId: 'dev_alice',
      actorId: 'usr_alice',
      mutations: [
        {
          clientMutationId: 'mut_c_3',
          entityType: 'transaction',
          entityUid: 'tx_hotel',
          operation: 'update',
          expectedVersion: 1,
          payload: { title: 'Hotel + Breakfast' },
        },
      ],
    },
  });

  // 3. Bob (who was offline) tries to update with stale expectedVersion = 1 -> Rejected with CONFLICT
  const staleRes = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_concurrency',
      deviceId: 'dev_bob',
      actorId: 'usr_bob',
      mutations: [
        {
          clientMutationId: 'mut_c_4',
          entityType: 'transaction',
          entityUid: 'tx_hotel',
          operation: 'update',
          expectedVersion: 1,
          payload: { title: 'Hotel (Bob Edit)' },
        },
      ],
    },
  });

  const result = (staleRes.body as PushMutationsResponse).results[0]!;
  assert.equal(result.status, 'CONFLICT');
  assert.equal(result.error, 'VERSION_MISMATCH');
  assert.equal(result.serverVersion, 2, 'Response must provide current server version');
});

test('server sync api: duplicate mutation delivery is handled idempotently', async () => {
  // 1. Send first mutation
  const push1 = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_idempotent',
      deviceId: 'dev_1',
      actorId: 'usr_alice',
      mutations: [
        {
          clientMutationId: 'mut_idem_999',
          entityType: 'group',
          entityUid: 'grp_idempotent',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Idempotent Group', creatorId: 'usr_alice' },
        },
      ],
    },
  });

  const res1 = (push1.body as PushMutationsResponse).results[0]!;
  assert.equal(res1.status, 'ACCEPTED');
  assert.equal(res1.serverSequence, 1);

  // 2. Retry sending the exact same mutation with the same clientMutationId
  const push2 = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_idempotent',
      deviceId: 'dev_1',
      actorId: 'usr_alice',
      mutations: [
        {
          clientMutationId: 'mut_idem_999',
          entityType: 'group',
          entityUid: 'grp_idempotent',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Idempotent Group', creatorId: 'usr_alice' },
        },
      ],
    },
  });

  const res2 = (push2.body as PushMutationsResponse).results[0]!;
  assert.equal(res2.status, 'ACCEPTED');
  assert.equal(res2.serverSequence, 1, 'Sequence must not advance on duplicate retransmission');

  // Verify only 1 change log entry exists
  const changes = ((await server.call({ method: 'GET', path: '/sync/changes/grp_idempotent' })).body as PullChangesResponse);
  assert.equal(changes.changes.length, 1);
});

test('server sync api: server-authoritative permissions for ADMIN_ONLY, CONTRIBUTOR, and COLLABORATIVE', async () => {
  // === Test 1: ADMIN_ONLY group ===
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_admin_only',
      deviceId: 'dev_admin',
      actorId: 'usr_admin',
      mutations: [
        {
          clientMutationId: 'mut_p_1',
          entityType: 'group',
          entityUid: 'grp_admin_only',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Admin Only Group', permissionModel: 'ADMIN_ONLY', creatorId: 'usr_admin' },
        },
      ],
    },
  });

  // Non-admin user tries to add expense -> REJECTED
  const unauthRes1 = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_admin_only',
      deviceId: 'dev_guest',
      actorId: 'usr_guest',
      mutations: [
        {
          clientMutationId: 'mut_p_2',
          entityType: 'transaction',
          entityUid: 'tx_guest_expense',
          operation: 'create',
          expectedVersion: 0,
          payload: { title: 'Unauthorized', amount: 500 },
        },
      ],
    },
  });

  const result1 = (unauthRes1.body as PushMutationsResponse).results[0]!;
  assert.equal(result1.status, 'REJECTED');
  assert.equal(result1.error, 'FORBIDDEN');

  // === Test 2: CONTRIBUTOR group ===
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_contrib',
      deviceId: 'dev_admin',
      actorId: 'usr_admin',
      mutations: [
        {
          clientMutationId: 'mut_p_3',
          entityType: 'group',
          entityUid: 'grp_contrib',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Contributor Group', permissionModel: 'CONTRIBUTOR', creatorId: 'usr_admin' },
        },
        {
          clientMutationId: 'mut_p_4',
          entityType: 'transaction',
          entityUid: 'tx_admin_tx',
          operation: 'create',
          expectedVersion: 0,
          payload: { title: 'Admin Tx', amount: 1000, paidByName: 'Admin', splits: [{ memberName: 'Admin', value: 1, share: 1000 }], authorId: 'usr_admin' },
        },
      ],
    },
  });

  // Non-admin contributor tries to edit admin's transaction -> REJECTED
  const unauthRes2 = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_contrib',
      deviceId: 'dev_bob',
      actorId: 'usr_bob',
      mutations: [
        {
          clientMutationId: 'mut_p_5',
          entityType: 'transaction',
          entityUid: 'tx_admin_tx',
          operation: 'update',
          expectedVersion: 1,
          payload: { title: 'Hacked Title' },
        },
      ],
    },
  });

  const result2 = (unauthRes2.body as PushMutationsResponse).results[0]!;
  assert.equal(result2.status, 'REJECTED');
  assert.equal(result2.error, 'FORBIDDEN');

  // === Test 3: COLLABORATIVE group (Delete protection) ===
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_collab',
      deviceId: 'dev_admin',
      actorId: 'usr_admin',
      mutations: [
        {
          clientMutationId: 'mut_p_6',
          entityType: 'group',
          entityUid: 'grp_collab',
          operation: 'create',
          expectedVersion: 0,
          payload: { name: 'Collab Group', permissionModel: 'COLLABORATIVE', creatorId: 'usr_admin' },
        },
        {
          clientMutationId: 'mut_p_7',
          entityType: 'transaction',
          entityUid: 'tx_charlie_tx',
          operation: 'create',
          expectedVersion: 0,
          payload: { title: 'Charlie Tx', amount: 2000, paidByName: 'Admin', splits: [{ memberName: 'Admin', value: 1, share: 2000 }], authorId: 'usr_charlie' },
        },
      ],
    },
  });

  // Bob (not author, not admin) tries to delete Charlie's transaction -> REJECTED
  const unauthRes3 = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_collab',
      deviceId: 'dev_bob',
      actorId: 'usr_bob',
      mutations: [
        {
          clientMutationId: 'mut_p_8',
          entityType: 'transaction',
          entityUid: 'tx_charlie_tx',
          operation: 'delete',
          expectedVersion: 1,
          payload: {},
        },
      ],
    },
  });

  const result3 = (unauthRes3.body as PushMutationsResponse).results[0]!;
  assert.equal(result3.status, 'REJECTED');
  assert.equal(result3.error, 'FORBIDDEN');
});

test('server sync api: transaction creation time is stored once, kept on updates, and sent to every phone', async () => {
  const push = async (mutations: unknown[]) =>
    (await server.call({ method: 'POST', path: '/sync/push', body: { groupUid: 'grp_time', deviceId: 'dev_a', actorId: 'usr_a', actorName: 'Ann', mutations } }))
      .body as PushMutationsResponse;
  const tx = (uid: string, extra: Record<string, unknown> = {}) => ({
    clientMutationId: `mut_${uid}`,
    entityType: 'transaction',
    entityUid: uid,
    operation: 'create',
    expectedVersion: 0,
    payload: {
      type: 'expense',
      title: uid,
      amount: 1000,
      paidByMemberUid: 'mem_ann',
      date: '2026-10-06',
      splits: [{ memberUid: 'mem_ann', value: 1, share: 1000 }],
      ...extra,
    },
  });
  const created = Date.UTC(2026, 9, 6, 9, 30);

  const res = await push([
    { clientMutationId: 'mut_g', entityType: 'group', entityUid: 'grp_time', operation: 'create', expectedVersion: 0, payload: { name: 'Time', currency: 'USD', creatorId: 'usr_a', creatorName: 'Ann' } },
    { clientMutationId: 'mut_m', entityType: 'member', entityUid: 'mem_ann', operation: 'create', expectedVersion: 0, payload: { name: 'Ann' } },
    tx('tx_timed', { createdTs: created }),
    tx('tx_old_app'),
    tx('tx_bad', { createdTs: 'yesterday' }),
  ]);
  assert.deepEqual(res.results.map((r) => r.status), ['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'REJECTED'], 'an invalid time is refused, not replaced');

  // An edit can't move the creation time, and the update change still carries the stored one.
  const upd = await push([
    {
      clientMutationId: 'mut_upd',
      entityType: 'transaction',
      entityUid: 'tx_timed',
      operation: 'update',
      expectedVersion: 1,
      payload: { title: 'Renamed', createdTs: created + 999_999 },
    },
  ]);
  assert.equal(upd.results[0]!.status, 'ACCEPTED');

  const snap = (await server.call({ method: 'GET', path: '/sync/bootstrap/grp_time' })).body as GroupBootstrapResponse;
  const byUid = Object.fromEntries(snap.transactions.map((t) => [t.uid, t.createdTs]));
  assert.deepEqual(byUid, { tx_timed: created, tx_old_app: null }, 'apps that send no time get "unknown", never an invented one');

  const changes = ((await server.call({ method: 'GET', path: '/sync/changes/grp_time', query: { after: '0' } })).body as PullChangesResponse).changes;
  const txChanges = changes.filter((c) => c.entityUid === 'tx_timed').map((c) => [c.operation, (c.payload as { createdTs: unknown }).createdTs]);
  assert.deepEqual(txChanges, [['create', created], ['update', created]]);
});

test('server sync api: upgrading the database derives creation times for existing transactions like phones do', async () => {
  const q = async (sql: string, params: unknown[] = []) => (await server.pglite.query<any>(sql, params as any[])).rows;
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: 'grp_mig', deviceId: 'dev_a', actorId: 'usr_a', actorName: 'Ann',
      mutations: [
        { clientMutationId: 'm_g', entityType: 'group', entityUid: 'grp_mig', operation: 'create', expectedVersion: 0, payload: { name: 'Mig', currency: 'USD', creatorId: 'usr_a', creatorName: 'Ann' } },
        { clientMutationId: 'm_m', entityType: 'member', entityUid: 'mem_ann', operation: 'create', expectedVersion: 0, payload: { name: 'Ann' } },
        ...['tx_untouched', 'tx_edited'].map((uid) => ({
          clientMutationId: `m_${uid}`, entityType: 'transaction', entityUid: uid, operation: 'create', expectedVersion: 0,
          payload: { type: 'expense', title: uid, amount: 500, paidByMemberUid: 'mem_ann', updatedTs: 1_780_000_000_000, splits: [{ memberUid: 'mem_ann', value: 1, share: 500 }] },
        })),
        { clientMutationId: 'm_edit', entityType: 'transaction', entityUid: 'tx_edited', operation: 'update', expectedVersion: 1, payload: { title: 'Edited' } },
      ],
    },
  });
  // Rows written before the column existed.
  await q('UPDATE transactions SET created_ts = NULL');
  await server.pglite.exec(readFileSync('relay/migrations/002_transaction_created_ts.sql', 'utf8'));
  const rows = Object.fromEntries((await q("SELECT tx_uid, created_ts FROM transactions WHERE group_uid = 'grp_mig'")).map((r) => [r.tx_uid, r.created_ts]));
  assert.equal(Number(rows.tx_untouched), 1_780_000_000_000, 'never edited: the creating phone’s timestamp');
  assert.equal(rows.tx_edited, null, 'edited: unknown, matching the phones’ rule');
});
