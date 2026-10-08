// Test harness: runs the real Express app on Node against PGlite (Postgres compiled to
// WASM, in-memory) with the production migrations. Outbound HTTP is captured, not sent.
import { readdirSync, readFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { AppConfig, createApp } from '../src/app';
import { Database, Queryable } from '../src/db';
import { dispatchNotifications, DispatchSummary } from '../src/notifications';

export interface OutboundRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface TestServerOptions {
  config?: AppConfig;
  /** Decides the response for each outbound request (webhooks, Expo). Defaults to 200 + ok tickets. */
  respond?: (req: OutboundRequest) => Response | Promise<Response>;
}

export interface TestServer {
  baseUrl: string;
  pglite: PGlite;
  outbound: OutboundRequest[];
  /** Same shape the old in-process handler returned, so ported tests stay readable. */
  call(req: { method: string; path: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> }): Promise<{
    status: number;
    body: any;
  }>;
  /** Waits for every background task (post-push notification dispatch) to finish. */
  settle(): Promise<void>;
  /** Runs what the cron trigger runs. */
  runScheduledDispatch(): Promise<DispatchSummary>;
  /** Shifts all retry timers into the past so the next dispatch retries immediately. */
  expireRetryTimers(): Promise<void>;
  close(): Promise<void>;
}

const migrationsDir = join(import.meta.dirname, '..', 'migrations');

function pgliteDatabase(pglite: PGlite): Database {
  const query = async <T,>(sql: string, params: unknown[] = []) => (await pglite.query<T>(sql, params as any[])).rows;
  return {
    query: query as Database['query'],
    transaction: (fn) => pglite.transaction((tx) => fn({ query: async (sql, params = []) => (await tx.query(sql, params as any[])).rows } as Queryable)),
    close: async () => {},
  };
}

export function defaultOutboundResponse(req: OutboundRequest): Response {
  if (req.url.includes('exp.host')) {
    const messages = JSON.parse(req.body) as unknown[];
    return Response.json({ data: messages.map(() => ({ status: 'ok', id: crypto.randomUUID() })) });
  }
  return new Response('ok', { status: 200 });
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const pglite = new PGlite();
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await pglite.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  const db = pgliteDatabase(pglite);
  const outbound: OutboundRequest[] = [];
  const pending = new Set<Promise<unknown>>();
  const respond = opts.respond ?? defaultOutboundResponse;

  const fakeFetch: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req: OutboundRequest = { url: String(input), method: init?.method ?? 'GET', headers, body: String(init?.body ?? '') };
    outbound.push(req);
    return respond(req);
  };

  const app = createApp({
    openDb: async () => db,
    getConfig: () => opts.config ?? {},
    defer: (work) => {
      const p = work.finally(() => pending.delete(p));
      pending.add(p);
    },
    fetch: fakeFetch,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    pglite,
    outbound,
    async call({ method, path, query, body, headers }) {
      const qs = query ? `?${new URLSearchParams(query)}` : '';
      const res = await fetch(`${baseUrl}${path}${qs}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, body: parsed };
    },
    async settle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    runScheduledDispatch: () => dispatchNotifications(db, { fetch: fakeFetch }),
    async expireRetryTimers() {
      await pglite.exec(`
        UPDATE webhook_subscriptions SET next_attempt_at = now() - interval '1 second';
        UPDATE device_group_subscriptions SET next_attempt_at = now() - interval '1 second';`);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pglite.close();
    },
  };
}
