// Pure money logic. All money values are integer cents.
import { AppError, MemberStat, Member, Settlement, SplitType, Transaction } from './types';

const SPLIT_TYPES: SplitType[] = ['equal', 'unequal', 'percent', 'shares'];

/**
 * Distribute `total` cents across weights using largest-remainder,
 * so the parts always add up exactly to the total.
 */
export function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new AppError('Split weights must be greater than zero');
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) floors[order[k]!.i]! += 1;
  return floors;
}

/**
 * Compute each participant's share of an expense.
 *  - equal: value ignored
 *  - unequal: value = cents for that member (must add up to amount)
 *  - percent: value = percent (must add up to 100)
 *  - shares: value = number of shares
 */
export function computeShares(amount: number, splitType: SplitType, splits: { memberId: number; value?: number }[]) {
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError('Amount must be greater than zero');
  if (!SPLIT_TYPES.includes(splitType)) throw new AppError('Invalid split type');
  if (!Array.isArray(splits) || splits.length === 0) throw new AppError('Select at least one member to split with');
  const ids = splits.map((s) => s.memberId);
  if (new Set(ids).size !== ids.length) throw new AppError('Duplicate member in split');

  if (splitType === 'equal') {
    const shares = distribute(amount, splits.map(() => 1));
    return splits.map((s, i) => ({ memberId: s.memberId, value: 1, share: shares[i]! }));
  }

  const values = splits.map((s) => Number(s.value));
  if (values.some((v) => !Number.isFinite(v) || v < 0)) throw new AppError('Split values must be non-negative numbers');

  if (splitType === 'unequal') {
    if (values.some((v) => !Number.isInteger(v))) throw new AppError('Unequal amounts must be in whole cents');
    const sum = values.reduce((a, b) => a + b, 0);
    if (sum !== amount) {
      throw new AppError(`Split amounts (${(sum / 100).toFixed(2)}) must add up to the total (${(amount / 100).toFixed(2)})`);
    }
    return splits.map((s, i) => ({ memberId: s.memberId, value: values[i]!, share: values[i]! }));
  }

  if (splitType === 'percent') {
    const sum = values.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 0.01) throw new AppError(`Percentages must add up to 100 (currently ${+sum.toFixed(2)})`);
    const shares = distribute(amount, values);
    return splits.map((s, i) => ({ memberId: s.memberId, value: values[i]!, share: shares[i]! }));
  }

  if (values.reduce((a, b) => a + b, 0) <= 0) throw new AppError('Total shares must be greater than zero');
  const shares = distribute(amount, values);
  return splits.map((s, i) => ({ memberId: s.memberId, value: values[i]!, share: shares[i]! }));
}

/**
 * Per-member stats. balance > 0 => should receive money; < 0 => owes money.
 * expense: paidBy paid `amount`; each split member benefited by `share`.
 * payment: paidBy paid `amount` directly to the single split member.
 */
export function memberStats(members: Pick<Member, 'id' | 'name'>[], transactions: Pick<Transaction, 'type' | 'amount' | 'paidBy' | 'splits'>[]): MemberStat[] {
  const stats = new Map<number, MemberStat>();
  for (const m of members) {
    stats.set(m.id, { memberId: m.id, name: m.name, totalPaid: 0, paymentsMade: 0, paymentsReceived: 0, totalBenefit: 0, balance: 0 });
  }
  for (const t of transactions) {
    const payer = stats.get(t.paidBy);
    if (t.type === 'expense') {
      if (payer) payer.totalPaid += t.amount;
      for (const s of t.splits) {
        const m = stats.get(s.memberId);
        if (m) m.totalBenefit += s.share;
      }
    } else {
      if (payer) payer.paymentsMade += t.amount;
      for (const s of t.splits) {
        const m = stats.get(s.memberId);
        if (m) m.paymentsReceived += s.share;
      }
    }
  }
  for (const s of stats.values()) s.balance = s.totalPaid + s.paymentsMade - s.totalBenefit - s.paymentsReceived;
  return [...stats.values()];
}

/**
 * Group cash position: payments count as money coming in, expenses as money going out.
 * balance = totalPayments - totalExpenses, so it is negative when more was spent than paid in.
 */
export function groupCashTotals(transactions: Pick<Transaction, 'type' | 'amount'>[]) {
  let totalExpenses = 0;
  let totalPayments = 0;
  for (const t of transactions) {
    if (t.type === 'expense') totalExpenses += t.amount;
    else totalPayments += t.amount;
  }
  return { totalExpenses, totalPayments, balance: totalPayments - totalExpenses };
}

/** Settlement plan: repeatedly match the largest debtor with the largest creditor. */
export function suggestSettlements(stats: MemberStat[]): Settlement[] {
  const creditors = stats.filter((s) => s.balance > 0).map((s) => ({ id: s.memberId, amt: s.balance }));
  const debtors = stats.filter((s) => s.balance < 0).map((s) => ({ id: s.memberId, amt: -s.balance }));
  const result: Settlement[] = [];
  while (creditors.length && debtors.length) {
    creditors.sort((a, b) => b.amt - a.amt || a.id - b.id);
    debtors.sort((a, b) => b.amt - a.amt || a.id - b.id);
    const c = creditors[0]!;
    const d = debtors[0]!;
    const amt = Math.min(c.amt, d.amt);
    result.push({ from: d.id, to: c.id, amount: amt });
    c.amt -= amt;
    d.amt -= amt;
    if (c.amt === 0) creditors.shift();
    if (d.amt === 0) debtors.shift();
  }
  return result;
}

/**
 * Calculates direct pairwise debts between members without multi-party debt simplification.
 * For each pair of members (A, B):
 * net(A -> B) = (expenses paid by B where A had a share) + (payments from B to A)
 *             - (expenses paid by A where B had a share) - (payments from A to B).
 * If net > 0, A owes B that amount.
 */
export function calculateDirectDebts(
  members: Pick<Member, 'id'>[],
  transactions: Pick<Transaction, 'type' | 'amount' | 'paidBy' | 'splits'>[]
): Settlement[] {
  const pairBalance = new Map<string, number>();

  for (const t of transactions) {
    if (t.type === 'expense') {
      const payerId = t.paidBy;
      for (const s of t.splits) {
        if (s.memberId !== payerId && s.share > 0) {
          const debtor = s.memberId;
          const creditor = payerId;
          const key = debtor < creditor ? `${debtor}:${creditor}` : `${creditor}:${debtor}`;
          const current = pairBalance.get(key) || 0;
          const sign = debtor < creditor ? 1 : -1;
          pairBalance.set(key, current + sign * s.share);
        }
      }
    } else if (t.type === 'payment') {
      const payerId = t.paidBy;
      for (const s of t.splits) {
        const receiverId = s.memberId;
        if (receiverId !== payerId && t.amount > 0) {
          const key = payerId < receiverId ? `${payerId}:${receiverId}` : `${receiverId}:${payerId}`;
          const current = pairBalance.get(key) || 0;
          const sign = payerId < receiverId ? -1 : 1;
          pairBalance.set(key, current + sign * t.amount);
        }
      }
    }
  }

  const result: Settlement[] = [];
  for (const [key, net] of pairBalance.entries()) {
    if (net === 0) continue;
    const [id1Str, id2Str] = key.split(':');
    const id1 = Number(id1Str);
    const id2 = Number(id2Str);
    if (net > 0) {
      result.push({ from: id1, to: id2, amount: net });
    } else {
      result.push({ from: id2, to: id1, amount: -net });
    }
  }

  result.sort((a, b) => b.amount - a.amount || a.from - b.from || a.to - b.to);
  return result;
}

export interface SettlementCause {
  transaction: Pick<Transaction, 'id' | 'type' | 'title' | 'amount' | 'paidBy' | 'category' | 'date'>;
  shareAmount: number;
  impact: number; // positive = debtor owes more to creditor; negative = reduces debt
}

/**
 * Returns transactions directly contributing to the balance between settlement.from and settlement.to.
 */
export function getSettlementCauses(
  settlement: Settlement,
  transactions: Pick<Transaction, 'id' | 'type' | 'title' | 'amount' | 'paidBy' | 'category' | 'date' | 'splits'>[]
): { directCauses: SettlementCause[]; directTotal: number } {
  const fromId = settlement.from;
  const toId = settlement.to;
  const directCauses: SettlementCause[] = [];

  for (const t of transactions) {
    if (t.type === 'expense') {
      if (t.paidBy === toId) {
        const sp = t.splits.find((s) => s.memberId === fromId);
        if (sp && sp.share > 0) {
          directCauses.push({
            transaction: t,
            shareAmount: sp.share,
            impact: sp.share,
          });
        }
      } else if (t.paidBy === fromId) {
        const sp = t.splits.find((s) => s.memberId === toId);
        if (sp && sp.share > 0) {
          directCauses.push({
            transaction: t,
            shareAmount: sp.share,
            impact: -sp.share,
          });
        }
      }
    } else if (t.type === 'payment') {
      if (t.paidBy === fromId && t.splits.some((s) => s.memberId === toId)) {
        directCauses.push({
          transaction: t,
          shareAmount: t.amount,
          impact: -t.amount,
        });
      } else if (t.paidBy === toId && t.splits.some((s) => s.memberId === fromId)) {
        directCauses.push({
          transaction: t,
          shareAmount: t.amount,
          impact: t.amount,
        });
      }
    }
  }

  directCauses.sort((a, b) => (b.transaction.date > a.transaction.date ? 1 : -1));
  const directTotal = directCauses.reduce((acc, c) => acc + c.impact, 0);

  return { directCauses, directTotal };
}

