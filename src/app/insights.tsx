import { ReactNode, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Avatar, Card, Chip, Empty, Loading, Row, SectionTitle } from '@/components/ui';
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
  const [personId, setPersonId] = useState<number | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string | 'all'>('all');
  const [currency, setCurrency] = useState<string | null>(null);
  const [selCat, setSelCat] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState<'groups' | 'categories' | 'members'>('groups');

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

  // Available categories across selected groups
  const availableCategories = useMemo(() => {
    const groupIds = new Set(selectedGroups.map((g) => g.id));
    const cats = new Set<string>();
    for (const t of txs) {
      if (groupIds.has(t.groupId) && t.type === 'expense' && t.category) {
        cats.add(t.category);
      }
    }
    return Array.from(cats).sort();
  }, [selectedGroups, txs]);

  // Available members across selected groups
  const availableMembers = useMemo(() => {
    const map = new Map<number, { id: number; name: string; isMe: boolean }>();
    for (const g of selectedGroups) {
      for (const m of g.members) {
        if (!map.has(m.id)) {
          map.set(m.id, { id: m.id, name: m.name, isMe: m.isMe });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => (a.isMe ? -1 : b.isMe ? 1 : a.name.localeCompare(b.name)));
  }, [selectedGroups]);

  // Filter transactions based on active person and category filters
  const filteredTxs = useMemo(() => {
    let list = txs;
    if (categoryFilter !== 'all') {
      list = list.filter((t) => t.category === categoryFilter);
    }
    if (personId !== 'all') {
      list = list.filter((t) => t.paidBy === personId || t.splits.some((s) => s.memberId === personId));
    }
    return list;
  }, [txs, categoryFilter, personId]);

  const cur = selectedGroups[0]?.currency ?? 'USD';
  const fmt = useCallback((c: number) => money(c, cur), [cur]);
  const data = useMemo(() => (groups ? computeInsights(selectedGroups, filteredTxs, period, fmt) : null), [groups, selectedGroups, filteredTxs, period, fmt]);

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

  const hasActiveFilters = groupId !== 'all' || personId !== 'all' || categoryFilter !== 'all';
  const selectedMemberObj = availableMembers.find((m) => m.id === personId);
  const selectedGroupObj = groups.find((g) => g.id === groupId);

  // AI-Era smart financial health badge derivation
  const financialHealth = (() => {
    if (data.total === 0) return { label: 'No Activity', color: '#6B7280', bg: '#F3F4F6' };
    if (data.myPaid > data.myShare * 1.5) return { label: '🛡️ Primary Funder', color: '#0F766E', bg: '#CCFBF1' };
    if (data.myPaid < data.myShare * 0.7) return { label: '📥 Net Funded', color: '#B45309', bg: '#FEF3C7' };
    if (data.changePct !== null && data.changePct > 50) return { label: '⚡ High Spending Spike', color: '#B91C1C', bg: '#FEE2E2' };
    return { label: '⚖️ Well Balanced', color: '#15803D', bg: '#DCFCE7' };
  })();

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 50, maxWidth: 760, width: '100%', alignSelf: 'center' }}>
      {/* Modern Filter Deck */}
      <Card style={{ padding: 16, marginBottom: 14 }}>
        {/* Period Selector */}
        <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <FilterLabel>Time Horizon</FilterLabel>
          {hasActiveFilters && (
            <Pressable
              onPress={() => {
                setGroupId('all');
                setPersonId('all');
                setCategoryFilter('all');
              }}
              hitSlop={8}
            >
              <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>Reset Filters ✕</Text>
            </Pressable>
          )}
        </Row>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginBottom: 12 }}>
          {PERIODS.map((p) => (
            <Chip key={p.value} label={p.label} active={period === p.value} onPress={() => setPeriod(p.value)} testID={`period-${p.value}`} />
          ))}
        </ScrollView>

        {/* Filter Dimension Navigation */}
        <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
          <Row style={{ gap: 8, marginBottom: 10 }}>
            <FilterTabButton
              label={`Groups (${groupId === 'all' ? 'All' : selectedGroupObj?.name || '1'})`}
              active={filterTab === 'groups'}
              onPress={() => setFilterTab('groups')}
            />
            <FilterTabButton
              label={`Categories (${categoryFilter === 'all' ? 'All' : categoryFilter})`}
              active={filterTab === 'categories'}
              onPress={() => setFilterTab('categories')}
            />
            <FilterTabButton
              label={`People (${personId === 'all' ? 'All' : selectedMemberObj?.name || '1'})`}
              active={filterTab === 'members'}
              onPress={() => setFilterTab('members')}
            />
          </Row>

          {/* Sub-Filters Content */}
          {filterTab === 'groups' && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              <Chip label="🌐 All groups" active={groupId === 'all'} onPress={() => setGroupId('all')} testID="ins-group-all" />
              {groups.map((g) => (
                <Chip key={g.id} label={g.name} active={groupId === g.id} onPress={() => setGroupId(g.id)} testID={`ins-group-${g.id}`} />
              ))}
            </ScrollView>
          )}

          {filterTab === 'categories' && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              <Chip label="📦 All Categories" active={categoryFilter === 'all'} onPress={() => setCategoryFilter('all')} />
              {availableCategories.map((c) => (
                <Chip key={c} label={`${categoryIcon(c)} ${c}`} active={categoryFilter === c} onPress={() => setCategoryFilter(c)} />
              ))}
            </ScrollView>
          )}

          {filterTab === 'members' && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              <Chip label="👥 Everyone" active={personId === 'all'} onPress={() => setPersonId('all')} />
              {availableMembers.map((m) => (
                <Chip key={m.id} label={m.isMe ? `👤 You (${m.name})` : m.name} active={personId === m.id} onPress={() => setPersonId(m.id)} />
              ))}
            </ScrollView>
          )}
        </View>

        {/* Multi-currency notice if applicable */}
        {groupId === 'all' && currencies.length > 1 && (
          <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
            <FilterLabel>Currency Scope</FilterLabel>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {currencies.map((c) => (
                <Chip key={c} label={c} active={(currency ?? currencies[0]) === c} onPress={() => setCurrency(c)} />
              ))}
            </ScrollView>
          </View>
        )}
      </Card>

      {/* Active Filter Pill Badge */}
      {hasActiveFilters && (
        <View
          style={{
            backgroundColor: 'rgba(15, 118, 110, 0.08)',
            borderColor: colors.primary,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 8,
            marginBottom: 14,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ fontSize: 13, color: colors.primaryDark, fontWeight: '700' }}>
            🎯 Scoped View: {groupId !== 'all' ? selectedGroupObj?.name : 'All Groups'}
            {categoryFilter !== 'all' ? ` · ${categoryIcon(categoryFilter)} ${categoryFilter}` : ''}
            {personId !== 'all' ? ` · 👤 ${selectedMemberObj?.name}` : ''}
          </Text>
          <Pressable
            onPress={() => {
              setGroupId('all');
              setPersonId('all');
              setCategoryFilter('all');
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '800', color: colors.primary }}>Clear ✕</Text>
          </Pressable>
        </View>
      )}

      {/* Headline Hero Card */}
      <View style={{ backgroundColor: colors.primary, borderRadius: 20, padding: 20, marginBottom: 14 }} testID="ins-hero">
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.primaryLight, fontSize: 13, fontWeight: '600' }}>
            Spent · {PERIODS.find((p) => p.value === period)?.label}
            {groupId === 'all' ? ` · ${selectedGroups.length} group${selectedGroups.length === 1 ? '' : 's'}` : ''}
          </Text>
          <View style={{ backgroundColor: financialHealth.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 }}>
            <Text style={{ color: financialHealth.color, fontSize: 11, fontWeight: '800' }}>{financialHealth.label}</Text>
          </View>
        </Row>
        <Text style={{ color: colors.white, fontSize: 34, fontWeight: '900', marginTop: 4 }} testID="ins-total">
          {fmt(data.total)}
        </Text>
        <Row style={{ flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {change !== null && <HeroBadge text={changeText} />}
          <HeroBadge text={`${data.count} expense${data.count === 1 ? '' : 's'}`} />
          {data.perDay > 0 && <HeroBadge text={`~${fmt(data.perDay)}/day`} />}
        </Row>
        <Text style={{ color: colors.primaryLight, fontSize: 12, marginTop: 12 }}>
          📅 {prettyDate(data.from)} – {prettyDate(data.to)}
        </Text>
      </View>

      {/* AI-Era Intelligence Copilot Card */}
      <Card
        style={{
          backgroundColor: '#0F172A',
          borderRadius: 18,
          padding: 16,
          marginBottom: 16,
          borderWidth: 1,
          borderColor: '#1E293B',
        }}
      >
        <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <Row style={{ alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 16 }}>✨</Text>
            <Text style={{ color: '#F8FAFC', fontWeight: '800', fontSize: 15, letterSpacing: 0.3 }}>
              AI Financial Intelligence
            </Text>
          </Row>
          <View style={{ backgroundColor: '#1E293B', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 }}>
            <Text style={{ color: '#94A3B8', fontSize: 11, fontWeight: '700' }}>SMART COPILOT</Text>
          </View>
        </Row>

        {data.count === 0 ? (
          <Text style={{ color: '#94A3B8', fontSize: 13, lineHeight: 18 }}>
            No expenses recorded for this timeframe. Log new transactions or widen your filters to trigger AI pattern detection.
          </Text>
        ) : (
          <View style={{ gap: 8 }}>
            {/* Velocity & Burn Rate */}
            <AIBullet
              icon="⚡"
              title="Daily Run Rate"
              body={`Averaging ${fmt(data.perDay)}/day across this horizon. Average transaction size is ${fmt(data.average)}.`}
            />

            {/* Top Category Driver */}
            {data.byCategory[0] && (
              <AIBullet
                icon={categoryIcon(data.byCategory[0].name)}
                title="Primary Budget Driver"
                body={`${data.byCategory[0].name} drives ${data.byCategory[0].pct}% of total spending (${fmt(data.byCategory[0].amount)}).`}
              />
            )}

            {/* Fairness & Upfront Buffer */}
            {data.hasMe && (
              <AIBullet
                icon="⚖️"
                title="Your Financial Position"
                body={
                  data.myPaid > data.myShare
                    ? `You are extending a net buffer of ${fmt(data.myPaid - data.myShare)} to other members. High liquidity provider.`
                    : data.myPaid < data.myShare
                      ? `Other members covered ${fmt(data.myShare - data.myPaid)} of your consumption. Settle-up recommended.`
                      : 'Your contributions match your exact share. Perfectly balanced.'
                }
              />
            )}

            {/* Outlier Detection */}
            {data.topExpenses[0] && data.count >= 2 && data.topExpenses[0].amount / (data.total || 1) >= 0.25 && (
              <AIBullet
                icon="🔍"
                title="High Impact Outlier"
                body={`"${data.topExpenses[0].title}" represents ${Math.round((data.topExpenses[0].amount / data.total) * 100)}% of all spending in this scope.`}
              />
            )}

            {/* Settlement Optimization Notice */}
            {data.settled.count > 0 && (
              <AIBullet
                icon="🤝"
                title="Debt Liquidation"
                body={`${data.settled.count} debt settlements completed, clearing ${fmt(data.settled.amount)} without circular payments.`}
              />
            )}
          </View>
        )}
      </Card>

      {data.count === 0 ? (
        <Empty title="No expenses in this scope" subtitle="Try expanding your period or resetting category and person filters." />
      ) : (
        <>
          {/* Your Money Breakdown */}
          {data.hasMe && (
            <>
              <SectionTitle>Your Money & Position</SectionTitle>
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
                  {data.settled.count ? ` ${data.settled.count} settle-up payment${data.settled.count === 1 ? '' : 's'} (${fmt(data.settled.amount)}) recorded in this period.` : ''}
                </Text>
                {data.total > 0 && (
                  <View style={{ marginTop: 10 }}>
                    <Text style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                      Your share of total group spending: {Math.round((data.myShare / data.total) * 100)}%
                    </Text>
                    <View style={{ height: 8, backgroundColor: barTrack, borderRadius: 4 }}>
                      <View style={{ width: `${(data.myShare / data.total) * 100}%`, minWidth: data.myShare ? 4 : 0, height: 8, backgroundColor: barColor, borderRadius: 4 }} />
                    </View>
                  </View>
                )}
              </Card>
            </>
          )}

          {/* At a Glance Metric Tiles */}
          <SectionTitle>At a Glance</SectionTitle>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <StatTile label="Average expense" value={fmt(data.average)} sub={`${data.count} expense${data.count === 1 ? '' : 's'}`} />
            <StatTile label="Daily burn rate" value={fmt(data.perDay)} sub={`across active range`} />
            <StatTile label="Biggest expense" value={data.topExpenses[0] ? fmt(data.topExpenses[0].amount) : '-'} sub={data.topExpenses[0]?.title} />
            <StatTile
              label="Top category"
              value={data.byCategory[0] ? `${categoryIcon(data.byCategory[0].name)} ${data.byCategory[0].name}` : '-'}
              sub={data.byCategory[0] ? `${data.byCategory[0].pct}% of spending` : undefined}
            />
          </View>

          {/* Categories Breakdown */}
          <SectionTitle>Where the Money Goes</SectionTitle>
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

          {/* Group Breakdown (Unique key applied) */}
          {groupId === 'all' && data.byGroup.length > 1 && (
            <>
              <SectionTitle>By Group</SectionTitle>
              <Card>
                <HBarList
                  rows={data.byGroup.map((g, idx) => ({
                    key: `grp-${g.id}-${idx}`,
                    label: g.name,
                    value: g.amount,
                    sub: `${data.total ? Math.round((g.amount / data.total) * 100) : 0}%`,
                  }))}
                  format={fmt}
                />
              </Card>
            </>
          )}

          {/* Monthly Trends */}
          <SectionTitle>Monthly Trajectory</SectionTitle>
          <Card>
            <ColumnChart data={data.byMonth.map((m) => ({ label: m.label, value: m.amount }))} format={fmt} />
          </Card>

          {/* People & Consumption */}
          {people.length > 0 && (
            <>
              <SectionTitle>Who’s Spending</SectionTitle>
              <Card>
                <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 8 }}>
                  “Paid” is money put down at checkout. “Share” is what they actually consumed.
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

              <SectionTitle>What Each Person Spends On</SectionTitle>
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

          {/* Day of Week */}
          <SectionTitle>By Day of Week</SectionTitle>
          <Card>
            <ColumnChart data={data.byWeekday.map((d) => ({ label: d.label, value: d.amount }))} format={fmt} height={100} highlightLast={false} />
          </Card>

          {/* Biggest Individual Expenses */}
          <SectionTitle>Biggest Expenses</SectionTitle>
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
  return <Text style={{ fontSize: 11, fontWeight: '800', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</Text>;
}

function FilterTabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: active ? colors.primary : colors.bg,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : colors.text }}>{label}</Text>
    </Pressable>
  );
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

function AIBullet({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#1E293B', padding: 10, borderRadius: 10 }}>
      <Text style={{ fontSize: 16 }}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#E2E8F0', fontWeight: '800', fontSize: 13 }}>{title}</Text>
        <Text style={{ color: '#94A3B8', fontSize: 12, marginTop: 2, lineHeight: 16 }}>{body}</Text>
      </View>
    </View>
  );
}
