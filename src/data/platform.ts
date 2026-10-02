// Wires expo-sqlite into the data layer. Imported once from the root layout.
import * as SQLite from 'expo-sqlite';
import { DB, Param, setDbOpener } from './db';

setDbOpener(async () => {
  const raw = await SQLite.openDatabaseAsync('splitmate.db');
  await raw.execAsync('PRAGMA journal_mode = WAL;');
  const db: DB = {
    execAsync: (sql) => raw.execAsync(sql),
    runAsync: async (sql, params: Param[]) => {
      const r = await raw.runAsync(sql, params);
      return { lastInsertRowId: Number(r.lastInsertRowId), changes: r.changes };
    },
    getFirstAsync: (sql, params) => raw.getFirstAsync(sql, params),
    getAllAsync: (sql, params) => raw.getAllAsync(sql, params),
    withTransactionAsync: (task) => raw.withTransactionAsync(task),
  };
  return db;
});
