import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { migrate, setDb, getDb, DB } from '../src/data/db';
import * as repo from '../src/data/repo';
import { getDeviceId } from '../src/lib/identity';
import { getPendingOutboxMutations, getOutboxCount, getOutboxMutationsByStatus, enqueueOutboxMutation } from '../src/data/outbox';
import { getSyncState } from '../src/data/syncState';
import { startTestServer, TestServer } from '../relay/test-support/testServer';
import { SyncEngine, SyncTransport } from '../src/data/syncEngine';
import {
  GroupBootstrapResponse,
  PullChangesResponse,
  PushMutationsRequest,
  PushMutationsResponse,
} from '../src/data/types';

/** Test Sync Transport connecting the mobile SyncEngine to the Express backend over HTTP */
class DirectServerSyncTransport implements SyncTransport {
  constructor(private server: TestServer) {}

  async push(request: PushMutationsRequest): Promise<PushMutationsResponse> {
    const res = await this.server.call({
      method: 'POST',
      path: '/sync/push',
      body: request,
    });
    if (res.status >= 400) {
      throw new Error(`Push failed with status ${res.status}: ${JSON.stringify(res.body)}`);
    }
    return res.body as PushMutationsResponse;
  }

  async pull(groupUid: string, afterSequence: number, limit = 100): Promise<PullChangesResponse> {
    const res = await this.server.call({
      method: 'GET',
      path: `/sync/changes/${groupUid}`,
      query: { after: String(afterSequence), limit: String(limit) },
    });
    if (res.status >= 400) {
      throw new Error(`Pull failed with status ${res.status}`);
    }
    return res.body as PullChangesResponse;
  }

  async bootstrap(groupUid: string): Promise<GroupBootstrapResponse> {
    const res = await this.server.call({
      method: 'GET',
      path: `/sync/bootstrap/${groupUid}`,
    });
    if (res.status >= 400) {
      throw new Error(`Bootstrap failed with status ${res.status}`);
    }
    return res.body as GroupBootstrapResponse;
  }
}

let server: TestServer;
let clientDb: DB;
let transport: DirectServerSyncTransport;
let engine: SyncEngine;

beforeEach(async () => {
  server = await startTestServer();
  clientDb = createNodeDb(':memory:');
  await migrate(clientDb);
  setDb(clientDb);

  transport = new DirectServerSyncTransport(server);
  engine = new SyncEngine(transport);
});

afterEach(async () => {
  await server.close();
});

/** Reads the backend Postgres (PGlite) directly to assert server-side state. */
async function serverRows<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await server.pglite.query<T>(sql, params as any[])).rows;
}

test('mobile sync engine: 1. offline create keeps local SQLite responsive with pending outbox records', async () => {
  // Mobile client is offline
  engine.setOnline(false);
  assert.equal(engine.isOnline(), false);

  // User creates group and adds expense while offline
  const group = await repo.createGroup({ name: 'Ski Trip 2026', myName: 'Alice', members: ['Bob'] });
  const members = await repo.getMembers(group.id);
  const alice = members.find((m) => m.name === 'Alice')!;
  const bob = members.find((m) => m.name === 'Bob')!;

  const txId = await repo.createTransaction(group.id, {
    type: 'expense',
    title: 'Lift Tickets',
    amount: 120,
    paidBy: alice.id,
    splitType: 'equal',
    splits: [{ memberId: alice.id }, { memberId: bob.id }],
  });

  // Local UI reads immediately and cleanly from SQLite
  const localGroups = await repo.listGroups();
  assert.equal(localGroups.length, 1);
  assert.equal(localGroups[0]!.name, 'Ski Trip 2026');

  const summary = await repo.getGroupSummary(group.id);
  assert.equal(summary.totals.totalExpenses, 12000);
  assert.equal(summary.transactions.length, 1);
  assert.equal(summary.transactions[0]!.title, 'Lift Tickets');

  // Outbox has pending mutations stored in SQLite
  const pending = await getPendingOutboxMutations(group.uid);
  assert.ok(pending.length >= 3, 'Outbox must contain group, member, and transaction mutations');

  // Server has 0 records (offline isolation)
  const serverGroups = (await serverRows('SELECT * FROM groups'));
  assert.equal(serverGroups.length, 0);
  const serverTxs = (await serverRows('SELECT * FROM transactions'));
  assert.equal(serverTxs.length, 0);
});

test('mobile sync engine: 2. reconnect flushes outbox, pushes mutations, and advances sync cursor', async () => {
  engine.setOnline(false);

  // 1. Create offline data
  const group = await repo.createGroup({ name: 'Road Trip', myName: 'Alice', members: ['Bob'] });
  const members = await repo.getMembers(group.id);
  const alice = members.find((m) => m.name === 'Alice')!;
  const bob = members.find((m) => m.name === 'Bob')!;

  await repo.createTransaction(group.id, {
    type: 'expense',
    title: 'Fuel',
    amount: 50,
    paidBy: alice.id,
    splitType: 'equal',
    splits: [{ memberId: alice.id }, { memberId: bob.id }],
  });

  const countsBefore = await getOutboxCount(group.uid);
  assert.ok(countsBefore.pending > 0);

  // 2. Reconnect & trigger sync
  engine.setOnline(true);
  const syncResult = await engine.syncGroup(group.uid);

  assert.ok(syncResult.pushed > 0, 'Mutations should be successfully pushed');
  assert.equal(syncResult.conflicts, 0);

  // 3. Verify outbox is cleared
  const countsAfter = await getOutboxCount(group.uid);
  assert.equal(countsAfter.pending, 0);
  assert.equal(countsAfter.total, 0);

  // 4. Verify server received and stored the data
  const serverGroup = (await serverRows<{ name: string }>('SELECT name FROM groups WHERE uid = $1', [group.uid]))[0];
  assert.equal(serverGroup?.name, 'Road Trip');

  const serverTxs = (await serverRows<{ title: string; amount: number }>('SELECT title, amount FROM transactions WHERE group_uid = $1', [group.uid]));
  assert.equal(serverTxs.length, 1);
  assert.equal(serverTxs[0]!.title, 'Fuel');
  assert.equal(serverTxs[0]!.amount, 5000);

  // 5. Verify local sync state cursor advanced
  const state = await getSyncState(group.uid);
  assert.ok(state);
  assert.ok(state.lastServerSequence > 0);
  assert.equal(state.syncStatus, 'idle');
});

test('mobile sync engine: 3. duplicate push is handled idempotently without duplicate records', async () => {
  const group = await repo.createGroup({ name: 'Camping', myName: 'Alice', members: ['Bob'] });
  const devId = await getDeviceId();

  const pendingBefore = await getPendingOutboxMutations(group.uid);
  const firstMutationId = pendingBefore[0]!.clientMutationId;

  // Initial push
  const result1 = await engine.pushPendingMutations(group.uid, devId);
  assert.ok(result1.accepted > 0);

  // Count server changes
  const initialChangesCount = (await serverRows('SELECT * FROM sync_changes WHERE group_uid = $1', [group.uid])).length;

  // Re-enqueue the exact same clientMutationId to simulate duplicate delivery
  await enqueueOutboxMutation({
    clientMutationId: firstMutationId,
    groupUid: group.uid,
    entityType: 'group',
    entityUid: group.uid,
    operation: 'create',
    expectedVersion: 0,
    payload: { name: 'Camping' },
  });

  // Push again
  const result2 = await engine.pushPendingMutations(group.uid, devId);
  assert.equal(result2.accepted, 1);
  assert.equal(result2.conflicts, 0);

  // Verify server change log did not duplicate
  const changesAfter = (await serverRows('SELECT * FROM sync_changes WHERE group_uid = $1', [group.uid])).length;
  assert.equal(changesAfter, initialChangesCount, 'Change log must not duplicate idempotent mutations');
});

test('mobile sync engine: 4. partial failure marks conflicting mutations while accepting valid ones', async () => {
  const group = await repo.createGroup({ name: 'Beach Trip', myName: 'Alice', members: ['Bob'] });
  const members = await repo.getMembers(group.id);
  const alice = members.find((m) => m.name === 'Alice')!;
  const bob = members.find((m) => m.name === 'Bob')!;

  // Sync initial state to server
  await engine.syncGroup(group.uid);

  // Now create two new local mutations in outbox:
  // 1. Valid transaction
  const validTxId = await repo.createTransaction(group.id, {
    type: 'expense',
    title: 'Snacks',
    amount: 25,
    paidBy: alice.id,
    splitType: 'equal',
    splits: [{ memberId: alice.id }, { memberId: bob.id }],
  });

  // 2. An invalid transaction mutation with stale expectedVersion (version mismatch)
  await enqueueOutboxMutation({
    clientMutationId: 'mut_stale_update_fail',
    groupUid: group.uid,
    entityType: 'group',
    entityUid: group.uid,
    operation: 'update',
    expectedVersion: 999, // Stale/invalid version
    payload: { name: 'New Name' },
  });

  // Perform push
  const devId = await getDeviceId();
  const pushRes = await engine.pushPendingMutations(group.uid, devId);

  assert.ok(pushRes.accepted >= 1, 'Valid mutation must be accepted');
  assert.equal(pushRes.conflicts, 1, 'Stale mutation must be flagged as conflict');

  // Verify outbox status
  const conflicts = await getOutboxMutationsByStatus('conflict', group.uid);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.clientMutationId, 'mut_stale_update_fail');
  assert.ok(conflicts[0]!.errorMessage?.includes('Expected version 999'));
});

test('mobile sync engine: 5. app restart recovers pending outbox records and sync cursors seamlessly', async () => {
  // 1. First app session: user creates group offline
  engine.setOnline(false);
  const group = await repo.createGroup({ name: 'Cabin Weekend', myName: 'Alice', members: ['Bob'] });

  const pendingBefore = await getPendingOutboxMutations(group.uid);
  assert.ok(pendingBefore.length >= 2);

  // 2. App restart simulation: instantiate new engine instance and reload
  const freshEngine = new SyncEngine(transport);
  freshEngine.setOnline(true);

  // 3. New engine syncs group
  const syncRes = await freshEngine.syncGroup(group.uid);
  assert.ok(syncRes.pushed >= 2);

  // 4. Check outbox is empty and server has the group
  const pendingAfter = await getPendingOutboxMutations(group.uid);
  assert.equal(pendingAfter.length, 0);

  const serverGroup = (await serverRows<{ name: string }>('SELECT name FROM groups WHERE uid = $1', [group.uid]))[0];
  assert.equal(serverGroup?.name, 'Cabin Weekend');
});

test('mobile sync engine: 6. missed changes are pulled incrementally and applied transactionally to SQLite', async () => {
  // 1. Device A sets up group and syncs to server
  const group = await repo.createGroup({ name: 'Office Lunch', myName: 'Alice', members: ['Bob'] });
  await engine.syncGroup(group.uid);

  const state1 = await getSyncState(group.uid);
  const seqAfterInit = state1!.lastServerSequence;
  assert.ok(seqAfterInit > 0);

  // 2. Device A goes offline
  engine.setOnline(false);

  // 3. Device B (peer on server) adds 2 new transactions directly to server
  await server.call({
    method: 'POST',
    path: '/sync/push',
    body: {
      groupUid: group.uid,
      deviceId: 'dev_bob_device',
      actorId: 'usr_bob',
      actorName: 'Bob',
      mutations: [
        {
          clientMutationId: 'mut_peer_pizza',
          entityType: 'transaction',
          entityUid: 'tx_bob_pizza',
          operation: 'create',
          expectedVersion: 0,
          payload: {
            type: 'expense',
            title: 'Pizza Delivery',
            amount: 4500, // $45.00
            paidByName: 'Bob',
            splitType: 'equal',
            category: 'Food',
            date: '2026-10-05',
            splits: [
              { memberName: 'Alice', value: 1, share: 2250 },
              { memberName: 'Bob', value: 1, share: 2250 },
            ],
          },
        },
        {
          clientMutationId: 'mut_peer_drinks',
          entityType: 'transaction',
          entityUid: 'tx_bob_drinks',
          operation: 'create',
          expectedVersion: 0,
          payload: {
            type: 'expense',
            title: 'Soft Drinks',
            amount: 1500, // $15.00
            paidByName: 'Bob',
            splitType: 'equal',
            category: 'Food',
            date: '2026-10-05',
            splits: [
              { memberName: 'Alice', value: 1, share: 750 },
              { memberName: 'Bob', value: 1, share: 750 },
            ],
          },
        },
      ],
    },
  });

  // 4. Device A reconnects and syncs
  engine.setOnline(true);
  const syncResult = await engine.syncGroup(group.uid);

  assert.equal(syncResult.pulled, 2, 'Should pull exactly the 2 new transactions');

  // 5. Verify Device A local SQLite has the new transactions and calculated summaries
  const txs = await repo.getTransactions(group.id);
  const pizza = txs.find((t) => t.uid === 'tx_bob_pizza');
  const drinks = txs.find((t) => t.uid === 'tx_bob_drinks');

  assert.ok(pizza, 'Device A must have pizza transaction in local SQLite');
  assert.equal(pizza.title, 'Pizza Delivery');
  assert.equal(pizza.amount, 4500);

  assert.ok(drinks, 'Device A must have drinks transaction in local SQLite');
  assert.equal(drinks.title, 'Soft Drinks');
  assert.equal(drinks.amount, 1500);

  const summary = await repo.getGroupSummary(group.id);
  assert.equal(summary.totals.totalExpenses, 6000); // 4500 + 1500

  // 6. Verify Device A cursor matches latest sequence
  const state2 = await getSyncState(group.uid);
  assert.ok(state2!.lastServerSequence > seqAfterInit);
});
