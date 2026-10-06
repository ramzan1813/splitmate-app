import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { migrate, setDb, getDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { getDeviceId } from '../src/lib/identity';
import {
  discardUnresolvedOutboxMutations,
  enqueueOutboxMutation,
  getOutboxCount,
  getOutboxMutationsByStatus,
  getPendingOutboxMutations,
  markOutboxMutationConflict,
  markOutboxMutationFailed,
  markOutboxMutationInFlight,
  requeueOutboxMutations,
  resetInFlightOutboxMutations,
} from '../src/data/outbox';
import {
  getSyncState,
  initSyncState,
  setSyncStatus,
  updateServerSequence,
} from '../src/data/syncState';

beforeEach(async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);
});

test('sync foundation: device ID is stable, persistent, and idempotent', async () => {
  const dev1 = await getDeviceId();
  assert.ok(dev1.startsWith('dev_'));
  assert.ok(dev1.length > 10);

  const dev2 = await getDeviceId();
  assert.equal(dev2, dev1, 'Repeated getDeviceId calls must return the identical device ID');
});

test('sync foundation: schema migrations establish all required sync tables and columns', async () => {
  const db = await getDb();
  const v = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version', []);
  assert.equal(v?.user_version, 6, 'Schema version must be 6');

  // The old relay's event log is gone
  const legacy = await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_events'", []);
  assert.equal(legacy, null);

  // Verify outbox_mutations table
  const outbox = await db.getAllAsync('SELECT * FROM outbox_mutations', []);
  assert.deepEqual(outbox, []);

  // Verify sync_state table
  const syncState = await db.getAllAsync('SELECT * FROM sync_state', []);
  assert.deepEqual(syncState, []);
});

test('sync foundation: entity creation, update, and deletion automatically enqueue outbox records', async () => {
  // 1. Create Group -> enqueues group CREATE mutation
  const g = await repo.createGroup({ name: 'Road Trip', myName: 'Alice', members: ['Bob'] });
  assert.equal(g.serverVersion, 1);
  assert.equal(g.isDeleted, false);

  const pending1 = await getPendingOutboxMutations(g.uid);
  assert.ok(pending1.length >= 2, 'Must contain group create mutation and initial member mutations');

  const groupCreateMut = pending1.find((m) => m.entityType === 'group' && m.operation === 'create')!;
  assert.ok(groupCreateMut);
  assert.equal(groupCreateMut.expectedVersion, 0);
  assert.equal((groupCreateMut.payload as any).name, 'Road Trip');

  // 2. Add Member -> enqueues member CREATE mutation
  const charlieId = await repo.addMember(g.id, 'Charlie');
  const members = await repo.getMembers(g.id);
  const charlie = members.find((m) => m.id === charlieId)!;
  assert.ok(charlie.uid);
  assert.equal(charlie.serverVersion, 1);

  const pending2 = await getPendingOutboxMutations(g.uid);
  const memberCreateMut = pending2.find((m) => m.entityType === 'member' && m.entityUid === charlie.uid && m.operation === 'create');
  assert.ok(memberCreateMut);

  // 3. Rename Member -> enqueues member UPDATE mutation
  await repo.renameMember(g.id, charlieId, 'Charlie B');
  const updatedCharlie = (await repo.getMembers(g.id)).find((m) => m.id === charlieId)!;
  assert.equal(updatedCharlie.name, 'Charlie B');
  assert.equal(updatedCharlie.serverVersion, 2);

  const pending3 = await getPendingOutboxMutations(g.uid);
  const memberUpdateMut = pending3.find((m) => m.entityType === 'member' && m.entityUid === charlie.uid && m.operation === 'update');
  assert.ok(memberUpdateMut);

  // 4. Create Transaction -> enqueues transaction CREATE mutation
  const alice = members.find((m) => m.name === 'Alice')!;
  const bob = members.find((m) => m.name === 'Bob')!;
  const txId = await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Fuel',
    amount: 60,
    paidBy: alice.id,
    splitType: 'equal',
    splits: [{ memberId: alice.id }, { memberId: bob.id }],
  });

  const txs = await repo.getTransactions(g.id);
  const fuelTx = txs.find((t) => t.id === txId)!;
  assert.equal(fuelTx.serverVersion, 1);
  assert.equal(fuelTx.isDeleted, false);

  const pending4 = await getPendingOutboxMutations(g.uid);
  const txCreateMut = pending4.find((m) => m.entityType === 'transaction' && m.entityUid === fuelTx.uid && m.operation === 'create');
  assert.ok(txCreateMut);
  assert.equal(txCreateMut?.expectedVersion, 0);

  // 5. Update Transaction -> enqueues transaction UPDATE mutation and increments local entity version
  await repo.updateTransaction(g.id, txId, {
    type: 'expense',
    title: 'Fuel + Oil',
    amount: 80,
    paidBy: alice.id,
    splitType: 'equal',
    splits: [{ memberId: alice.id }, { memberId: bob.id }],
  });

  const updatedTx = (await repo.getTransactions(g.id)).find((t) => t.id === txId)!;
  assert.equal(updatedTx.title, 'Fuel + Oil');
  assert.equal(updatedTx.serverVersion, 2);

  const pending5 = await getPendingOutboxMutations(g.uid);
  const txUpdateMut = pending5.find((m) => m.entityType === 'transaction' && m.entityUid === fuelTx.uid && m.operation === 'update');
  assert.ok(txUpdateMut);
  assert.equal(txUpdateMut?.expectedVersion, 1, 'Expected version must match previous version');

  // 6. Delete Transaction -> soft-deletes row (tombstone) and enqueues DELETE mutation
  await repo.deleteTransaction(g.id, txId);
  const activeTxs = await repo.getTransactions(g.id);
  assert.equal(activeTxs.length, 0, 'Active transactions list must exclude soft-deleted transactions');

  const pending6 = await getPendingOutboxMutations(g.uid);
  const txDeleteMut = pending6.find((m) => m.entityType === 'transaction' && m.entityUid === fuelTx.uid && m.operation === 'delete');
  assert.ok(txDeleteMut);
  assert.equal(txDeleteMut?.expectedVersion, 2);

  // 7. Verify soft-deleted tombstone directly in SQLite
  const db = await getDb();
  const rawTx = await db.getFirstAsync<{ id: number; is_deleted: number; deleted_at: string }>(
    'SELECT id, is_deleted, deleted_at FROM transactions WHERE id = ?',
    [txId]
  );
  assert.equal(rawTx?.is_deleted, 1);
  assert.ok(rawTx?.deleted_at);
});

test('sync foundation: outbox state transitions and lifecycle methods', async () => {
  const mut = await enqueueOutboxMutation({
    clientMutationId: 'mut_test_state_1',
    groupUid: 'grp_test_1',
    entityType: 'transaction',
    entityUid: 'tx_abc',
    operation: 'create',
    expectedVersion: 0,
    payload: { title: 'Coffee', amount: 500 },
  });

  assert.equal(mut.status, 'pending');
  assert.equal(mut.retryCount, 0);

  // 1. In-flight (sending)
  await markOutboxMutationInFlight(['mut_test_state_1']);
  let inFlight = await getOutboxMutationsByStatus('sending', 'grp_test_1');
  assert.equal(inFlight.length, 1);
  assert.equal(inFlight[0]!.clientMutationId, 'mut_test_state_1');

  // 2. Transient failure (network down): back to pending for the next sync
  await requeueOutboxMutations(['mut_test_state_1'], 'Network timeout');
  let pending = await getPendingOutboxMutations('grp_test_1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.retryCount, 1);
  assert.equal(pending[0]!.errorMessage, 'Network timeout');

  // 3. A push interrupted mid-request (app killed) is recovered on the next sync
  await markOutboxMutationInFlight(['mut_test_state_1']);
  await resetInFlightOutboxMutations('grp_test_1');
  assert.equal((await getPendingOutboxMutations('grp_test_1')).length, 1);

  // 4. Rejected by the server: kept as failed for the user to review
  await markOutboxMutationFailed('mut_test_state_1', 'FORBIDDEN');
  const failed = await getOutboxMutationsByStatus('failed', 'grp_test_1');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.retryCount, 2);

  // 5. Conflict
  await markOutboxMutationConflict('mut_test_state_1', 'VERSION_MISMATCH');
  const conflict = await getOutboxMutationsByStatus('conflict', 'grp_test_1');
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0]!.errorMessage, 'VERSION_MISMATCH');

  // 6. Counts summary
  const counts = await getOutboxCount('grp_test_1');
  assert.equal(counts.pending, 0);
  assert.equal(counts.conflict, 1);
  assert.equal(counts.total, 1);

  // 7. The user accepts the server's version: refused mutations are discarded
  assert.equal(await discardUnresolvedOutboxMutations('grp_test_1'), 1);
  assert.equal((await getOutboxCount('grp_test_1')).total, 0);
});

test('sync foundation: sync cursor and sync state management', async () => {
  const devId = await getDeviceId();
  const state = await initSyncState('grp_cursor_test', devId);

  assert.equal(state.groupUid, 'grp_cursor_test');
  assert.equal(state.deviceId, devId);
  assert.equal(state.lastServerSequence, 0);
  assert.equal(state.syncStatus, 'idle');
  assert.equal(state.lastSyncAt, null);

  // 1. Update server sequence cursor
  await updateServerSequence('grp_cursor_test', 150);
  let updated = await getSyncState('grp_cursor_test');
  assert.equal(updated?.lastServerSequence, 150);
  assert.ok(updated?.lastSyncAt);

  // 2. Monotonicity check: lower sequence does not regress cursor
  await updateServerSequence('grp_cursor_test', 100);
  updated = await getSyncState('grp_cursor_test');
  assert.equal(updated?.lastServerSequence, 150, 'Cursor must never regress to a lower sequence');

  // 3. Advance to higher sequence
  await updateServerSequence('grp_cursor_test', 200);
  updated = await getSyncState('grp_cursor_test');
  assert.equal(updated?.lastServerSequence, 200);

  // 4. Set sync status and errors
  await setSyncStatus('grp_cursor_test', 'error', 'Connection lost');
  updated = await getSyncState('grp_cursor_test');
  assert.equal(updated?.syncStatus, 'error');
  assert.equal(updated?.errorDetail, 'Connection lost');
});

test('sync foundation: financial calculations strictly ignore soft-deleted tombstones', async () => {
  const g = await repo.createGroup({ name: 'Dinner Group', myName: 'Alice', members: ['Bob'] });
  const [alice, bob] = (await repo.getMembers(g.id)).map((m) => m.id) as [number, number];

  // Create 2 expenses: Hotel ($200) + Dinner ($100)
  const hotelId = await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Hotel',
    amount: 200,
    paidBy: alice,
    splitType: 'equal',
    splits: [{ memberId: alice }, { memberId: bob }],
  });

  const dinnerId = await repo.createTransaction(g.id, {
    type: 'expense',
    title: 'Dinner',
    amount: 100,
    paidBy: bob,
    splitType: 'equal',
    splits: [{ memberId: alice }, { memberId: bob }],
  });

  let summary = await repo.getGroupSummary(g.id);
  assert.equal(summary.totals.totalExpenses, 30000); // $300.00 in cents
  assert.equal(summary.transactions.length, 2);

  // Soft delete Hotel
  await repo.deleteTransaction(g.id, hotelId);

  // Summary and balances must now only reflect Dinner ($100)
  summary = await repo.getGroupSummary(g.id);
  assert.equal(summary.totals.totalExpenses, 10000);
  assert.equal(summary.transactions.length, 1);
  assert.equal(summary.transactions[0]!.id, dinnerId);

  // Bob paid 100, share 50 -> gets back 50. Alice owes 50.
  const aliceStat = summary.stats.find((s) => s.memberId === alice)!;
  const bobStat = summary.stats.find((s) => s.memberId === bob)!;
  assert.equal(aliceStat.balance, -5000);
  assert.equal(bobStat.balance, 5000);
});
