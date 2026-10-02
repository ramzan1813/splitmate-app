// Test-only adapter: exposes Node's built-in SQLite through the app's DB interface.
import { DatabaseSync } from 'node:sqlite';
import type { DB, Param } from '../src/data/db';

export function createNodeDb(file = ':memory:'): DB {
  const raw = new DatabaseSync(file);
  let depth = 0;
  return {
    async execAsync(sql) {
      raw.exec(sql);
    },
    async runAsync(sql, params: Param[]) {
      const r = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async getFirstAsync<T>(sql: string, params: Param[]) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, params: Param[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async withTransactionAsync(task) {
      if (depth > 0) return task();
      depth++;
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
  };
}
