// Server-authoritative Permission Engine for SplitMate Relay
import { ServerDB } from './db';

export interface GroupAuthContext {
  groupUid: string;
  actorId: string;
  deviceId: string;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Check whether an actor has permission to perform an operation on an entity. */
export function checkServerPermission(
  db: ServerDB,
  context: GroupAuthContext,
  entityType: 'group' | 'member' | 'transaction',
  operation: 'create' | 'update' | 'delete',
  entityUid?: string,
  existingEntity?: any
): PermissionCheckResult {
  const { groupUid, actorId } = context;

  // 1. Fetch group metadata
  const group = db.get<{
    uid: string;
    creator_id: string;
    permission_model: string;
    is_deleted: number;
  }>('SELECT uid, creator_id, permission_model, is_deleted FROM groups WHERE uid = ?', [groupUid]);

  // If creating group, actor becomes creator
  if (entityType === 'group' && operation === 'create') {
    return { allowed: true };
  }

  if (!group || group.is_deleted) {
    return { allowed: false, reason: 'Group not found or deleted' };
  }

  const isCreator = group.creator_id === actorId;
  const permModel = (group.permission_model || 'COLLABORATIVE').toUpperCase();

  // 2. Creator always has full admin permissions
  if (isCreator) {
    return { allowed: true };
  }

  // 3. Group settings and permission changes are strictly creator-only
  if (entityType === 'group') {
    return { allowed: false, reason: 'Only the group creator can modify group settings or delete the group' };
  }

  // 4. ADMIN_ONLY group model
  if (permModel === 'ADMIN_ONLY') {
    return { allowed: false, reason: 'This group is ADMIN_ONLY: only the admin can add, edit, or delete records' };
  }

  // 5. CONTRIBUTOR group model
  if (permModel === 'CONTRIBUTOR') {
    if (entityType === 'transaction') {
      if (operation === 'create') {
        return { allowed: true };
      }
      const tx = existingEntity ?? db.get<{ author_id: string }>('SELECT author_id FROM transactions WHERE tx_uid = ? AND group_uid = ?', [entityUid!, groupUid]);
      if (tx && tx.author_id === actorId) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'In CONTRIBUTOR mode, you can only modify or delete your own transactions' };
    }
    if (entityType === 'member') {
      if (operation === 'create') {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Only the group creator can modify or remove members in CONTRIBUTOR mode' };
    }
  }

  // 6. COLLABORATIVE group model
  if (permModel === 'COLLABORATIVE') {
    if (entityType === 'transaction') {
      if (operation === 'create') {
        return { allowed: true };
      }
      if (operation === 'update') {
        // In collaborative mode, all members can edit expenses (audit trail is maintained)
        return { allowed: true };
      }
      if (operation === 'delete') {
        const tx = existingEntity ?? db.get<{ author_id: string }>('SELECT author_id FROM transactions WHERE tx_uid = ? AND group_uid = ?', [entityUid!, groupUid]);
        if (tx && tx.author_id === actorId) {
          return { allowed: true };
        }
        return { allowed: false, reason: 'Only the author or group creator can delete this transaction' };
      }
    }
    if (entityType === 'member') {
      if (operation === 'create' || operation === 'update') {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Only the group creator can delete members' };
    }
  }

  return { allowed: true };
}
