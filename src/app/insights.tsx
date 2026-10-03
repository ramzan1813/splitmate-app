import { ReactNode, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Card, Chip, Empty, Loading, Row, SectionTitle } from '@/components/ui';
import { ColumnChart, HBarList, Legend, PairedBars, StackedBar, StatTile } from '@/components/Charts';
import { getMembers, getTransactions, listGroups } from '@/data/repo';
import { computeInsights, InsightGroup, Period, PERIODS } from '@/data/insights';
import { Transaction } from '@/data/types';
import { money, prettyDate } from '@/lib/format';
import { barColor, barTrack, categoryIcon, colors, OTHER_COLOR, palette } from '@/lib/theme';
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
  const legendCats = foldCategories(data.byCategory).map((c) => ({ label: c.name, color: c.name === 'Other' ? OTHER_COLOR : catColor(c.name) }));
  const people = data.byPerson.slice(0, 8);

  const change = data.changePct;
  const changeText = change === null ? (period === 'all' ? 'all time' : 'no data before') : `${change > 0 ? '▲' : change < 0 ? '▼' : '■'} ${Math.abs(change)}% vs previous`;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, maxWidth: 760, width: '100%', alignSelf: 'center' }}>
      {/* Filters */}
      <Card style={{ paddingBottom: 6 }}>
        <FilterLabel>Period</FilterLabel>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {PERIODS.map((p) => (
            <Chip key={p.value} label={p.label} active={period === p.value} onPress={() => setPeriod(p.value)} testID={`period-${p.value}`} />
          ))}
        </ScrollView>
        <FilterLabel>Group</FilterLabel>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Chip label="All groups" active={groupId === 'all'} onPress={() => setGroupId('all')} testID="ins-group-all" />
          {groups.map((g) => (
            <Chip key={g.id} label={g.name} active={groupId === g.id} onPress={() => setGroupId(g.id)} testID={`ins-group-${g.id}`} />
          ))}
        </ScrollView>
        {groupId === 'all' && currencies.length > 1 && (
          <>
            <FilterLabel>Currency (groups in different currencies are shown separately)</FilterLabel>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {currencies.map((c) => (
                <Chip key={c} label={c} active={(currency ?? currencies[0]) === c} onPress={() => setCurrency(c)} />
              ))}
            </ScrollView>
          </>
        )}
      </Card>

      {/* Headline */}
      <View style={{ backgroundColor: colors.primary, borderRadius: 18, padding: 18, marginBottom: 14 }} testID="ins-hero">
        <Text style={{ color: colors.primaryLight, fontSize: 13, fontWeight: '600' }}>
          Spent · {PERIODS.find((p) => p.value === period)?.label}
          {groupId === 'all' ? ` · ${selectedGroups.length} group${selectedGroups.length === 1 ? '' : 's'}` : ''}
        </Text>
        <Text style={{ color: colors.white, fontSize: 32, fontWeight: '900', marginTop: 2 }} testID="ins-total">
          {fmt(data.total)}
        </Text>
        <Row style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {change !== null && <HeroBadge text={changeText} />}
          <HeroBadge text={`${data.count} expense${data.count === 1 ? '' : 's'}`} />
        </Row>
        <Text style={{ color: colors.primaryLight, fontSize: 12, marginTop: 10 }}>
          📅 {prettyDate(data.from)} – {prettyDate(data.to)}
        </Text>
      </View>

      {data.count === 0 ? (
        <Empty title="No expenses in this period" subtitle="Try a longer period, like “All time”." />
      ) : (
        <>
          {data.hasMe && (
            <>
              <SectionTitle>Your money</SectionTitle>
              <Card testID="ins-myshare">
                <Row>
                  <MoneyCol label="You paid" value={fmt(data.myPaid)} />
                  <MoneyCol label="Your share" value={fmt(data.myShare)} />
                  <MoneyCol
                    label={data.myPaid >= data.myShare ? 'You covered' : 'Others covered'}
                    value={fmt(Math.abs(data.myPaid - data.myShare))}
                    color={data.myPaid > data.myShare ? colors.positive : data.myPaid < data.myShare ? colors.negative : colors.text}
                  />
                </Row>
                <Text style={{ color: colors.muted, fontSize: 12, marginTop: 10, lineHeight: 17 }}>
                  {data.myPaid > data.myShare
                    ? `You paid ${fmt(data.myPaid - data.myShare)} more than your own share, so others owe you for that part.`
                    : data.myPaid < data.myShare
                      ? `Others paid ${fmt(data.myShare - data.myPaid)} of your share, so you owe that part.`
                      : 'You paid exactly your own share.'}
                  {data.settled.count ? ` ${data.settled.count} settle-up payment${data.settled.count === 1 ? '' : 's'} (${fmt(data.settled.amount)}) in this period.` : ''}
                </Text>
                {data.total > 0 && (
                  <View style={{ marginTop: 10 }}>
                    <Text style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>Your share of all spending: {Math.round((data.myShare / data.total) * 100)}%</Text>
                    <View style={{ height: 8, backgroundColor: barTrack, borderRadius: 4 }}>
                      <View style={{ width: `${(data.myShare / data.total) * 100}%`, minWidth: data.myShare ? 4 : 0, height: 8, backgroundColor: barColor, borderRadius: 4 }} />
                    </View>
                  </View>
                )}
              </Card>
            </>
          )}

          <SectionTitle>At a glance</SectionTitle>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <StatTile label="Average expense" value={fmt(data.average)} sub={`${data.count} expense${data.count === 1 ? '' : 's'}`} />
            <StatTile label="Per day" value={fmt(data.perDay)} sub={`over ${Math.round((Date.parse(data.to) - Date.parse(data.from)) / 86400000) + 1} days`} />
            <StatTile label="Biggest expense" value={data.topExpenses[0] ? fmt(data.topExpenses[0].amount) : '-'} sub={data.topExpenses[0]?.title} />
            <StatTile
              label="Top category"
              value={data.byCategory[0] ? `${categoryIcon(data.byCategory[0].name)} ${data.byCategory[0].name}` : '-'}
              sub={data.byCategory[0] ? `${data.byCategory[0].pct}% of spending` : undefined}
            />
          </View>

          {data.messages.length > 0 && (
            <>
              <SectionTitle>What stands out</SectionTitle>
              <Card testID="ins-messages">
                {data.messages.map((m, i) => (
                  <Row key={i} style={{ alignItems: 'flex-start', paddingVertical: 7, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }}>
                    <Text style={{ marginRight: 10, fontSize: 15 }}>💡</Text>
                    <Text style={{ flex: 1, color: colors.text, lineHeight: 20 }}>{m}</Text>
                  </Row>
                ))}
              </Card>
            </>
          )}

          <SectionTitle>Where the money goes</SectionTitle>
          <Card testID="ins-categories">
            {data.byCategory.map((c, i) => {
              const diff = period === 'all' || !c.prevAmount ? null : Math.round(((c.amount - c.prevAmount) / c.prevAmount) * 100);
              return (
                <View key={c.name} style={{ paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }}>
                  <Row>
                    <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontSize: 17 }}>{categoryIcon(c.name)}</Text>
                    </View>
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={{ fontWeight: '700', color: colors.text }}>{c.name}</Text>
                      <Text style={{ color: colors.muted, fontSize: 12 }}>
                        {c.count} expense{c.count === 1 ? '' : 's'} · {c.pct}%
                        {diff !== null ? (
                          <Text style={{ color: diff > 0 ? colors.negative : colors.positive, fontWeight: '700' }}> · {diff > 0 ? '▲' : diff < 0 ? '▼' : '■'} {Math.abs(diff)}%</Text>
                        ) : null}
                      </Text>
                    </View>
                    <Text style={{ fontWeight: '800', color: colors.text }}>{fmt(c.amount)}</Text>
                  </Row>
                  <View style={{ height: 6, backgroundColor: barTrack, borderRadius: 3, marginTop: 8, marginLeft: 46 }}>
                    <View style={{ width: `${c.pct}%`, minWidth: c.amount ? 4 : 0, height: 6, backgroundColor: catColor(c.name), borderRadius: 3 }} />
                  </View>
                </View>
              );
            })}
            {period !== 'all' && <Text style={{ color: colors.muted, fontSize: 11, marginTop: 6 }}>▲▼ compared with the previous period</Text>}
          </Card>

          {groupId === 'all' && data.byGroup.length > 1 && (
            <>
              <SectionTitle>By group</SectionTitle>
              <Card>
                <HBarList
                  rows={data.byGroup.map((g) => ({ label: g.name, value: g.amount, sub: `${data.total ? Math.round((g.amount / data.total) * 100) : 0}%` }))}
                  format={fmt}
                />
              </Card>
            </>
          )}

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
                  <Text style={{ fontSize: 18, marginRight: 10 }}>{categoryIcon(t.category)}</Text>
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

function FilterLabel({ children }: { children: ReactNode }) {
  return <Text style={{ fontSize: 11, fontWeight: '800', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, marginTop: 4 }}>{children}</Text>;
}

function HeroBadge({ text }: { text: string }) {
  return (
    <View style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ color: colors.white, fontWeight: '700', fontSize: 12 }}>{text}</Text>
    </View>
  );
}

function MoneyCol({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color: colors.muted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: color ?? colors.text, fontSize: 16, fontWeight: '800', marginTop: 2 }} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}
