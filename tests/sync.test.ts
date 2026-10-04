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

test('sync: p2p state snapshot export and full group hydration on peer', async () => {
  // Device A creates a full group with multiple members and expenses
  const dbA = createNodeDb();
  await migrate(dbA);
  setDb(dbA);

  const groupA = await repo.createGroup({
    name: 'Dubai Holiday',
    currency: 'AED',
    myName: 'Ramzan',
    members: ['Ikram', 'Sara'],
  });

  const membersA = await repo.getMembers(groupA.id);
  const ramzanId = membersA.find((m) => m.name === 'Ramzan')!.id;
  const ikramId = membersA.find((m) => m.name === 'Ikram')!.id;
  const saraId = membersA.find((m) => m.name === 'Sara')!.id;

  // Ramzan records a $300 expense split with Ikram and Sara
  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Desert Safari Tour',
    amount: 300,
    paidBy: ramzanId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId }, { memberId: ikramId }, { memberId: saraId }],
    category: 'Activities',
    date: '2026-10-04',
  });

  // Export full snapshot from Device A
  const snapshot = await repo.exportGroupSnapshot(groupA.id);
  assert.equal(snapshot.name, 'Dubai Holiday');
  assert.equal(snapshot.currency, 'AED');
  assert.equal(snapshot.members.length, 3);
  assert.equal(snapshot.transactions.length, 1);
  assert.equal(snapshot.transactions[0]!.title, 'Desert Safari Tour');
  assert.equal(snapshot.transactions[0]!.amount, 30000);

  // Device B (Ikram joining on a new phone)
  const dbB = createNodeDb();
  await migrate(dbB);
  setDb(dbB);

  // Device B creates group shell with same UID & Sync Key, choosing "Ikram" as myName
  const groupB = await repo.createGroup({
    name: groupA.name,
    currency: groupA.currency,
    myName: 'Ikram',
    syncKey: groupA.syncKey,
    uid: groupA.uid,
  });

  // Device B applies snapshot received from peer
  const result = await repo.applyGroupSnapshot(groupB.id, snapshot);
  assert.equal(result.added, 1);

  // Verify Device B state
  const membersB = await repo.getMembers(groupB.id);
  assert.equal(membersB.length, 3);
  const ikramB = membersB.find((m) => m.name === 'Ikram')!;
  assert.equal(ikramB.isMe, true); // Ikram is marked as (you) on Device B

  const txsB = await repo.getTransactions(groupB.id);
  assert.equal(txsB.length, 1);
  assert.equal(txsB[0]!.title, 'Desert Safari Tour');
  assert.equal(txsB[0]!.amount, 30000);

  // Check balances on Device B: Ramzan paid $300, Ikram and Sara owe $100 each
  const summaryB = await repo.getGroupSummary(groupB.id);
  const ikramStat = summaryB.stats.find((s) => s.memberId === ikramB.id)!;
  assert.equal(ikramStat.balance, -10000); // Ikram owes 100 AED
});

test('members: merge member reassigns all past transactions and splits', async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);

  // Group created with Ramzan, and two duplicate entries for Ikram: "Ikram" and "Ikram Khan"
  const group = await repo.createGroup({
    name: 'Flat Expenses',
    currency: 'USD',
    myName: 'Ramzan',
    members: ['Ikram', 'Ikram Khan'],
  });

  const members = await repo.getMembers(group.id);
  const ramzanId = members.find((m) => m.name === 'Ramzan')!.id;
  const ikramId = members.find((m) => m.name === 'Ikram')!.id;
  const ikramKhanId = members.find((m) => m.name === 'Ikram Khan')!.id;

  // Expense 1: Paid by Ramzan, split with "Ikram Khan"
  await repo.createTransaction(group.id, {
    type: 'expense',
    title: 'Groceries',
    amount: 100,
    paidBy: ramzanId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId }, { memberId: ikramKhanId }],
    category: 'Food',
    date: '2026-10-04',
  });

  // Expense 2: Paid by "Ikram Khan", split with Ramzan
  await repo.createTransaction(group.id, {
    type: 'expense',
    title: 'Electricity Bill',
    amount: 60,
    paidBy: ikramKhanId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId }, { memberId: ikramKhanId }],
    category: 'Utilities',
    date: '2026-10-04',
  });

  // Merge "Ikram Khan" into "Ikram"
  await repo.mergeMembers(group.id, ikramKhanId, ikramId);

  // Check remaining members: "Ikram Khan" should be removed
  const updatedMembers = await repo.getMembers(group.id);
  assert.equal(updatedMembers.length, 2);
  assert.ok(!updatedMembers.some((m) => m.name === 'Ikram Khan'));
  assert.ok(updatedMembers.some((m) => m.name === 'Ikram'));

  // Check transactions: Electricity Bill paidBy should now be "Ikram"
  const updatedTxs = await repo.getTransactions(group.id);
  const electricity = updatedTxs.find((t) => t.title === 'Electricity Bill')!;
  assert.equal(electricity.paidBy, ikramId);

  // Groceries split should now be with "Ikram"
  const groceries = updatedTxs.find((t) => t.title === 'Groceries')!;
  assert.ok(groceries.splits.some((s) => s.memberId === ikramId));

  // Check overall balances:
  // Ramzan paid 100 (benefit 50 + 30 = 80 -> balance +20)
  // Ikram paid 60 (benefit 50 + 30 = 80 -> balance -20)
  const summary = await repo.getGroupSummary(group.id);
  const ikramStat = summary.stats.find((s) => s.memberId === ikramId)!;
  assert.equal(ikramStat.totalPaid, 6000);
  assert.equal(ikramStat.totalBenefit, 8000);
  assert.equal(ikramStat.balance, -2000); // -$20.00
});

test('groups: createGroup deduplication prevents duplicate rows when UID already exists', async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);

  const original = await repo.createGroup({
    name: 'London Trip',
    currency: 'GBP',
    myName: 'Ramzan',
    members: ['Ikram'],
    uid: 'grp_london_123',
    syncKey: 'key_london_abc',
  });

  assert.equal(original.uid, 'grp_london_123');
  assert.equal(original.name, 'London Trip');

  // Attempt to create the same group again with the same UID (e.g. repeated QR scan or join)
  const duplicate = await repo.createGroup({
    name: 'London Trip (Scanned Again)',
    currency: 'GBP',
    myName: 'Ramzan',
    members: ['Ikram'],
    uid: 'grp_london_123',
    syncKey: 'key_london_abc',
  });

  assert.equal(duplicate.id, original.id);
  assert.equal(duplicate.uid, 'grp_london_123');

  // Verify only 1 group exists in the database
  const allGroups = await repo.listGroups();
  assert.equal(allGroups.length, 1);
  assert.equal(allGroups[0]!.uid, 'grp_london_123');
});

test('sync: end-to-end REQUEST_STATE and STATE_SNAPSHOT handshake between peers', async () => {
  // === Setup Device A (Host with full dataset) ===
  const dbA = createNodeDb();
  await migrate(dbA);
  setDb(dbA);

  const groupA = await repo.createGroup({
    name: 'Euro Trip 2026',
    currency: 'EUR',
    myName: 'Alice',
    members: ['Bob', 'Charlie'],
    uid: 'grp_euro_2026',
    syncKey: 'synckey_euro_xyz',
  });

  const membersA = await repo.getMembers(groupA.id);
  const aliceA = membersA.find((m) => m.name === 'Alice')!.id;
  const bobA = membersA.find((m) => m.name === 'Bob')!.id;
  const charlieA = membersA.find((m) => m.name === 'Charlie')!.id;

  // Alice adds Expense 1: Train Tickets (300 EUR)
  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Train Tickets',
    amount: 300,
    paidBy: aliceA,
    splitType: 'equal',
    splits: [{ memberId: aliceA }, { memberId: bobA }, { memberId: charlieA }],
    category: 'Transport',
    date: '2026-10-04',
  });

  // Bob adds Expense 2: Dinner in Paris (150 EUR)
  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Paris Dinner',
    amount: 150,
    paidBy: bobA,
    splitType: 'equal',
    splits: [{ memberId: aliceA }, { memberId: bobA }, { memberId: charlieA }],
    category: 'Food',
    date: '2026-10-04',
  });

  // === Setup Device B (Bob joins on a fresh mobile phone) ===
  const dbB = createNodeDb();
  await migrate(dbB);
  setDb(dbB);

  // Bob creates group shell via QR scan
  const groupB = await repo.createGroup({
    name: 'Euro Trip 2026',
    currency: 'EUR',
    myName: 'Bob',
    members: ['Alice', 'Charlie'],
    uid: 'grp_euro_2026',
    syncKey: 'synckey_euro_xyz',
  });

  // Device B sends REQUEST_STATE
  const requestEvent: SyncEvent = {
    eventId: 'evt_req_1',
    groupUid: 'grp_euro_2026',
    authorId: 'usr_bob_device',
    authorName: 'Bob',
    timestamp: Date.now(),
    action: 'REQUEST_STATE',
    payload: { requestedAt: Date.now() },
  };

  // Device A receives REQUEST_STATE
  setDb(dbA);
  const snapshotA = await repo.exportGroupSnapshot(groupA.id);
  assert.equal(snapshotA.transactions.length, 2);
  assert.equal(snapshotA.members.length, 3);

  // Device A sends STATE_SNAPSHOT back to Device B
  const snapshotEvent: SyncEvent = {
    eventId: 'evt_snap_1',
    groupUid: 'grp_euro_2026',
    authorId: 'usr_alice_device',
    authorName: 'Alice',
    timestamp: Date.now(),
    action: 'STATE_SNAPSHOT',
    payload: snapshotA,
  };

  // Device B receives and applies STATE_SNAPSHOT
  setDb(dbB);
  const applied = await applyRemoteSyncEvent(snapshotEvent);
  assert.equal(applied, true);

  // Verify Device B now has all 2 transactions, correct members and balances
  const txsB = await repo.getTransactions(groupB.id);
  assert.equal(txsB.length, 2);

  const trainTx = txsB.find((t) => t.title === 'Train Tickets')!;
  assert.equal(trainTx.amount, 30000); // 300.00 EUR in cents

  const dinnerTx = txsB.find((t) => t.title === 'Paris Dinner')!;
  assert.equal(dinnerTx.amount, 15000); // 150.00 EUR in cents

  const summaryB = await repo.getGroupSummary(groupB.id);
  assert.equal(summaryB.totals.totalExpenses, 45000); // 450.00 EUR total

  // Alice paid 300, share 150 -> balance +150
  // Bob paid 150, share 150 -> balance 0
  // Charlie paid 0, share 150 -> balance -150
  const bobStat = summaryB.stats.find((s) => s.name === 'Bob')!;
  assert.equal(bobStat.totalPaid, 15000);
  assert.equal(bobStat.totalBenefit, 15000);
  assert.equal(bobStat.balance, 0);

  const aliceStat = summaryB.stats.find((s) => s.name === 'Alice')!;
  assert.equal(aliceStat.balance, 15000);

  const charlieStat = summaryB.stats.find((s) => s.name === 'Charlie')!;
  assert.equal(charlieStat.balance, -15000);
});



