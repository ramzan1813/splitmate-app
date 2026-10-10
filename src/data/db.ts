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

const SCHEMA_VERSION = 10;

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
  4: `
    ALTER TABLE groups ADD COLUMN server_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE groups ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE groups ADD COLUMN deleted_at TEXT;

    ALTER TABLE members ADD COLUMN uid TEXT NOT NULL DEFAULT '';
    ALTER TABLE members ADD COLUMN server_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE members ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE members ADD COLUMN deleted_at TEXT;

    ALTER TABLE transactions ADD COLUMN server_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE transactions ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE transactions ADD COLUMN deleted_at TEXT;

    CREATE TABLE IF NOT EXISTS outbox_mutations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_mutation_id TEXT UNIQUE NOT NULL,
      group_uid TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_uid TEXT NOT NULL,
      operation TEXT NOT NULL,
      expected_version INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_group_status ON outbox_mutations(group_uid, status);
    CREATE INDEX IF NOT EXISTS idx_outbox_mutation_id ON outbox_mutations(client_mutation_id);

    CREATE TABLE IF NOT EXISTS sync_state (
      group_uid TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL,
      last_server_sequence INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      sync_status TEXT NOT NULL DEFAULT 'idle',
      error_detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  // Rows created before v4 have no uid; the server identifies every entity by uid.
  5: `
    UPDATE members SET uid = 'mem_' || lower(hex(randomblob(12))) WHERE uid = '';
    UPDATE transactions SET uid = 'tx_' || lower(hex(randomblob(12))) WHERE uid = '';
  `,
  // The encrypted WebSocket relay's event log; the outbox replaced it.
  6: `
    DROP INDEX IF EXISTS idx_sync_events_group;
    DROP INDEX IF EXISTS idx_sync_events_synced;
    DROP TABLE IF EXISTS sync_events;
  `,
  // When each transaction was created (epoch ms, creating phone's clock); set once, synced, never edited.
  // Backfill matches the server's: a never-edited transaction's updated_ts is still its creation time.
  7: `
    ALTER TABLE transactions ADD COLUMN created_ts INTEGER;
    UPDATE transactions SET created_ts = updated_ts WHERE updated_by_id = '' AND updated_ts > 0;
  `,
  // A group being removed from this phone: 'leave' (member; local only) or 'delete' (admin; erased
  // on the server). It is hidden at once and erased locally after its queued changes are sent.
  8: `
    ALTER TABLE groups ADD COLUMN removal TEXT;
  `,
  // Connected user identity on members table (real user vs dummy user)
  9: `
    ALTER TABLE members ADD COLUMN user_id TEXT;
  `,
  // Repair for files imported by v2.1.0 and earlier: those rows were saved with uid '' and no
  // author. Everything else (sync payloads, edits) called them tx_<id> / mem_<id>, but lookups by uid
  // never found them, so each replay of their server changes inserted another copy.
  //  1. Groups with such rows replay their change log from 0 (upload marker kept: nothing is
  //     re-uploaded), so deletes and edits the server sent to tx_<id> now reach the row.
  //  2. Give the rows the uid they were already synced under.
  //  3. Rows sharing one uid in a group are the same transaction: keep one (highest server_version,
  //     then the one with an author, then the oldest row) and drop the other local copies.
  //  4. From now on a transaction uid is unique per group.
  10: `
    UPDATE sync_state SET last_server_sequence = 0
     WHERE group_uid IN (
       SELECT g.uid FROM groups g
        WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.group_id = g.id AND (t.uid IS NULL OR t.uid = ''))
           OR EXISTS (SELECT 1 FROM members m WHERE m.group_id = g.id AND (m.uid IS NULL OR m.uid = ''))
           OR EXISTS (SELECT 1 FROM transactions t JOIN transactions o ON o.group_id = t.group_id AND o.uid = t.uid AND o.id <> t.id
                       WHERE t.group_id = g.id AND t.uid <> ''));

    UPDATE transactions SET uid = 'tx_' || id WHERE uid IS NULL OR uid = '';
    UPDATE members SET uid = 'mem_' || id WHERE uid IS NULL OR uid = '';

    CREATE TEMP TABLE tx_copies AS
      SELECT t.id FROM transactions t
       WHERE EXISTS (
         SELECT 1 FROM transactions k
          WHERE k.group_id = t.group_id AND k.uid = t.uid AND k.id <> t.id
            AND (k.server_version > t.server_version
                 OR (k.server_version = t.server_version AND (k.author_name <> '') > (t.author_name <> ''))
                 OR (k.server_version = t.server_version AND (k.author_name <> '') = (t.author_name <> '') AND k.id < t.id)));
    DELETE FROM transaction_splits WHERE transaction_id IN (SELECT id FROM tx_copies);
    DELETE FROM transactions WHERE id IN (SELECT id FROM tx_copies);
    DROP TABLE tx_copies;

    CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_group_uid ON transactions(group_id, uid);
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
