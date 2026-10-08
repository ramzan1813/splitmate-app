import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { getSyncState } from '../src/data/syncState';
import { getDeviceId } from '../src/lib/identity';
import { startTestServer, TestServer } from '../relay/test-support/testServer';
import { ExpoPushHub } from '../relay/test-support/pushHub';
import { RealtimeClient, SyncEngine, SyncTransport } from '../src/data/syncEngine';
import {
  GroupBootstrapResponse,
  PullChangesResponse,
  PushMutationsRequest,
  PushMutationsResponse,
  RealtimeNotification,
} from '../src/data/types';

/** Stands in for the phone's push-notification receiver, fed by the test push hub. */
class MemoryRealtimeClient implements RealtimeClient {
  private connected = true;
  private subscribedGroups = new Set<string>();
  private handlers = new Set<(notification: RealtimeNotification) => void>();
  private unsubscribers = new Map<string, () => void>();

  constructor(private hub: { subscribe(groupUid: string, cb: (notif: RealtimeNotification) => void): () => void }) {}

  connect(): void {
    this.connected = true;
    for (const groupUid of this.subscribedGroups) this.attach(groupUid);
  }

  disconnect(): void {
    this.connected = false;
    for (const unsub of this.unsubscribers.values()) unsub();
    this.unsubscribers.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribeGroup(groupUid: string): void {
    this.subscribedGroups.add(groupUid);
    if (this.connected) this.attach(groupUid);
  }

  unsubscribeGroup(groupUid: string): void {
    this.subscribedGroups.delete(groupUid);
    this.unsubscribers.get(groupUid)?.();
    this.unsubscribers.delete(groupUid);
  }

  onNotification(handler: (notification: RealtimeNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private attach(groupUid: string) {
    if (this.unsubscribers.has(groupUid)) return;
    const unsub = this.hub.subscribe(groupUid, (notif) => {
      if (!this.connected) return;
      for (const h of this.handlers) h(notif);
    });
    this.unsubscribers.set(groupUid, unsub);
  }
}

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
let realtimeHub: ExpoPushHub;

beforeEach(async () => {
  // Notifications travel backend -> Expo push -> device; the hub plays Expo and the phone's push receiver.
  realtimeHub = new ExpoPushHub();
  server = await startTestServer({ respond: realtimeHub.respond });
});

afterEach(async () => {
  await server.close();
});

/** What the app does once it has an Expo push token: register it for its groups. */
async function registerPushToken(groupUid: string) {
  const res = await server.call({
    method: 'POST',
    path: '/devices/register',
    body: { deviceId: await getDeviceId(), expoPushToken: 'ExponentPushToken[test-device]', groupUids: [groupUid] },
  });
  assert.equal(res.status, 200);
}

test('phase 4: online device A creates transaction -> device B receives notification -> pulls change -> updates SQLite -> UI reflects change', async () => {
  // === Setup Device A (Alice) ===
  const dbA = createNodeDb(':memory:');
  await migrate(dbA);
  setDb(dbA);

  const transportA = new DirectServerSyncTransport(server);
  const realtimeA = new MemoryRealtimeClient(realtimeHub);
  const engineA = new SyncEngine(transportA, realtimeA, dbA);

  const groupA = await repo.createGroup({ name: 'Rome Holiday', myName: 'Alice', members: ['Bob'] });
  await engineA.syncGroup(groupA.uid);

  // === Setup Device B (Bob) ===
  const dbB = createNodeDb(':memory:');
  await migrate(dbB);
  setDb(dbB);

  const transportB = new DirectServerSyncTransport(server);
  const realtimeB = new MemoryRealtimeClient(realtimeHub);
  const engineB = new SyncEngine(transportB, realtimeB, dbB);

  // Device B joins from the server's snapshot as the existing member Bob
  const groupB = await repo.getGroup(await engineB.joinGroup(await engineB.fetchGroupSnapshot(groupA.uid), 'Bob'));
  await engineB.syncGroup(groupB.uid);

  // Device B is now subscribed to groupA.uid in realtime
  assert.equal(realtimeHub.getSubscriberCount(groupA.uid), 2);
  await registerPushToken(groupA.uid);

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
  // The accepted push schedules a dispatch: backend -> Expo push { type: 'CHANGES_AVAILABLE' } -> Device B
  // Device B's MemoryRealtimeClient receives notification -> triggers engineB.handleRealtimeNotification -> pulls changes strictly after cursor
  await engineA.syncGroup(groupA.uid);

  // Wait for the backend's background dispatch, then for Device B's notification-triggered pull
  await server.settle();
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

  const transportA = new DirectServerSyncTransport(server);
  const realtimeA = new MemoryRealtimeClient(realtimeHub);
  const engineA = new SyncEngine(transportA, realtimeA, dbA);

  const groupA = await repo.createGroup({ name: 'Tokyo Trip', myName: 'Alice', members: ['Bob'] });
  await engineA.syncGroup(groupA.uid);

  // === Setup Device B (Bob) ===
  const dbB = createNodeDb(':memory:');
  await migrate(dbB);
  setDb(dbB);

  const transportB = new DirectServerSyncTransport(server);
  const realtimeB = new MemoryRealtimeClient(realtimeHub);
  const engineB = new SyncEngine(transportB, realtimeB, dbB);

  // Device B joins from the server's snapshot as the existing member Bob
  const groupB = await repo.getGroup(await engineB.joinGroup(await engineB.fetchGroupSnapshot(groupA.uid), 'Bob'));
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
