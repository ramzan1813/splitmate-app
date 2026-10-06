import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDb } from './node-db';
import { migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { setSetting } from '../src/data/settings';
import { getSyncNotifications } from '../src/data/sync';

beforeEach(async () => {
  const db = createNodeDb();
  await migrate(db);
  setDb(db);
});

test('identity: generates and persists on-device user account identity', async () => {
  const { getIdentity, setAccountName, updateServerUrl, DEFAULT_SERVER_URL } = await import('../src/lib/identity');

  const identity1 = await getIdentity();
  assert.match(identity1.id, /^usr_[0-9a-f]{16}$/);

  // Calling it again returns the same persisted identity
  const identity2 = await getIdentity();
  assert.equal(identity2.id, identity1.id);

  // Updating account name and server url (trailing slash trimmed)
  await setAccountName('Alice In Wonderland');
  await updateServerUrl('http://192.168.1.20:8787/');

  const updatedIdentity = await getIdentity();
  assert.equal(updatedIdentity.name, 'Alice In Wonderland');
  assert.equal(updatedIdentity.serverUrl, 'http://192.168.1.20:8787');

  // A WebSocket relay address saved by an older build maps to the HTTP server URL
  await setSetting('sync.relay_url', 'wss://custom-relay.example.com/ws');
  assert.equal((await getIdentity()).serverUrl, 'https://custom-relay.example.com');

  // Non-HTTP URLs are refused
  await assert.rejects(updateServerUrl('ftp://example.com'));

  // Clearing the server url falls back to default
  await updateServerUrl('');
  const fallbackIdentity = await getIdentity();
  assert.equal(fallbackIdentity.serverUrl, DEFAULT_SERVER_URL);
});

test('qr: produces valid ISO-compliant QR matrix from universal join URL', async () => {
  const QRCodeLib = (await import('qrcode')).default;
  const testUrl = 'https://splitmate-relay.rn45819.workers.dev/join?uid=grp_test_qr&name=Ski%20Trip&cur=USD';
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

