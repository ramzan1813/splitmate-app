import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { migrate, setDb, DB } from '../src/data/db';
import * as repo from '../src/data/repo';
import { getSyncState } from '../src/data/syncState';
import { createServerDb, ServerDB } from '../relay/src/db';
import { handleSyncApiRequest } from '../relay/src/api';
import { RealtimeHub, serverRealtimeHub } from '../relay/src/realtimeHub';
import {
  SyncEngine,
  SyncTransport,
  MemoryRealtimeClient,
} from '../src/data/syncEngine';
import {
  GroupBootstrapResponse,
  PullChangesResponse,
  PushMutationsRequest,
  PushMutationsResponse,
} from '../src/data/types';

/** Test Sync Transport connecting client to server database */
class DirectServerSyncTransport implements SyncTransport {
  constructor(private serverDb: ServerDB) {}

  async push(request: PushMutationsRequest): Promise<PushMutationsResponse> {
    const res = handleSyncApiRequest(this.serverDb, {
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
    const res = handleSyncApiRequest(this.serverDb, {
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
    const res = handleSyncApiRequest(this.serverDb, {
      method: 'GET',
      path: `/sync/bootstrap/${groupUid}`,
    });
    if (res.status >= 400) {
      throw new Error(`Bootstrap failed with status ${res.status}`);
    }
    return res.body as GroupBootstrapResponse;
  }
}

let serverDb: ServerDB;
let realtimeHub: RealtimeHub;

beforeEach(() => {
  serverDb = createServerDb(':memory:');
  realtimeHub = serverRealtimeHub;
  realtimeHub.clear();
});

test('phase 4: online device A creates transaction -> device B receives notification -> pulls change -> updates SQLite -> UI reflects change', async () => {
  // === Setup Device A (Alice) ===
  const dbA = createNodeDb(':memory:');
  await migrate(dbA);
  setDb(dbA);

  const transportA = new DirectServerSyncTransport(serverDb);
  const realtimeA = new MemoryRealtimeClient(realtimeHub);
  const engineA = new SyncEngine(transportA, realtimeA, dbA);

  const groupA = await repo.createGroup({ name: 'Rome Holiday', myName: 'Alice', members: ['Bob'] });
  await engineA.syncGroup(groupA.uid);

  // === Setup Device B (Bob) ===
  const dbB = createNodeDb(':memory:');
  await migrate(dbB);
  setDb(dbB);

  const transportB = new DirectServerSyncTransport(serverDb);
  const realtimeB = new MemoryRealtimeClient(realtimeHub);
  const engineB = new SyncEngine(transportB, realtimeB, dbB);

  // Device B bootstraps or creates local group shell and syncs initial state
  const groupB = await repo.createGroup({
    name: 'Rome Holiday',
    myName: 'Bob',
    members: ['Alice'],
    uid: groupA.uid,
    syncKey: groupA.syncKey,
    creatorId: groupA.creatorId,
  });
  await engineB.syncGroup(groupB.uid);

  // Device B is now subscribed to groupA.uid in realtime
  assert.equal(realtimeHub.getSubscriberCount(groupA.uid), 2);

  // Check initial sequence on Device B
  const stateB1 = await getSyncState(groupB.uid, dbB);
  const initialSeqB = stateB1!.lastServerSequence;
  assert.ok(initialSeqB > 0);

  // === Alice on Device A creates an expense online ===
  setDb(dbA);
  const membersA = await repo.getMembers(groupA.id);
  const aliceA = membersA.find((m) => m.name === 'Alice')!;
  const bobA = membersA.find((m) => m.name === 'Bob')!;

  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Colosseum Tickets',
    amount: 60, // $60.00
    paidBy: aliceA.id,
    splitType: 'equal',
    splits: [{ memberId: aliceA.id }, { memberId: bobA.id }],
  });

  // Track UI updates on Device B
  let deviceBNotified = false;
  engineB.subscribe((gUid) => {
    if (gUid === groupB.uid) {
      deviceBNotified = true;
    }
  });

  // Alice pushes transaction to backend
  // This automatically triggers serverRealtimeHub.publish(groupUid, { type: 'CHANGES_AVAILABLE' })
  // Device B's MemoryRealtimeClient receives notification -> triggers engineB.handleRealtimeNotification -> pulls changes strictly after cursor
  await engineA.syncGroup(groupA.uid);

  // Allow async realtime notification pull on Device B to settle
  await new Promise((r) => setTimeout(r, 20));

  // Verify Device B received notification, pulled changes, updated SQLite, and notified UI
  assert.equal(deviceBNotified, true, 'Device B UI listener must be notified after realtime pull');

  setDb(dbB);
  const txsB = await repo.getTransactions(groupB.id);
  assert.equal(txsB.length, 1);
  assert.equal(txsB[0]!.title, 'Colosseum Tickets');
  assert.equal(txsB[0]!.amount, 6000);

  const summaryB = await repo.getGroupSummary(groupB.id);
  assert.equal(summaryB.totals.totalExpenses, 6000);
  const bobStat = summaryB.stats.find((s) => s.name === 'Bob')!;
  assert.equal(bobStat.balance, -3000); // Bob owes $30.00

  // Cursor advanced on Device B
  const stateB2 = await getSyncState(groupB.uid, dbB);
  assert.ok(stateB2!.lastServerSequence > initialSeqB);
});

test('phase 4: realtime disconnect -> missed notification -> reconnect -> cursor recovery', async () => {
  // === Setup Device A (Alice) ===
  const dbA = createNodeDb(':memory:');
  await migrate(dbA);
  setDb(dbA);

  const transportA = new DirectServerSyncTransport(serverDb);
  const realtimeA = new MemoryRealtimeClient(realtimeHub);
  const engineA = new SyncEngine(transportA, realtimeA, dbA);

  const groupA = await repo.createGroup({ name: 'Tokyo Trip', myName: 'Alice', members: ['Bob'] });
  await engineA.syncGroup(groupA.uid);

  // === Setup Device B (Bob) ===
  const dbB = createNodeDb(':memory:');
  await migrate(dbB);
  setDb(dbB);

  const transportB = new DirectServerSyncTransport(serverDb);
  const realtimeB = new MemoryRealtimeClient(realtimeHub);
  const engineB = new SyncEngine(transportB, realtimeB, dbB);

  const groupB = await repo.createGroup({
    name: 'Tokyo Trip',
    myName: 'Bob',
    members: ['Alice'],
    uid: groupA.uid,
    syncKey: groupA.syncKey,
    creatorId: groupA.creatorId,
  });
  await engineB.syncGroup(groupB.uid);

  const stateB1 = await getSyncState(groupB.uid, dbB);
  const cursorBeforeDisconnect = stateB1!.lastServerSequence;

  // === 1. Device B experiences realtime disconnect / goes offline ===
  engineB.setOnline(false);
  assert.equal(realtimeB.isConnected(), false);
  assert.equal(engineB.isOnline(), false);

  // === 2. Device A creates 2 transactions while Device B is disconnected ===
  setDb(dbA);
  const membersA = await repo.getMembers(groupA.id);
  const aliceA = membersA.find((m) => m.name === 'Alice')!;
  const bobA = membersA.find((m) => m.name === 'Bob')!;

  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Bullet Train',
    amount: 140,
    paidBy: aliceA.id,
    splitType: 'equal',
    splits: [{ memberId: aliceA.id }, { memberId: bobA.id }],
  });

  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Sushi Dinner',
    amount: 80,
    paidBy: aliceA.id,
    splitType: 'equal',
    splits: [{ memberId: aliceA.id }, { memberId: bobA.id }],
  });

  // Alice syncs to server -> Realtime notification is emitted, but Device B misses it
  await engineA.syncGroup(groupA.uid);

  // Verify Device B local SQLite still has 0 transactions while disconnected
  setDb(dbB);
  const txsBeforeReconnect = await repo.getTransactions(groupB.id);
  assert.equal(txsBeforeReconnect.length, 0);

  // === 3. Device B reconnects ===
  // When setOnline(true) is called, engine reconnects realtime and triggers cursor synchronization across groups
  engineB.setOnline(true);
  assert.equal(realtimeB.isConnected(), true);
  assert.equal(engineB.isOnline(), true);

  // Wait a tick for reconnect sync cycle or call syncGroup
  await engineB.syncGroup(groupB.uid);

  // === 4. Verify Cursor Recovery on Device B ===
  // Local SQLite has received and applied all missed changes
  const txsAfter = await repo.getTransactions(groupB.id);
  assert.equal(txsAfter.length, 2);
  const train = txsAfter.find((t) => t.title === 'Bullet Train');
  const sushi = txsAfter.find((t) => t.title === 'Sushi Dinner');
  assert.ok(train);
  assert.equal(train.amount, 14000);
  assert.ok(sushi);
  assert.equal(sushi.amount, 8000);

  const summary = await repo.getGroupSummary(groupB.id);
  assert.equal(summary.totals.totalExpenses, 22000); // $140 + $80 = $220.00 in cents

  // Device B cursor advanced past cursorBeforeDisconnect
  const stateB2 = await getSyncState(groupB.uid, dbB);
  assert.ok(stateB2!.lastServerSequence > cursorBeforeDisconnect);
});
