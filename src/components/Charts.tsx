// Lightweight bar charts built from Views (fast, accessible, no chart library needed).
// Conventions: one hue for a single measure, the categorical palette only for identity,
// rounded data-ends, 2px gaps between stacked segments, a legend whenever there are 2+ series,
// and tap-to-reveal values so labels stay selective.
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { barColor, barTrack, colors } from '@/lib/theme';

/** Horizontal ranked bars, one measure (e.g. spending per category). */
export function HBarList({ rows, format, testID }: { rows: { label: string; value: number; sub?: string; color?: string }[]; format: (v: number) => string; testID?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <View testID={testID}>
      {rows.map((r) => {
        const pct = (r.value / max) * 100;
        const min = r.value > 0 ? 4 : 0;
        return (
        <View key={r.label} style={{ marginBottom: 12 }} accessible accessibilityLabel={`${r.label}: ${format(r.value)}${r.sub ? `, ${r.sub}` : ''}`}>
          <View style={{ flexDirection: 'row', marginBottom: 4 }}>
            {r.color ? <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: r.color, marginRight: 8, marginTop: 4 }} /> : null}
            <Text style={{ flex: 1, color: colors.text, fontWeight: '600' }} numberOfLines={1}>
              {r.label}
            </Text>
            <Text style={{ color: colors.text, fontWeight: '700' }}>{format(r.value)}</Text>
            {r.sub ? <Text style={{ color: colors.muted, width: 56, textAlign: 'right' }}>{r.sub}</Text> : null}
          </View>
          <View style={{ height: 8, backgroundColor: barTrack, borderRadius: 4 }}>
            <View style={{ width: `${pct}%`, minWidth: min, height: 8, backgroundColor: barColor, borderRadius: 4 }} />
          </View>
        </View>
        );
      })}
    </View>
  );
}

/** Vertical bars over time / buckets, one measure. Tap a bar to see its value. */
export function ColumnChart({ data, format, height = 140, highlightLast = true }: { data: { label: string; value: number }[]; format: (v: number) => string; height?: number; highlightLast?: boolean }) {
  const [sel, setSel] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const shown = sel ?? (highlightLast ? data.length - 1 : null);
  return (
    <View>
      <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 6, minHeight: 16 }}>
        {shown !== null && data[shown] ? `${data[shown]!.label}: ${format(data[shown]!.value)}` : ' '}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {data.map((d, i) => {
          const barHeight = d.value > 0 ? Math.max(3, (d.value / max) * (height - 4)) : 0;
          return (
          <Pressable
            key={d.label + i}
            onPress={() => setSel(sel === i ? null : i)}
            style={{ flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 3 }}
            accessibilityRole="button"
            accessibilityLabel={`${d.label}: ${format(d.value)}`}
          >
            <View
              style={{
                width: '70%',
                maxWidth: 34,
                height: barHeight,
                backgroundColor: barColor,
                opacity: shown === null || shown === i ? 1 : 0.45,
                borderTopLeftRadius: 4,
                borderTopRightRadius: 4,
              }}
            />
          </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 4 }}>
        {data.map((d, i) => (
          <Text key={d.label + i} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: colors.muted }} numberOfLines={1}>
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** Two measures on the same money scale per row (e.g. Paid vs Share), with a legend. */
export function PairedBars({ rows, series, format }: { rows: { label: string; a: number; b: number }[]; series: [{ name: string; color: string }, { name: string; color: string }]; format: (v: number) => string }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  return (
    <View>
      <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />
      {rows.map((r) => (
        <View key={r.label} style={{ marginTop: 10 }} accessible accessibilityLabel={`${r.label}: ${series[0].name} ${format(r.a)}, ${series[1].name} ${format(r.b)}`}>
          <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 4 }}>{r.label}</Text>
          {([['a', 0], ['b', 1]] as const).map(([k, si]) => (
            <View key={k} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
              <View style={{ flex: 1, height: 8 }}>
                <View style={{ width: `${(r[k] / max) * 100}%`, minWidth: r[k] > 0 ? 4 : 0, height: 8, borderRadius: 4, backgroundColor: series[si].color }} />
              </View>
              <Text style={{ width: 100, textAlign: 'right', fontSize: 12, color: colors.text }}>{format(r[k])}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** One 100% stacked bar (e.g. a person's spending split by category). */
export function StackedBar({ parts, onSelect, selected }: { parts: { label: string; value: number; color: string }[]; onSelect?: (label: string | null) => void; selected?: string | null }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <View style={{ height: 12, borderRadius: 6, backgroundColor: barTrack }} />;
  const visible = parts.filter((p) => p.value > 0);
  return (
    <View style={{ flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
      {visible.map(({ label, value: weight, color }) => (
        <Pressable
          key={label}
          onPress={() => onSelect?.(selected === label ? null : label)}
          style={{ flex: weight, backgroundColor: color, opacity: !selected || selected === label ? 1 : 0.35 }}
          accessibilityLabel={`${label}: ${Math.round((weight / total) * 100)}%`}
        />
      ))}
    </View>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {items.map((i) => (
        <View key={i.label} style={{ flexDirection: 'row', alignItems: 'center', marginRight: 14, marginBottom: 4 }}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: i.color, marginRight: 6 }} />
          <Text style={{ fontSize: 12, color: colors.text }}>{i.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** Headline number tile. */
export function StatTile({ label, value, sub, subColor, testID }: { label: string; value: string; sub?: string; subColor?: string; testID?: string }) {
  return (
    <View style={{ flexBasis: '47%', flexGrow: 1, backgroundColor: colors.card, borderRadius: 14, padding: 12 }} testID={testID}>
      <Text style={{ color: colors.muted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 19, fontWeight: '800', marginTop: 2 }} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={{ color: subColor ?? colors.muted, fontSize: 12, marginTop: 2, fontWeight: '600' }}>{sub}</Text> : null}
    </View>
  );
}
