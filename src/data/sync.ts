// Sync notifications (what other members changed) and the local-change signal that tells the
// sync engine a group has new outbox mutations. Server communication lives in syncEngine.ts.
import { DB, getDb, Param } from './db';
import { SyncNotification, Transaction, TxType } from './types';

/** Transaction payload pushed to the server for create/update mutations. */
export interface SyncTxPayload {
  txUid: string;
  type: TxType;
  title: string;
  amount: number; // in cents
  paidByName: string;
  paidByMemberUid?: string;
  splitType: Transaction['splitType'];
  category: string;
  note: string;
  date: string;
  splits: { memberName: string; memberUid?: string; value: number; share: number }[];
  authorId?: string;
  authorName?: string;
  updatedById?: string;
  updatedByName?: string;
  updatedTs: number;
  /** Creation time (epoch ms). The server keeps the first value it receives and ignores it on updates. */
  createdTs?: number;
}

// ---------- Local change signal ----------

type LocalChangeHandler = (groupUid: string) => void;
let localChangeHandler: LocalChangeHandler | null = null;

/** Registers the single handler (the app's sync engine) for local outbox writes. */
export function onLocalChange(handler: LocalChangeHandler): () => void {
  localChangeHandler = handler;
  return () => {
    if (localChangeHandler === handler) localChangeHandler = null;
  };
}

/** Called by the repository after a committed write that enqueued outbox mutations. */
export function signalLocalChange(groupUid: string) {
  try {
    localChangeHandler?.(groupUid);
  } catch {
    // The mutation is durable in the outbox; the next sync trigger pushes it.
  }
}

// ---------- Notifications ----------

export async function recordSyncNotification(
  db: DB,
  n: { groupUid: string; authorName: string; title: string; message: string }
): Promise<void> {
  await db.runAsync(
    'INSERT INTO sync_notifications (group_uid, author_name, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [n.groupUid, n.authorName, n.title, n.message, new Date().toISOString()]
  );
}

/** Get unread notifications for groups. */
export async function getSyncNotifications(groupUid?: string): Promise<SyncNotification[]> {
  const db = await getDb();
  const where = groupUid ? 'WHERE group_uid = ?' : '';
  const params: Param[] = groupUid ? [groupUid] : [];
  const rows = await db.getAllAsync<{
    id: number;
    group_uid: string;
    author_name: string;
    title: string;
    message: string;
    read: number;
    created_at: string;
  }>(`SELECT * FROM sync_notifications ${where} ORDER BY id DESC LIMIT 50`, params);

  return rows.map((r) => ({
    id: r.id,
    groupUid: r.group_uid,
    authorName: r.author_name,
    title: r.title,
    message: r.message,
    read: !!r.read,
    createdAt: r.created_at,
  }));
}

/** Mark all notifications as read. */
export async function markNotificationsRead(groupUid?: string): Promise<void> {
  const db = await getDb();
  if (groupUid) {
    await db.runAsync('UPDATE sync_notifications SET read = 1 WHERE group_uid = ?', [groupUid]);
  } else {
    await db.runAsync('UPDATE sync_notifications SET read = 1', []);
  }
}
