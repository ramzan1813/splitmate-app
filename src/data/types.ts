export type SplitType = 'equal' | 'unequal' | 'percent' | 'shares';
export type TxType = 'expense' | 'payment';
export type PermissionModel = 'admin_only' | 'contributor' | 'collaborative';

export interface Group {
  id: number;
  uid: string;
  name: string;
  description: string;
  currency: string;
  permissionModel: PermissionModel;
  creatorId: string;
  creatorName: string;
  serverVersion?: number;
  isDeleted?: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupListItem extends Group {
  memberCount: number;
  totalExpenses: number;
  myBalance: number;
  hasMe: boolean;
}

export interface Member {
  id: number;
  uid?: string;
  name: string;
  isMe: boolean;
  memberUid?: string;
  userId?: string | null;
  serverVersion?: number;
  isDeleted?: boolean;
  deletedAt?: string;
}

export interface Split {
  memberId: number;
  value: number;
  share: number;
}

export interface Transaction {
  id: number;
  uid?: string; // unique ID across peers
  groupId: number;
  type: TxType;
  title: string;
  amount: number; // cents
  paidBy: number;
  splitType: SplitType;
  category: string;
  note: string;
  date: string; // YYYY-MM-DD
  authorId?: string;
  authorName?: string;
  updatedById?: string;
  updatedByName?: string;
  updatedTs?: number;
  /** When it was created (epoch ms, creating phone's clock). Synced and never changed; null when unknown. */
  createdTs?: number | null;
  serverVersion?: number;
  isDeleted?: boolean;
  deletedAt?: string;
  splits: Split[];
  createdAt: string;
  updatedAt: string;
}

export interface MemberStat {
  memberId: number;
  name: string;
  totalPaid: number;
  paymentsMade: number;
  paymentsReceived: number;
  totalBenefit: number;
  balance: number;
}

export interface Settlement {
  from: number;
  to: number;
  amount: number;
}

export interface GroupSummary {
  group: Group;
  members: Member[];
  stats: MemberStat[];
  settlements: Settlement[];
  directSettlements: Settlement[];
  /** groupBalance = totalPayments - totalExpenses (cents); negative when spending exceeds money paid in. */
  totals: { totalExpenses: number; totalPayments: number; groupBalance: number; expenseCount: number; paymentCount: number };
  categories: { name: string; amount: number }[];
  myMemberId: number | null;
  myIdentityId: string;
  isCreator: boolean;
  canAdd: boolean;
  canAddMember: boolean;
  transactions: Transaction[];
}

/** Input for creating/updating a transaction. Amounts are decimals (e.g. 12.5), not cents. */
export interface TxInput {
  type: TxType;
  title?: string;
  amount: number;
  paidBy: number;
  to?: number; // payment receiver
  splitType?: SplitType;
  splits?: { memberId: number; value?: number }[];
  category?: string;
  note?: string;
  date?: string;
}

// ---------- Synchronization Foundation Types ----------

export type SyncEntityType = 'group' | 'member' | 'transaction';
export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'conflict';
/** pending: waiting to be sent · sending: in a push · failed: rejected by the server · conflict: version conflict */
export type OutboxStatus = 'pending' | 'sending' | 'failed' | 'conflict';

export interface OutboxMutation<T = unknown> {
  id?: number;
  clientMutationId: string;
  groupUid: string;
  entityType: SyncEntityType;
  entityUid: string;
  operation: SyncOperation;
  expectedVersion: number;
  payload: T;
  createdAt: string;
  retryCount: number;
  status: OutboxStatus;
  errorMessage?: string;
}

export interface SyncState {
  groupUid: string;
  deviceId: string;
  lastServerSequence: number;
  lastSyncAt: string | null;
  syncStatus: SyncStatus;
  errorDetail?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ServerChange<T = unknown> {
  changeId: string;
  sequence: number;
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
  mutations: {
    clientMutationId: string;
    entityType: SyncEntityType;
    entityUid: string;
    operation: SyncOperation;
    expectedVersion: number;
    payload: unknown;
  }[];
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

/** GET /sync/bootstrap/:groupUid — the server's complete current copy of a group (wire shape, see relay/src/types.ts). */
export interface GroupBootstrapResponse {
  groupUid: string;
  serverSequence: number;
  group: {
    uid: string;
    name: string;
    description?: string;
    currency: string;
    permissionModel: PermissionModel;
    creatorId: string;
    creatorName: string;
    serverVersion: number;
    createdAt: string;
    updatedAt: string;
  };
  members: { uid: string; name: string; userId?: string | null; serverVersion: number }[];
  transactions: {
    uid: string;
    type: TxType;
    title: string;
    amount: number;
    paidByMemberUid: string;
    splitType: SplitType;
    category: string;
    note: string;
    date: string;
    authorId: string;
    authorName: string;
    updatedById?: string;
    updatedByName?: string;
    updatedTs?: number;
    createdTs?: number | null;
    serverVersion: number;
    createdAt: string;
    updatedAt: string;
    splits: { memberUid: string; value: number; share: number }[];
  }[];
}

export interface SyncNotification {
  id: number;
  groupUid: string;
  authorName: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface RealtimeNotification {
  type: 'CHANGES_AVAILABLE';
  groupUid: string;
  latestSequence?: number;
  actorId?: string;
  timestamp: string;
}

export class AppError extends Error {}

