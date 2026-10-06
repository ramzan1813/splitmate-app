// Applies relay/migrations/*.sql to Postgres (Neon, Supabase, local) in filename order, once each.
// Usage: DATABASE_URL="postgresql://..." npm run migrate
// Use a direct or session connection string (not a transaction pooler). Non-local hosts get
// verified TLS unless the URL sets sslmode (see withDefaultTls).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { withDefaultTls } from '../src/db.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const dir = join(import.meta.dirname, '..', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: withDefaultTls(url) });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
  const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip   ${file}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`apply  ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
} finally {
  await client.end();
}
