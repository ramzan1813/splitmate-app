// Synchronization Data Types for SplitMate Server
export type SyncEntityType = 'group' | 'member' | 'transaction';
export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'conflict';
export type PermissionModel = 'admin_only' | 'contributor' | 'collaborative';
export type TxType = 'expense' | 'payment';

export interface Group {
  id: number;
  uid: string;
  name: string;
  description?: string;
  currency: string;
  permissionModel: PermissionModel;
  creatorId: string;
  creatorName: string;
  syncKey?: string;
  serverVersion: number;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: number;
  uid: string;
  memberUid: string;
  name: string;
  userId?: string;
  role?: string;
  isMe?: boolean;
  serverVersion: number;
  isDeleted: boolean;
}

export interface Split {
  memberId?: number;
  memberUid?: string;
  memberName?: string;
  value: number;
  share: number;
}

export interface Transaction {
  id: number;
  uid: string;
  groupId: number;
  type: TxType;
  title: string;
  amount: number;
  paidBy: number;
  paidByMemberUid?: string;
  paidByName?: string;
  splitType: 'equal' | 'exact' | 'percentage' | 'unequal';
  category: string;
  note: string;
  date: string;
  authorId: string;
  authorName: string;
  updatedById?: string;
  updatedByName?: string;
  updatedTs?: number;
  serverVersion: number;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  splits: Split[];
}

export interface ServerChange<T = any> {
  sequence: number;
  changeId: string;
  groupUid: string;
  entityType: SyncEntityType;
  entityUid: string;
  operation: SyncOperation;
  actorId: string;
  deviceId: string;
  entityVersion: number;
  payload: T;
  createdAt: string;
}

export interface PushMutationsRequest {
  groupUid: string;
  deviceId: string;
  actorId?: string;
  actorName?: string;
  mutations: Array<{
    clientMutationId: string;
    entityType: SyncEntityType;
    entityUid: string;
    operation: SyncOperation;
    expectedVersion: number;
    payload: any;
  }>;
}

export interface PushMutationResult {
  clientMutationId: string;
  status: 'ACCEPTED' | 'CONFLICT' | 'REJECTED';
  entityUid: string;
  serverVersion?: number;
  serverSequence?: number;
  error?: string;
  message?: string;
}

export interface PushMutationsResponse {
  groupUid: string;
  results: PushMutationResult[];
}

export interface PullChangesResponse {
  groupUid: string;
  latestServerSequence: number;
  hasMore: boolean;
  changes: ServerChange[];
}

export interface GroupBootstrapResponse {
  groupUid: string;
  serverSequence: number;
  group: Group;
  members: Member[];
  transactions: Transaction[];
}

export interface RealtimeNotification {
  type: 'CHANGES_AVAILABLE';
  groupUid: string;
  latestSequence?: number;
  actorId?: string;
  timestamp: string;
}
