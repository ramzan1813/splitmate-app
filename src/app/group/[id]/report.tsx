import { useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Button, Card, Loading, Row, Screen, SectionTitle } from '@/components/ui';
import { useGroup } from '@/lib/useGroup';
import { money, prettyDate } from '@/lib/format';
import { colors } from '@/lib/theme';
import { exportExcel, printReport, sharePdf } from '@/lib/report';
import { errorMessage, notify } from '@/lib/dialog';
import { useApp } from '@/lib/app';

export default function Report() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, memberName } = useGroup(id);
  const [busy, setBusy] = useState<string | null>(null);
  const { suspendLock } = useApp();
  if (!data) return <Loading />;
  const cur = data.group.currency;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    suspendLock();
    try {
      await fn();
    } catch (e) {
      notify('Something went wrong', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen style={{ maxWidth: 820, width: '100%', alignSelf: 'center' }}>
      <Row style={{ gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <Button small title="🖨 Print" onPress={() => run('print', () => printReport(data))} loading={busy === 'print'} testID="report-print" />
        {Platform.OS !== 'web' && <Button small variant="outline" title="Share PDF" onPress={() => run('pdf', () => sharePdf(data))} loading={busy === 'pdf'} />}
        <Button small variant="outline" title="📊 Export to Excel" onPress={() => run('xlsx', () => exportExcel(data))} loading={busy === 'xlsx'} testID="report-excel" />
      </Row>

      <Card>
        <Text style={{ fontSize: 20, fontWeight: '800' }}>{data.group.name}</Text>
        <Text style={{ color: colors.muted, marginTop: 4 }}>
          Total {money(data.totals.totalExpenses, cur)} · {data.totals.expenseCount} expense{data.totals.expenseCount === 1 ? "" : "s"} · {data.totals.paymentCount} payment{data.totals.paymentCount === 1 ? "" : "s"}
        </Text>
      </Card>

      <SectionTitle>Member summary</SectionTitle>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ minWidth: '100%' }}>
        <View style={{ minWidth: 600, flex: 1 }}>
        <TableRow head cells={['Member', 'Paid', 'Share', 'Sent', 'Received', 'Balance']} />
        {data.stats.map((s) => (
          <TableRow
            key={s.memberId}
            cells={[s.name, money(s.totalPaid, cur), money(s.totalBenefit, cur), money(s.paymentsMade, cur), money(s.paymentsReceived, cur), money(s.balance, cur, { sign: true })]}
            lastColor={s.balance > 0 ? colors.positive : s.balance < 0 ? colors.negative : colors.muted}
          />
        ))}
        </View>
        </ScrollView>
      </Card>

      <SectionTitle>Settlement plan</SectionTitle>
      <Card>
        {data.settlements.length === 0 ? (
          <Text style={{ color: colors.muted }}>Everyone is settled up.</Text>
        ) : (
          data.settlements.map((x, i) => (
            <Row key={i} style={{ paddingVertical: 5 }}>
              <Text style={{ flex: 1 }}>
                {memberName(x.from)} → {memberName(x.to)}
              </Text>
              <Text style={{ fontWeight: '800' }}>{money(x.amount, cur)}</Text>
            </Row>
          ))
        )}
      </Card>

      <SectionTitle>By category</SectionTitle>
      <Card>
        {data.categories.length === 0 ? (
          <Text style={{ color: colors.muted }}>No expenses yet.</Text>
        ) : (
          data.categories.map((c) => (
            <Row key={c.name} style={{ paddingVertical: 5 }}>
              <Text style={{ flex: 1 }}>{c.name}</Text>
              <Text style={{ fontWeight: '700' }}>{money(c.amount, cur)}</Text>
            </Row>
          ))
        )}
      </Card>

      <SectionTitle>All transactions</SectionTitle>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <TableRow head cells={['Date', 'Title', 'Paid by', 'Amount']} />
        {data.transactions.map((t) => (
          <TableRow
            key={t.id}
            cells={[
              prettyDate(t.date),
              t.type === 'payment' ? `Payment → ${memberName(t.splits[0]?.memberId ?? 0)}` : t.title,
              memberName(t.paidBy),
              money(t.amount, cur),
            ]}
          />
        ))}
        {data.transactions.length === 0 && <Text style={{ padding: 12, color: colors.muted }}>No transactions yet.</Text>}
      </Card>
    </Screen>
  );
}

function TableRow({ cells, head, lastColor }: { cells: string[]; head?: boolean; lastColor?: string }) {
  return (
    <View style={{ flexDirection: 'row', paddingVertical: 9, paddingHorizontal: 10, backgroundColor: head ? colors.primaryLight : 'transparent', borderBottomWidth: 1, borderBottomColor: colors.border }}>
      {cells.map((c, i) => (
        <Text
          key={i}
          numberOfLines={2}
          style={{
            flex: i === 0 || (cells.length === 4 && i === 1) ? 1.4 : 1,
            fontSize: 12,
            fontWeight: head || i === cells.length - 1 ? '700' : '400',
            color: !head && i === cells.length - 1 && lastColor ? lastColor : colors.text,
            textAlign: i === 0 || (cells.length === 4 && i <= 2) ? 'left' : 'right',
          }}
        >
          {c}
        </Text>
      ))}
    </View>
  );
}
