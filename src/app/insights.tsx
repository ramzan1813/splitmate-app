import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Card, Chip, Empty, Loading, Row, SectionTitle } from '@/components/ui';
import { ColumnChart, HBarList, Legend, PairedBars, StackedBar, StatTile } from '@/components/Charts';
import { getMembers, getTransactions, listGroups } from '@/data/repo';
import { computeInsights, InsightGroup, Period, PERIODS } from '@/data/insights';
import { Transaction } from '@/data/types';
import { money, prettyDate } from '@/lib/format';
import { colors, OTHER_COLOR, palette } from '@/lib/theme';
import { errorMessage } from '@/lib/dialog';

const MAX_CATEGORY_COLORS = 7; // 7 coloured categories + "Other"

export default function InsightsScreen() {
  const params = useLocalSearchParams<{ groupId?: string }>();
  const router = useRouter();
  const [groups, setGroups] = useState<InsightGroup[] | null>(null);
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<Period>('month');
  const [groupId, setGroupId] = useState<number | 'all'>(params.groupId ? Number(params.groupId) : 'all');
  const [currency, setCurrency] = useState<string | null>(null);
  const [selCat, setSelCat] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          const list = await listGroups();
          const gs: InsightGroup[] = [];
          for (const g of list) gs.push({ id: g.id, name: g.name, currency: g.currency, members: await getMembers(g.id) });
          setGroups(gs);
          setTxs(await getTransactions());
          setError('');
        } catch (e) {
          setError(errorMessage(e));
        }
      })();
    }, [])
  );

  // currencies can't be added together, so "All groups" is shown per currency
  const currencies = useMemo(() => {
    if (!groups) return [];
    const spend = new Map<string, number>();
    for (const g of groups) spend.set(g.currency, spend.get(g.currency) ?? 0);
    for (const t of txs) {
      const g = groups.find((x) => x.id === t.groupId);
      if (g && t.type === 'expense') spend.set(g.currency, (spend.get(g.currency) ?? 0) + t.amount);
    }
    return [...spend.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [groups, txs]);

  const selectedGroups = useMemo(() => {
    if (!groups) return [];
    if (groupId !== 'all') return groups.filter((g) => g.id === groupId);
    const cur = currency ?? currencies[0];
    return groups.filter((g) => g.currency === cur);
  }, [groups, groupId, currency, currencies]);

  const cur = selectedGroups[0]?.currency ?? 'USD';
  const fmt = useCallback((c: number) => money(c, cur), [cur]);
  const data = useMemo(() => (groups ? computeInsights(selectedGroups, txs, period, fmt) : null), [groups, selectedGroups, txs, period, fmt]);

  // category colours follow the category (by overall rank), never re-assigned when filtering
  const catColor = useMemo(() => {
    const m = new Map<string, string>();
    (data?.byCategory ?? []).forEach((c, i) => m.set(c.name, i < MAX_CATEGORY_COLORS ? palette[i]! : OTHER_COLOR));
    return (name: string) => m.get(name) ?? OTHER_COLOR;
  }, [data]);

  if (error) return <Empty title="Couldn't load insights" subtitle={error} />;
  if (!groups || !data) return <Loading />;
  if (!groups.length) return <Empty title="No data yet" subtitle="Create a group and add some expenses to see where your money goes." />;

  const foldCategories = (list: { name: string; amount: number }[]) => {
    const top = list.slice(0, MAX_CATEGORY_COLORS);
    const rest = list.slice(MAX_CATEGORY_COLORS).reduce((a, c) => a + c.amount, 0);
    return rest > 0 ? [...top, { name: 'Other', amount: rest }] : top;
  };
  const categoryRows = foldCategories(data.byCategory).map((c) => ({
    label: c.name,
    value: c.amount,
    sub: data.total ? `${Math.round((c.amount / data.total) * 1000) / 10}%` : '',
  }));
  const legendCats = foldCategories(data.byCategory).map((c) => ({ label: c.name, color: c.name === 'Other' ? OTHER_COLOR : catColor(c.name) }));
  const people = data.byPerson.slice(0, 8);

  const change = data.changePct;
  const changeText = change === null ? (period === 'all' ? 'all time' : 'no data before') : `${change > 0 ? '▲' : change < 0 ? '▼' : '■'} ${Math.abs(change)}% vs previous`;
  const changeColor = change === null ? colors.muted : change > 0 ? colors.negative : colors.positive;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, maxWidth: 760, width: '100%', alignSelf: 'center' }}>
      {/* Filters: one row each, above everything */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {PERIODS.map((p) => (
          <Chip key={p.value} label={p.label} active={period === p.value} onPress={() => setPeriod(p.value)} testID={`period-${p.value}`} />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Chip label="All groups" active={groupId === 'all'} onPress={() => setGroupId('all')} testID="ins-group-all" />
        {groups.map((g) => (
          <Chip key={g.id} label={g.name} active={groupId === g.id} onPress={() => setGroupId(g.id)} testID={`ins-group-${g.id}`} />
        ))}
      </ScrollView>
      {groupId === 'all' && currencies.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {currencies.map((c) => (
            <Chip key={c} label={c} active={(currency ?? currencies[0]) === c} onPress={() => setCurrency(c)} />
          ))}
        </ScrollView>
      )}
      <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 12 }}>
        {prettyDate(data.from)} – {prettyDate(data.to)}
        {groupId === 'all' ? ` · ${selectedGroups.length} group${selectedGroups.length === 1 ? '' : 's'} in ${cur}` : ''}
      </Text>

      {data.count === 0 ? (
        <Empty title="No expenses in this period" subtitle="Try a longer period, like “All time”." />
      ) : (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <StatTile label="Total spent" value={fmt(data.total)} sub={changeText} subColor={changeColor} testID="ins-total" />
            <StatTile label="Expenses" value={String(data.count)} sub={`avg ${fmt(data.average)}`} />
            <StatTile label="Per day" value={fmt(data.perDay)} sub={`over ${Math.round((Date.parse(data.to) - Date.parse(data.from)) / 86400000) + 1} days`} />
            {data.hasMe ? (
              <StatTile label="Your share" value={fmt(data.myShare)} sub={`you paid ${fmt(data.myPaid)}`} testID="ins-myshare" />
            ) : (
              <StatTile label="Biggest category" value={data.byCategory[0]?.name ?? '-'} sub={`${data.byCategory[0]?.pct ?? 0}%`} />
            )}
          </View>

          <SectionTitle>What stands out</SectionTitle>
          <Card testID="ins-messages">
            {data.messages.map((m, i) => (
              <Row key={i} style={{ alignItems: 'flex-start', paddingVertical: 5 }}>
                <Text style={{ color: colors.primary, marginRight: 8, fontWeight: '900' }}>•</Text>
                <Text style={{ flex: 1, color: colors.text, lineHeight: 20 }}>{m}</Text>
              </Row>
            ))}
          </Card>

          <SectionTitle>Where the money goes</SectionTitle>
          <Card>
            <HBarList rows={categoryRows} format={fmt} testID="ins-categories" />
          </Card>

          <SectionTitle>Spending by month</SectionTitle>
          <Card>
            <ColumnChart data={data.byMonth.map((m) => ({ label: m.label, value: m.amount }))} format={fmt} />
          </Card>

          {people.length > 0 && (
            <>
              <SectionTitle>Who’s spending</SectionTitle>
              <Card>
                <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 8 }}>
                  “Paid” is money they put down at the till. “Share” is what they actually used — their part of each expense.
                </Text>
                <PairedBars
                  rows={people.map((p) => ({ label: p.name, a: p.paid, b: p.share }))}
                  series={[
                    { name: 'Paid', color: palette[0]! },
                    { name: 'Share (used)', color: palette[1]! },
                  ]}
                  format={fmt}
                />
              </Card>

              <SectionTitle>What each person spends on</SectionTitle>
              <Card>
                <Legend items={legendCats} />
                {selCat && <Text style={{ color: colors.text, fontWeight: '700', marginTop: 6 }}>Showing: {selCat} (tap again to clear)</Text>}
                {people.map((p) => {
                  const top = p.categories[0];
                  const parts = foldCategories(p.categories).map((c) => ({ label: c.name, value: c.amount, color: c.name === 'Other' ? OTHER_COLOR : catColor(c.name) }));
                  const selAmount = selCat ? (parts.find((x) => x.label === selCat)?.value ?? 0) : 0;
                  return (
                    <View key={p.key} style={{ marginTop: 14 }}>
                      <Row style={{ marginBottom: 6 }}>
                        <Text style={{ fontWeight: '700', flex: 1 }}>{p.name}</Text>
                        <Text style={{ color: colors.muted, fontSize: 12 }}>
                          {selCat
                            ? `${selCat}: ${fmt(selAmount)} (${p.share ? Math.round((selAmount / p.share) * 100) : 0}%)`
                            : top
                              ? `mostly ${top.name} · ${p.share ? Math.round((top.amount / p.share) * 100) : 0}%`
                              : ''}
                        </Text>
                      </Row>
                      <StackedBar parts={parts} selected={selCat} onSelect={setSelCat} />
                    </View>
                  );
                })}
              </Card>
            </>
          )}

          <SectionTitle>By day of week</SectionTitle>
          <Card>
            <ColumnChart data={data.byWeekday.map((d) => ({ label: d.label, value: d.amount }))} format={fmt} height={100} highlightLast={false} />
          </Card>

          <SectionTitle>Biggest expenses</SectionTitle>
          <Card>
            {data.topExpenses.map((t, i) => (
              <Pressable key={t.id} onPress={() => router.push(`/group/${t.groupId}/transaction/${t.id}`)}>
                <Row style={{ paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }}>
                  <Text style={{ width: 22, color: colors.muted, fontWeight: '800' }}>{i + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: '700' }} numberOfLines={1}>
                      {t.title}
                    </Text>
                    <Text style={{ color: colors.muted, fontSize: 12 }}>
                      {prettyDate(t.date)} · {t.category} · {t.paidByName} paid{groupId === 'all' ? ` · ${t.groupName}` : ''}
                    </Text>
                  </View>
                  <Text style={{ fontWeight: '800' }}>{fmt(t.amount)}</Text>
                </Row>
              </Pressable>
            ))}
          </Card>
        </>
      )}
    </ScrollView>
  );
}
