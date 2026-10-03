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

test('identity: generates and persists on-device user account identity', async () => {
  const { getIdentity, setAccountName, updateRelayUrl } = await import('../src/lib/identity');

  const identity1 = await getIdentity();
  assert.ok(identity1.id.startsWith('usr_'));
  assert.ok(identity1.publicKey.length > 0);
  assert.ok(identity1.secretKey.length > 0);

  // Calling it again returns the same persisted identity
  const identity2 = await getIdentity();
  assert.equal(identity2.id, identity1.id);
  assert.equal(identity2.publicKey, identity1.publicKey);

  // Updating account name and relay url
  await setAccountName('Alice In Wonderland');
  await updateRelayUrl('wss://custom-relay.example.com/ws');

  const updatedIdentity = await getIdentity();
  assert.equal(updatedIdentity.name, 'Alice In Wonderland');
  assert.equal(updatedIdentity.relayUrl, 'wss://custom-relay.example.com/ws');

  // Clearing relay url falls back to default
  await updateRelayUrl('');
  const fallbackIdentity = await getIdentity();
  assert.equal(fallbackIdentity.relayUrl, 'wss://splitmate-relay.rn45819.workers.dev/ws');
});

test('sync: ignores outdated sync events (Last-Write-Wins conflict resolution)', async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);

  const g = await repo.createGroup({ name: 'Camping', myName: 'Alice' });
  const [alice] = (await repo.getMembers(g.id)).map((m) => m.id) as [number];
  await repo.createTransaction(g.id, { type: 'expense', title: 'Tent', amount: 100, paidBy: alice, splits: [{ memberId: alice }] });

  const txs = await repo.getTransactions(g.id);
  const txUid = txs[0]!.uid!;

  // Event with future timestamp (newer)
  const newerEvent: SyncEvent<SyncTxPayload> = {
    eventId: 'evt_newer',
    groupUid: g.uid,
    authorId: 'usr_peer',
    authorName: 'Bob',
    timestamp: Date.now() + 5000,
    action: 'UPSERT_TX',
    payload: {
      txUid,
      type: 'expense',
      title: 'Luxury Tent',
      amount: 15000,
      paidByName: 'Alice',
      splitType: 'equal',
      category: 'General',
      note: 'Upgraded',
      date: '2026-10-03',
      splits: [{ memberName: 'Alice', value: 1, share: 15000 }],
      updatedTs: Date.now() + 5000,
    },
  };

  await applyRemoteSyncEvent(newerEvent);
  let updatedTxs = await repo.getTransactions(g.id);
  assert.equal(updatedTxs[0]!.title, 'Luxury Tent');
  assert.equal(updatedTxs[0]!.amount, 15000);

  // Event with past timestamp (older) - should be rejected by LWW
  const olderEvent: SyncEvent<SyncTxPayload> = {
    eventId: 'evt_older',
    groupUid: g.uid,
    authorId: 'usr_peer',
    authorName: 'Bob',
    timestamp: Date.now() - 50000,
    action: 'UPSERT_TX',
    payload: {
      txUid,
      type: 'expense',
      title: 'Old Tent',
      amount: 5000,
      paidByName: 'Alice',
      splitType: 'equal',
      category: 'General',
      note: 'Old',
      date: '2026-10-03',
      splits: [{ memberName: 'Alice', value: 1, share: 5000 }],
      updatedTs: Date.now() - 50000,
    },
  };

  await applyRemoteSyncEvent(olderEvent);
  updatedTxs = await repo.getTransactions(g.id);
  // Title should remain 'Luxury Tent' because older event was rejected
  assert.equal(updatedTxs[0]!.title, 'Luxury Tent');
  assert.equal(updatedTxs[0]!.amount, 15000);
});

test('join: preserves group UID when joining via invite link', async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);

  const inviteLink = 'https://splitmate-relay.rn45819.workers.dev/join?uid=grp_beach_trip_99&key=secretkey123&name=Beach%20Trip&cur=EUR';
  const url = new URL(inviteLink);
  const uid = url.searchParams.get('uid')!;
  const key = url.searchParams.get('key')!;
  const name = decodeURIComponent(url.searchParams.get('name')!);
  const cur = url.searchParams.get('cur')!;

  assert.equal(uid, 'grp_beach_trip_99');
  assert.equal(key, 'secretkey123');
  assert.equal(name, 'Beach Trip');
  assert.equal(cur, 'EUR');

  const joinedGroup = await repo.createGroup({
    name,
    currency: cur,
    myName: 'Bob',
    syncKey: key,
    uid,
  });

  assert.equal(joinedGroup.uid, 'grp_beach_trip_99');
  assert.equal(joinedGroup.name, 'Beach Trip');
  assert.equal(joinedGroup.currency, 'EUR');
  assert.equal(joinedGroup.syncKey, 'secretkey123');
});

test('qr: produces valid ISO-compliant QR matrix from universal join URL', async () => {
  const QRCodeLib = (await import('qrcode')).default;
  const testUrl = 'https://splitmate-relay.rn45819.workers.dev/join?uid=grp_test_qr&key=abc12345&name=Ski%20Trip&cur=USD';
  const qr = QRCodeLib.create(testUrl, { errorCorrectionLevel: 'M' });

  assert.ok(qr.modules.size > 20);
  assert.ok(qr.modules.data.length > 0);
  // Top-left finder corner (0,0) must be black/1
  assert.equal(qr.modules.get(0, 0), 1);
});

test('notifications: unread counter, retrieval, and mark all read', async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);

  const { markNotificationsRead } = await import('../src/data/sync');

  // Insert test notifications
  await db.runAsync(
    'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ['grp_notif_1', 'Alice', 'Trip', 'Alice added Coffee ($5.00)', new Date().toISOString()]
  );
  await db.runAsync(
    'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ['grp_notif_1', 'Bob', 'Trip', 'Bob recorded a payment ($10.00)', new Date().toISOString()]
  );

  const unreadBefore = await getSyncNotifications('grp_notif_1');
  assert.equal(unreadBefore.length, 2);
  assert.equal(unreadBefore[0]!.read, false);
  assert.equal(unreadBefore[1]!.read, false);

  // Mark read
  await markNotificationsRead('grp_notif_1');
  const afterRead = await getSyncNotifications('grp_notif_1');
  assert.equal(afterRead.length, 2);
  assert.equal(afterRead[0]!.read, true);
  assert.equal(afterRead[1]!.read, true);
});



