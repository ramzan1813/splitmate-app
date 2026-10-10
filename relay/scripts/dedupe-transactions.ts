// Finds transactions that were uploaded more than once and, with --apply, deletes the extra copies
// through the sync server's own /sync/push, so every phone receives the delete from the change log.
//
// Usage (dry run, prints the plan only):
//   DATABASE_URL="postgresql://..." SERVER_URL="https://splitmate-relay..." npm run dedupe
// Apply:
//   DATABASE_URL="..." SERVER_URL="..." npm run dedupe -- --apply
//
// The database is only read, inside a READ ONLY transaction. Copies are removed only when they match
// the kept transaction in every field including the millisecond creation time; look-alikes without a
// creation time are listed for review and never touched.
import pg from 'pg';
import { withDefaultTls } from '../src/db.ts';
import { buildDuplicateDeletes, findDuplicateTransactions } from '../src/maintenance.ts';

const url = process.env.DATABASE_URL;
const server = (process.env.SERVER_URL ?? '').replace(/\/+$/, '');
const apply = process.argv.includes('--apply');
if (!url || !server) {
  console.error('DATABASE_URL and SERVER_URL are required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: withDefaultTls(url) });
await client.connect();
let report;
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  report = await findDuplicateTransactions({ query: async (sql, params) => (await client.query(sql, params as unknown[])).rows });
  await client.query('COMMIT');
} finally {
  await client.end();
}

// DATABASE_URL and SERVER_URL must be the same database. Confirm through the server itself that
// every kept and removed transaction exists there at the version read above; skip groups that don't
// match (or can't be read, e.g. hidden groups) instead of deleting through a different database.
// A copy the server no longer serves (hidden with is_display=false) is skipped too: its delete would
// not reach phones either, because the change feed only carries changes of visible rows.
const served = new Map<string, Map<string, number> | null>();
for (const groupUid of new Set(report.copies.map((c) => c.groupUid))) {
  const res = await fetch(`${server}/sync/bootstrap/${encodeURIComponent(groupUid)}`);
  if (!res.ok) {
    console.log(`server check: group ${groupUid} is not readable through SERVER_URL (HTTP ${res.status})`);
    served.set(groupUid, null);
    continue;
  }
  const snap = (await res.json()) as { serverSequence: number; transactions: { uid: string; serverVersion: number }[] };
  served.set(groupUid, new Map(snap.transactions.map((t) => [t.uid, t.serverVersion])));
}
const money = (cents: number) => (cents / 100).toFixed(2);
const verified = report.copies.filter((c) => {
  const versions = served.get(c.groupUid);
  const all = [c.keep, ...c.remove];
  const missing = all.filter((r) => versions?.get(r.txUid) === undefined);
  const changed = all.filter((r) => versions?.has(r.txUid) && versions.get(r.txUid) !== r.serverVersion);
  if (!missing.length && !changed.length) return true;
  console.log(
    `server check: skipped [${c.groupName}] "${c.title}" ${money(c.amount)} on ${c.date}: ` +
      [missing.length && `not served by SERVER_URL (hidden or a different database): ${missing.map((r) => r.txUid).join(', ')}`,
       changed.length && `version changed since read: ${changed.map((r) => r.txUid).join(', ')}`].filter(Boolean).join('; ')
  );
  return false;
});
if (verified.length < report.copies.length) console.log(`server check: ${report.copies.length - verified.length} transaction(s) skipped\n`);
report.copies = verified;

console.log(`Copies to remove: ${report.copies.reduce((n, c) => n + c.remove.length, 0)} in ${report.copies.length} transaction(s)`);
for (const c of report.copies) {
  console.log(`  [${c.groupName}] "${c.title}" ${money(c.amount)} on ${c.date}: keep ${c.keep.txUid} (by ${c.keep.authorName}, ${c.keep.createdAt})`);
  for (const r of c.remove) console.log(`      remove ${r.txUid} (by ${r.authorName}, ${r.createdAt})`);
}
if (report.needsReview.length) {
  console.log(`\nLook-alikes without a creation time (NOT removed; review by hand): ${report.needsReview.length}`);
  for (const c of report.needsReview) {
    console.log(`  [${c.groupName}] "${c.title}" ${money(c.amount)} on ${c.date}: ${[c.keep, ...c.remove].map((r) => r.txUid).join(', ')}`);
  }
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to delete the copies listed above.');
  process.exit(0);
}

let failed = 0;
for (const req of buildDuplicateDeletes(report.copies)) {
  const res = await fetch(`${server}/sync/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  if (!res.ok) {
    failed += req.mutations.length;
    console.error(`push for group ${req.groupUid} failed: HTTP ${res.status} ${await res.text()}`);
    continue;
  }
  const body = (await res.json()) as { results: { entityUid: string; status: string; error?: string; message?: string }[] };
  for (const r of body.results) {
    if (r.status !== 'ACCEPTED' && r.error !== 'ALREADY_DELETED') failed++;
    console.log(`  ${r.entityUid}: ${r.status}${r.error ? ` ${r.error}` : ''}${r.message ? ` (${r.message})` : ''}`);
  }
}
process.exit(failed ? 1 : 0);
