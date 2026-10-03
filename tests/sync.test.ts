import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { decryptWithKey, encryptWithKey, generateGroupKey, sha256Hex } from '../src/lib/crypto';
import { applyRemoteSyncEvent, createSyncEvent, getSyncNotifications, SyncEvent, SyncTxPayload } from '../src/data/sync';

beforeEach(async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);
});

test('crypto: encryption and decryption round-trip', async () => {
  const key = generateGroupKey();
  const plaintext = JSON.stringify({ message: 'Hello from Device A', amount: 15000 });
  const encrypted = await encryptWithKey(plaintext, key);

  assert.notEqual(encrypted, plaintext);
  assert.ok(encrypted.includes(':')); // iv:ciphertext

  const decrypted = await decryptWithKey(encrypted, key);
  assert.equal(decrypted, plaintext);
  assert.deepEqual(JSON.parse(decrypted), { message: 'Hello from Device A', amount: 15000 });
});

test('crypto: sha256 hex matches expected length', async () => {
  const hash = await sha256Hex('test_room_123');
  assert.equal(hash.length, 64);
});

test('sync: two-device synchronization and notification simulation', async () => {
  // === 1. Setup Device A (Alice) ===
  const dbA = createNodeDb();
  await migrate(dbA);
  setDb(dbA);

  const groupA = await repo.createGroup({
    name: 'Road Trip',
    currency: 'USD',
    myName: 'Alice',
    members: ['Bob'],
  });

  const [aliceId, bobId] = (await repo.getMembers(groupA.id)).map((m) => m.id) as [number, number];
  const txId = await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Hotel',
    amount: 200,
    paidBy: aliceId,
    splitType: 'equal',
    splits: [{ memberId: aliceId }, { memberId: bobId }],
    category: 'Stay',
    date: '2026-10-03',
  });

  const txsA = await repo.getTransactions(groupA.id);
  assert.equal(txsA.length, 1);
  assert.equal(txsA[0]!.title, 'Hotel');
  assert.equal(txsA[0]!.amount, 20000); // $200.00 in cents

  // === 2. Setup Device B (Bob) joining with the same group UID & Sync Key ===
  const dbB = createNodeDb();
  await migrate(dbB);
  setDb(dbB);

  // Bob creates or joins the group with same UID and syncKey
  await dbB.runAsync(
    'INSERT INTO groups (uid, name, description, currency, sync_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [groupA.uid, groupA.name, groupA.description, groupA.currency, groupA.syncKey, groupA.createdAt, groupA.updatedAt]
  );
  const bobGroupRow = await dbB.getFirstAsync<{ id: number }>('SELECT id FROM groups WHERE uid = ?', [groupA.uid]);
  assert.ok(bobGroupRow);
  await dbB.runAsync('INSERT INTO members (group_id, name, is_me, created_at) VALUES (?, ?, 1, ?)', [bobGroupRow.id, 'Bob', groupA.createdAt]);

  // === 3. Device A exports and encrypts event -> Device B receives and applies ===
  const syncPayload: SyncTxPayload = {
    txUid: txsA[0]!.uid!,
    type: 'expense',
    title: 'Hotel',
    amount: 20000,
    paidByName: 'Alice',
    splitType: 'equal',
    category: 'Stay',
    note: '',
    date: '2026-10-03',
    splits: [
      { memberName: 'Alice', value: 1, share: 10000 },
      { memberName: 'Bob', value: 1, share: 10000 },
    ],
    updatedTs: Date.now(),
  };

  const syncEvent: SyncEvent<SyncTxPayload> = {
    eventId: 'evt_hotel_1',
    groupUid: groupA.uid,
    authorId: 'usr_alice_123',
    authorName: 'Alice',
    timestamp: Date.now(),
    action: 'UPSERT_TX',
    payload: syncPayload,
  };

  // Encrypt with group symmetric key
  const encryptedPayload = await encryptWithKey(JSON.stringify(syncEvent), groupA.syncKey!);
  // Device B decrypts and applies
  const decryptedStr = await decryptWithKey(encryptedPayload, groupA.syncKey!);
  const decryptedEvent = JSON.parse(decryptedStr) as SyncEvent<SyncTxPayload>;

  const applied = await applyRemoteSyncEvent(decryptedEvent);
  assert.equal(applied, true);

  // === 4. Verify Device B local SQLite state ===
  const txsB = await repo.getTransactions(bobGroupRow.id);
  assert.equal(txsB.length, 1);
  assert.equal(txsB[0]!.title, 'Hotel');
  assert.equal(txsB[0]!.amount, 20000);
  assert.equal(txsB[0]!.authorName, 'Alice');

  const summaryB = await repo.getGroupSummary(bobGroupRow.id);
  assert.equal(summaryB.totals.totalExpenses, 20000);
  const bobStat = summaryB.stats.find((s) => s.name === 'Bob');
  assert.equal(bobStat?.balance, -10000); // Bob owes $100.00

  // Verify in-app notifications
  const notifsB = await getSyncNotifications(groupA.uid);
  assert.equal(notifsB.length, 1);
  assert.ok(notifsB[0]!.message.includes('Alice added Hotel ($200.00)'));
});

test('sync: delete transaction event deletes row on peer', async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);

  const g = await repo.createGroup({ name: 'Dinner', myName: 'Alice' });
  const [alice] = (await repo.getMembers(g.id)).map((m) => m.id) as [number];
  await repo.createTransaction(g.id, { type: 'expense', title: 'Pizza', amount: 30, paidBy: alice, splits: [{ memberId: alice }] });

  const txs = await repo.getTransactions(g.id);
  assert.equal(txs.length, 1);
  const txUid = txs[0]!.uid!;

  const deleteEvent: SyncEvent = {
    eventId: 'evt_del_1',
    groupUid: g.uid,
    authorId: 'usr_remote_1',
    authorName: 'Bob',
    timestamp: Date.now(),
    action: 'DELETE_TX',
    payload: { txUid },
  };

  await applyRemoteSyncEvent(deleteEvent);

  const txsAfter = await repo.getTransactions(g.id);
  assert.equal(txsAfter.length, 0);
});
