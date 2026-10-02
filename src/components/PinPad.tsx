import { Pressable, Text, View } from 'react-native';
import { colors } from '@/lib/theme';

/** Numeric keypad with 4 dots. Calls onComplete when 4 digits are entered. */
export function PinPad({ value, onChange, onComplete, disabled }: { value: string; onChange: (v: string) => void; onComplete: (v: string) => void; disabled?: boolean }) {
  const press = (d: string) => {
    if (disabled) return;
    if (d === 'del') return onChange(value.slice(0, -1));
    if (value.length >= 4) return;
    const next = value + d;
    onChange(next);
    if (next.length === 4) onComplete(next);
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', gap: 16, marginVertical: 24 }} accessibilityLabel={`${value.length} of 4 digits entered`}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.primary, backgroundColor: i < value.length ? colors.primary : 'transparent' }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 264, justifyContent: 'center' }}>
        {keys.map((k, i) =>
          k === '' ? (
            <View key={i} style={{ width: 72, height: 72, margin: 8 }} />
          ) : (
            <Pressable
              key={i}
              testID={`pin-${k}`}
              accessibilityRole="button"
              accessibilityLabel={k === 'del' ? 'Delete' : k}
              onPress={() => press(k)}
              style={({ pressed }) => ({
                width: 72,
                height: 72,
                margin: 8,
                borderRadius: 36,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? colors.primaryLight : colors.white,
                opacity: disabled ? 0.5 : 1,
              })}
            >
              <Text style={{ fontSize: k === 'del' ? 18 : 26, fontWeight: '600', color: colors.text }}>{k === 'del' ? '⌫' : k}</Text>
            </Pressable>
          )
        )}
      </View>
    </View>
  );
}
