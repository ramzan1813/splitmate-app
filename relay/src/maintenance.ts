// Maintenance: finding transactions that were uploaded twice, and removing the extra copies the
// only way phones learn about it, through ordinary delete mutations (tombstones in the change log).
// Never delete rows from the tables directly: phones keep their copies forever.
import type { Queryable } from './db';
import type { PushMutationsRequest } from './types';

export interface DuplicateCopy {
  txUid: string;
  serverVersion: number;
  authorName: string;
  createdAt: string;
}

export interface DuplicateCluster {
  groupUid: string;
  groupName: string;
  creatorId: string;
  creatorName: string;
  title: string;
  amount: number;
  date: string;
  /** The first upload (earliest created_at): kept. */
  keep: DuplicateCopy;
  /** Later uploads of the same transaction: removed. */
  remove: DuplicateCopy[];
}

export interface DuplicateReport {
  /** Same group, type, title, amount, date, payer, splits AND the same creation timestamp (ms): one transaction uploaded more than once. */
  copies: DuplicateCluster[];
  /** Same everything but without a creation timestamp: may be separate real expenses. Listed for a person to review, never removed. */
  needsReview: DuplicateCluster[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/** Read-only. Run inside a READ ONLY transaction against production. */
export async function findDuplicateTransactions(db: Queryable): Promise<DuplicateReport> {
  const rows = await db.query<{
    tx_uid: string;
    group_uid: string;
    group_name: string;
    creator_id: string;
    creator_name: string;
    title: string;
    amount: string | number;
    date: string;
    created_ts: string | number | null;
    created_at: Date | string;
    author_name: string;
    server_version: number;
    cluster: string | number;
  }>(
    `WITH live AS (
       SELECT t.*,
              (SELECT string_agg(s.member_uid || ':' || s.share::text, ',' ORDER BY s.member_uid)
                 FROM transaction_splits s WHERE s.transaction_uid = t.tx_uid) AS splits_sig
         FROM transactions t
        WHERE NOT t.is_deleted),
     keyed AS (
       SELECT l.*, g.name AS group_name, g.creator_id, g.creator_name,
              count(*) OVER w AS n,
              dense_rank() OVER (ORDER BY l.group_uid, l.type, lower(trim(l.title)), l.amount, l.date,
                                          l.paid_by_member_uid, l.splits_sig, l.created_ts NULLS FIRST) AS cluster
         FROM live l JOIN groups g ON g.uid = l.group_uid
        WHERE NOT g.is_deleted
       WINDOW w AS (PARTITION BY l.group_uid, l.type, lower(trim(l.title)), l.amount, l.date,
                                 l.paid_by_member_uid, l.splits_sig, l.created_ts))
     SELECT tx_uid, group_uid, group_name, creator_id, creator_name, title, amount, date, created_ts,
            created_at, author_name, server_version, cluster
       FROM keyed
      WHERE n > 1
      ORDER BY cluster, created_at, id`
  );

  const clusters = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = String(r.cluster);
    clusters.set(key, [...(clusters.get(key) ?? []), r]);
  }

  const report: DuplicateReport = { copies: [], needsReview: [] };
  for (const list of clusters.values()) {
    const [first, ...rest] = list;
    const copy = (r: (typeof rows)[number]): DuplicateCopy => ({
      txUid: r.tx_uid,
      serverVersion: r.server_version,
      authorName: r.author_name,
      createdAt: iso(r.created_at),
    });
    const cluster: DuplicateCluster = {
      groupUid: first!.group_uid,
      groupName: first!.group_name,
      creatorId: first!.creator_id,
      creatorName: first!.creator_name,
      title: first!.title,
      amount: Number(first!.amount),
      date: first!.date,
      keep: copy(first!),
      remove: rest.map(copy),
    };
    (first!.created_ts == null ? report.needsReview : report.copies).push(cluster);
  }
  return report;
}

/**
 * One push per group that deletes the extra copies as the group's creator (allowed to delete any
 * transaction in every permission model). clientMutationIds are derived from the transaction, so
 * running the cleanup twice is idempotent.
 */
export function buildDuplicateDeletes(copies: DuplicateCluster[]): PushMutationsRequest[] {
  const byGroup = new Map<string, PushMutationsRequest>();
  for (const c of copies) {
    const req = byGroup.get(c.groupUid) ?? {
      groupUid: c.groupUid,
      deviceId: 'maintenance-dedupe',
      actorId: c.creatorId,
      actorName: c.creatorName,
      mutations: [],
    };
    for (const r of c.remove) {
      req.mutations.push({
        clientMutationId: `dedupe-${r.txUid}`,
        entityType: 'transaction',
        entityUid: r.txUid,
        operation: 'delete',
        expectedVersion: r.serverVersion,
        payload: { txUid: r.txUid },
      });
    }
    byGroup.set(c.groupUid, req);
  }
  return [...byGroup.values()];
}
