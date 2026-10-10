// Sample groups created on first launch, so new users can see how EvenUp is used before entering their own data.
// They are ordinary groups; their uids are remembered so they can be removed in one go.
import { getDb } from './db';
import { createGroup, createTransaction, deleteGroup, getMembers } from './repo';
import { getSetting, setSetting } from './settings';
import { TxInput } from './types';

const SAMPLE_UIDS_KEY = 'sampleGroupUids';

/** YYYY-MM-DD for `days` before `today`. */
function daysAgo(today: Date, days: number) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD for a day of the month `monthsAgo` months back, never later than today. */
function dayOfMonth(today: Date, monthsAgo: number, day: number) {
  const d = new Date(today.getFullYear(), today.getMonth() - monthsAgo, day);
  return daysAgo(today, Math.max(0, Math.round((today.getTime() - d.getTime()) / 86_400_000)));
}

type Tx = Omit<TxInput, 'paidBy' | 'to' | 'splits'> & { paidBy: string; to?: string; splits?: { name: string; value?: number }[] };

async function addGroup(
  group: { name: string; description: string; currency: string },
  myName: string,
  others: string[],
  txs: (me: string) => Tx[]
) {
  const g = await createGroup({ ...group, myName, members: others });
  const members = await getMembers(g.id);
  // the first member is "me"; samples refer to it by the placeholder 'me'
  const idOf = (name: string) => (name === 'me' ? members[0]!.id : members.slice(1).find((m) => m.name === name)!.id);
  for (const t of txs('me')) {
    await createTransaction(g.id, {
      ...t,
      paidBy: idOf(t.paidBy),
      to: t.to ? idOf(t.to) : undefined,
      splits: t.splits?.map((s) => ({ memberId: idOf(s.name), value: s.value })),
    });
  }
  return g.uid;
}

const all = (...names: string[]) => names.map((name) => ({ name }));

/** Creates the sample groups and remembers them. Dates are relative to `today` so insights have recent data. */
export async function createSampleGroups(myName: string, today = new Date()) {
  const me = myName.trim() || 'Me';
  const uids: string[] = [];

  // 1. A weekend trip with friends: equal and unequal splits, someone left out, and a repayment.
  const trip = ['Bilal Ahmed', 'Ayesha Khan', 'Hamza Tariq'];
  uids.push(
    await addGroup({ name: 'Murree Weekend Trip', description: '3-day trip with university friends', currency: 'PKR' }, me, trip, (m) => [
      { type: 'expense', title: 'Hotel booking (2 nights)', amount: 24000, paidBy: m, splitType: 'equal', splits: all(m, ...trip), category: 'Stay', date: daysAgo(today, 20), note: 'Two rooms at Pearl Continental, booked online' },
      { type: 'expense', title: 'Fuel Islamabad to Murree', amount: 6500, paidBy: 'Hamza Tariq', splitType: 'equal', splits: all(m, ...trip), category: 'Fuel', date: daysAgo(today, 20) },
      {
        type: 'expense',
        title: 'Dinner on Mall Road',
        amount: 8400,
        paidBy: 'Bilal Ahmed',
        splitType: 'unequal',
        splits: [
          { name: m, value: 2400 },
          { name: 'Bilal Ahmed', value: 2000 },
          { name: 'Ayesha Khan', value: 1800 },
          { name: 'Hamza Tariq', value: 2200 },
        ],
        category: 'Food',
        date: daysAgo(today, 20),
        note: 'Everyone paid for what they ordered',
      },
      { type: 'expense', title: 'Breakfast at Pindi Point', amount: 3200, paidBy: m, splitType: 'equal', splits: all(m, ...trip), category: 'Food', date: daysAgo(today, 19) },
      { type: 'expense', title: 'Chairlift tickets', amount: 4800, paidBy: 'Ayesha Khan', splitType: 'equal', splits: all(m, 'Ayesha Khan', 'Hamza Tariq'), category: 'Entertainment', date: daysAgo(today, 19), note: 'Bilal skipped the chairlift' },
      { type: 'expense', title: 'Shawls for family', amount: 7500, paidBy: 'Ayesha Khan', splitType: 'unequal', splits: [{ name: 'Ayesha Khan', value: 4500 }, { name: m, value: 3000 }], category: 'Shopping', date: daysAgo(today, 18) },
      { type: 'payment', amount: 5000, paidBy: 'Bilal Ahmed', to: m, date: daysAgo(today, 15), note: 'Bank transfer' },
    ])
  );

  // 2. A shared flat: three months of rent and bills, rent split by %, monthly settle-ups.
  const flat = ['Usman Ali', 'Fahad Raza'];
  uids.push(
    await addGroup({ name: 'Flat 4B — Shared Home', description: 'Rent, bills and groceries for our apartment', currency: 'PKR' }, me, flat, (m) => {
      const out: Tx[] = [];
      const electricity = [14350, 18900, 12600];
      const groceries = [11200, 9850, 12400];
      for (const [i, monthsAgo] of [2, 1, 0].entries()) {
        out.push(
          {
            type: 'expense',
            title: 'Monthly rent',
            amount: 90000,
            paidBy: m,
            splitType: 'percent',
            splits: [{ name: m, value: 40 }, { name: 'Usman Ali', value: 30 }, { name: 'Fahad Raza', value: 30 }],
            category: 'Rent',
            date: dayOfMonth(today, monthsAgo, 1),
            note: 'Master bedroom pays 40%',
          },
          { type: 'expense', title: 'Electricity bill', amount: electricity[i]!, paidBy: 'Usman Ali', splitType: 'equal', splits: all(m, ...flat), category: 'Bills', date: dayOfMonth(today, monthsAgo, 8) },
          { type: 'expense', title: 'Internet (fiber 50 Mbps)', amount: 4500, paidBy: 'Fahad Raza', splitType: 'equal', splits: all(m, ...flat), category: 'Bills', date: dayOfMonth(today, monthsAgo, 10) },
          { type: 'expense', title: 'Monthly groceries', amount: groceries[i]!, paidBy: m, splitType: 'equal', splits: all(m, ...flat), category: 'Groceries', date: dayOfMonth(today, monthsAgo, 12) }
        );
        if (monthsAgo > 0) {
          // older months were settled up; the current month is still open
          out.push(
            { type: 'payment', amount: 27000, paidBy: 'Usman Ali', to: m, date: dayOfMonth(today, monthsAgo, 25), note: 'Rent share' },
            { type: 'payment', amount: 27000, paidBy: 'Fahad Raza', to: m, date: dayOfMonth(today, monthsAgo, 26), note: 'Rent share' }
          );
        }
      }
      return out;
    })
  );

  // 3. A family holiday abroad in another currency, split by family size using shares.
  const family = ['Imran Malik', 'Sana Javed'];
  const byFamily = (m: string) => [{ name: m, value: 2 }, { name: 'Imran Malik', value: 4 }, { name: 'Sana Javed', value: 3 }];
  uids.push(
    await addGroup({ name: 'Dubai Family Holiday', description: 'Cousins trip — costs split by family size (2, 4 and 3 people)', currency: 'AED' }, me, family, (m) => [
      { type: 'expense', title: 'Apartment in Dubai Marina', amount: 3600, paidBy: 'Imran Malik', splitType: 'shares', splits: byFamily(m), category: 'Stay', date: daysAgo(today, 45), note: '4 nights, 3 bedrooms' },
      { type: 'expense', title: 'Desert safari', amount: 1620, paidBy: m, splitType: 'shares', splits: byFamily(m), category: 'Entertainment', date: daysAgo(today, 44), note: 'AED 180 per person, 9 people' },
      { type: 'expense', title: 'Dinner at Dubai Mall', amount: 945, paidBy: 'Sana Javed', splitType: 'shares', splits: byFamily(m), category: 'Food', date: daysAgo(today, 43) },
      { type: 'expense', title: 'Metro cards & taxis', amount: 380, paidBy: m, splitType: 'equal', splits: all(m, ...family), category: 'Travel', date: daysAgo(today, 42) },
      { type: 'expense', title: 'Gold Souk shopping', amount: 1250, paidBy: 'Sana Javed', splitType: 'unequal', splits: [{ name: 'Sana Javed', value: 850 }, { name: m, value: 400 }], category: 'Shopping', date: daysAgo(today, 42) },
      { type: 'payment', amount: 800, paidBy: 'Sana Javed', to: 'Imran Malik', date: daysAgo(today, 40), note: 'Paid back for the apartment' },
    ])
  );

  await setSetting(SAMPLE_UIDS_KEY, JSON.stringify(uids));
}

/** Sample groups that still exist on this phone. */
export async function getSampleGroupIds(): Promise<number[]> {
  let uids: unknown;
  try {
    uids = JSON.parse((await getSetting(SAMPLE_UIDS_KEY)) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(uids)) return [];
  const db = await getDb();
  const ids: number[] = [];
  for (const uid of uids) {
    const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM groups WHERE uid = ?', [String(uid)]);
    if (row) ids.push(row.id);
  }
  return ids;
}

export async function removeSampleGroups() {
  for (const id of await getSampleGroupIds()) await deleteGroup(id);
  await setSetting(SAMPLE_UIDS_KEY, null);
}
