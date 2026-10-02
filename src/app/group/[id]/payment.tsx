import { useLayoutEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Button, Chip, Field, Loading, Screen, SectionTitle } from '@/components/ui';
import { useGroup } from '@/lib/useGroup';
import { createTransaction, updateTransaction } from '@/data/repo';
import { GroupSummary } from '@/data/types';
import { currencySymbol, money, parseAmount, todayISO } from '@/lib/format';
import { colors } from '@/lib/theme';
import { errorMessage, notify } from '@/lib/dialog';

type PayParams = { id: string; tid?: string; from?: string; to?: string; amount?: string };

export default function PaymentScreen() {
  const params = useLocalSearchParams<PayParams>();
  const { data } = useGroup(params.id);
  if (!data) return <Loading />;
  return <PaymentForm params={params} data={data} />;
}

function PaymentForm({ params, data }: { params: PayParams; data: GroupSummary }) {
  const { id, tid } = params;
  const router = useRouter();
  const nav = useNavigation();
  const editing = !!tid;
  // initial values computed once: the payment being edited, or values passed from "Settle"
  const [initialTx] = useState(() => (editing ? (data.transactions.find((t) => String(t.id) === String(tid)) ?? null) : null));

  const [from, setFrom] = useState<number | null>(initialTx ? initialTx.paidBy : params.from ? Number(params.from) : (data.myMemberId ?? null));
  const [to, setTo] = useState<number | null>(initialTx ? (initialTx.splits[0]?.memberId ?? null) : params.to ? Number(params.to) : null);
  const [amountText, setAmountText] = useState(initialTx ? (initialTx.amount / 100).toFixed(2) : (params.amount ?? ''));
  const [date, setDate] = useState(initialTx?.date ?? todayISO());
  const [note, setNote] = useState(initialTx?.note ?? '');
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    nav.setOptions({ title: editing ? 'Edit payment' : 'Record payment' });
  }, [nav, editing]);

  const cur = data.group.currency;

  const save = async () => {
    const amount = parseAmount(amountText);
    if (!from) return notify('Select who paid');
    if (!to) return notify('Select who received the money');
    if (from === to) return notify('Invalid payment', 'Payer and receiver must be different people');
    if (!Number.isFinite(amount) || amount <= 0) return notify('Invalid amount', 'Enter an amount greater than zero');
    setSaving(true);
    try {
      const body = { type: 'payment' as const, paidBy: from, to, amount, date, note };
      if (editing) await updateTransaction(Number(id), Number(tid), body);
      else await createTransaction(Number(id), body);
      router.back();
    } catch (e) {
      notify('Could not save', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const fromStat = data.stats.find((s) => s.memberId === from);

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Text style={{ color: colors.muted, marginBottom: 12 }}>
        Record money paid directly from one member to another (one-to-one payment), e.g. when settling a debt.
      </Text>
      <SectionTitle>From (who paid)</SectionTitle>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {data.members.map((m) => (
          <Chip key={m.id} label={m.name} active={from === m.id} onPress={() => setFrom(m.id)} testID={`pay-from-${m.id}`} />
        ))}
      </View>
      {fromStat && fromStat.balance < 0 ? (
        <Text style={{ color: colors.negative, marginBottom: 8, fontSize: 12 }}>
          {fromStat.name} currently owes {money(-fromStat.balance, cur)}
        </Text>
      ) : null}
      <SectionTitle>To (who received)</SectionTitle>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
        {data.members
          .filter((m) => m.id !== from)
          .map((m) => (
            <Chip key={m.id} label={m.name} active={to === m.id} onPress={() => setTo(m.id)} testID={`pay-to-${m.id}`} />
          ))}
      </View>
      <Field label={`Amount (${currencySymbol(cur).trim()})`} value={amountText} onChangeText={setAmountText} keyboardType="decimal-pad" placeholder="0.00" testID="pay-amount" />
      <Field label="Date (YYYY-MM-DD)" value={date} onChangeText={setDate} />
      <Field label="Note (optional)" value={note} onChangeText={setNote} />
      <Button title={editing ? 'Save changes' : 'Save payment'} onPress={save} loading={saving} testID="pay-save" />
    </Screen>
  );
}
