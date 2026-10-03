import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { colors, colorFor } from '@/lib/theme';
import { initials } from '@/lib/format';

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  style,
  small,
  testID,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'outline' | 'danger' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
  testID?: string;
}) {
  const v = btnVariants[variant];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        { backgroundColor: v.bg, borderColor: v.border },
        (disabled || loading) && { opacity: 0.55 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <Text style={[styles.btnText, small && { fontSize: 14 }, { color: v.fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

const btnVariants = {
  primary: { bg: colors.primary, fg: colors.white, border: colors.primary },
  outline: { bg: 'transparent', fg: colors.primary, border: colors.primary },
  danger: { bg: colors.negative, fg: colors.white, border: colors.negative },
  ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
};

export function HeaderButton({
  title,
  icon,
  onPress,
  testID,
  accessibilityLabel,
  highlight,
}: {
  title?: string;
  icon?: string;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  highlight?: boolean;
}) {
  const isIconOnly = !title && !!icon;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      style={({ pressed }) => [
        {
          backgroundColor: highlight ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.16)',
          borderWidth: 1,
          borderColor: highlight ? 'rgba(255, 255, 255, 0.45)' : 'rgba(255, 255, 255, 0.22)',
          paddingHorizontal: isIconOnly ? 7 : 8,
          paddingVertical: 4,
          borderRadius: 12,
          marginHorizontal: 2,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 28,
        },
        pressed && { backgroundColor: 'rgba(255, 255, 255, 0.38)', transform: [{ scale: 0.95 }] },
      ]}
    >
      {icon ? <Text style={{ color: '#fff', fontSize: 13, marginRight: title ? 3 : 0 }}>{icon}</Text> : null}
      {title ? <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{title}</Text> : null}
    </Pressable>
  );
}

export function Field({ label, error, ...props }: TextInputProps & { label?: string; error?: string }) {
  return (
    <View style={{ marginBottom: 14 }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput placeholderTextColor="#9CA3AF" {...props} style={[styles.input, props.multiline && { minHeight: 70 }, props.style]} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Card({ children, style, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View style={[styles.card, style]} testID={testID}>
      {children}
    </View>
  );
}

export function Avatar({ name, index = 0, size = 38 }: { name: string; index?: number; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: colorFor(index) }]}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
  onLongPress,
  testID,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  testID?: string;
}) {
  return (
    <Pressable testID={testID} onPress={onPress} onLongPress={onLongPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && { color: colors.white }]}>{label}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[styles.segmentItem, active && styles.segmentItemActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.segmentText, active && { color: colors.primary }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

export function Empty({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <View style={[styles.center, { padding: 32 }]}>
      <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, textAlign: 'center' }}>{title}</Text>
      {subtitle ? <Text style={{ color: colors.muted, marginTop: 6, textAlign: 'center' }}>{subtitle}</Text> : null}
      {children ? <View style={{ marginTop: 16, alignSelf: 'stretch' }}>{children}</View> : null}
    </View>
  );
}

export function Screen({ children, scroll = true, style }: { children: React.ReactNode; scroll?: boolean; style?: StyleProp<ViewStyle> }) {
  if (!scroll) return <View style={[styles.screen, style]}>{children}</View>;
  return (
    // scrolls the focused input above the keyboard (a plain ScrollView leaves it hidden behind the keyboard)
    <KeyboardAwareScrollView
      style={styles.screen}
      contentContainerStyle={[{ padding: 16, paddingBottom: 40 }, style]}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  btn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderWidth: 1.5,
  },
  btnSmall: { height: 36, borderRadius: 10, paddingHorizontal: 12 },
  btnText: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted, marginBottom: 6 },
  input: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 16,
    color: colors.text,
  },
  error: { color: colors.negative, marginTop: 4, fontSize: 13 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontWeight: '600', fontSize: 13 },
  segment: { flexDirection: 'row', backgroundColor: '#E5E7EB', borderRadius: 10, padding: 3, marginBottom: 14 },
  segmentItem: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  segmentItemActive: { backgroundColor: colors.white },
  segmentText: { fontWeight: '700', color: colors.muted, fontSize: 13 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, marginTop: 6 },
});
