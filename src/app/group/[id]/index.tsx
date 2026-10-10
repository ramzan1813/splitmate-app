import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Animated, Modal, PanResponder, Platform, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Avatar, Button, Card, Empty, HeaderButton, Loading, Row, Segmented, SectionTitle } from '@/components/ui';
import { PieChart } from '@/components/PieChart';
import { TransactionCard } from '@/components/TransactionCard';
import { QRCode } from '@/components/QRCode';
import { QRScannerModal } from '@/components/QRScannerModal';
import * as Clipboard from 'expo-clipboard';
import { useGroup, useSyncStatus } from '@/lib/useGroup';
import { GroupSyncStatus, syncEngine } from '@/data/syncEngine';
import { getUnresolvedOutboxMutations } from '@/data/outbox';
import { GROUP_NOT_FOUND } from '@/data/repo';
import { DEFAULT_SERVER_URL, getServerUrl } from '@/lib/identity';
import { buildInviteLink } from '@/lib/invite';
import { money } from '@/lib/format';
import { dragOffset, isHorizontalSwipe, swipeDirection } from '@/lib/swipeTabs';
import { colors, colorFor, categoryIcon } from '@/lib/theme';
import { confirm, errorMessage, notify } from '@/lib/dialog';
import { Settlement } from '@/data/types';
import { canSettle as canSettleFor, getSettlementCauses } from '@/data/logic';

type Tab = 'transactions' | 'balances' | 'settle' | 'chart';
/** Order of the tabs in the segmented bar; swiping left/right moves through this list. */
const TABS: Tab[] = ['transactions', 'balances', 'settle', 'chart'];
const useNativeDriver = Platform.OS !== 'web';

export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const nav = useNavigation();
  const { data, error, reload, refresh, memberName, memberIndex } = useGroup(id);
  const syncStatus = useSyncStatus(data?.group.uid);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  useEffect(() => {
    getServerUrl().then(setServerUrl).catch(() => {});
  }, []);
  const [tab, setTab] = useState<Tab>('transactions');
  const [refreshing, setRefreshing] = useState(false);
  const [chartMode, setChartMode] = useState<'paid' | 'share' | 'category'>('share');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [copied, setCopied] = useState(false);
  const [settlementMode, setSettlementMode] = useState<'direct' | 'simplified'>('direct');
  const [breakdownSettlement, setBreakdownSettlement] = useState<(Settlement & { isDirect?: boolean }) | null>(null);

  useEffect(() => {
    return () => {
      setSettlementMode('direct');
    };
  }, []);

  const breakdownData = useMemo(() => {
    if (!breakdownSettlement || !data) return null;
    const s = breakdownSettlement;
    const cur = data.group.currency ?? 'PKR';
    const { directCauses, directTotal } = getSettlementCauses(s, data.transactions);

    const fromName = memberName(s.from);
    const toName = memberName(s.to);
    const simplificationDiff = s.amount - directTotal;
    const isDirect = s.isDirect ?? (simplificationDiff === 0);

    const debtorExpenses = data.transactions.filter(
      (t) => t.type === 'expense' && t.paidBy !== s.from && t.splits.some((sp) => sp.memberId === s.from && sp.share > 0)
    );

    return {
      settlement: s,
      fromName,
      toName,
      cur,
      directCauses,
      directTotal,
      simplificationDiff,
      isDirect,
      debtorExpenses,
    };
  }, [breakdownSettlement, data, memberName]);

  // Horizontal swipe switches tabs. Only claims clearly horizontal drags, so vertical scrolling and taps still work.
  const { width } = useWindowDimensions();
  const [slide] = useState(() => new Animated.Value(0));
  const swipe = useMemo(() => {
    const index = TABS.indexOf(tab);
    const springBack = () => Animated.spring(slide, { toValue: 0, useNativeDriver }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) => isHorizontalSwipe(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => slide.setValue(dragOffset(TABS.length, index, g.dx)),
      onPanResponderRelease: (_, g) => {
        const dir = swipeDirection(TABS.length, index, g.dx, g.vx);
        const next = TABS[index + dir];
        if (!dir || !next) return springBack();
        Animated.timing(slide, { toValue: -dir * width, duration: 140, useNativeDriver }).start(() => {
          setTab(next);
          setSettlementMode('direct');
          reload();
          slide.setValue(dir * width);
          Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver }).start();
        });
      },
      onPanResponderTerminate: springBack,
    });
  }, [tab, slide, width]);

  useLayoutEffect(() => {
    nav.setOptions({
      title: data?.group.name ?? '',
      headerRight: () => (
        <Row style={{ alignItems: 'center', gap: 4 }}>
          <HeaderButton
            title="Invite"
            icon="🔗"
            highlight
            onPress={() => setShowInviteModal(true)}
            testID="open-invite"
          />
          <HeaderButton
            icon="👥"
            onPress={() => router.push(`/group/${id}/members`)}
            testID="open-members"
            accessibilityLabel="Members"
          />
          <HeaderButton
            icon="⚙"
            onPress={() => router.push(`/group/${id}/settings`)}
            testID="open-settings"
            accessibilityLabel="Group settings"
          />
        </Row>
      ),
    });
  }, [nav, data, id, router]);

  const cur = data?.group.currency ?? 'USD';
  const me = data?.stats.find((s) => s.memberId === data.myMemberId);
  const canSettle = (s: { from: number; to: number }) => !!data && canSettleFor(data, s);

  const inviteLink = useMemo(() => {
    if (!data?.group?.uid) return '';
    return buildInviteLink(serverUrl, data.group);
  }, [data, serverUrl]);

  const chartData = useMemo(() => {
    if (!data) return [];
    if (chartMode === 'category') {
      return data.categories.map((c, i) => ({ label: c.name, value: c.amount, color: colorFor(i) }));
    }
    return data.stats.map((s) => ({
      label: s.name,
      value: chartMode === 'paid' ? s.totalPaid : s.totalBenefit,
      color: colorFor(memberIndex(s.memberId)),
    }));
  }, [data, chartMode, memberIndex]);

  if (!data) {
    if (error === GROUP_NOT_FOUND) {
      return (
        <Empty title="This group is no longer here" subtitle="It was deleted by its admin or removed from this phone.">
          <Button title="Back to groups" onPress={() => router.dismissTo('/')} testID="group-gone-home" />
        </Empty>
      );
    }
    return error ? <Empty title="Couldn't load group" subtitle={error}><Button title="Retry" onPress={reload} /></Empty> : <Loading />;
  }

  const chartTotal = chartData.reduce((a, b) => a + b.value, 0);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} {...swipe.panHandlers}>
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 120, maxWidth: 760, width: '100%', alignSelf: 'center' }}
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
          {/* Summary header */}
          <View style={{ backgroundColor: colors.primary, borderRadius: 16, padding: 16, marginBottom: 14 }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.primaryLight, fontSize: 13 }}>Total group spending</Text>
              <SyncBadge status={syncStatus} groupUid={data.group.uid} onRefresh={refresh} />
            </Row>
            <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800' }} testID="total-spending">
              {money(data.totals.totalExpenses, cur)}
            </Text>
            <Row style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.primaryLight, fontSize: 13, flex: 1, marginRight: 8 }}>Group balance</Text>
              <Text
                style={{ color: data.totals.groupBalance < 0 ? '#FECACA' : '#fff', fontSize: 16, fontWeight: '800' }}
                numberOfLines={1}
                testID="group-balance"
                accessibilityLabel={`Group balance ${money(data.totals.groupBalance, cur)}: payments ${money(data.totals.totalPayments, cur)} minus expenses`}
              >
                {money(data.totals.groupBalance, cur)}
              </Text>
            </Row>
            {me && (() => {
              if (settlementMode === 'direct') {
                const myDirectDebts = (data.directSettlements ?? []).filter((s) => s.from === data.myMemberId);
                const myDirectCredits = (data.directSettlements ?? []).filter((s) => s.to === data.myMemberId);
                const totalOwedDirectly = myDirectDebts.reduce((sum, s) => sum + s.amount, 0);
                const totalReceivableDirectly = myDirectCredits.reduce((sum, s) => sum + s.amount, 0);

                const net = totalReceivableDirectly - totalOwedDirectly;
                if (net > 0) {
                  return (
                    <Text style={{ color: '#A7F3D0', marginTop: 6, fontWeight: '700' }} testID="my-balance">
                      You get back {money(net, cur)} directly
                    </Text>
                  );
                } else if (net < 0) {
                  return (
                    <Text style={{ color: '#FECACA', marginTop: 6, fontWeight: '700' }} testID="my-balance">
                      You owe {money(-net, cur)} directly
                    </Text>
                  );
                } else {
                  return (
                    <Text style={{ color: '#fff', marginTop: 6 }} testID="my-balance">
                      You are all settled up (Rs 0.00)
                    </Text>
                  );
                }
              }

              return (
                <Text style={{ color: '#fff', marginTop: 6 }} testID="my-balance">
                  {me.balance > 0
                    ? `You get back ${money(me.balance, cur)}`
                    : me.balance < 0
                      ? `You owe ${money(-me.balance, cur)}`
                      : 'You are all settled up'}
                </Text>
              );
            })()}
            {!me && (
              <Pressable onPress={() => router.push(`/group/${id}/members`)}>
                <Text style={{ color: colors.primaryLight, marginTop: 6, textDecorationLine: 'underline' }}>Tap to choose which member is you</Text>
              </Pressable>
            )}
          </View>

          <Segmented<Tab>
            value={tab}
            onChange={(newTab) => {
              setTab(newTab);
              setSettlementMode('direct');
              reload();
            }}
            options={[
              { value: 'transactions', label: 'Expenses' },
              { value: 'balances', label: 'Balances' },
              { value: 'settle', label: 'Settle up' },
              { value: 'chart', label: 'Chart' },
            ]}
          />

          <Animated.View style={{ transform: [{ translateX: slide }] }} testID="group-tab-content">
            {tab === 'transactions' &&
              (data.transactions.length === 0 ? (
                <Empty title="No expenses yet" subtitle='Tap “Add expense” to record the first one.' />
              ) : (
                data.transactions.map((t) => (
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
              ))}

            {tab === 'balances' &&
              data.stats.map((s) => {
                const memberDebts = (data.directSettlements ?? []).filter((ds) => ds.from === s.memberId);
                const memberCredits = (data.directSettlements ?? []).filter((ds) => ds.to === s.memberId);
                const directOwed = memberDebts.reduce((sum, ds) => sum + ds.amount, 0);
                const directCredit = memberCredits.reduce((sum, ds) => sum + ds.amount, 0);
                const netDirect = directCredit - directOwed;

                const displayBalance = settlementMode === 'direct' ? netDirect : s.balance;

                return (
                  <Pressable
                    key={s.memberId}
                    onPress={() => router.push(`/group/${id}/member/${s.memberId}`)}
                    testID={`member-balance-${s.memberId}`}
                    style={({ pressed }) => pressed && { opacity: 0.85 }}
                  >
                    <Card>
                      <Row style={{ alignItems: 'center' }}>
                        <Avatar name={s.name} index={memberIndex(s.memberId)} />
                        <View style={{ flex: 1, marginLeft: 12 }}>
                          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={{ fontWeight: '700', fontSize: 15 }}>
                              {s.name}
                              {s.memberId === data.myMemberId ? ' (you)' : ''}
                            </Text>
                            <Text style={{ fontSize: 12, color: colors.primary, fontWeight: '700' }}>Details →</Text>
                          </Row>
                          <Text style={{ color: displayBalance > 0 ? colors.positive : displayBalance < 0 ? colors.negative : colors.muted, fontWeight: '700', marginTop: 2 }}>
                            {displayBalance > 0 ? `gets back ${money(displayBalance, cur)}` : displayBalance < 0 ? `owes ${money(-displayBalance, cur)}` : 'settled up'}
                          </Text>
                          {settlementMode === 'direct' && (memberDebts.length > 0 || memberCredits.length > 0) && (
                            <View style={{ marginTop: 6, paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.border }}>
                              {memberDebts.map((d, i) => (
                                <Text key={`debt-${i}`} style={{ fontSize: 12, color: colors.negative, fontWeight: '600', marginTop: 1 }}>
                                  🔴 owes {memberName(d.to)}: {money(d.amount, cur)}
                                </Text>
                              ))}
                              {memberCredits.map((c, i) => (
                                <Text key={`cred-${i}`} style={{ fontSize: 12, color: colors.positive, fontWeight: '600', marginTop: 1 }}>
                                  🟢 gets back from {memberName(c.from)}: {money(c.amount, cur)}
                                </Text>
                              ))}
                            </View>
                          )}
                        </View>
                      </Row>
                      <View style={{ flexDirection: 'row', marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
                        <Stat label="Expenses paid" value={money(s.totalPaid, cur)} />
                        <Stat label="Share (benefit)" value={money(s.totalBenefit, cur)} />
                        <Stat label="Paid / Received" value={`${money(s.paymentsMade, cur)} / ${money(s.paymentsReceived, cur)}`} />
                      </View>
                    </Card>
                  </Pressable>
                );
              })}

            {tab === 'settle' && (() => {
              const activeSettlements = settlementMode === 'direct' ? (data.directSettlements ?? []) : (data.settlements ?? []);
              return (
                <>
                  <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                    <SectionTitle style={{ marginBottom: 0 }}>Suggested payments</SectionTitle>
                    <View style={{ minWidth: 200 }}>
                      <Segmented<'direct' | 'simplified'>
                        style={{ marginBottom: 0 }}
                        value={settlementMode}
                        onChange={setSettlementMode}
                        options={[
                          { value: 'direct', label: 'Direct' },
                          { value: 'simplified', label: 'Simplified' },
                        ]}
                      />
                    </View>
                  </Row>
                  <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 12 }}>
                    {settlementMode === 'direct'
                      ? 'Direct debts: Exact pairwise balances between members who shared expenses together.'
                      : 'Simplified debts: Combines multi-person group balances to settle with fewest total transfers.'}
                  </Text>

                  {activeSettlements.length === 0 ? (
                    <Empty title="All settled up 🎉" subtitle="Nobody owes anything right now." />
                  ) : (
                    activeSettlements.map((x, i) => (
                      <Card key={`${settlementMode}-${i}`}>
                        <Row style={{ alignItems: 'center' }}>
                          <Avatar name={memberName(x.from)} index={memberIndex(x.from)} size={34} />
                          <View style={{ flex: 1, marginHorizontal: 10 }}>
                            <Text style={{ fontWeight: '600' }}>
                              <Text style={{ fontWeight: '800' }}>{memberName(x.from)}</Text> pays <Text style={{ fontWeight: '800' }}>{memberName(x.to)}</Text>
                            </Text>
                            <Text style={{ color: colors.negative, fontWeight: '800', fontSize: 16, marginTop: 2 }}>{money(x.amount, cur)}</Text>
                          </View>
                          <Row style={{ gap: 8, alignItems: 'center' }}>
                            <Button
                              small
                              variant="outline"
                              title="Breakdown"
                              testID={`settle-breakdown-${i}`}
                              onPress={() => setBreakdownSettlement({ ...x, isDirect: settlementMode === 'direct' })}
                            />
                            {canSettle(x) && (
                              <Button
                                small
                                title="Settle"
                                testID={`settle-${i}`}
                                onPress={() => router.push(`/group/${id}/payment?from=${x.from}&to=${x.to}&amount=${(x.amount / 100).toFixed(2)}`)}
                              />
                            )}
                          </Row>
                        </Row>
                      </Card>
                    ))
                  )}
                </>
              );
            })()}

            {tab === 'chart' && (
              <Card>
                <Segmented
                  value={chartMode}
                  onChange={setChartMode}
                  options={[
                    { value: 'share', label: 'Share' },
                    { value: 'paid', label: 'Paid' },
                    { value: 'category', label: 'Category' },
                  ]}
                />
                <PieChart data={chartData} centerLabel={chartMode === 'category' ? 'By category' : chartMode === 'paid' ? 'Paid' : 'Spent on'} centerValue={money(chartTotal, cur)} />
                <View style={{ marginTop: 16 }}>
                  {chartData.map((d) => (
                    <Row key={d.label} style={{ paddingVertical: 6 }}>
                      <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: d.color, marginRight: 10 }} />
                      <Text style={{ flex: 1, color: colors.text }}>{d.label}</Text>
                      <Text style={{ color: colors.muted, marginRight: 10 }}>{chartTotal ? Math.round((d.value / chartTotal) * 1000) / 10 : 0}%</Text>
                      <Text style={{ fontWeight: '700' }}>{money(d.value, cur)}</Text>
                    </Row>
                  ))}
                </View>
              </Card>
            )}
          </Animated.View>

          <Row style={{ gap: 10, marginTop: 8 }}>
            <Button title="📊 Insights" variant="outline" onPress={() => router.push(`/insights?groupId=${id}`)} style={{ flex: 1 }} testID="open-group-insights" />
            <Button title="📄 Report & export" variant="outline" onPress={() => router.push(`/group/${id}/report`)} style={{ flex: 1 }} testID="open-report" />
          </Row>
        </ScrollView>
      </View>

      {/* Responsive Bottom Floating Action Bar */}
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingBottom: Platform.OS === 'ios' ? 28 : 16,
          paddingTop: 10,
          backgroundColor: 'rgba(241, 245, 249, 0.96)',
          borderTopWidth: 1,
          borderTopColor: 'rgba(203, 213, 225, 0.7)',
        }}
      >
        {data.canAdd ? (
          <View style={{ width: '100%', maxWidth: 760, flexDirection: 'row', gap: 12 }}>
            <Button
              title="Record payment"
              variant="outline"
              onPress={() => router.push(`/group/${id}/payment`)}
              style={{ flex: 1, backgroundColor: '#fff' }}
              testID="add-payment"
            />
            <Button
              title="+ Add expense"
              onPress={() => router.push(`/group/${id}/expense`)}
              style={{ flex: 1 }}
              testID="add-expense"
            />
          </View>
        ) : (
          <View style={{ width: '100%', maxWidth: 760, alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.muted }}>
              🔒 Read-Only Group · Only admin ({data.group.creatorName || 'creator'}) can add expenses
            </Text>
          </View>
        )}
      </View>

      {/* Group Invite Modal */}
      <Modal visible={showInviteModal} transparent animationType="slide" onRequestClose={() => setShowInviteModal(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <View style={{ backgroundColor: '#fff', borderRadius: 20, padding: 24, maxWidth: 360, width: '100%', alignItems: 'center' }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Group Invite & Sync</Text>
            <Text style={{ fontSize: 13, color: colors.muted, textAlign: 'center', marginBottom: 16 }}>
              Scan this QR code with another phone to join and sync <Text style={{ fontWeight: '700' }}>{data.group.name}</Text>.
            </Text>

            {inviteLink ? <QRCode value={inviteLink} size={210} /> : null}

            <View style={{ marginTop: 16, width: '100%', gap: 8 }}>
              <Button
                title={copied ? '✓ Copied to Clipboard!' : 'Copy Invite Link'}
                variant="outline"
                onPress={async () => {
                  if (!inviteLink) return;
                  await Clipboard.setStringAsync(inviteLink);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2500);
                }}
              />
              <Button
                title="📷 Scan Another QR Code"
                variant="outline"
                onPress={() => {
                  setShowInviteModal(false);
                  setShowScanner(true);
                }}
              />
              <Button title="Done" onPress={() => setShowInviteModal(false)} />
            </View>
          </View>
        </View>
      </Modal>

      {/* Settle Breakdown Modal */}
      <Modal
        visible={Boolean(breakdownSettlement && breakdownData)}
        transparent
        animationType="slide"
        onRequestClose={() => setBreakdownSettlement(null)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View
            style={{
              backgroundColor: colors.bg,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              maxHeight: '88%',
              maxWidth: 580,
              width: '100%',
              alignSelf: 'center',
              overflow: 'hidden',
            }}
          >
            {/* Modal Header */}
            <View
              style={{
                paddingHorizontal: 20,
                paddingTop: 18,
                paddingBottom: 14,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
                backgroundColor: colors.card,
              }}
            >
              <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '800', fontSize: 18, color: colors.text }}>
                    Debt Breakdown
                  </Text>
                  <Text style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>
                    {breakdownData?.fromName} pays {breakdownData?.toName}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setBreakdownSettlement(null)}
                  hitSlop={12}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: colors.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  accessibilityLabel="Close breakdown"
                >
                  <Text style={{ fontSize: 16, fontWeight: '700', color: colors.muted }}>✕</Text>
                </Pressable>
              </Row>
            </View>

            <ScrollView
              contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 28 }}
              showsVerticalScrollIndicator={false}
            >
              {/* Relationship Banner */}
              <Card
                style={{
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderWidth: 1,
                  padding: 16,
                  marginBottom: 0,
                }}
              >
                <Row style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <Row style={{ alignItems: 'center', gap: 8 }}>
                    <Avatar
                      name={breakdownData?.fromName ?? ''}
                      index={memberIndex(breakdownData?.settlement.from ?? 0)}
                      size={36}
                    />
                    <View>
                      <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>
                        {breakdownData?.fromName}
                      </Text>
                      <Text style={{ fontSize: 11, color: colors.muted }}>Owes</Text>
                    </View>
                  </Row>

                  <View style={{ alignItems: 'center', paddingHorizontal: 6 }}>
                    <Text style={{ fontSize: 18, fontWeight: '900', color: colors.negative }}>
                      {money(breakdownData?.settlement.amount ?? 0, breakdownData?.cur ?? 'USD')}
                    </Text>
                    <Text style={{ fontSize: 11, color: colors.muted }}>➔ to</Text>
                  </View>

                  <Row style={{ alignItems: 'center', gap: 8 }}>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }}>
                        {breakdownData?.toName}
                      </Text>
                      <Text style={{ fontSize: 11, color: colors.muted }}>Gets back</Text>
                    </View>
                    <Avatar
                      name={breakdownData?.toName ?? ''}
                      index={memberIndex(breakdownData?.settlement.to ?? 0)}
                      size={36}
                    />
                  </Row>
                </Row>

                <Text style={{ fontSize: 13, color: colors.muted, lineHeight: 18 }}>
                  {breakdownData && breakdownData.directCauses.length > 0
                    ? breakdownData.isDirect
                      ? `Showing ${breakdownData.directCauses.length} direct transaction${
                          breakdownData.directCauses.length === 1 ? '' : 's'
                        } between ${breakdownData.toName} and ${breakdownData.fromName}.`
                      : `Showing direct transactions plus group-level debt simplification between ${breakdownData.toName} and ${breakdownData.fromName}.`
                    : `This amount is calculated from simplified multi-member balances to settle all group debts efficiently.`}
                </Text>
              </Card>

              {/* Multi-Person Debt Simplification Reconciliation */}
              {!breakdownData?.isDirect && breakdownData && breakdownData.simplificationDiff !== 0 && (
                <Card style={{ backgroundColor: '#f0fdf4', borderColor: '#bbf7d0', borderWidth: 1, padding: 14 }}>
                  <Text style={{ fontWeight: '800', color: '#166534', fontSize: 13, marginBottom: 8 }}>
                    💡 Multi-Person Debt Simplification
                  </Text>
                  <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ color: '#14532d', fontSize: 13, flex: 1, marginRight: 8 }}>
                      Direct balance between {breakdownData.fromName} and {breakdownData.toName}:
                    </Text>
                    <Text style={{ fontWeight: '700', color: '#14532d', fontSize: 13 }}>
                      {money(breakdownData.directTotal, breakdownData.cur)}
                    </Text>
                  </Row>
                  <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ color: '#14532d', fontSize: 13, flex: 1, marginRight: 8 }}>
                      Multi-person group adjustment:
                    </Text>
                    <Text style={{ fontWeight: '700', color: '#14532d', fontSize: 13 }}>
                      {breakdownData.simplificationDiff < 0 ? '-' : '+'}
                      {money(Math.abs(breakdownData.simplificationDiff), breakdownData.cur)}
                    </Text>
                  </Row>
                  <View style={{ height: 1, backgroundColor: '#bbf7d0', marginVertical: 6 }} />
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={{ fontWeight: '800', color: '#14532d', fontSize: 13 }}>
                      Net simplified payment:
                    </Text>
                    <Text style={{ fontWeight: '900', color: colors.negative, fontSize: 15 }}>
                      {money(breakdownData.settlement.amount, breakdownData.cur)}
                    </Text>
                  </Row>
                  <Text style={{ fontSize: 11, color: '#15803d', marginTop: 8, lineHeight: 15 }}>
                    EvenUp settled shared group debts with other members across this payment to minimize total transactions.
                  </Text>
                </Card>
              )}

              {/* Transactions List */}
              {breakdownData && breakdownData.directCauses.length > 0 ? (
                <View style={{ gap: 10 }}>
                  <Text style={{ fontWeight: '800', fontSize: 14, color: colors.text }}>
                    {breakdownData.isDirect
                      ? `Transactions causing this balance (${breakdownData.directCauses.length})`
                      : `Direct transactions between members (${breakdownData.directCauses.length})`}
                  </Text>
                  {breakdownData.directCauses.map((cause, idx) => {
                    const t = cause.transaction;
                    const isExpense = t.type === 'expense';
                    const isCreditorPayer = t.paidBy === breakdownData.settlement.to;
                    const detail = isExpense
                      ? isCreditorPayer
                        ? `${breakdownData.toName} paid ${money(t.amount, breakdownData.cur)} · ${breakdownData.fromName}'s share: ${money(cause.shareAmount, breakdownData.cur)}`
                        : `${breakdownData.fromName} paid ${money(t.amount, breakdownData.cur)} · ${breakdownData.toName}'s share: ${money(cause.shareAmount, breakdownData.cur)}`
                      : `Direct payment between members`;

                    return (
                      <Pressable
                        key={`cause-${t.id}-${idx}`}
                        onPress={() => {
                          setBreakdownSettlement(null);
                          router.push(`/group/${id}/transaction/${t.id}`);
                        }}
                        style={({ pressed }) => ({
                          backgroundColor: colors.card,
                          borderRadius: 14,
                          padding: 14,
                          borderWidth: 1,
                          borderColor: colors.border,
                          opacity: pressed ? 0.8 : 1,
                        })}
                      >
                        <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                          <Row style={{ alignItems: 'center', flex: 1, gap: 10 }}>
                            <View
                              style={{
                                width: 38,
                                height: 38,
                                borderRadius: 10,
                                backgroundColor: colors.primaryLight,
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <Text style={{ fontSize: 18 }}>{categoryIcon(t.category)}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontWeight: '700', fontSize: 14, color: colors.text }} numberOfLines={1}>
                                {t.title}
                              </Text>
                              <Text style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>{detail}</Text>
                            </View>
                          </Row>

                          <View style={{ alignItems: 'flex-end', marginLeft: 8 }}>
                            <Text
                              style={{
                                fontWeight: '800',
                                fontSize: 15,
                                color: cause.impact > 0 ? colors.negative : colors.positive,
                              }}
                            >
                              {cause.impact > 0 ? '+' : '-'}
                              {money(Math.abs(cause.shareAmount), breakdownData.cur)}
                            </Text>
                            <Text style={{ fontSize: 10, color: colors.muted, marginTop: 2 }}>
                              {cause.impact > 0 ? 'added to debt' : 'reduced debt'}
                            </Text>
                          </View>
                        </Row>
                      </Pressable>
                    );
                  })}
                  {breakdownData.directCauses.length > 0 && (
                    <Row style={{ justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 4 }}>
                      <Text style={{ fontWeight: '700', color: colors.muted, fontSize: 13 }}>
                        Direct pairwise total:
                      </Text>
                      <Text style={{ fontWeight: '800', color: colors.text, fontSize: 13 }}>
                        {money(breakdownData.directTotal, breakdownData.cur)}
                      </Text>
                    </Row>
                  )}
                </View>
              ) : (
                /* Simplified Multi-Person Settlement fallback */
                <View style={{ gap: 10 }}>
                  <Card style={{ backgroundColor: '#f0f9ff', borderColor: '#bae6fd', borderWidth: 1 }}>
                    <Text style={{ fontWeight: '700', color: '#0369a1', fontSize: 14, marginBottom: 4 }}>
                      ℹ️ Simplified Multi-Person Settlement
                    </Text>
                    <Text style={{ fontSize: 13, color: '#0c4a6e', lineHeight: 18 }}>
                      {breakdownData?.fromName} and {breakdownData?.toName} have no 1-to-1 direct expenses together. 
                      Instead, {breakdownData?.fromName} owes money across shared group expenses, and {breakdownData?.toName} paid for group expenses. 
                      EvenUp resolved these cross-debts into a single direct settlement to minimize total transfers.
                    </Text>
                  </Card>

                  {breakdownData && breakdownData.debtorExpenses.length > 0 && (
                    <View style={{ gap: 8, marginTop: 4 }}>
                      <Text style={{ fontWeight: '700', fontSize: 13, color: colors.text }}>
                        Expenses {breakdownData.fromName} participated in ({breakdownData.debtorExpenses.length}):
                      </Text>
                      {breakdownData.debtorExpenses.slice(0, 5).map((t) => {
                        const mySplit = t.splits.find((sp) => sp.memberId === breakdownData.settlement.from);
                        return (
                          <Pressable
                            key={`debtor-${t.id}`}
                            onPress={() => {
                              setBreakdownSettlement(null);
                              router.push(`/group/${id}/transaction/${t.id}`);
                            }}
                            style={{
                              backgroundColor: colors.card,
                              borderRadius: 12,
                              padding: 12,
                              borderWidth: 1,
                              borderColor: colors.border,
                            }}
                          >
                            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                              <Text style={{ fontWeight: '600', fontSize: 13, color: colors.text, flex: 1 }} numberOfLines={1}>
                                {t.title}
                              </Text>
                              <Text style={{ fontWeight: '700', fontSize: 13, color: colors.negative }}>
                                Share: {money(mySplit?.share ?? 0, breakdownData.cur)}
                              </Text>
                            </Row>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
              )}

              {/* Action buttons inside modal */}
              <View style={{ marginTop: 8, gap: 8 }}>
                {breakdownData && canSettle(breakdownData.settlement) && (
                  <Button
                    title={`Record payment (${money(breakdownData.settlement.amount, breakdownData.cur)})`}
                    testID="breakdown-record-payment"
                    onPress={() => {
                      const s = breakdownData.settlement;
                      setBreakdownSettlement(null);
                      router.push(`/group/${id}/payment?from=${s.from}&to=${s.to}&amount=${(s.amount / 100).toFixed(2)}`);
                    }}
                  />
                )}
                {breakdownData && canSettle(breakdownData.settlement) && !breakdownData.isDirect && breakdownData.directTotal > 0 && breakdownData.simplificationDiff !== 0 && (
                  <Button
                    variant="outline"
                    title={`Record direct debt instead (${money(breakdownData.directTotal, breakdownData.cur)})`}
                    onPress={() => {
                      const s = breakdownData.settlement;
                      setBreakdownSettlement(null);
                      router.push(
                        `/group/${id}/payment?from=${s.from}&to=${s.to}&amount=${(breakdownData.directTotal / 100).toFixed(2)}`
                      );
                    }}
                  />
                )}
                <Button
                  variant="ghost"
                  title="Close"
                  onPress={() => setBreakdownSettlement(null)}
                />
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <QRScannerModal
        visible={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(scanned) => {
          setShowScanner(false);
          router.push(`/join?invite=${encodeURIComponent(scanned)}`);
        }}
      />
    </View>
  );
}

const BADGE: Record<GroupSyncStatus['phase'], { color: string; label: (s: GroupSyncStatus) => string }> = {
  syncing: { color: '#F59E0B', label: () => 'Syncing…' },
  synced: { color: '#10B981', label: () => 'Synced' },
  pending: { color: '#F59E0B', label: (s) => `${s.pending} pending` },
  offline: { color: '#94A3B8', label: () => 'Offline' },
  error: { color: '#EF4444', label: () => 'Sync error' },
  conflict: { color: '#EF4444', label: (s) => `${s.unresolved} not synced` },
  never: { color: '#94A3B8', label: () => 'Not synced' },
};

/** Header badge: what the server has of this group. Tap to sync now or to resolve refused changes. */
function SyncBadge({ status, groupUid, onRefresh }: { status: GroupSyncStatus | null; groupUid: string; onRefresh: () => Promise<void> }) {
  const look = BADGE[status?.phase ?? 'never'];

  const onPress = async () => {
    if (status?.phase === 'conflict') {
      const refused = await getUnresolvedOutboxMutations(groupUid);
      const reasons = [...new Set(refused.map((m) => m.errorMessage).filter(Boolean))].slice(0, 3).join('\n• ');
      const ok = await confirm(
        'Changes not synced',
        `The server refused ${refused.length} change(s) from this phone:\n• ${reasons}\n\nUse the server's version of this group? Your refused changes will be discarded.`,
        "Use server's version",
        true
      );
      if (!ok) return;
      try {
        await syncEngine.acceptServerVersion(groupUid);
        notify('Group updated', "This phone now matches the server's copy of the group.");
      } catch (e) {
        notify("Couldn't update", errorMessage(e));
      }
      return;
    }
    if ((status?.phase === 'error' || status?.phase === 'offline') && status.error) {
      notify(status.phase === 'offline' ? "Can't reach the server" : 'Sync problem', `${status.error}\n\nRetrying now.`);
    }
    await onRefresh();
  };

  return (
    <Pressable
      onPress={onPress}
      testID="sync-status"
      accessibilityLabel={`Sync status: ${look.label(status ?? ({ pending: 0, unresolved: 0 } as GroupSyncStatus))}`}
      style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: look.color, marginRight: 6 }} />
      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{look.label(status ?? ({ pending: 0, unresolved: 0 } as GroupSyncStatus))}</Text>
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 11, color: colors.muted }}>{label}</Text>
      <Text style={{ fontWeight: '700', fontSize: 13, color: colors.text, marginTop: 2 }}>{value}</Text>
    </View>
  );
}
