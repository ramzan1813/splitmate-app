import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Avatar, Button, Card, Empty, Loading, Row, Screen, SectionTitle } from '@/components/ui';
import { useGroup } from '@/lib/useGroup';
import { deleteTransaction } from '@/data/repo';
import { money, prettyDate } from '@/lib/format';
import { colors } from '@/lib/theme';
import { confirm, errorMessage, notify } from '@/lib/dialog';

const SPLIT_LABEL = { equal: 'Split equally', unequal: 'Split by exact amounts', percent: 'Split by percentage', shares: 'Split by shares' };

export default function TransactionDetail() {
  const { id, tid } = useLocalSearchParams<{ id: string; tid: string }>();
  const router = useRouter();
  const { data, memberName, memberIndex } = useGroup(id);
  if (!data) return <Loading />;
  const tx = data.transactions.find((t) => String(t.id) === String(tid));
  if (!tx) return <Empty title="Transaction not found" subtitle="It may have been deleted." />;
  const cur = data.group.currency;
  const isPayment = tx.type === 'payment';

  const remove = async () => {
    if (!(await confirm('Delete', `Delete this ${isPayment ? 'payment' : 'expense'}? This cannot be undone.`, 'Delete', true))) return;
    try {
      await deleteTransaction(Number(id), tx.id);
      router.back();
    } catch (e) {
      notify('Could not delete', errorMessage(e));
    }
  };

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Card style={{ alignItems: 'center', paddingVertical: 22 }}>
        <Text style={{ fontSize: 32 }}>{isPayment ? '💸' : '🧾'}</Text>
        <Text style={{ fontSize: 20, fontWeight: '800', marginTop: 6, color: colors.text, textAlign: 'center' }}>
          {isPayment ? `${memberName(tx.paidBy)} paid ${memberName(tx.splits[0]?.memberId ?? 0)}` : tx.title}
        </Text>
        <Text style={{ fontSize: 30, fontWeight: '900', color: colors.primary, marginTop: 6 }}>{money(tx.amount, cur)}</Text>
        <Text style={{ color: colors.muted, marginTop: 4 }}>
          {prettyDate(tx.date)}
          {isPayment ? ' · Payment' : ` · ${tx.category}`}
        </Text>
        {!isPayment && <Text style={{ color: colors.muted, marginTop: 2 }}>Paid by {memberName(tx.paidBy)}</Text>}
      </Card>
      {!isPayment && (
        <>
          <SectionTitle>{SPLIT_LABEL[tx.splitType]}</SectionTitle>
          <Card>
            {tx.splits.map((s) => (
              <Row key={s.memberId} style={{ paddingVertical: 6 }}>
                <Avatar name={memberName(s.memberId)} index={memberIndex(s.memberId)} size={30} />
                <Text style={{ flex: 1, marginLeft: 10, fontWeight: '600' }}>{memberName(s.memberId)}</Text>
                {tx.splitType === 'percent' && <Text style={{ color: colors.muted, marginRight: 10 }}>{s.value}%</Text>}
                {tx.splitType === 'shares' && <Text style={{ color: colors.muted, marginRight: 10 }}>{s.value} shares</Text>}
                <Text style={{ fontWeight: '700' }}>{money(s.share, cur)}</Text>
              </Row>
            ))}
          </Card>
        </>
      )}
      {tx.note ? (
        <>
          <SectionTitle>Note</SectionTitle>
          <Card>
            <Text>{tx.note}</Text>
          </Card>
        </>
      ) : null}
      {(
        <View style={{ gap: 10, marginTop: 6 }}>
          <Button
            title="Edit"
            testID="tx-edit"
            onPress={() => router.replace(`/group/${id}/${isPayment ? 'payment' : 'expense'}?tid=${tx.id}`)}
          />
          <Button title="Delete" variant="danger" onPress={remove} testID="tx-delete" />
        </View>
      )}
    </Screen>
  );
}
