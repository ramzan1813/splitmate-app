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
  syncKey?: string; // 256-bit AES encryption key for E2EE sync
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
  name: string;
  isMe: boolean;
  memberUid?: string;
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
  totals: { totalExpenses: number; expenseCount: number; paymentCount: number };
  categories: { name: string; amount: number }[];
  myMemberId: number | null;
  myIdentityId: string;
  isCreator: boolean;
  canAdd: boolean;
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

export type SyncAction = 'UPSERT_TX' | 'DELETE_TX' | 'UPDATE_GROUP' | 'JOIN_GROUP' | 'REQUEST_STATE' | 'STATE_SNAPSHOT' | 'MERGE_MEMBERS';

export interface SyncEvent<T = unknown> {
  eventId: string;
  groupUid: string;
  authorId: string;
  authorName: string;
  timestamp: number;
  action: SyncAction;
  payload: T;
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

export class AppError extends Error {}
