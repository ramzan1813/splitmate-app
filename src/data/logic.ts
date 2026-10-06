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
