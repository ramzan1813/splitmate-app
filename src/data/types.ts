export type SplitType = 'equal' | 'unequal' | 'percent' | 'shares';
export type TxType = 'expense' | 'payment';

export interface Group {
  id: number;
  uid: string;
  name: string;
  description: string;
  currency: string;
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
}

export interface Split {
  memberId: number;
  value: number;
  share: number;
}

export interface Transaction {
  id: number;
  groupId: number;
  type: TxType;
  title: string;
  amount: number; // cents
  paidBy: number;
  splitType: SplitType;
  category: string;
  note: string;
  date: string; // YYYY-MM-DD
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

export class AppError extends Error {}
