// Express application. Platform-neutral: the Worker entry (index.ts) and the Node test
// harness inject the database factory, config, background-task hook and fetch.
import express, { NextFunction, Request, Response } from 'express';
import { Database, OpenDatabase, isRetryableDbError } from './db';
import { renderJoinPage } from './joinPage';
import { dispatchNotifications, generateWebhookSecret, NotifierOptions } from './notifications';
import { getChangesSince, getGroupBootstrap, HttpError, processPushMutations, validatePushRequest } from './syncService';

export interface AppConfig {
  /** Bearer token for webhook management and manual dispatch. Unset disables those routes. */
  adminApiKey?: string;
  expoAccessToken?: string;
  /** Dev only: allow http:// webhook URLs. */
  allowInsecureWebhookUrls?: boolean;
}

export interface AppDeps {
  openDb: OpenDatabase;
  getConfig: () => AppConfig;
  /** Keeps background work alive after the response (Workers: waitUntil). */
  defer: (work: Promise<unknown>) => void;
  fetch: typeof fetch;
}

const SERVICE_VERSION = '3.0.0';
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;
const MAX_GROUPS_PER_DEVICE_REGISTRATION = 100;

type DbHandler = (req: Request, res: Response, db: Database) => Promise<unknown>;

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  /** Opens a connection for the request and always closes it. */
  const withDb = (handler: DbHandler) => async (req: Request, res: Response) => {
    let db: Database;
    try {
      db = await deps.openDb();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.error('database connection failed', err);
      throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'Database is unreachable; retry the request');
    }
    try {
      await handler(req, res, db);
    } finally {
      await db.close();
    }
  };

  const notifierOptions = (): NotifierOptions => ({
    fetch: deps.fetch,
    expoAccessToken: deps.getConfig().expoAccessToken,
  });

  /** Delivers notifications for a group after the response; cron retries anything that fails. */
  const scheduleDispatch = (groupUid: string) => {
    deps.defer(
      (async () => {
        const db = await deps.openDb();
        try {
          await dispatchNotifications(db, notifierOptions(), { groupUid });
        } finally {
          await db.close();
        }
      })().catch((err) => console.error('notification dispatch failed', err))
    );
  };

  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    const key = deps.getConfig().adminApiKey;
    if (!key) throw new HttpError(503, 'ADMIN_API_DISABLED', 'ADMIN_API_KEY is not configured');
    const auth = req.header('authorization') ?? '';
    if (!timingSafeEqual(auth, `Bearer ${key}`)) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid admin API key');
    next();
  };

  // --- Service ---------------------------------------------------------------

  const health = (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      name: 'SplitMate Sync API',
      version: SERVICE_VERSION,
      architecture: 'Express on Cloudflare Workers + Postgres; webhooks + Expo push notifications',
    });
  };
  app.get('/', health);
  app.get('/health', health);

  app.get(
    '/health/db',
    withDb(async (_req, res, db) => {
      await db.query('SELECT 1');
      res.json({ status: 'ok', database: 'reachable' });
    })
  );

  app.get('/join', (req, res) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    res.type('html').send(renderJoinPage(params));
  });

  // --- Sync ------------------------------------------------------------------

  app.get(
    '/sync/bootstrap/:groupUid',
    withDb(async (req, res, db) => {
      res.json(await getGroupBootstrap(db, String(req.params.groupUid)));
    })
  );

  app.get(
    '/sync/changes/:groupUid',
    withDb(async (req, res, db) => {
      const after = parseNonNegativeInt(req.query.after, 0, 'after');
      const limit = parseNonNegativeInt(req.query.limit, 100, 'limit');
      res.json(await getChangesSince(db, String(req.params.groupUid), after, limit));
    })
  );

  app.post(
    '/sync/push',
    withDb(async (req, res, db) => {
      const body = validatePushRequest(req.body);
      const result = await processPushMutations(db, body);
      if (result.results.some((r) => r.status === 'ACCEPTED')) scheduleDispatch(body.groupUid);
      res.json(result);
    })
  );

  // --- Devices (Expo push targets) --------------------------------------------

  app.post(
    '/devices/register',
    withDb(async (req, res, db) => {
      const { deviceId, actorId, actorName, expoPushToken, groupUids } = req.body ?? {};
      if (typeof deviceId !== 'string' || !deviceId.trim()) throw new HttpError(400, 'BAD_REQUEST', 'deviceId is required');
      if (expoPushToken != null && (typeof expoPushToken !== 'string' || !EXPO_TOKEN_RE.test(expoPushToken))) {
        throw new HttpError(400, 'BAD_REQUEST', 'expoPushToken must look like ExponentPushToken[...]');
      }
      const groups: string[] = groupUids == null ? [] : groupUids;
      if (!Array.isArray(groups) || groups.length > MAX_GROUPS_PER_DEVICE_REGISTRATION || groups.some((g) => typeof g !== 'string')) {
        throw new HttpError(400, 'BAD_REQUEST', `groupUids must be an array of at most ${MAX_GROUPS_PER_DEVICE_REGISTRATION} strings`);
      }

      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO devices (device_id, user_id, user_name, expo_push_token, push_enabled, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (device_id) DO UPDATE SET
             user_id = COALESCE(EXCLUDED.user_id, devices.user_id),
             user_name = COALESCE(EXCLUDED.user_name, devices.user_name),
             expo_push_token = COALESCE(EXCLUDED.expo_push_token, devices.expo_push_token),
             push_enabled = EXCLUDED.push_enabled OR (devices.push_enabled AND EXCLUDED.expo_push_token IS NULL),
             last_seen_at = now()`,
          [deviceId, actorId ?? null, actorName ?? null, expoPushToken ?? null, expoPushToken != null]
        );
        // New subscriptions start at the current sequence: the device pulls history itself.
        for (const groupUid of groups) {
          await tx.query(
            `INSERT INTO device_group_subscriptions (group_uid, device_id, delivered_sequence)
             SELECT uid, $2, last_sequence FROM groups WHERE uid = $1 AND is_deleted = false
             ON CONFLICT (group_uid, device_id) DO NOTHING`,
            [groupUid, deviceId]
          );
        }
      });

      const subs = await db.query<{ group_uid: string }>(
        'SELECT group_uid FROM device_group_subscriptions WHERE device_id = $1 ORDER BY group_uid',
        [deviceId]
      );
      res.json({ deviceId, pushEnabled: expoPushToken != null, groupUids: subs.map((s) => s.group_uid) });
    })
  );

  app.delete(
    '/devices/:deviceId/push-token',
    withDb(async (req, res, db) => {
      await db.query('UPDATE devices SET expo_push_token = NULL, push_enabled = false WHERE device_id = $1', [req.params.deviceId]);
      res.status(204).end();
    })
  );

  // --- Webhooks (admin) --------------------------------------------------------

  app.post(
    '/groups/:groupUid/webhooks',
    requireAdmin,
    withDb(async (req, res, db) => {
      const url = validateWebhookUrl(req.body?.url, Boolean(deps.getConfig().allowInsecureWebhookUrls));
      const secret = generateWebhookSecret();
      const rows = await db.query(
        `INSERT INTO webhook_subscriptions (group_uid, url, secret, delivered_sequence)
         SELECT uid, $2, $3, last_sequence FROM groups WHERE uid = $1 AND is_deleted = false
         RETURNING id, group_uid, url, is_active, delivered_sequence, created_at`,
        [req.params.groupUid, url, secret]
      );
      if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', `Group ${req.params.groupUid} not found`);
      // The secret is returned only once; store it on the receiving side to verify signatures.
      res.status(201).json({ ...webhookView(rows[0]!), secret });
    })
  );

  app.get(
    '/groups/:groupUid/webhooks',
    requireAdmin,
    withDb(async (req, res, db) => {
      const rows = await db.query('SELECT * FROM webhook_subscriptions WHERE group_uid = $1 ORDER BY created_at', [req.params.groupUid]);
      res.json({ webhooks: rows.map(webhookView) });
    })
  );

  app.delete(
    '/webhooks/:id',
    requireAdmin,
    withDb(async (req, res, db) => {
      const rows = await db.query('DELETE FROM webhook_subscriptions WHERE id = $1 RETURNING id', [parseUuid(req.params.id)]);
      if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Webhook not found');
      res.status(204).end();
    })
  );

  app.post(
    '/webhooks/:id/reactivate',
    requireAdmin,
    withDb(async (req, res, db) => {
      const rows = await db.query(
        `UPDATE webhook_subscriptions SET is_active = true, attempts = 0, next_attempt_at = now(), last_error = NULL
          WHERE id = $1 RETURNING *`,
        [parseUuid(req.params.id)]
      );
      if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Webhook not found');
      scheduleDispatch(rows[0]!.group_uid);
      res.json(webhookView(rows[0]!));
    })
  );

  app.post(
    '/notifications/dispatch',
    requireAdmin,
    withDb(async (_req, res, db) => {
      res.json(await dispatchNotifications(db, notifierOptions()));
    })
  );

  // --- Errors ------------------------------------------------------------------

  app.use((req, _res, next) => next(new HttpError(404, 'ENDPOINT_NOT_FOUND', `Route ${req.method} ${req.path} not found`)));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Malformed JSON body' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' });
      return;
    }
    console.error('unhandled error', err);
    // Mutations processed before the failure are committed and replay idempotently on retry.
    const transient = isRetryableDbError(err) || /^(08|57P|53)/.test(String(err?.code ?? '')) || err?.code === 'ECONNREFUSED';
    res.status(transient ? 503 : 500).json({
      error: transient ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_SERVER_ERROR',
      message: transient ? 'Temporary database error; retry the request' : 'Unexpected server error',
    });
  });

  return app;
}

function parseNonNegativeInt(v: unknown, fallback: number, name: string): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'BAD_REQUEST', `${name} must be a non-negative integer`);
  return n;
}

function parseUuid(v: unknown): string {
  const s = String(v);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new HttpError(404, 'NOT_FOUND', 'Webhook not found');
  }
  return s;
}

function validateWebhookUrl(v: unknown, allowInsecure: boolean): string {
  let url: URL;
  try {
    url = new URL(String(v));
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'url must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new HttpError(400, 'BAD_REQUEST', 'Webhook url must use https');
  }
  if (url.username || url.password) throw new HttpError(400, 'BAD_REQUEST', 'Webhook url must not contain credentials');
  return url.toString();
}

function webhookView(row: Record<string, any>) {
  return {
    id: row.id,
    groupUid: row.group_uid,
    url: row.url,
    isActive: row.is_active,
    deliveredSequence: row.delivered_sequence,
    attempts: row.attempts ?? 0,
    lastError: row.last_error ?? null,
    lastDeliveredAt: row.last_delivered_at ?? null,
    createdAt: row.created_at,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
