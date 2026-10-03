import { useLayoutEffect, useMemo, useState } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Avatar, Button, Card, Empty, Loading, Row, Segmented, SectionTitle } from '@/components/ui';
import { PieChart } from '@/components/PieChart';
import { TransactionCard } from '@/components/TransactionCard';
import { QRCode } from '@/components/QRCode';
import { useGroup } from '@/lib/useGroup';
import { money } from '@/lib/format';
import { colors, colorFor } from '@/lib/theme';
import { notify } from '@/lib/dialog';

type Tab = 'transactions' | 'balances' | 'settle' | 'chart';

export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const nav = useNavigation();
  const { data, error, reload, memberName, memberIndex, isConnected } = useGroup(id);
  const [tab, setTab] = useState<Tab>('transactions');
  const [refreshing, setRefreshing] = useState(false);
  const [chartMode, setChartMode] = useState<'paid' | 'share' | 'category'>('share');
  const [showInviteModal, setShowInviteModal] = useState(false);

  useLayoutEffect(() => {
    nav.setOptions({
      title: data?.group.name ?? '',
      headerRight: () => (
        <Row>
          <Pressable onPress={() => setShowInviteModal(true)} style={{ paddingHorizontal: 6 }} testID="open-invite">
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 }}>Invite</Text>
          </Pressable>
          <Pressable onPress={() => router.push(`/group/${id}/members`)} style={{ paddingHorizontal: 6 }} testID="open-members">
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Members</Text>
          </Pressable>
          <Pressable onPress={() => router.push(`/group/${id}/settings`)} style={{ paddingHorizontal: 6 }} testID="open-settings">
            <Text style={{ color: '#fff', fontSize: 20 }}>⚙</Text>
          </Pressable>
        </Row>
      ),
    });
  }, [nav, data, id, router]);

  const cur = data?.group.currency ?? 'USD';
  const me = data?.stats.find((s) => s.memberId === data.myMemberId);

  const inviteLink = useMemo(() => {
    if (!data?.group?.uid) return '';
    return `splitmate://join?uid=${data.group.uid}&key=${data.group.syncKey || ''}&name=${encodeURIComponent(data.group.name)}&cur=${data.group.currency}`;
  }, [data]);

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
    return error ? <Empty title="Couldn't load group" subtitle={error}><Button title="Retry" onPress={reload} /></Empty> : <Loading />;
  }

  const chartTotal = chartData.reduce((a, b) => a + b.value, 0);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 120, maxWidth: 760, width: '100%', alignSelf: 'center' }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await reload();
              setRefreshing(false);
            }}
          />
        }
      >
        {/* Summary header */}
        <View style={{ backgroundColor: colors.primary, borderRadius: 16, padding: 16, marginBottom: 14 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.primaryLight, fontSize: 13 }}>Total group spending</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isConnected ? '#10B981' : '#F59E0B', marginRight: 6 }} />
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{isConnected ? 'E2EE Synced' : 'Sync Active'}</Text>
            </View>
          </Row>
          <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800' }} testID="total-spending">
            {money(data.totals.totalExpenses, cur)}
          </Text>
          {me && (
            <Text style={{ color: '#fff', marginTop: 6 }} testID="my-balance">
              {me.balance > 0
                ? `You get back ${money(me.balance, cur)}`
                : me.balance < 0
                  ? `You owe ${money(-me.balance, cur)}`
                  : 'You are all settled up'}
            </Text>
          )}
          {!me && (
            <Pressable onPress={() => router.push(`/group/${id}/members`)}>
              <Text style={{ color: colors.primaryLight, marginTop: 6, textDecorationLine: 'underline' }}>Tap to choose which member is you</Text>
            </Pressable>
          )}
        </View>

        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'transactions', label: 'Expenses' },
            { value: 'balances', label: 'Balances' },
            { value: 'settle', label: 'Settle up' },
            { value: 'chart', label: 'Chart' },
          ]}
        />

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
          data.stats.map((s) => (
            <Card key={s.memberId}>
              <Row>
                <Avatar name={s.name} index={memberIndex(s.memberId)} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15 }}>
                    {s.name}
                    {s.memberId === data.myMemberId ? ' (you)' : ''}
                  </Text>
                  <Text style={{ color: s.balance > 0 ? colors.positive : s.balance < 0 ? colors.negative : colors.muted, fontWeight: '700', marginTop: 2 }}>
                    {s.balance > 0 ? `gets back ${money(s.balance, cur)}` : s.balance < 0 ? `owes ${money(-s.balance, cur)}` : 'settled up'}
                  </Text>
                </View>
              </Row>
              <View style={{ flexDirection: 'row', marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
                <Stat label="Expenses paid" value={money(s.totalPaid, cur)} />
                <Stat label="Share (benefit)" value={money(s.totalBenefit, cur)} />
                <Stat label="Paid / Received" value={`${money(s.paymentsMade, cur)} / ${money(s.paymentsReceived, cur)}`} />
              </View>
            </Card>
          ))}

        {tab === 'settle' && (
          <>
            {data.settlements.length === 0 ? (
              <Empty title="All settled up 🎉" subtitle="Nobody owes anything right now." />
            ) : (
              <>
                <SectionTitle>Suggested payments</SectionTitle>
                {data.settlements.map((x, i) => (
                  <Card key={i}>
                    <Row>
                      <Avatar name={memberName(x.from)} index={memberIndex(x.from)} size={34} />
                      <View style={{ flex: 1, marginHorizontal: 10 }}>
                        <Text style={{ fontWeight: '600' }}>
                          <Text style={{ fontWeight: '800' }}>{memberName(x.from)}</Text> pays <Text style={{ fontWeight: '800' }}>{memberName(x.to)}</Text>
                        </Text>
                        <Text style={{ color: colors.negative, fontWeight: '800', fontSize: 16, marginTop: 2 }}>{money(x.amount, cur)}</Text>
                      </View>
                      {(
                        <Button
                          small
                          title="Settle"
                          testID={`settle-${i}`}
                          onPress={() => router.push(`/group/${id}/payment?from=${x.from}&to=${x.to}&amount=${(x.amount / 100).toFixed(2)}`)}
                        />
                      )}
                    </Row>
                  </Card>
                ))}
              </>
            )}
          </>
        )}

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

        <Row style={{ gap: 10, marginTop: 8 }}>
          <Button title="📊 Insights" variant="outline" onPress={() => router.push(`/insights?groupId=${id}`)} style={{ flex: 1 }} testID="open-group-insights" />
          <Button title="📄 Report & export" variant="outline" onPress={() => router.push(`/group/${id}/report`)} style={{ flex: 1 }} testID="open-report" />
        </Row>
      </ScrollView>

      {(
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 24, flexDirection: 'row', gap: 12 }}>
          <Button title="Record payment" variant="outline" onPress={() => router.push(`/group/${id}/payment`)} style={{ flex: 1, backgroundColor: '#fff' }} testID="add-payment" />
          <Button title="+ Add expense" onPress={() => router.push(`/group/${id}/expense`)} style={{ flex: 1 }} testID="add-expense" />
        </View>
      )}

      {/* Group Invite & E2EE Sync Modal */}
      <Modal visible={showInviteModal} transparent animationType="slide" onRequestClose={() => setShowInviteModal(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <View style={{ backgroundColor: '#fff', borderRadius: 20, padding: 24, maxWidth: 360, width: '100%', alignItems: 'center' }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, marginBottom: 4 }}>Group Invite & Sync</Text>
            <Text style={{ fontSize: 13, color: colors.muted, textAlign: 'center', marginBottom: 16 }}>
              Scan this QR code with another phone to join and sync <Text style={{ fontWeight: '700' }}>{data.group.name}</Text> end-to-end encrypted.
            </Text>

            {inviteLink ? <QRCode value={inviteLink} size={210} /> : null}

            <View style={{ marginTop: 16, width: '100%' }}>
              <Button
                title="Copy Invite Link"
                variant="outline"
                onPress={() => {
                  notify('Invite Link Copied', inviteLink);
                }}
                style={{ marginBottom: 8 }}
              />
              <Button title="Done" onPress={() => setShowInviteModal(false)} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
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
