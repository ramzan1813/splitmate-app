import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Avatar, Button, Card, Chip, Field, Loading, Row, Screen, Segmented, SectionTitle, styles as ui } from '@/components/ui';
import { DateField } from '@/components/Calendar';
import { useGroup } from '@/lib/useGroup';
import { addCustomCategory, createTransaction, getCustomCategories, removeCustomCategory, updateTransaction } from '@/data/repo';
import { GroupSummary, SplitType } from '@/data/types';
import { currencySymbol, money, parseAmount, toCents, todayISO } from '@/lib/format';
import { CATEGORIES, colors } from '@/lib/theme';
import { confirm, errorMessage, notify } from '@/lib/dialog';

export default function ExpenseScreen() {
  const { id, tid } = useLocalSearchParams<{ id: string; tid?: string }>();
  const { data, memberIndex } = useGroup(id);
  if (!data) return <Loading />;
  return <ExpenseForm id={id} tid={tid} data={data} memberIndex={memberIndex} />;
}

function ExpenseForm({ id, tid, data, memberIndex }: { id: string; tid?: string; data: GroupSummary; memberIndex: (mid: number) => number }) {
  const router = useRouter();
  const nav = useNavigation();
  const editing = !!tid;
  // initial values are computed once, from the transaction being edited (if any)
  const [initialTx] = useState(() => (editing ? (data.transactions.find((t) => String(t.id) === String(tid)) ?? null) : null));

  const [title, setTitle] = useState(initialTx?.title ?? '');
  const [amountText, setAmountText] = useState(initialTx ? (initialTx.amount / 100).toFixed(2) : '');
  const [paidBy, setPaidBy] = useState<number | null>(initialTx?.paidBy ?? data.myMemberId ?? data.members[0]?.id ?? null);
  const [splitType, setSplitType] = useState<SplitType>(initialTx?.splitType ?? 'equal');
  const [category, setCategory] = useState(initialTx?.category ?? 'General');
  const [date, setDate] = useState(initialTx?.date ?? todayISO());
  const [note, setNote] = useState(initialTx?.note ?? '');
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialTx ? initialTx.splits.map((s) => s.memberId) : data.members.map((m) => m.id)));
  const [values, setValues] = useState<Record<number, string>>(() => {
    const v: Record<number, string> = {};
    if (initialTx) for (const s of initialTx.splits) v[s.memberId] = initialTx.splitType === 'unequal' ? (s.value / 100).toFixed(2) : String(s.value);
    return v;
  });
  const [saving, setSaving] = useState(false);
  const [customCategories, setCustomCategories] = useState<string[]>([]);
  const [newCategory, setNewCategory] = useState<string | null>(null); // null = the "new category" input is hidden

  useEffect(() => {
    getCustomCategories().then(setCustomCategories, () => {});
  }, []);

  // built-in + user-created, plus any category already used in this group (e.g. from an imported file)
  const categoryOptions = useMemo(() => {
    const used = data.categories.map((c) => c.name).concat(category);
    return [...new Set([...CATEGORIES, ...customCategories, ...used])];
  }, [customCategories, data.categories, category]);

  const addCategory = async () => {
    try {
      const name = await addCustomCategory(newCategory ?? '');
      setCustomCategories(await getCustomCategories());
      setCategory(name);
      setNewCategory(null);
    } catch (e) {
      notify('Could not add category', errorMessage(e));
    }
  };

  const removeCategory = async (name: string) => {
    if (!(await confirm('Remove category', `Remove "${name}" from the list? Expenses already in "${name}" keep it.`, 'Remove', true))) return;
    await removeCustomCategory(name);
    setCustomCategories(await getCustomCategories());
    if (category === name) setCategory('General');
  };

  useLayoutEffect(() => {
    nav.setOptions({ title: editing ? 'Edit expense' : 'Add expense' });
  }, [nav, editing]);

  const amount = parseAmount(amountText);
  const cur = data.group.currency;

  const preview = useMemo(() => {
    const members = data.members;
    const total = Number.isFinite(amount) ? toCents(amount) : 0;
    const shares: Record<number, number> = {};
    if (splitType === 'equal') {
      const ids = members.filter((m) => selected.has(m.id)).map((m) => m.id);
      if (!ids.length) return { shares, message: 'Select at least one member', ok: false };
      const base = Math.floor(total / ids.length);
      let rem = total - base * ids.length;
      ids.forEach((mid) => (shares[mid] = base + (rem-- > 0 ? 1 : 0)));
      return { shares, message: `${money(base, cur)} per person`, ok: total > 0 };
    }
    const nums = members.map((m) => ({ id: m.id, v: parseAmount(values[m.id] || '0') || 0 }));
    const sum = nums.reduce((a, b) => a + b.v, 0);
    if (splitType === 'unequal') {
      nums.forEach((n) => (shares[n.id] = toCents(n.v)));
      const left = total - toCents(sum);
      return {
        shares,
        message: left === 0 ? 'Amounts match the total ✓' : left > 0 ? `${money(left, cur)} left to assign` : `${money(-left, cur)} over the total`,
        ok: left === 0 && total > 0,
      };
    }
    if (splitType === 'percent') {
      nums.forEach((n) => (shares[n.id] = Math.round((total * n.v) / 100)));
      const left = Math.round((100 - sum) * 100) / 100;
      return { shares, message: left === 0 ? '100% assigned ✓' : left > 0 ? `${left}% left to assign` : `${-left}% over 100%`, ok: left === 0 && total > 0 };
    }
    // shares
    nums.forEach((n) => (shares[n.id] = sum > 0 ? Math.round((total * n.v) / sum) : 0));
    return { shares, message: sum > 0 ? `${sum} total shares` : 'Enter shares for at least one member', ok: sum > 0 && total > 0 };
  }, [data, amount, splitType, selected, values, cur]);


  const toggle = (mid: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(mid)) n.delete(mid);
      else n.add(mid);
      return n;
    });

  const save = async () => {
    if (!title.trim()) return notify('Missing title', 'What was this expense for?');
    if (!Number.isFinite(amount) || amount <= 0) return notify('Invalid amount', 'Enter an amount greater than zero');
    if (!paidBy) return notify('Who paid?', 'Select who paid for this expense');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return notify('Invalid date', 'Use the format YYYY-MM-DD');
    if (!preview.ok) return notify('Check the split', preview.message);
    const splits =
      splitType === 'equal'
        ? data.members.filter((m) => selected.has(m.id)).map((m) => ({ memberId: m.id }))
        : data.members
            .map((m) => ({ memberId: m.id, value: parseAmount(values[m.id] || '0') || 0 }))
            .filter((s) => s.value > 0);
    setSaving(true);
    try {
      const body = { type: 'expense' as const, title, amount, paidBy, splitType, splits, category, date, note };
      if (editing) await updateTransaction(Number(id), Number(tid), body);
      else await createTransaction(Number(id), body);
      router.back();
    } catch (e) {
      notify('Could not save', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const valueSuffix = splitType === 'percent' ? '%' : splitType === 'shares' ? 'shares' : '';

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="e.g. Dinner, Hotel, Fuel" testID="exp-title" />
      <Field
        label={`Amount (${currencySymbol(cur).trim()})`}
        value={amountText}
        onChangeText={setAmountText}
        keyboardType="decimal-pad"
        placeholder="0.00"
        testID="exp-amount"
      />

      <SectionTitle>Paid by</SectionTitle>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 }}>
        {data.members.map((m) => (
          <Chip key={m.id} label={m.name} active={paidBy === m.id} onPress={() => setPaidBy(m.id)} testID={`paidby-${m.id}`} />
        ))}
      </View>

      <SectionTitle>Split</SectionTitle>
      <Segmented<SplitType>
        value={splitType}
        onChange={setSplitType}
        options={[
          { value: 'equal', label: 'Equally' },
          { value: 'unequal', label: 'Unequally' },
          { value: 'percent', label: 'By %' },
          { value: 'shares', label: 'By shares' },
        ]}
      />
      <Card>
        {data.members.map((m) => {
          const share = preview.shares[m.id] ?? 0;
          return (
            <Row key={m.id} style={{ paddingVertical: 7 }}>
              {splitType === 'equal' ? (
                <Pressable onPress={() => toggle(m.id)} style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }} testID={`split-toggle-${m.id}`}>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      borderWidth: 2,
                      borderColor: colors.primary,
                      backgroundColor: selected.has(m.id) ? colors.primary : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: 10,
                    }}
                  >
                    {selected.has(m.id) && <Text style={{ color: '#fff', fontWeight: '900', fontSize: 13 }}>✓</Text>}
                  </View>
                  <Avatar name={m.name} index={memberIndex(m.id)} size={30} />
                  <Text style={{ marginLeft: 10, flex: 1, fontWeight: '600' }}>{m.name}</Text>
                </Pressable>
              ) : (
                <>
                  <Avatar name={m.name} index={memberIndex(m.id)} size={30} />
                  <Text style={{ marginLeft: 10, flex: 1, fontWeight: '600' }}>{m.name}</Text>
                  <TextInput
                    value={values[m.id] ?? ''}
                    onChangeText={(t) => setValues((v) => ({ ...v, [m.id]: t }))}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    placeholderTextColor="#9CA3AF"
                    style={[ui.input, { width: 90, paddingVertical: 6, textAlign: 'right' }]}
                    testID={`split-value-${m.id}`}
                  />
                  {valueSuffix ? <Text style={{ color: colors.muted, marginLeft: 6, width: 44 }}>{valueSuffix}</Text> : null}
                </>
              )}
              {splitType !== 'unequal' && <Text style={{ color: colors.muted, width: 90, textAlign: 'right' }}>{money(share, cur)}</Text>}
            </Row>
          );
        })}
        <Text style={{ marginTop: 8, fontWeight: '700', color: preview.ok ? colors.positive : colors.negative }} testID="split-message">
          {preview.message}
        </Text>
      </Card>

      <SectionTitle>Category</SectionTitle>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 }}>
        {categoryOptions.map((c) => (
          <Chip
            key={c}
            label={c}
            active={category === c}
            onPress={() => setCategory(c)}
            onLongPress={customCategories.includes(c) ? () => removeCategory(c) : undefined}
          />
        ))}
        <Chip label="+ New" onPress={() => setNewCategory((v) => (v === null ? '' : null))} testID="category-new" />
      </View>
      {newCategory !== null && (
        <Row style={{ gap: 8, marginBottom: 10 }}>
          <View style={{ flex: 1 }}>
            <TextInput
              value={newCategory}
              onChangeText={setNewCategory}
              onSubmitEditing={addCategory}
              placeholder="New category, e.g. Gym"
              placeholderTextColor="#9CA3AF"
              maxLength={40}
              autoFocus
              style={ui.input}
              testID="category-new-name"
            />
          </View>
          <Button title="Add" small onPress={addCategory} testID="category-add" />
        </Row>
      )}
      {customCategories.length > 0 && <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 10 }}>Long-press a category you created to remove it.</Text>}
      <DateField label="Date" value={date} onChange={setDate} testID="exp-date" />
      <Field label="Note (optional)" value={note} onChangeText={setNote} multiline />
      <Button title={editing ? 'Save changes' : 'Add expense'} onPress={save} loading={saving} testID="exp-save" />
    </Screen>
  );
}
