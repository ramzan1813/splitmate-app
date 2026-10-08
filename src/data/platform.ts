// Wires expo-sqlite into the data layer. Imported once from the root layout.
import * as SQLite from 'expo-sqlite';
import { DB, Param, setDbOpener } from './db';

setDbOpener(async () => {
  const raw = await SQLite.openDatabaseAsync('splitmate.db');
  await raw.execAsync('PRAGMA journal_mode = WAL;');
  // expo-sqlite runs every call on one connection, so two overlapping withTransactionAsync calls
  // (background sync applying server changes while the user saves an expense) would issue a
  // nested BEGIN and fail. Queue transactions so only one is open at a time. Tasks must not
  // start another transaction themselves.
  let txQueue: Promise<unknown> = Promise.resolve();
  const db: DB = {
    execAsync: (sql) => raw.execAsync(sql),
    runAsync: async (sql, params: Param[]) => {
      const r = await raw.runAsync(sql, params);
      return { lastInsertRowId: Number(r.lastInsertRowId), changes: r.changes };
    },
    getFirstAsync: (sql, params) => raw.getFirstAsync(sql, params),
    getAllAsync: (sql, params) => raw.getAllAsync(sql, params),
    withTransactionAsync: (task) => {
      const run = txQueue.then(() => raw.withTransactionAsync(task));
      txQueue = run.catch(() => undefined);
      return run;
    },
  };
  return db;
});
