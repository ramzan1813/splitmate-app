// A transaction in the group's list, with enough detail that it rarely needs to be opened.
import { Pressable, Text, View } from 'react-native';
import { Avatar, Card, Row } from './ui';
import { Transaction } from '@/data/types';
import { money, prettyDate } from '@/lib/format';
import { categoryIcon, colors } from '@/lib/theme';

interface Props {
  t: Transaction;
  currency: string;
  myMemberId: number | null;
  memberName: (id: number) => string;
  memberIndex: (id: number) => number;
  onPress: () => void;
}

const SPLIT_LABELS = { equal: 'Split equally', unequal: 'Split by amount', percent: 'Split by %', shares: 'Split by shares' } as const;
const MAX_SPLIT_ROWS = 8;

export function TransactionCard(props: Props) {
  return (
    <Pressable onPress={props.onPress} testID={`tx-${props.t.id}`} style={({ pressed }) => pressed && { opacity: 0.85 }}>
      {props.t.type === 'payment' ? <PaymentCard {...props} /> : <ExpenseCard {...props} />}
    </Pressable>
  );
}

function ExpenseCard({ t, currency: cur, myMemberId, memberName, memberIndex }: Props) {
  const paidByMe = myMemberId !== null && t.paidBy === myMemberId;
  const mySplit = t.splits.find((s) => s.memberId === myMemberId);
  const myShare = mySplit?.share ?? 0;
  // what this expense does to my balance: + I lent money, - I borrowed
  const myNet = myMemberId === null ? 0 : (paidByMe ? t.amount : 0) - myShare;
  const involved = paidByMe || !!mySplit;
  const splits = [...t.splits].sort((a, b) => b.share - a.share);
  const shown = splits.slice(0, MAX_SPLIT_ROWS);

  return (
    <Card style={{ padding: 0, overflow: 'hidden', borderLeftWidth: 4, borderLeftColor: colors.primary }}>
      <View style={{ padding: 14 }}>
        <Row style={{ alignItems: 'flex-start' }}>
          <View style={{ width: 46, height: 46, borderRadius: 12, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 22 }}>{categoryIcon(t.category)}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ fontWeight: '800', fontSize: 17, color: colors.text }} numberOfLines={2}>
              {t.title}
            </Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 3 }}>📅 {prettyDate(t.date)}</Text>
          </View>
          <Text style={{ fontWeight: '900', fontSize: 20, color: colors.text, marginLeft: 8 }}>{money(t.amount, cur)}</Text>
        </Row>

        <Row style={{ flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          <Tag text={t.category} />
          <Tag text={`${SPLIT_LABELS[t.splitType]} · ${t.splits.length} ${t.splits.length === 1 ? 'person' : 'people'}`} />
        </Row>

        <Row style={{ marginTop: 12 }}>
          <Avatar name={memberName(t.paidBy)} index={memberIndex(t.paidBy)} size={26} />
          <Text style={{ marginLeft: 8, color: colors.text, fontSize: 14 }}>
            <Text style={{ fontWeight: '800' }}>{paidByMe ? 'You' : memberName(t.paidBy)}</Text> paid {money(t.amount, cur)}
          </Text>
        </Row>

        <View style={{ marginTop: 10, backgroundColor: colors.bg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 }}>
          {shown.map((s) => (
            <Row key={s.memberId} style={{ paddingVertical: 4 }}>
              <Avatar name={memberName(s.memberId)} index={memberIndex(s.memberId)} size={20} />
              <Text style={{ flex: 1, marginLeft: 8, color: colors.text, fontWeight: s.memberId === myMemberId ? '800' : '500' }} numberOfLines={1}>
                {memberName(s.memberId)}
                {s.memberId === myMemberId ? ' (you)' : ''}
              </Text>
              {t.splitType === 'percent' || t.splitType === 'shares' ? (
                <Text style={{ color: colors.muted, fontSize: 12, marginRight: 8 }}>{t.splitType === 'percent' ? `${+s.value.toFixed(2)}%` : `×${+s.value.toFixed(2)}`}</Text>
              ) : null}
              <Text style={{ fontWeight: '700', color: colors.text }}>{money(s.share, cur)}</Text>
            </Row>
          ))}
          {splits.length > shown.length && (
            <Text style={{ color: colors.muted, fontSize: 12, paddingVertical: 4 }}>+ {splits.length - shown.length} more</Text>
          )}
        </View>

        {t.note ? (
          <Text style={{ color: colors.muted, fontStyle: 'italic', marginTop: 10 }} numberOfLines={3}>
            📝 {t.note}
          </Text>
        ) : null}
      </View>

      {myMemberId !== null && (
        <View
          style={{
            paddingHorizontal: 14,
            paddingVertical: 9,
            backgroundColor: !involved || myNet === 0 ? colors.bg : myNet > 0 ? colors.positiveBg : colors.negativeBg,
          }}
        >
          <Text style={{ fontWeight: '700', fontSize: 13, color: !involved || myNet === 0 ? colors.muted : myNet > 0 ? colors.positive : colors.negative }}>
            {!involved
              ? 'You are not part of this expense'
              : myNet > 0
                ? `You lent ${money(myNet, cur)}${myShare ? ` · your share ${money(myShare, cur)}` : ''}`
                : myNet < 0
                  ? `You owe ${money(-myNet, cur)} for this`
                  : `Your share ${money(myShare, cur)} · fully paid by you`}
          </Text>
        </View>
      )}
    </Card>
  );
}

function PaymentCard({ t, currency: cur, myMemberId, memberName, memberIndex }: Props) {
  const to = t.splits[0]?.memberId ?? 0;
  const iPaid = myMemberId !== null && t.paidBy === myMemberId;
  const iReceived = myMemberId !== null && to === myMemberId;
  const name = (id: number) => (id === myMemberId ? 'You' : memberName(id));

  return (
    <Card style={{ padding: 0, overflow: 'hidden', borderLeftWidth: 4, borderLeftColor: colors.positive }}>
      <View style={{ padding: 14 }}>
        <Row>
          <View style={{ width: 46, height: 46, borderRadius: 12, backgroundColor: colors.positiveBg, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 22 }}>💸</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ fontWeight: '800', fontSize: 17, color: colors.text }}>Payment</Text>
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 3 }}>📅 {prettyDate(t.date)}</Text>
          </View>
          <Text style={{ fontWeight: '900', fontSize: 20, color: colors.positive, marginLeft: 8 }}>{money(t.amount, cur)}</Text>
        </Row>

        <Row style={{ marginTop: 12, backgroundColor: colors.bg, borderRadius: 10, padding: 10 }}>
          <Row style={{ flex: 1 }}>
            <Avatar name={memberName(t.paidBy)} index={memberIndex(t.paidBy)} size={28} />
            <Text style={{ marginLeft: 8, fontWeight: '700', color: colors.text, flexShrink: 1 }} numberOfLines={1}>
              {name(t.paidBy)}
            </Text>
          </Row>
          <Text style={{ color: colors.positive, fontWeight: '900', fontSize: 18, marginHorizontal: 8 }}>→</Text>
          <Row style={{ flex: 1, justifyContent: 'flex-end' }}>
            <Text style={{ marginRight: 8, fontWeight: '700', color: colors.text, flexShrink: 1, textAlign: 'right' }} numberOfLines={1}>
              {name(to)}
            </Text>
            <Avatar name={memberName(to)} index={memberIndex(to)} size={28} />
          </Row>
        </Row>

        {t.title && t.title !== 'Payment' ? <Text style={{ color: colors.text, marginTop: 10 }}>{t.title}</Text> : null}
        {t.note ? (
          <Text style={{ color: colors.muted, fontStyle: 'italic', marginTop: 8 }} numberOfLines={3}>
            📝 {t.note}
          </Text>
        ) : null}
      </View>

      {(iPaid || iReceived) && (
        <View style={{ paddingHorizontal: 14, paddingVertical: 9, backgroundColor: colors.positiveBg }}>
          <Text style={{ fontWeight: '700', fontSize: 13, color: colors.positive }}>
            {iReceived ? `You received ${money(t.amount, cur)} from ${memberName(t.paidBy)}` : `You paid ${money(t.amount, cur)} to ${memberName(to)}`}
          </Text>
        </View>
      )}
    </Card>
  );
}

function Tag({ text }: { text: string }) {
  return (
    <View style={{ backgroundColor: colors.bg, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 3, borderWidth: 1, borderColor: colors.border }}>
      <Text style={{ fontSize: 12, fontWeight: '600', color: colors.muted }}>{text}</Text>
    </View>
  );
}
