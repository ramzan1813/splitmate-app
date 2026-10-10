import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Animated, PanResponder, Platform, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Avatar, Button, Card, Empty, HeaderButton, Loading, Row, SectionTitle, Segmented, swipeArea } from '@/components/ui';
import { TransactionCard } from '@/components/TransactionCard';
import { useGroup } from '@/lib/useGroup';
import { money } from '@/lib/format';
import { categoryIcon, colorFor, colors } from '@/lib/theme';
import { Transaction } from '@/data/types';
import { dragOffset, isHorizontalSwipe, swipeDirection } from '@/lib/swipeTabs';

type FilterTab = 'all' | 'paid' | 'shared' | 'payments';
const FILTERS: FilterTab[] = ['all', 'paid', 'shared', 'payments'];
const useNativeDriver = Platform.OS !== 'web';

export default function MemberDashboardScreen() {
  const { id, memberId } = useLocalSearchParams<{ id: string; memberId: string }>();
  const router = useRouter();
  const nav = useNavigation();
  const { data, error, reload, refresh, memberName, memberIndex } = useGroup(id);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const mid = Number(memberId);
  const member = data?.members.find((m) => m.id === mid);
  const stat = data?.stats.find((s) => s.memberId === mid);
  const cur = data?.group.currency ?? 'USD';
  const isMe = member?.id === data?.myMemberId;

  useLayoutEffect(() => {
    if (member) {
      nav.setOptions({
        title: `${member.name}${isMe ? ' (You)' : ''}`,
        headerRight: () => (
          <Row style={{ alignItems: 'center', gap: 4 }}>
            <HeaderButton
              icon="👥"
              onPress={() => router.push(`/group/${id}/members`)}
              testID="open-members"
              accessibilityLabel="Members"
            />
          </Row>
        ),
      });
    }
  }, [nav, member, isMe, id, router]);

  const [settlementMode, setSettlementMode] = useState<'direct' | 'simplified'>('direct');

  const {
    paidExpenses,
    sharedExpenses,
    payments,
    allInvolved,
    categoryBreakdown,
    paidCategoryBreakdown,
    owesList,
    owedList,
  } = useMemo(() => {
    if (!data || !member) {
      return {
        paidExpenses: [] as Transaction[],
        sharedExpenses: [] as Transaction[],
        payments: [] as Transaction[],
        allInvolved: [] as Transaction[],
        categoryBreakdown: [] as { label: string; value: number; count: number; color: string }[],
        paidCategoryBreakdown: [] as { label: string; value: number; count: number; color: string }[],
        owesList: [],
        owedList: [],
      };
    }

    const paidExp: Transaction[] = [];
    const sharedExp: Transaction[] = [];
    const pmts: Transaction[] = [];
    const allInv: Transaction[] = [];
    const catMap = new Map<string, { value: number; count: number }>();
    const paidCatMap = new Map<string, { value: number; count: number }>();

    for (const t of data.transactions) {
      const isPayer = t.paidBy === mid;
      const mySplit = t.splits.find((s) => s.memberId === mid);
      const isBeneficiary = !!mySplit;

      if (t.type === 'expense') {
        if (isPayer) {
          paidExp.push(t);
          const currentPaid = paidCatMap.get(t.category) || { value: 0, count: 0 };
          paidCatMap.set(t.category, {
            value: currentPaid.value + t.amount,
            count: currentPaid.count + 1,
          });
        }
        if (isBeneficiary) {
          sharedExp.push(t);
          const currentCat = catMap.get(t.category) || { value: 0, count: 0 };
          catMap.set(t.category, {
            value: currentCat.value + mySplit.share,
            count: currentCat.count + 1,
          });
        }
      } else if (t.type === 'payment') {
        if (isPayer || isBeneficiary) pmts.push(t);
      }

      if (isPayer || isBeneficiary) {
        allInv.push(t);
      }
    }

    const categories = Array.from(catMap.entries())
      .filter(([_, d]) => d.value > 0)
      .map(([name, d], i) => ({
        label: name,
        value: d.value,
        count: d.count,
        color: colorFor(i),
      }))
      .sort((a, b) => b.value - a.value);

    const paidCategories = Array.from(paidCatMap.entries())
      .filter(([_, d]) => d.value > 0)
      .map(([name, d], i) => ({
        label: name,
        value: d.value,
        count: d.count,
        color: colorFor(i),
      }))
      .sort((a, b) => b.value - a.value);

    const sourceSettlements =
      settlementMode === 'direct'
        ? (data.directSettlements ?? data.settlements)
        : data.settlements;

    const owes = sourceSettlements.filter((s) => s.from === mid);
    const owed = sourceSettlements.filter((s) => s.to === mid);

    return {
      paidExpenses: paidExp,
      sharedExpenses: sharedExp,
      payments: pmts,
      allInvolved: allInv,
      categoryBreakdown: categories,
      paidCategoryBreakdown: paidCategories,
      owesList: owes,
      owedList: owed,
    };
  }, [data, member, mid, settlementMode]);

  const directOwed = useMemo(
    () =>
      (data?.directSettlements ?? [])
        .filter((ds) => ds.from === mid)
        .reduce((sum, ds) => sum + ds.amount, 0),
    [data, mid]
  );
  const directCredit = useMemo(
    () =>
      (data?.directSettlements ?? [])
        .filter((ds) => ds.to === mid)
        .reduce((sum, ds) => sum + ds.amount, 0),
    [data, mid]
  );
  const directNetBalance = directCredit - directOwed;
  const displayNetBalance = settlementMode === 'direct' ? directNetBalance : (stat?.balance ?? 0);

  useEffect(() => {
    return () => {
      setSettlementMode('direct');
    };
  }, []);

  // Swiping the activity list left/right moves between its filter tabs, like the group screen's tabs.
  // Only clearly horizontal drags are claimed, so vertical scrolling and taps on cards still work.
  const { width } = useWindowDimensions();
  const [slide] = useState(() => new Animated.Value(0));
  const swipe = useMemo(() => {
    const index = FILTERS.indexOf(filter);
    const springBack = () => Animated.spring(slide, { toValue: 0, useNativeDriver }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) => isHorizontalSwipe(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => slide.setValue(dragOffset(FILTERS.length, index, g.dx)),
      onPanResponderRelease: (_, g) => {
        const dir = swipeDirection(FILTERS.length, index, g.dx, g.vx);
        const next = FILTERS[index + dir];
        if (!dir || !next) return springBack();
        Animated.timing(slide, { toValue: -dir * width, duration: 140, useNativeDriver }).start(() => {
          setFilter(next);
          slide.setValue(dir * width);
          Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver }).start();
        });
      },
      onPanResponderTerminate: springBack,
    });
  }, [filter, slide, width]);

  if (!data || !member || !stat) {
    if (error) {
      return (
        <Empty title="Couldn’t load member details" subtitle={error}>
          <Button title="Retry" onPress={reload} />
        </Empty>
      );
    }
    return <Loading />;
  }

  const totalCategoryShare = categoryBreakdown.reduce((sum, c) => sum + c.value, 0);

  const filteredTransactions = (() => {
    let list =
      filter === 'paid'
        ? paidExpenses
        : filter === 'shared'
          ? sharedExpenses
          : filter === 'payments'
            ? payments
            : allInvolved;

    if (selectedCategory) {
      list = list.filter((t) => t.category === selectedCategory);
    }
    return list;
  })();

  const mIndex = memberIndex(mid);

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: 60, maxWidth: 760, width: '100%', alignSelf: 'center' }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }}
        />
      }
    >
      {/* Member Hero Header Card */}
      <View
        style={{
          backgroundColor: colors.primary,
          borderRadius: 20,
          padding: 20,
          marginBottom: 16,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 10,
          elevation: 4,
        }}
      >
        <Row style={{ alignItems: 'center', marginBottom: 14 }}>
          <Avatar name={member.name} index={mIndex} size={54} />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Row style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>{member.name}</Text>
              {isMe && (
                <View style={{ backgroundColor: 'rgba(255,255,255,0.25)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
                  <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>YOU</Text>
                </View>
              )}
              {member.userId ? (
                <View style={{ backgroundColor: '#e6f4ea', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
                  <Text style={{ color: '#137333', fontSize: 11, fontWeight: '700' }}>👤 Real User</Text>
                </View>
              ) : (
                <View style={{ backgroundColor: '#fef7e0', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
                  <Text style={{ color: '#b06000', fontSize: 11, fontWeight: '700' }}>Dummy User</Text>
                </View>
              )}
            </Row>
            <Text style={{ color: colors.primaryLight, fontSize: 13, marginTop: 3 }}>
              Group: <Text style={{ fontWeight: '700' }}>{data.group.name}</Text>
            </Text>
          </View>
        </Row>

        {/* Net Balance Headline */}
        <View style={{ backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 14, padding: 14, marginBottom: 14 }}>
          <Text style={{ color: colors.primaryLight, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {settlementMode === 'direct' ? 'Direct Standing' : 'Net Standing (Group)'}
          </Text>
          <Text
            style={{
              color: displayNetBalance > 0 ? '#A7F3D0' : displayNetBalance < 0 ? '#FECACA' : '#FFFFFF',
              fontSize: 26,
              fontWeight: '900',
              marginTop: 2,
            }}
            testID="member-net-balance"
          >
            {displayNetBalance > 0
              ? `Gets back ${money(displayNetBalance, cur)}`
              : displayNetBalance < 0
                ? `Owes ${money(-displayNetBalance, cur)}`
                : 'All Settled Up'}
          </Text>
        </View>

        {/* Financial Stat Matrix */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.18)', paddingTop: 12 }}>
          <View style={{ flex: 1, minWidth: '45%' }}>
            <Text style={{ color: colors.primaryLight, fontSize: 11 }}>Expenses Paid</Text>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 1 }}>{money(stat.totalPaid, cur)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: '45%' }}>
            <Text style={{ color: colors.primaryLight, fontSize: 11 }}>Total Share (Benefit)</Text>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 1 }}>{money(stat.totalBenefit, cur)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: '45%' }}>
            <Text style={{ color: colors.primaryLight, fontSize: 11 }}>Payments Sent</Text>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 1 }}>{money(stat.paymentsMade, cur)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: '45%' }}>
            <Text style={{ color: colors.primaryLight, fontSize: 11 }}>Payments Received</Text>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 1 }}>{money(stat.paymentsReceived, cur)}</Text>
          </View>
        </View>
      </View>

      {/* Quick Action Buttons */}
      <Row style={{ gap: 10, marginBottom: 16 }}>
        {data.canAdd && (
          <Button
            title="+ Add Expense"
            variant="outline"
            onPress={() => router.push(`/group/${id}/expense?paidBy=${mid}`)}
            style={{ flex: 1, backgroundColor: '#fff' }}
            testID="member-add-expense"
          />
        )}
        <Button
          title="💳 Record Payment"
          onPress={() => {
            const myId = data.myMemberId;
            if (myId && myId !== mid) {
              if (displayNetBalance < 0) {
                // this member owes money -> pay from this member to me
                router.push(`/group/${id}/payment?from=${mid}&to=${myId}`);
              } else {
                // this member gets back money -> pay from me to this member
                router.push(`/group/${id}/payment?from=${myId}&to=${mid}`);
              }
            } else {
              router.push(`/group/${id}/payment?from=${mid}`);
            }
          }}
          style={{ flex: 1 }}
          testID="member-add-payment"
        />
      </Row>

      {/* Settlement Status / Pairwise Debts */}
      <Card style={{ marginBottom: 16 }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <Text style={{ fontWeight: '800', fontSize: 16 }}>Settlement Breakdown</Text>
          <View style={{ minWidth: 200 }}>
            <Segmented
              style={{ marginBottom: 0 }}
              value={settlementMode}
              onChange={(val) => setSettlementMode(val as 'direct' | 'simplified')}
              options={[
                { value: 'direct', label: 'Direct' },
                { value: 'simplified', label: 'Simplified' },
              ]}
            />
          </View>
        </Row>
        <Text style={{ fontSize: 12, color: colors.muted, marginBottom: 12 }}>
          {settlementMode === 'direct'
            ? 'Exact direct debts calculated from shared transactions between members.'
            : 'Simplified group debt routing minimizing total payments.'}
        </Text>
        {owesList.length === 0 && owedList.length === 0 && (
          <Text style={{ color: colors.muted, fontSize: 13, paddingVertical: 8, textAlign: 'center' }}>
            No pending debts for this member.
          </Text>
        )}
        {owesList.map((s, idx) => (
            <Row key={`owes-${idx}`} style={{ justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: idx < owesList.length - 1 ? 1 : 0, borderBottomColor: colors.border }}>
              <Row style={{ alignItems: 'center', flex: 1 }}>
                <Text style={{ fontSize: 16, marginRight: 6 }}>🔴</Text>
                <Text style={{ color: colors.text, fontSize: 14 }}>
                  Owes <Text style={{ fontWeight: '700' }}>{memberName(s.to)}</Text>
                </Text>
              </Row>
              <Row style={{ alignItems: 'center', gap: 8 }}>
                <Text style={{ color: colors.negative, fontWeight: '800', fontSize: 15 }}>{money(s.amount, cur)}</Text>
                <Button
                  small
                  title="Settle"
                  onPress={() => router.push(`/group/${id}/payment?from=${mid}&to=${s.to}&amount=${(s.amount / 100).toFixed(2)}`)}
                />
              </Row>
            </Row>
          ))}
          {owedList.map((s, idx) => (
            <Row key={`owed-${idx}`} style={{ justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderTopWidth: owesList.length > 0 && idx === 0 ? 1 : 0, borderTopColor: colors.border }}>
              <Row style={{ alignItems: 'center', flex: 1 }}>
                <Text style={{ fontSize: 16, marginRight: 6 }}>🟢</Text>
                <Text style={{ color: colors.text, fontSize: 14 }}>
                  <Text style={{ fontWeight: '700' }}>{memberName(s.from)}</Text> owes {member.name}
                </Text>
              </Row>
              <Row style={{ alignItems: 'center', gap: 8 }}>
                <Text style={{ color: colors.positive, fontWeight: '800', fontSize: 15 }}>{money(s.amount, cur)}</Text>
                <Button
                  small
                  variant="outline"
                  title="Settle"
                  onPress={() => router.push(`/group/${id}/payment?from=${s.from}&to=${mid}&amount=${(s.amount / 100).toFixed(2)}`)}
                />
              </Row>
            </Row>
          ))}
        </Card>

      {/* Expense Breakdown by Category Card */}
      {categoryBreakdown.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '800', fontSize: 16 }}>Expense Breakdown by Category</Text>
              <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>
                {money(totalCategoryShare, cur)} across {categoryBreakdown.length} {categoryBreakdown.length === 1 ? 'category' : 'categories'}
              </Text>
            </View>
            <Text style={{ fontSize: 11, color: colors.muted }}>Tap row to filter</Text>
          </Row>

          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
            {categoryBreakdown.map((c) => {
              const pct = totalCategoryShare > 0 ? (c.value / totalCategoryShare) * 100 : 0;
              const isSelected = selectedCategory === c.label;

              return (
                <Pressable
                  key={c.label}
                  onPress={() => setSelectedCategory(isSelected ? null : c.label)}
                  style={({ pressed }) => ({
                    paddingVertical: 9,
                    paddingHorizontal: 8,
                    borderRadius: 10,
                    backgroundColor: isSelected ? 'rgba(15, 118, 110, 0.1)' : pressed ? 'rgba(0,0,0,0.03)' : 'transparent',
                    marginBottom: 6,
                  })}
                >
                  <Row style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Row style={{ alignItems: 'center', flex: 1, marginRight: 8 }}>
                      <View
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          backgroundColor: `${c.color}22`,
                          borderWidth: 1.5,
                          borderColor: c.color,
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginRight: 10,
                        }}
                      >
                        <Text style={{ fontSize: 15 }}>{categoryIcon(c.label)}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Row style={{ alignItems: 'center', gap: 6 }}>
                          <Text style={{ fontWeight: isSelected ? '800' : '700', fontSize: 14, color: isSelected ? colors.primary : colors.text }}>
                            {c.label}
                          </Text>
                          <Text style={{ fontSize: 11, color: colors.muted }}>
                            ({c.count} {c.count === 1 ? 'expense' : 'expenses'})
                          </Text>
                        </Row>
                      </View>
                    </Row>

                    <Row style={{ alignItems: 'center', gap: 8 }}>
                      <Text style={{ fontSize: 12, color: colors.muted, fontWeight: '700' }}>
                        {pct.toFixed(1)}%
                      </Text>
                      <Text style={{ fontWeight: '800', fontSize: 14, color: colors.text }}>
                        {money(c.value, cur)}
                      </Text>
                    </Row>
                  </Row>

                  {/* Visual progress proportion bar */}
                  <View style={{ height: 6, backgroundColor: '#E2E8F0', borderRadius: 3, overflow: 'hidden' }}>
                    <View style={{ height: '100%', width: `${Math.min(Math.max(pct, 2), 100)}%`, backgroundColor: c.color, borderRadius: 3 }} />
                  </View>
                </Pressable>
              );
            })}

            {/* Total Summary Row */}
            <View
              style={{
                marginTop: 6,
                paddingTop: 10,
                borderTopWidth: 1,
                borderTopColor: colors.border,
              }}
            >
              <Row style={{ justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 8 }}>
                <Text style={{ fontWeight: '800', fontSize: 14, color: colors.text }}>Total Share</Text>
                <Row style={{ alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: 12, color: colors.muted, fontWeight: '700' }}>100%</Text>
                  <Text style={{ fontWeight: '900', fontSize: 15, color: colors.primary }}>
                    {money(totalCategoryShare, cur)}
                  </Text>
                </Row>
              </Row>
            </View>
          </View>
        </Card>
      )}

      {/* Transaction List with Filter Tabs */}
      <SectionTitle>Activity & Transactions</SectionTitle>

      {/* Category Filter Active Indicator */}
      {selectedCategory && (
        <Row
          style={{
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'rgba(15, 118, 110, 0.1)',
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 10,
            marginBottom: 10,
          }}
        >
          <Row style={{ alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 14 }}>{categoryIcon(selectedCategory)}</Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.primary }}>
              Filtered by: {selectedCategory} ({filteredTransactions.length})
            </Text>
          </Row>
          <Pressable onPress={() => setSelectedCategory(null)} hitSlop={8}>
            <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 13 }}>Clear ✕</Text>
          </Pressable>
        </Row>
      )}

      <View style={swipeArea} {...swipe.panHandlers} testID="member-activity-swipe">
      <Segmented<FilterTab>
        options={[
          { value: 'all', label: `All (${allInvolved.length})` },
          { value: 'paid', label: `Paid (${paidExpenses.length})` },
          { value: 'shared', label: `Shared (${sharedExpenses.length})` },
          { value: 'payments', label: `Payments (${payments.length})` },
        ]}
        value={filter}
        onChange={setFilter}
      />

      <Animated.View style={{ transform: [{ translateX: slide }] }} testID="member-activity-content">
      {filteredTransactions.length === 0 ? (
        <Empty
          title="No transactions found"
          subtitle={
            filter === 'paid'
              ? `${member.name} hasn’t paid for any expenses yet.`
              : filter === 'shared'
                ? `${member.name} hasn’t been included in any split expenses yet.`
                : filter === 'payments'
                  ? `No direct payments recorded for ${member.name}.`
                  : `No transactions involving ${member.name} yet.`
          }
        />
      ) : (
        filteredTransactions.map((t) => (
          <TransactionCard
            key={t.id}
            t={t}
            currency={cur}
            myMemberId={data.myMemberId}
            memberName={memberName}
            memberIndex={memberIndex}
            onPress={() => router.push(`/group/${id}/transaction/${t.id}`)}
          />
        ))
      )}
      </Animated.View>
      </View>
    </ScrollView>
  );
}
