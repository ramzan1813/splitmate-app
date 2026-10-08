import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Avatar, Button, Card, Empty, Loading, Row, Screen, SectionTitle } from '@/components/ui';
import { useGroup } from '@/lib/useGroup';
import { deleteTransaction, getGroupPermissions } from '@/data/repo';
import { money, txWhen } from '@/lib/format';
import { categoryIcon, colors } from '@/lib/theme';
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
  const me = data.myMemberId;
  const to = tx.splits[0]?.memberId ?? 0;
  const name = (mid: number) => (mid === me ? 'You' : memberName(mid));
  const myShare = tx.splits.find((s) => s.memberId === me)?.share ?? 0;
  const myNet = me === null ? 0 : (tx.paidBy === me ? tx.amount : 0) - myShare;
  const perms = getGroupPermissions(data.group, data.myIdentityId);

  const remove = async () => {
    if (!(await confirm('Delete', `Delete this ${isPayment ? 'payment' : 'expense'}? This cannot be undone.`, 'Delete', true))) return;
    try {
      await deleteTransaction(Number(id), tx.id);
      router.back();
    } catch (e) {
      notify('Could not delete', errorMessage(e));
    }
  };

  const accent = isPayment ? colors.positive : colors.primary;

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <View style={{ backgroundColor: accent, borderRadius: 18, padding: 20, marginBottom: 14 }}>
        <Row>
          <View style={{ width: 52, height: 52, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 26 }}>{isPayment ? '💸' : categoryIcon(tx.category)}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600' }}>{isPayment ? 'Payment' : tx.category}</Text>
            <Text style={{ color: colors.white, fontSize: 20, fontWeight: '800' }} numberOfLines={2}>
              {isPayment ? `${name(tx.paidBy)} paid ${name(to) === 'You' ? 'you' : name(to)}` : tx.title}
            </Text>
          </View>
        </Row>
        <Text style={{ color: colors.white, fontSize: 34, fontWeight: '900', marginTop: 16 }}>{money(tx.amount, cur)}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)', marginTop: 2 }}>📅 {txWhen(tx.date, tx.createdTs)}</Text>
      </View>

      {isPayment ? (
        <Card>
          <Row>
            <Person name={memberName(tx.paidBy)} label={name(tx.paidBy)} sub="paid" index={memberIndex(tx.paidBy)} />
            <Text style={{ color: colors.positive, fontWeight: '900', fontSize: 24, marginHorizontal: 6 }}>→</Text>
            <Person name={memberName(to)} label={name(to)} sub="received" index={memberIndex(to)} />
          </Row>
        </Card>
      ) : (
        <>
          <Card>
            <Row>
              <Avatar name={memberName(tx.paidBy)} index={memberIndex(tx.paidBy)} size={36} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ color: colors.muted, fontSize: 12 }}>Paid by</Text>
                <Text style={{ fontWeight: '800', fontSize: 16, color: colors.text }}>{name(tx.paidBy)}</Text>
              </View>
              <Text style={{ fontWeight: '800', fontSize: 16, color: colors.text }}>{money(tx.amount, cur)}</Text>
            </Row>
          </Card>

          <SectionTitle>
            {SPLIT_LABEL[tx.splitType]} · {tx.splits.length} {tx.splits.length === 1 ? 'person' : 'people'}
          </SectionTitle>
          <Card>
            {tx.splits.map((s, i) => (
              <View key={s.memberId} style={{ paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }}>
                <Row>
                  <Avatar name={memberName(s.memberId)} index={memberIndex(s.memberId)} size={30} />
                  <Text style={{ flex: 1, marginLeft: 10, fontWeight: s.memberId === me ? '800' : '600', color: colors.text }}>{memberName(s.memberId)}{s.memberId === me ? ' (you)' : ''}</Text>
                  {tx.splitType === 'percent' && <Text style={{ color: colors.muted, marginRight: 10 }}>{s.value}%</Text>}
                  {tx.splitType === 'shares' && <Text style={{ color: colors.muted, marginRight: 10 }}>{s.value} {s.value === 1 ? 'share' : 'shares'}</Text>}
                  <Text style={{ fontWeight: '800', color: colors.text }}>{money(s.share, cur)}</Text>
                </Row>
                <View style={{ height: 4, backgroundColor: colors.border, borderRadius: 2, marginTop: 6, marginLeft: 40 }}>
                  <View style={{ width: `${tx.amount ? (s.share / tx.amount) * 100 : 0}%`, height: 4, borderRadius: 2, backgroundColor: colors.primary }} />
                </View>
              </View>
            ))}
          </Card>

          {me !== null && (tx.paidBy === me || myShare > 0) && (
            <Card style={{ backgroundColor: myNet > 0 ? colors.positiveBg : myNet < 0 ? colors.negativeBg : colors.card }}>
              <Text style={{ fontWeight: '800', color: myNet > 0 ? colors.positive : myNet < 0 ? colors.negative : colors.text }}>
                {myNet > 0 ? `You lent ${money(myNet, cur)}` : myNet < 0 ? `You owe ${money(-myNet, cur)} for this` : 'You paid exactly your share'}
              </Text>
              <Text style={{ color: colors.muted, marginTop: 2, fontSize: 13 }}>
                Your share {money(myShare, cur)}
                {tx.paidBy === me ? ` · you paid ${money(tx.amount, cur)}` : ''}
              </Text>
            </Card>
          )}
        </>
      )}

      {tx.note ? (
        <>
          <SectionTitle>Note</SectionTitle>
          <Card>
            <Text style={{ color: colors.text, lineHeight: 20 }}>📝 {tx.note}</Text>
          </Card>
        </>
      ) : null}

      {/* Audit Trail & Permission Info */}
      <Card style={{ marginTop: 10, paddingVertical: 10 }}>
        {tx.authorName ? (
          <Row style={{ justifyContent: 'space-between', marginBottom: tx.updatedByName ? 4 : 0 }}>
            <Text style={{ fontSize: 12, color: colors.muted }}>Created by</Text>
            <Text style={{ fontSize: 12, fontWeight: '700', color: colors.text }}>{tx.authorName}</Text>
          </Row>
        ) : null}
        {tx.updatedByName ? (
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 12, color: colors.muted }}>Last updated by</Text>
            <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primaryDark }}>{tx.updatedByName}</Text>
          </Row>
        ) : null}
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <Text style={{ fontSize: 12, color: colors.muted }}>Permission mode</Text>
          <Text style={{ fontSize: 12, fontWeight: '600', color: colors.muted }}>
            {data.group.permissionModel === 'admin_only' ? '👑 Admin Only' : data.group.permissionModel === 'contributor' ? '✍️ Contributor' : '🤝 Collaborative'}
          </Text>
        </Row>
      </Card>

      <Row style={{ gap: 10, marginTop: 12 }}>
        {perms.canDeleteTx({ authorId: tx.authorId }) && (
          <Button title="Delete" variant="danger" onPress={remove} style={{ flex: 1 }} testID="tx-delete" />
        )}
        {perms.canEditTx({ authorId: tx.authorId }) && (
          <Button
            title="Edit"
            onPress={() => router.replace(`/group/${id}/${isPayment ? 'payment' : 'expense'}?tid=${tx.id}`)}
            style={{ flex: 1 }}
            testID="tx-edit"
          />
        )}
      </Row>
    </Screen>
  );
}

function Person({ name, label, sub, index }: { name: string; label: string; sub: string; index: number }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Avatar name={name} index={index} size={48} />
      <Text style={{ fontWeight: '800', color: colors.text, marginTop: 6 }} numberOfLines={1}>
        {label}
      </Text>
      <Text style={{ color: colors.muted, fontSize: 12 }}>{sub}</Text>
    </View>
  );
}
