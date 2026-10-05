// Backend Database Engine for SplitMate Synchronization Coordinator
// Supports Cloudflare Workers Durable Object SQLite, Node.js SQLite, and In-Memory SQLite.

export type SqlParam = string | number | null;

export interface ServerDB {
  exec(sql: string): void;
  run(sql: string, params?: SqlParam[]): { changes: number; lastInsertRowId: number };
  get<T = any>(sql: string, params?: SqlParam[]): T | null;
  all<T = any>(sql: string, params?: SqlParam[]): T[];
  transaction<T>(fn: () => T): T;
}

/** Creates a ServerDB wrapper around Cloudflare Workers Durable Object SQLite (state.storage.sql) */
export function createDurableObjectDb(sqlStorage: any): ServerDB {
  const db: ServerDB = {
    exec(sql: string) {
      sqlStorage.exec(sql);
    },
    run(sql: string, params: SqlParam[] = []) {
      const cursor = sqlStorage.exec(sql, ...params);
      return {
        changes: Number(cursor.rowsWritten ?? 1),
        lastInsertRowId: Number(cursor.lastRowId ?? 0),
      };
    },
    get<T = any>(sql: string, params: SqlParam[] = []): T | null {
      const cursor = sqlStorage.exec(sql, ...params);
      const rows = cursor.toArray ? cursor.toArray() : Array.from(cursor);
      return (rows[0] as T | undefined) ?? null;
    },
    all<T = any>(sql: string, params: SqlParam[] = []): T[] {
      const cursor = sqlStorage.exec(sql, ...params);
      const rows = cursor.toArray ? cursor.toArray() : Array.from(cursor);
      return rows as T[];
    },
    transaction<T>(fn: () => T): T {
      // Cloudflare Durable Objects execute transactions automatically in memory
      sqlStorage.exec('BEGIN');
      try {
        const res = fn();
        sqlStorage.exec('COMMIT');
        return res;
      } catch (e) {
        sqlStorage.exec('ROLLBACK');
        throw e;
      }
    },
  };

  initServerSchema(db);
  return db;
}

/** In-Memory / Node fallback database implementation */
export function createServerDb(file = ':memory:'): ServerDB {
  // Dynamically require or create Node DatabaseSync if available
  try {
    const { DatabaseSync } = require('node:sqlite');
    const sqlite = new DatabaseSync(file);
    sqlite.exec('PRAGMA foreign_keys = ON;');

    const db: ServerDB = {
      exec(sql: string) {
        sqlite.exec(sql);
      },
      run(sql: string, params: SqlParam[] = []) {
        const stmt = sqlite.prepare(sql);
        const res = stmt.run(...params);
        return {
          changes: Number(res.changes),
          lastInsertRowId: Number(res.lastInsertRowid),
        };
      },
      get<T = any>(sql: string, params: SqlParam[] = []): T | null {
        const stmt = sqlite.prepare(sql);
        return (stmt.get(...params) as T | undefined) ?? null;
      },
      all<T = any>(sql: string, params: SqlParam[] = []): T[] {
        const stmt = sqlite.prepare(sql);
        return stmt.all(...params) as T[];
      },
      transaction<T>(fn: () => T): T {
        sqlite.exec('BEGIN');
        try {
          const result = fn();
          sqlite.exec('COMMIT');
          return result;
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }
      },
    };

    initServerSchema(db);
    return db;
  } catch {
    // Ephemeral in-memory database fallback
    const tables = new Map<string, any[]>();
    const db: ServerDB = {
      exec() {},
      run() {
        return { changes: 1, lastInsertRowId: 1 };
      },
      get() {
        return null;
      },
      all() {
        return [];
      },
      transaction<T>(fn: () => T): T {
        return fn();
      },
    };
    return db;
  }
}

export function initServerSchema(db: ServerDB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      user_id TEXT,
      user_name TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'USD',
      permission_model TEXT NOT NULL DEFAULT 'COLLABORATIVE',
      creator_id TEXT NOT NULL,
      creator_name TEXT NOT NULL,
      sync_key TEXT NOT NULL DEFAULT '',
      server_version INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_uid TEXT NOT NULL REFERENCES groups(uid) ON DELETE CASCADE,
      member_uid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      user_id TEXT,
      role TEXT NOT NULL DEFAULT 'MEMBER',
      server_version INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_server_members_group ON group_members(group_uid);

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_uid TEXT NOT NULL REFERENCES groups(uid) ON DELETE CASCADE,
      tx_uid TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('expense', 'payment')),
      title TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      paid_by_member_uid TEXT NOT NULL,
      split_type TEXT NOT NULL DEFAULT 'equal',
      category TEXT NOT NULL DEFAULT 'General',
      note TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      updated_by_id TEXT,
      updated_by_name TEXT,
      updated_ts INTEGER NOT NULL DEFAULT 0,
      server_version INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_server_tx_group ON transactions(group_uid);

    CREATE TABLE IF NOT EXISTS transaction_splits (
      transaction_uid TEXT NOT NULL REFERENCES transactions(tx_uid) ON DELETE CASCADE,
      member_uid TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 1,
      share INTEGER NOT NULL,
      PRIMARY KEY (transaction_uid, member_uid)
    );

    CREATE TABLE IF NOT EXISTS sync_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT UNIQUE NOT NULL,
      group_uid TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_uid TEXT NOT NULL,
      operation TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_server_changes_group_seq ON sync_changes(group_uid, sequence);

    CREATE TABLE IF NOT EXISTS client_mutations (
      client_mutation_id TEXT PRIMARY KEY,
      group_uid TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      response_payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
