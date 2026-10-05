// Server-authoritative permission rules (ADMIN_ONLY, CONTRIBUTOR, COLLABORATIVE).
// Evaluated inside the mutation transaction against the locked group row.
import { Queryable } from './db';
import { SyncEntityType, SyncOperation } from './types';

export interface GroupRow {
  uid: string;
  creator_id: string;
  permission_model: string;
  is_deleted: boolean;
  server_version: number;
  last_sequence: number;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export async function checkPermission(
  tx: Queryable,
  group: GroupRow | null,
  actorId: string,
  entityType: SyncEntityType,
  operation: SyncOperation,
  entityUid: string
): Promise<PermissionCheckResult> {
  // Creating a group makes the actor its creator; existence is checked by the caller.
  if (entityType === 'group' && operation === 'create') return { allowed: true };

  if (!group || group.is_deleted) {
    return { allowed: false, reason: 'Group not found or deleted' };
  }

  if (group.creator_id === actorId) return { allowed: true };

  if (entityType === 'group') {
    return { allowed: false, reason: 'Only the group creator can modify group settings or delete the group' };
  }

  const model = (group.permission_model || 'COLLABORATIVE').toUpperCase();
  const isAuthor = async () => {
    const rows = await tx.query<{ author_id: string }>(
      'SELECT author_id FROM transactions WHERE tx_uid = $1 AND group_uid = $2',
      [entityUid, group.uid]
    );
    return rows[0]?.author_id === actorId;
  };

  if (model === 'ADMIN_ONLY') {
    return { allowed: false, reason: 'This group is ADMIN_ONLY: only the admin can add, edit, or delete records' };
  }

  if (model === 'CONTRIBUTOR') {
    if (entityType === 'transaction') {
      if (operation === 'create' || (await isAuthor())) return { allowed: true };
      return { allowed: false, reason: 'In CONTRIBUTOR mode, you can only modify or delete your own transactions' };
    }
    if (operation === 'create') return { allowed: true };
    return { allowed: false, reason: 'Only the group creator can modify or remove members in CONTRIBUTOR mode' };
  }

  // COLLABORATIVE: anyone edits (with audit fields), only author/creator deletes.
  if (entityType === 'transaction') {
    if (operation !== 'delete' || (await isAuthor())) return { allowed: true };
    return { allowed: false, reason: 'Only the author or group creator can delete this transaction' };
  }
  if (operation === 'delete') {
    return { allowed: false, reason: 'Only the group creator can delete members' };
  }
  return { allowed: true };
}
