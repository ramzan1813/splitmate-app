// Spending insights: pure functions over transactions, so they're easy to test.
import { Member, Transaction } from './types';

export type Period = 'month' | '30d' | '90d' | 'year' | 'all';
export const PERIODS: { value: Period; label: string }[] = [
  { value: 'month', label: 'This month' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '3 months' },
  { value: 'year', label: 'This year' },
  { value: 'all', label: 'All time' },
];

const pad = (n: number) => String(n).padStart(2, '0');
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Inclusive date range for a period, plus the equally long range right before it. */
export function periodRange(period: Period, today = new Date(), firstDate?: string) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let start: Date;
  if (period === 'month') start = new Date(end.getFullYear(), end.getMonth(), 1);
  else if (period === '30d') start = addDays(end, -29);
  else if (period === '90d') start = addDays(end, -89);
  else if (period === 'year') start = new Date(end.getFullYear(), 0, 1);
  else start = firstDate ? new Date(Date.parse(firstDate + 'T00:00:00')) : end;
  const from = iso(start);
  const to = iso(end);
  const len = dayDiff(from, to) + 1;
  const prev =
    period === 'all'
      ? null
      : period === 'month'
        ? { from: iso(new Date(end.getFullYear(), end.getMonth() - 1, 1)), to: iso(addDays(start, -1)) }
        : period === 'year'
          ? { from: `${end.getFullYear() - 1}-01-01`, to: `${end.getFullYear() - 1}-12-31` }
          : { from: iso(addDays(start, -len)), to: iso(addDays(start, -1)) };
  return { from, to, days: len, prev };
}

export interface InsightGroup {
  id: number;
  name: string;
  currency: string;
  members: Member[];
}

export interface CategoryStat {
  name: string;
  amount: number;
  pct: number;
  count: number;
  prevAmount: number;
}
export interface PersonStat {
  key: string;
  name: string;
  isMe: boolean;
  paid: number;
  share: number;
  categories: { name: string; amount: number }[];
}

export interface Insights {
  from: string;
  to: string;
  total: number;
  count: number;
  average: number;
  perDay: number;
  prevTotal: number | null;
  changePct: number | null;
  myPaid: number;
  myShare: number;
  hasMe: boolean;
  byCategory: CategoryStat[];
  byMonth: { key: string; label: string; amount: number }[];
  byPerson: PersonStat[];
  byWeekday: { label: string; amount: number }[];
  topExpenses: (Transaction & { groupName: string; paidByName: string })[];
  messages: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const weekday = (date: string) => (new Date(date + 'T00:00:00').getDay() + 6) % 7;

/**
 * @param fmt formats cents as money for the generated sentences
 */
export function computeInsights(
  groups: InsightGroup[],
  transactions: Transaction[],
  period: Period,
  fmt: (cents: number) => string,
  today = new Date()
): Insights {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const expenses = transactions.filter((t) => t.type === 'expense' && groupById.has(t.groupId));
  const firstDate = expenses.reduce<string | undefined>((min, t) => (!min || t.date < min ? t.date : min), undefined);
  const { from, to, days, prev } = periodRange(period, today, firstDate);
  const inRange = expenses.filter((t) => t.date >= from && t.date <= to);
  const inPrev = prev ? expenses.filter((t) => t.date >= prev.from && t.date <= prev.to) : [];

  const memberInfo = new Map<number, { name: string; isMe: boolean }>();
  for (const g of groups) for (const m of g.members) memberInfo.set(m.id, { name: m.name, isMe: m.isMe });
  const personKey = (mid: number) => {
    const m = memberInfo.get(mid);
    if (!m) return { key: 'unknown', name: 'Unknown', isMe: false };
    return m.isMe ? { key: 'me', name: 'You', isMe: true } : { key: m.name.trim().toLowerCase(), name: m.name.trim(), isMe: false };
  };

  const total = inRange.reduce((a, t) => a + t.amount, 0);
  const prevTotal = prev ? inPrev.reduce((a, t) => a + t.amount, 0) : null;
  const changePct = prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : null;

  // categories
  const cat = new Map<string, CategoryStat>();
  for (const t of inRange) {
    const c = cat.get(t.category) || { name: t.category, amount: 0, pct: 0, count: 0, prevAmount: 0 };
    c.amount += t.amount;
    c.count += 1;
    cat.set(t.category, c);
  }
  for (const t of inPrev) {
    const c = cat.get(t.category);
    if (c) c.prevAmount += t.amount;
  }
  const byCategory = [...cat.values()].sort((a, b) => b.amount - a.amount);
  byCategory.forEach((c) => (c.pct = total ? Math.round((c.amount / total) * 1000) / 10 : 0));

  // people: who paid and who consumed (their share), with their category mix
  const people = new Map<string, PersonStat & { catMap: Map<string, number> }>();
  const person = (mid: number) => {
    const p = personKey(mid);
    if (!people.has(p.key)) people.set(p.key, { ...p, paid: 0, share: 0, categories: [], catMap: new Map() });
    return people.get(p.key)!;
  };
  let myPaid = 0;
  let myShare = 0;
  for (const t of inRange) {
    const payer = person(t.paidBy);
    payer.paid += t.amount;
    if (payer.isMe) myPaid += t.amount;
    for (const s of t.splits) {
      const p = person(s.memberId);
      p.share += s.share;
      p.catMap.set(t.category, (p.catMap.get(t.category) || 0) + s.share);
      if (p.isMe) myShare += s.share;
    }
  }
  const byPerson: PersonStat[] = [...people.values()]
    .map(({ catMap, ...p }) => ({ ...p, categories: [...catMap.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => b.share - a.share || b.paid - a.paid);

  // months: up to 12 months ending at `to`
  const endD = new Date(to + 'T00:00:00');
  const startD = new Date(from + 'T00:00:00');
  const monthsSpan = Math.min(12, Math.max(1, (endD.getFullYear() - startD.getFullYear()) * 12 + endD.getMonth() - startD.getMonth() + 1));
  const span = Math.max(monthsSpan, 6);
  const byMonth: Insights['byMonth'] = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(endD.getFullYear(), endD.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    byMonth.push({ key, label: `${MONTHS[d.getMonth()]}${d.getMonth() === 0 || i === span - 1 ? ` ${String(d.getFullYear()).slice(2)}` : ''}`, amount: 0 });
  }
  const monthIdx = new Map(byMonth.map((m, i) => [m.key, i]));
  for (const t of expenses) {
    const i = monthIdx.get(t.date.slice(0, 7));
    if (i !== undefined) byMonth[i]!.amount += t.amount;
  }

  const byWeekday = WEEKDAYS.map((label) => ({ label, amount: 0 }));
  for (const t of inRange) byWeekday[weekday(t.date)]!.amount += t.amount;

  const name = (mid: number) => memberInfo.get(mid)?.name ?? 'Unknown';
  const topExpenses = [...inRange]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((t) => ({ ...t, groupName: groupById.get(t.groupId)?.name ?? '', paidByName: name(t.paidBy) }));

  // ---- plain-language insights ----
  const messages: string[] = [];
  if (total > 0) {
    const top = byCategory[0]!;
    messages.push(`${top.name} is where most money goes: ${fmt(top.amount)}, ${top.pct}% of all spending.`);
    if (byCategory.length > 1 && byCategory[0]!.pct + byCategory[1]!.pct >= 60) {
      messages.push(`${byCategory[0]!.name} and ${byCategory[1]!.name} together make up ${Math.round(byCategory[0]!.pct + byCategory[1]!.pct)}% of spending.`);
    }
    if (changePct !== null && Math.abs(changePct) >= 5) {
      messages.push(`Spending is ${changePct > 0 ? 'up' : 'down'} ${Math.abs(changePct)}% compared with the previous period (${fmt(prevTotal!)}).`);
    } else if (changePct !== null) {
      messages.push('Spending is about the same as the previous period.');
    }
    const grower = byCategory
      .filter((c) => c.prevAmount > 0 && c.amount - c.prevAmount > 0)
      .sort((a, b) => b.amount - b.prevAmount - (a.amount - a.prevAmount))[0];
    if (grower && prev) {
      messages.push(`${grower.name} grew the most: ${fmt(grower.amount - grower.prevAmount)} more than the previous period.`);
    }
    const payers = [...byPerson].sort((a, b) => b.paid - a.paid);
    if (payers[0] && payers.length > 1) {
      const p = payers[0];
      messages.push(`${p.isMe ? 'You' : p.name} paid the most: ${fmt(p.paid)} (${Math.round((p.paid / total) * 100)}% of the bills).`);
    }
    const consumer = byPerson[0];
    if (consumer && consumer.categories[0] && byPerson.length > 1) {
      const c = consumer.categories[0];
      messages.push(
        `${consumer.isMe ? 'Your' : `${consumer.name}'s`} share is the biggest (${fmt(consumer.share)}), mostly on ${c.name} (${Math.round((c.amount / consumer.share) * 100)}%).`
      );
    }
    const me = byPerson.find((p) => p.isMe);
    if (me && me.share > 0 && me.categories[0]) {
      const c = me.categories[0];
      if (consumer !== me) messages.push(`Your own spending is mostly on ${c.name}: ${fmt(c.amount)} of your ${fmt(me.share)} share.`);
    }
    const biggest = topExpenses[0];
    if (biggest && inRange.length > 2 && biggest.amount / total >= 0.25) {
      messages.push(`One expense, "${biggest.title}" (${fmt(biggest.amount)}), is ${Math.round((biggest.amount / total) * 100)}% of the total.`);
    }
    const weekend = byWeekday[5]!.amount + byWeekday[6]!.amount;
    const wkPct = Math.round((weekend / total) * 100);
    if (inRange.length >= 4 && wkPct >= 45) messages.push(`${wkPct}% of spending happens on weekends.`);
    const peakDay = [...byWeekday].sort((a, b) => b.amount - a.amount)[0]!;
    if (inRange.length >= 4) messages.push(`${peakDay.label} is your most expensive day of the week.`);
  }

  return {
    from,
    to,
    total,
    count: inRange.length,
    average: inRange.length ? Math.round(total / inRange.length) : 0,
    perDay: days > 0 ? Math.round(total / days) : 0,
    prevTotal,
    changePct,
    myPaid,
    myShare,
    hasMe: groups.some((g) => g.members.some((m) => m.isMe)),
    byCategory,
    byMonth,
    byPerson,
    byWeekday,
    topExpenses,
    messages,
  };
}
