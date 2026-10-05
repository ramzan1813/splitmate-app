// Postgres access layer. Workers cannot share sockets across requests, so every
// request (and every scheduled run) opens its own connection and closes it when done.
import pg from 'pg';

export type Row = Record<string, any>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Database extends Queryable {
  /** Runs fn inside BEGIN/COMMIT; any throw rolls back. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type OpenDatabase = () => Promise<Database>;

// int8 (BIGINT/BIGSERIAL) arrives as a string by default. Sequences, ids and cent
// amounts stay far below 2^53, so convert to number at the driver boundary.
const INT8_OID = 20;
const types = {
  getTypeParser(oid: number, format?: any) {
    if (oid === INT8_OID) return (v: string) => Number(v);
    return (pg.types.getTypeParser as any)(oid, format);
  },
};

export function pgDatabaseFactory(connectionString: string): OpenDatabase {
  return async () => {
    const client = new pg.Client({ connectionString, types });
    await client.connect();
    let inTransaction = false;
    const query = async <T extends Row>(sql: string, params: unknown[] = []) =>
      (await client.query(sql, params as any[])).rows as T[];

    return {
      query,
      async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
        if (inTransaction) throw new Error('Nested transactions are not supported');
        inTransaction = true;
        await client.query('BEGIN');
        try {
          const result = await fn({ query });
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          inTransaction = false;
        }
      },
      async close() {
        await client.end().catch(() => {});
      },
    };
  };
}

/** Postgres SQLSTATEs that mean "the same work may succeed if retried". */
export function isRetryableDbError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '23505' /* unique_violation from a concurrent insert */
    || code === '40001' /* serialization_failure */
    || code === '40P01'; /* deadlock_detected */
}
