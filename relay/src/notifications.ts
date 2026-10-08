// Outbound change notifications: signed webhooks and Expo push.
//
// Notifications are hints, never data: { type: 'CHANGES_AVAILABLE', groupUid, latestSequence }.
// Receivers pull GET /sync/changes/:groupUid?after=<cursor>. Delivery state lives on each target
// (delivered_sequence); a target is pending while delivered_sequence < groups.last_sequence.
// Because last_sequence commits atomically with the change, nothing is lost if the Worker dies
// mid-request, bursts coalesce into one send, and the cron trigger retries with backoff.
import { Database } from './db';
import { ChangesAvailableEvent } from './types';

export interface NotifierOptions {
  fetch: typeof fetch;
  expoAccessToken?: string;
  expoPushUrl?: string;
  webhookTimeoutMs?: number;
}

export interface DispatchSummary {
  webhooks: { delivered: number; failed: number };
  push: { delivered: number; failed: number; disabled: number };
}

const CLAIM_LEASE_SECONDS = 60; // a claimed target is invisible to other dispatchers for this long
const BATCH_SIZE = 100; // Expo accepts up to 100 messages per request
const MAX_WEBHOOK_ATTEMPTS = 30; // ~1 day of retries at the backoff cap, then the hook is disabled
const DEFAULT_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function changesAvailableEvent(groupUid: string, latestSequence: number): ChangesAvailableEvent {
  return { type: 'CHANGES_AVAILABLE', groupUid, latestSequence, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Webhook signing (Stripe-style): X-SplitMate-Signature: t=<unix>,v1=<hex HMAC-SHA256>
// over `${t}.${rawBody}`. Receivers should reject timestamps older than ~5 minutes.
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signWebhookPayload(secret: string, body: string, timestampSec: number): Promise<string> {
  return `t=${timestampSec},v1=${await hmacSha256Hex(secret, `${timestampSec}.${body}`)}`;
}

export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec || !parts.v1) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function dispatchNotifications(
  db: Database,
  opts: NotifierOptions,
  filter: { groupUid?: string } = {}
): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    webhooks: { delivered: 0, failed: 0 },
    push: { delivered: 0, failed: 0, disabled: 0 },
  };
  await dispatchWebhooks(db, opts, filter.groupUid ?? null, summary);
  await dispatchExpoPush(db, opts, filter.groupUid ?? null, summary);
  return summary;
}

async function dispatchWebhooks(db: Database, opts: NotifierOptions, groupUid: string | null, summary: DispatchSummary) {
  const claimed = await db.query<{ id: string; group_uid: string; url: string; secret: string; last_sequence: number }>(
    `UPDATE webhook_subscriptions w
        SET next_attempt_at = now() + interval '${CLAIM_LEASE_SECONDS} seconds'
       FROM groups g
      WHERE g.uid = w.group_uid
        AND w.id IN (
          SELECT w2.id FROM webhook_subscriptions w2
            JOIN groups g2 ON g2.uid = w2.group_uid
           WHERE w2.is_active
             AND EXISTS (SELECT 1 FROM visible_webhook_subscriptions v WHERE v.id = w2.id) -- is_display
             AND w2.delivered_sequence < g2.last_sequence
             AND w2.next_attempt_at <= now()
             AND ($1::text IS NULL OR w2.group_uid = $1)
           ORDER BY w2.next_attempt_at
           LIMIT ${BATCH_SIZE}
           FOR UPDATE OF w2 SKIP LOCKED)
      RETURNING w.id, w.group_uid, w.url, w.secret, g.last_sequence`,
    [groupUid]
  );

  await Promise.all(
    claimed.map(async (hook) => {
      const event = changesAvailableEvent(hook.group_uid, hook.last_sequence);
      const body = JSON.stringify(event);
      let error: string | null = null;
      try {
        const res = await opts.fetch(hook.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.webhookTimeoutMs ?? 10_000),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'SplitMate-Webhooks/1.0',
            'X-SplitMate-Event': event.type,
            'X-SplitMate-Delivery': `${hook.id}:${hook.last_sequence}`,
            'X-SplitMate-Signature': await signWebhookPayload(hook.secret, body, Math.floor(Date.now() / 1000)),
          },
          body,
        });
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (err: any) {
        error = err?.message || String(err);
      }

      if (error === null) {
        summary.webhooks.delivered++;
        await db.query(
          `UPDATE webhook_subscriptions
              SET delivered_sequence = GREATEST(delivered_sequence, $2), attempts = 0,
                  next_attempt_at = now(), last_error = NULL, last_delivered_at = now()
            WHERE id = $1`,
          [hook.id, hook.last_sequence]
        );
      } else {
        summary.webhooks.failed++;
        await db.query(
          `UPDATE webhook_subscriptions
              SET attempts = attempts + 1,
                  next_attempt_at = now() + make_interval(secs => LEAST(30 * power(2, attempts), 3600)),
                  last_error = $2,
                  is_active = (attempts + 1 < $3)
            WHERE id = $1`,
          [hook.id, error.slice(0, 500), MAX_WEBHOOK_ATTEMPTS]
        );
      }
    })
  );
}

interface PushTarget {
  group_uid: string;
  device_id: string;
  expo_push_token: string;
  last_sequence: number;
}

async function dispatchExpoPush(db: Database, opts: NotifierOptions, groupUid: string | null, summary: DispatchSummary) {
  const claimed = await db.query<PushTarget>(
    `UPDATE device_group_subscriptions s
        SET next_attempt_at = now() + interval '${CLAIM_LEASE_SECONDS} seconds'
       FROM groups g, devices d
      WHERE g.uid = s.group_uid AND d.device_id = s.device_id
        AND (s.group_uid, s.device_id) IN (
          SELECT s2.group_uid, s2.device_id FROM device_group_subscriptions s2
            JOIN groups g2 ON g2.uid = s2.group_uid
            JOIN devices d2 ON d2.device_id = s2.device_id
           WHERE d2.push_enabled AND d2.expo_push_token IS NOT NULL
             AND EXISTS (SELECT 1 FROM visible_device_group_subscriptions v WHERE v.group_uid = s2.group_uid AND v.device_id = s2.device_id) -- is_display
             AND s2.delivered_sequence < g2.last_sequence
             AND s2.next_attempt_at <= now()
             AND ($1::text IS NULL OR s2.group_uid = $1)
           ORDER BY s2.next_attempt_at
           LIMIT ${BATCH_SIZE}
           FOR UPDATE OF s2 SKIP LOCKED)
      RETURNING s.group_uid, s.device_id, d.expo_push_token, g.last_sequence`,
    [groupUid]
  );
  if (claimed.length === 0) return;

  const messages = claimed.map((t) => ({
    to: t.expo_push_token,
    data: changesAvailableEvent(t.group_uid, t.last_sequence),
    priority: 'high',
    _contentAvailable: true, // silent/background delivery; the app pulls on receipt
  }));

  // One ticket per message, in order. A transport-level failure fails the whole batch.
  let tickets: { status: 'ok' | 'error'; message?: string; details?: { error?: string } }[];
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (opts.expoAccessToken) headers.Authorization = `Bearer ${opts.expoAccessToken}`;
    const res = await opts.fetch(opts.expoPushUrl ?? DEFAULT_EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(opts.webhookTimeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
    const json = (await res.json()) as { data?: typeof tickets };
    tickets = Array.isArray(json.data) ? json.data : [];
  } catch (err: any) {
    tickets = claimed.map(() => ({ status: 'error' as const, message: err?.message || String(err) }));
  }

  for (let i = 0; i < claimed.length; i++) {
    const target = claimed[i]!;
    const ticket = tickets[i] ?? { status: 'error' as const, message: 'Missing push ticket' };
    if (ticket.status === 'ok') {
      summary.push.delivered++;
      await db.query(
        `UPDATE device_group_subscriptions
            SET delivered_sequence = GREATEST(delivered_sequence, $3), attempts = 0, next_attempt_at = now(), last_error = NULL
          WHERE group_uid = $1 AND device_id = $2`,
        [target.group_uid, target.device_id, target.last_sequence]
      );
    } else if (ticket.details?.error === 'DeviceNotRegistered') {
      summary.push.disabled++;
      await db.query('UPDATE devices SET push_enabled = false WHERE device_id = $1', [target.device_id]);
      await db.query(
        'UPDATE device_group_subscriptions SET last_error = $3 WHERE group_uid = $1 AND device_id = $2',
        [target.group_uid, target.device_id, 'DeviceNotRegistered']
      );
    } else {
      summary.push.failed++;
      await db.query(
        `UPDATE device_group_subscriptions
            SET attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => LEAST(30 * power(2, attempts), 3600)),
                last_error = $3
          WHERE group_uid = $1 AND device_id = $2`,
        [target.group_uid, target.device_id, (ticket.message || ticket.details?.error || 'Push failed').slice(0, 500)]
      );
    }
  }
}
