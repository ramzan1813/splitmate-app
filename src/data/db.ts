// Database access. On the phone this is expo-sqlite (a file in the app's private storage).
// Tests inject a Node implementation with the same small interface via setDb().

export type Param = string | number | null;

export interface DB {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: Param[]): Promise<{ lastInsertRowId: number; changes: number }>;
  getFirstAsync<T>(sql: string, params: Param[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params: Param[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

const SCHEMA_VERSION = 3;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      is_me INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('expense','payment')),
      title TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      paid_by INTEGER NOT NULL REFERENCES members(id),
      split_type TEXT NOT NULL DEFAULT 'equal',
      category TEXT NOT NULL DEFAULT 'General',
      note TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transaction_splits (
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id),
      value REAL NOT NULL,
      share INTEGER NOT NULL,
      PRIMARY KEY (transaction_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id);
    CREATE INDEX IF NOT EXISTS idx_tx_group ON transactions(group_id);
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_splits_member ON transaction_splits(member_id);
  `,
  2: `
    ALTER TABLE groups ADD COLUMN sync_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE transactions ADD COLUMN uid TEXT NOT NULL DEFAULT '';
    ALTER TABLE transactions ADD COLUMN author_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE transactions ADD COLUMN author_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE transactions ADD COLUMN updated_ts INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      group_uid TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_events_group ON sync_events(group_uid);
    CREATE INDEX IF NOT EXISTS idx_sync_events_synced ON sync_events(synced);

    CREATE TABLE IF NOT EXISTS sync_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_uid TEXT NOT NULL,
      author_name TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_notif_group ON sync_notifications(group_uid);
  `,
  3: `
    ALTER TABLE groups ADD COLUMN permission_model TEXT NOT NULL DEFAULT 'collaborative';
    ALTER TABLE groups ADD COLUMN creator_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE groups ADD COLUMN creator_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE transactions ADD COLUMN updated_by_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE transactions ADD COLUMN updated_by_name TEXT NOT NULL DEFAULT '';
  `,
};

let db: DB | null = null;
let opening: Promise<DB> | null = null;
let opener: (() => Promise<DB>) | null = null;

/** Tests (or alternative platforms) can provide their own database. */
export function setDb(instance: DB | null) {
  db = instance;
  opening = null;
}

/** Registers how to open the platform database (done in src/data/platform.ts). */
export function setDbOpener(fn: () => Promise<DB>) {
  opener = fn;
}

export async function migrate(d: DB) {
  await d.execAsync('PRAGMA foreign_keys = ON;');
  const row = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version', []);
  let version = row?.user_version ?? 0;
  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    await d.withTransactionAsync(async () => {
      await d.execAsync(MIGRATIONS[next]!);
    });
    await d.execAsync(`PRAGMA user_version = ${next}`);
    version = next;
  }
}

export async function getDb(): Promise<DB> {
  if (db) return db;
  if (!opening) {
    if (!opener) throw new Error('Database opener not configured');
    opening = (async () => {
      const d = await opener!();
      await migrate(d);
      db = d;
      return d;
    })();
  }
  return opening;
}
