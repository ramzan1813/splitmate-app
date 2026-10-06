// Cloudflare Worker entry: Express served through the Workers Node HTTP server bridge,
// plus a cron trigger that retries pending webhook / push notifications.
import { httpServerHandler } from 'cloudflare:node';
import { env, waitUntil } from 'cloudflare:workers';
import { createApp, AppConfig } from './app';
import { pgDatabaseFactory, withDefaultTls } from './db';
import { dispatchNotifications } from './notifications';
import { HttpError } from './syncService';

export { RelayRoom } from './legacyRelayRoom';

export interface Env {
  /** Optional Hyperdrive binding in front of Supabase (recommended for production). */
  HYPERDRIVE?: { connectionString: string };
  /** Supabase Postgres connection string (secret). Used when HYPERDRIVE is not bound. */
  DATABASE_URL?: string;
  ADMIN_API_KEY?: string;
  EXPO_ACCESS_TOKEN?: string;
  ALLOW_INSECURE_WEBHOOK_URLS?: string;
}

function connectionString(e: Env): string {
  // Hyperdrive terminates TLS to the origin itself, so only the direct URL gets the TLS default.
  if (e.HYPERDRIVE?.connectionString) return e.HYPERDRIVE.connectionString;
  if (!e.DATABASE_URL) throw new HttpError(503, 'DATABASE_NOT_CONFIGURED', 'Bind HYPERDRIVE or set the DATABASE_URL secret');
  return withDefaultTls(e.DATABASE_URL);
}

function readConfig(e: Env): AppConfig {
  return {
    adminApiKey: e.ADMIN_API_KEY || undefined,
    expoAccessToken: e.EXPO_ACCESS_TOKEN || undefined,
    allowInsecureWebhookUrls: e.ALLOW_INSECURE_WEBHOOK_URLS === 'true',
  };
}

const workerEnv = env as unknown as Env;
const PORT = 8080;

const app = createApp({
  openDb: () => pgDatabaseFactory(connectionString(workerEnv))(),
  getConfig: () => readConfig(workerEnv),
  defer: (work) => waitUntil(work),
  fetch: (input, init) => fetch(input, init),
});
app.listen(PORT);

const http = httpServerHandler({ port: PORT });

export default {
  fetch: http.fetch,

  async scheduled(_controller: ScheduledController, e: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const db = await pgDatabaseFactory(connectionString(e))();
        try {
          const summary = await dispatchNotifications(db, {
            fetch: (input, init) => fetch(input, init),
            expoAccessToken: readConfig(e).expoAccessToken,
          });
          console.log('notification dispatch', JSON.stringify(summary));
        } finally {
          await db.close();
        }
      })()
    );
  },
} satisfies ExportedHandler<Env>;
