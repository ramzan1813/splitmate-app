import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createNodeDb } from './node-db';
import { migrate, setDb } from '../src/data/db';
import * as repo from '../src/data/repo';
import { SyncEvent, SyncTxPayload, GroupSnapshotPayload, applyRemoteSyncEvent, createSyncEvent } from '../src/data/sync';
import { decryptWithKey, encryptWithKey, generateGroupKey, sha256Hex } from '../src/lib/crypto';

// Polyfill global WebSocket for node environment during test
(globalThis as any).WebSocket = WebSocket;

test('E2E LIVE RELAY P2P: Full group state hydration and real-time transaction sync across two devices', async () => {
  // === 1. Setup Device A (PC) ===
  const dbA = createNodeDb();
  await migrate(dbA);
  setDb(dbA);

  const groupA = await repo.createGroup({
    name: 'Trip to Murree',
    currency: 'PKR',
    myName: 'Ramzan',
    members: ['Ikram', 'Sara'],
  });

  const membersA = await repo.getMembers(groupA.id);
  const ramzanId = membersA.find((m) => m.name === 'Ramzan')!.id;
  const ikramId = membersA.find((m) => m.name === 'Ikram')!.id;
  const saraId = membersA.find((m) => m.name === 'Sara')!.id;

  // Add 3 expenses on Device A
  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Highway Toll',
    amount: 1200, // PKR 1200.00
    paidBy: ramzanId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId }, { memberId: ikramId }, { memberId: saraId }],
    category: 'Transport',
    date: '2026-10-04',
  });

  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Hotel Booking',
    amount: 15000, // PKR 15000.00
    paidBy: ramzanId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId }, { memberId: ikramId }, { memberId: saraId }],
    category: 'Stay',
    date: '2026-10-04',
  });

  await repo.createTransaction(groupA.id, {
    type: 'expense',
    title: 'Dinner at Monal',
    amount: 6000, // PKR 6000.00
    paidBy: ikramId,
    splitType: 'equal',
    splits: [{ memberId: ramzanId }, { memberId: ikramId }, { memberId: saraId }],
    category: 'Food',
    date: '2026-10-04',
  });

  const summaryA1 = await repo.getGroupSummary(groupA.id);
  assert.equal(summaryA1.totals.totalExpenses, 2220000); // 22,200 PKR in cents
  assert.equal(summaryA1.transactions.length, 3);

  // Connect Device A to Live Relay
  const roomHash = await sha256Hex(`splitmate_room_${groupA.uid}`);
  const relayUrl = `wss://splitmate-relay.rn45819.workers.dev/ws?room=${roomHash}`;

  const wsA = new WebSocket(relayUrl);
  await new Promise((res, rej) => {
    wsA.on('open', res);
    wsA.on('error', rej);
  });

  wsA.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'SYNC_EVENT') {
        const decrypted = await decryptWithKey(msg.payload, groupA.syncKey!);
        const event = JSON.parse(decrypted) as SyncEvent;

        // Switch to DB A context to process remote event on Device A
        setDb(dbA);
        if (event.action === 'REQUEST_STATE') {
          const batches = await repo.exportGroupSnapshotBatches(groupA.id, 25);
          for (const chunk of batches) {
            const snapEvent = {
              eventId: `evt_snap_${Date.now()}`,
              groupUid: groupA.uid,
              authorId: groupA.creatorId,
              authorName: 'Ramzan',
              timestamp: Date.now(),
              action: 'STATE_SNAPSHOT',
              payload: chunk,
            };
            const enc = await encryptWithKey(JSON.stringify(snapEvent), groupA.syncKey!);
            wsA.send(JSON.stringify({ id: snapEvent.eventId, payload: enc }));
          }
        } else {
          await applyRemoteSyncEvent(event);
        }
      }
    } catch (err) {
      console.error('Device A onmessage error:', err);
    }
  });

  // === 2. Setup Device B (Mobile - Ikram joining via QR link) ===
  const dbB = createNodeDb();
  await migrate(dbB);
  setDb(dbB);

  // Device B joins using invite params
  const groupB = await repo.createGroup({
    name: 'Trip to Murree',
    currency: 'PKR',
    myName: 'Ikram',
    members: ['Ramzan', 'Sara'],
    syncKey: groupA.syncKey,
    uid: groupA.uid,
  });

  const wsB = new WebSocket(relayUrl);
  await new Promise((res, rej) => {
    wsB.on('open', res);
    wsB.on('error', rej);
  });

  let snapshotReceived = false;

  wsB.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'SYNC_EVENT') {
        const decrypted = await decryptWithKey(msg.payload, groupA.syncKey!);
        const event = JSON.parse(decrypted) as SyncEvent;

        // Switch to DB B context to process remote event on Device B
        setDb(dbB);
        if (event.action === 'STATE_SNAPSHOT') {
          await repo.applyGroupSnapshot(groupB.id, event.payload as GroupSnapshotPayload);
          snapshotReceived = true;
        } else {
          await applyRemoteSyncEvent(event);
        }
      }
    } catch (err) {
      console.error('Device B onmessage error:', err);
    }
  });

  // Device B requests state from online peers
  const reqEvent = {
    eventId: `evt_req_${Date.now()}`,
    groupUid: groupA.uid,
    authorId: 'usr_ikram_mobile',
    authorName: 'Ikram',
    timestamp: Date.now(),
    action: 'REQUEST_STATE',
    payload: { requestedAt: Date.now() },
  };
  const encReq = await encryptWithKey(JSON.stringify(reqEvent), groupA.syncKey!);
  wsB.send(JSON.stringify({ id: reqEvent.eventId, payload: encReq }));

  // Wait for P2P handshake over live relay
  for (let i = 0; i < 20; i++) {
    if (snapshotReceived) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  assert.equal(snapshotReceived, true, 'Device B must have received and applied STATE_SNAPSHOT from Device A');

  // Verify Device B (Mobile) now has all 3 expenses and identical balances
  setDb(dbB);
  const summaryB = await repo.getGroupSummary(groupB.id);
  assert.equal(summaryB.totals.totalExpenses, 2220000);
  assert.equal(summaryB.transactions.length, 3);
  assert.equal(summaryB.transactions[0]!.title, 'Highway Toll');
  assert.equal(summaryB.transactions[1]!.title, 'Hotel Booking');
  assert.equal(summaryB.transactions[2]!.title, 'Dinner at Monal');

  // === 3. Real-time Live Sync: Device B records an expense -> instantly reflects on Device A ===
  setDb(dbB);
  const membersB = await repo.getMembers(groupB.id);
  const ikramIdB = membersB.find((m) => m.name === 'Ikram')!.id;
  const ramzanIdB = membersB.find((m) => m.name === 'Ramzan')!.id;
  const saraIdB = membersB.find((m) => m.name === 'Sara')!.id;

  const newTxId = await repo.createTransaction(groupB.id, {
    type: 'expense',
    title: 'Chairlift Tickets',
    amount: 3000, // PKR 3000.00
    paidBy: ikramIdB,
    splitType: 'equal',
    splits: [{ memberId: ramzanIdB }, { memberId: ikramIdB }, { memberId: saraIdB }],
    category: 'Activities',
    date: '2026-10-04',
  });

  const txsB = await repo.getTransactions(groupB.id);
  const chairliftTx = txsB.find((t) => t.id === newTxId)!;

  // Broadcast UPSERT_TX from Device B to Device A
  const upsertEvent: SyncEvent<SyncTxPayload> = {
    eventId: `evt_upsert_chairlift_${Date.now()}`,
    groupUid: groupA.uid,
    authorId: 'usr_ikram_mobile',
    authorName: 'Ikram',
    timestamp: Date.now(),
    action: 'UPSERT_TX',
    payload: {
      txUid: chairliftTx.uid!,
      type: 'expense',
      title: 'Chairlift Tickets',
      amount: 300000,
      paidByName: 'Ikram',
      splitType: 'equal',
      category: 'Activities',
      note: '',
      date: '2026-10-04',
      splits: [
        { memberName: 'Ramzan', value: 1, share: 100000 },
        { memberName: 'Ikram', value: 1, share: 100000 },
        { memberName: 'Sara', value: 1, share: 100000 },
      ],
      updatedTs: Date.now(),
    },
  };
  const encUpsert = await encryptWithKey(JSON.stringify(upsertEvent), groupA.syncKey!);
  wsB.send(JSON.stringify({ id: upsertEvent.eventId, payload: encUpsert }));

  // Wait for Device A to receive and apply the event
  await new Promise((r) => setTimeout(r, 1000));

  // Verify Device A now has 4 expenses
  setDb(dbA);
  const summaryA2 = await repo.getGroupSummary(groupA.id);
  assert.equal(summaryA2.transactions.length, 4);
  assert.equal(summaryA2.totals.totalExpenses, 2520000);
  assert.ok(summaryA2.transactions.some((t) => t.title === 'Chairlift Tickets'));

  wsA.close();
  wsB.close();
});
