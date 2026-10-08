import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestServer, defaultOutboundResponse, OutboundRequest } from '../relay/test-support/testServer';
import { verifyWebhookSignature } from '../relay/src/notifications';

const ADMIN = { authorization: 'Bearer test-admin-key' };
const GROUP = 'grp_notify';

let server: TestServer;
let webhookUp = true;

beforeEach(async () => {
  webhookUp = true;
  server = await startTestServer({
    config: { adminApiKey: 'test-admin-key' },
    respond: (req: OutboundRequest) =>
      req.url.startsWith('https://hooks.example.com') && !webhookUp ? new Response('down', { status: 500 }) : defaultOutboundResponse(req),
  });
});

afterEach(async () => {
  await server.close();
});

async function push(mutations: any[], deviceId = 'dev_alice') {
  const res = await server.call({
    method: 'POST',
    path: '/sync/push',
    body: { groupUid: GROUP, deviceId, actorId: 'usr_alice', actorName: 'Alice', mutations },
  });
  assert.equal(res.status, 200);
  return res.body.results as any[];
}

async function createGroupWithMember() {
  await push([
    { clientMutationId: 'm_g', entityType: 'group', entityUid: GROUP, operation: 'create', expectedVersion: 0, payload: { name: 'Notify', creatorId: 'usr_alice' } },
    { clientMutationId: 'm_alice', entityType: 'member', entityUid: 'mem_alice', operation: 'create', expectedVersion: 0, payload: { name: 'Alice' } },
  ]);
}

function expense(id: string, amount: number) {
  return {
    clientMutationId: `m_${id}`,
    entityType: 'transaction',
    entityUid: id,
    operation: 'create',
    expectedVersion: 0,
    payload: { type: 'expense', title: id, amount, paidByMemberUid: 'mem_alice', splits: [{ memberUid: 'mem_alice', value: 1, share: amount }] },
  };
}

const webhookCalls = () => server.outbound.filter((r) => r.url.startsWith('https://hooks.example.com'));
const expoCalls = () => server.outbound.filter((r) => r.url.includes('exp.host'));

test('webhooks: management routes require the admin API key', async () => {
  await createGroupWithMember();
  const noKey = await server.call({ method: 'POST', path: `/groups/${GROUP}/webhooks`, body: { url: 'https://hooks.example.com/a' } });
  assert.equal(noKey.status, 401);

  const insecure = await server.call({ method: 'POST', path: `/groups/${GROUP}/webhooks`, headers: ADMIN, body: { url: 'http://hooks.example.com/a' } });
  assert.equal(insecure.status, 400, 'webhook urls must use https');

  const missingGroup = await server.call({ method: 'POST', path: '/groups/grp_nope/webhooks', headers: ADMIN, body: { url: 'https://hooks.example.com/a' } });
  assert.equal(missingGroup.status, 404);
});

test('webhooks: accepted push delivers a signed CHANGES_AVAILABLE event with the latest sequence', async () => {
  await createGroupWithMember();
  const created = await server.call({ method: 'POST', path: `/groups/${GROUP}/webhooks`, headers: ADMIN, body: { url: 'https://hooks.example.com/a' } });
  assert.equal(created.status, 201);
  const { id, secret, deliveredSequence } = created.body;
  assert.match(secret, /^whsec_[0-9a-f]{64}$/);
  assert.equal(deliveredSequence, 2, 'a new webhook starts at the current sequence, not at history');

  const [result] = await push([expense('tx_1', 1000)]);
  assert.equal(result.status, 'ACCEPTED');
  await server.settle();

  const calls = webhookCalls();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!.body);
  assert.deepEqual({ type: body.type, groupUid: body.groupUid, latestSequence: body.latestSequence }, {
    type: 'CHANGES_AVAILABLE',
    groupUid: GROUP,
    latestSequence: result.serverSequence,
  });
  assert.ok(await verifyWebhookSignature(secret, calls[0]!.body, calls[0]!.headers['x-splitmate-signature']!));
  assert.equal(await verifyWebhookSignature('whsec_wrong', calls[0]!.body, calls[0]!.headers['x-splitmate-signature']!), false);

  const list = await server.call({ method: 'GET', path: `/groups/${GROUP}/webhooks`, headers: ADMIN });
  assert.equal(list.body.webhooks[0].id, id);
  assert.equal(list.body.webhooks[0].deliveredSequence, result.serverSequence);
  assert.equal(list.body.webhooks[0].secret, undefined, 'secret is only returned at creation');
});

test('webhooks: failed delivery is retried by the scheduled dispatcher and coalesces missed changes', async () => {
  await createGroupWithMember();
  await server.call({ method: 'POST', path: `/groups/${GROUP}/webhooks`, headers: ADMIN, body: { url: 'https://hooks.example.com/a' } });

  webhookUp = false;
  await push([expense('tx_1', 1000)]);
  await server.settle();
  await push([expense('tx_2', 2000)]);
  await server.settle();
  assert.equal(webhookCalls().length, 1, 'second dispatch is held back by the retry backoff');

  let list = await server.call({ method: 'GET', path: `/groups/${GROUP}/webhooks`, headers: ADMIN });
  assert.equal(list.body.webhooks[0].attempts, 1);
  assert.equal(list.body.webhooks[0].lastError, 'HTTP 500');
  assert.equal(list.body.webhooks[0].deliveredSequence, 2);

  // Cron run before the backoff expires does nothing.
  await server.runScheduledDispatch();
  assert.equal(webhookCalls().length, 1);

  webhookUp = true;
  await server.expireRetryTimers();
  const summary = await server.runScheduledDispatch();
  assert.equal(summary.webhooks.delivered, 1);

  const last = JSON.parse(webhookCalls().at(-1)!.body);
  const [txTwo] = (await server.pglite.query<{ last_sequence: number }>('SELECT last_sequence FROM groups WHERE uid = $1', [GROUP])).rows;
  assert.equal(last.latestSequence, txTwo!.last_sequence, 'one event covers every change missed while the hook was down');

  list = await server.call({ method: 'GET', path: `/groups/${GROUP}/webhooks`, headers: ADMIN });
  assert.equal(list.body.webhooks[0].attempts, 0);
  assert.equal(list.body.webhooks[0].deliveredSequence, txTwo!.last_sequence);
});

test('expo push: registered devices get a silent CHANGES_AVAILABLE push; DeviceNotRegistered disables the token', async () => {
  await createGroupWithMember();
  const reg = await server.call({
    method: 'POST',
    path: '/devices/register',
    body: { deviceId: 'dev_bob', actorId: 'usr_bob', expoPushToken: 'ExponentPushToken[bob]', groupUids: [GROUP, 'grp_unknown'] },
  });
  assert.equal(reg.status, 200);
  assert.deepEqual(reg.body.groupUids, [GROUP], 'unknown groups are ignored');

  const badToken = await server.call({ method: 'POST', path: '/devices/register', body: { deviceId: 'dev_x', expoPushToken: 'not-a-token' } });
  assert.equal(badToken.status, 400);

  await push([expense('tx_1', 1000)]);
  await server.settle();
  assert.equal(expoCalls().length, 1);
  const [message] = JSON.parse(expoCalls()[0]!.body);
  assert.equal(message.to, 'ExponentPushToken[bob]');
  assert.equal(message.data.type, 'CHANGES_AVAILABLE');
  assert.equal(message.data.groupUid, GROUP);
  assert.equal(message._contentAvailable, true);

  // Token no longer valid: Expo returns DeviceNotRegistered -> stop sending to it.
  await server.close();
  server = await startTestServer({
    respond: (req) =>
      req.url.includes('exp.host')
        ? Response.json({ data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] })
        : defaultOutboundResponse(req),
  });
  await createGroupWithMember();
  await server.call({ method: 'POST', path: '/devices/register', body: { deviceId: 'dev_bob', expoPushToken: 'ExponentPushToken[bob]', groupUids: [GROUP] } });
  await push([expense('tx_1', 1000)]);
  await server.settle();
  const [device] = (await server.pglite.query<{ push_enabled: boolean }>('SELECT push_enabled FROM devices WHERE device_id = $1', ['dev_bob'])).rows;
  assert.equal(device!.push_enabled, false);
  await push([expense('tx_2', 500)]);
  await server.settle();
  assert.equal(expoCalls().length, 1, 'disabled tokens are not sent to again');
});
