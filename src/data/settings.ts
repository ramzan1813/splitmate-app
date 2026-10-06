// Key/value app settings stored in SQLite. Kept apart from repo.ts so low-level modules
// (identity, PIN) can read settings without importing the whole repository.
import { getDb } from './db';

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return r ? r.value : null;
}

export async function setSetting(key: string, value: string | null) {
  const db = await getDb();
  if (value === null) await db.runAsync('DELETE FROM settings WHERE key = ?', [key]);
  else await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}
