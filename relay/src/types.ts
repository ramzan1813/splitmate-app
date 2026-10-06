// Wire types for the SplitMate sync API. Shapes match src/data/types.ts in the mobile app.
export type SyncEntityType = 'group' | 'member' | 'transaction';
export type SyncOperation = 'create' | 'update' | 'delete';
export type PermissionModel = 'admin_only' | 'contributor' | 'collaborative';
export type TxType = 'expense' | 'payment';
// Client values (src/data/logic.ts) plus exact/percentage accepted from older payloads.
export type SplitType = 'equal' | 'unequal' | 'percent' | 'shares' | 'exact' | 'percentage';

export const ENTITY_TYPES: readonly SyncEntityType[] = ['group', 'member', 'transaction'];
export const OPERATIONS: readonly SyncOperation[] = ['create', 'update', 'delete'];
export const TX_TYPES: readonly TxType[] = ['expense', 'payment'];
export const SPLIT_TYPES: readonly SplitType[] = ['equal', 'unequal', 'percent', 'shares', 'exact', 'percentage'];

export interface Group {
  id: number;
  uid: string;
  name: string;
  description?: string;
  currency: string;
  permissionModel: PermissionModel;
  creatorId: string;
  creatorName: string;
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
  splitType: SplitType;
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

export interface ServerChange<T = unknown> {
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

export interface PushMutation {
  clientMutationId: string;
  entityType: SyncEntityType;
  entityUid: string;
  operation: SyncOperation;
  expectedVersion: number;
  payload: any;
}

export interface PushMutationsRequest {
  groupUid: string;
  deviceId: string;
  actorId?: string;
  actorName?: string;
  mutations: PushMutation[];
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

/** Body of every outbound notification (webhook POST body and Expo push `data`). */
export interface ChangesAvailableEvent {
  type: 'CHANGES_AVAILABLE';
  groupUid: string;
  latestSequence: number;
  timestamp: string;
}
