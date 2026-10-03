// Popular currencies as chips, plus a search over every world currency.
import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Chip, Row, styles as ui } from './ui';
import { findCurrency, POPULAR_CURRENCIES, searchCurrencies } from '@/lib/currencies';
import { colors } from '@/lib/theme';

const MAX_RESULTS = 25;

export function CurrencyPicker({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchCurrencies(query), [query]);
  const selected = findCurrency(value);
  const chips = POPULAR_CURRENCIES.includes(value) ? POPULAR_CURRENCIES : [value, ...POPULAR_CURRENCIES];

  const pick = (code: string) => {
    onChange(code);
    setSearching(false);
    setQuery('');
  };

  return (
    <View style={{ marginBottom: 12 }}>
      {selected && (
        <Text style={{ color: colors.text, marginBottom: 8 }}>
          <Text style={{ fontWeight: '800' }}>{selected.code}</Text> · {selected.name} ({selected.symbol.trim()})
        </Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {chips.map((c) => (
          <Chip key={c} label={c} active={value === c} onPress={() => pick(c)} testID={`cur-${c}`} />
        ))}
        <Chip label={searching ? 'Close' : '🔍 All currencies'} onPress={() => setSearching((s) => !s)} testID="cur-search" />
      </View>
      {searching && (
        <View style={{ marginTop: 4 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name or code, e.g. rupee, LKR"
            placeholderTextColor="#9CA3AF"
            autoFocus
            autoCorrect={false}
            style={ui.input}
            testID="cur-search-input"
          />
          <View style={{ backgroundColor: colors.white, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginTop: 6 }}>
            {results.slice(0, MAX_RESULTS).map((c, i) => (
              <Pressable
                key={c.code}
                onPress={() => pick(c.code)}
                style={({ pressed }) => [{ paddingHorizontal: 12, paddingVertical: 11, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border }, pressed && { backgroundColor: colors.bg }]}
                testID={`cur-option-${c.code}`}
              >
                <Row>
                  <Text style={{ fontWeight: '800', width: 48, color: c.code === value ? colors.primary : colors.text }}>{c.code}</Text>
                  <Text style={{ flex: 1, color: colors.text }}>{c.name}</Text>
                  <Text style={{ color: colors.muted }}>{c.symbol.trim()}</Text>
                </Row>
              </Pressable>
            ))}
            {results.length === 0 && <Text style={{ padding: 12, color: colors.muted }}>No currency matches “{query}”</Text>}
            {results.length > MAX_RESULTS && (
              <Text style={{ padding: 12, color: colors.muted, fontSize: 12 }}>{results.length - MAX_RESULTS} more — keep typing to narrow down</Text>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
