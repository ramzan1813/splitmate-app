import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { colors } from '@/lib/theme';

import { money } from '@/lib/format';

export interface Slice {
  label: string;
  value: number;
  color: string;
  count?: number;
}

function arc(cx: number, cy: number, r: number, start: number, end: number) {
  const s = { x: cx + r * Math.cos(start), y: cy + r * Math.sin(start) };
  const e = { x: cx + r * Math.cos(end), y: cy + r * Math.sin(end) };
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y} Z`;
}

export function PieChart({
  data,
  size = 220,
  centerLabel,
  centerValue,
  total: propTotal,
  currency,
}: {
  data: Slice[];
  size?: number;
  centerLabel?: string;
  centerValue?: string;
  total?: number;
  currency?: string;
}) {
  const slices = data.filter((d) => d.value > 0);
  const calculatedTotal = slices.reduce((a, b) => a + b.value, 0);
  const total = propTotal !== undefined ? propTotal : calculatedTotal;
  const r = size / 2;

  // Resolve display values so the donut center is never empty when totals/currencies are supplied
  const resolvedValue = centerValue ?? (currency ? money(total, currency) : undefined);
  const resolvedLabel = centerLabel ?? (resolvedValue ? 'Total' : undefined);

  // precompute each slice's start/end angle (no mutation during render)
  const arcs = slices.reduce<{ start: number; end: number }[]>((acc, s) => {
    const start = acc.length ? acc[acc.length - 1]!.end : -Math.PI / 2;
    acc.push({ start, end: start + (total ? (s.value / total) * Math.PI * 2 : 0) });
    return acc;
  }, []);

  const valLen = resolvedValue?.length ?? 0;
  const valueFontSize = valLen > 15 ? 13 : valLen > 11 ? 15 : 18;

  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          {total === 0 ? (
            <Circle cx={r} cy={r} r={r} fill={colors.border} />
          ) : slices.length === 1 ? (
            <Circle cx={r} cy={r} r={r} fill={slices[0]!.color} />
          ) : (
            <G>
              {slices.map((s, i) => (
                <Path key={i} d={arc(r, r, r, arcs[i]!.start, arcs[i]!.end)} fill={s.color} stroke="#fff" strokeWidth={2} />
              ))}
            </G>
          )}
          <Circle cx={r} cy={r} r={r * 0.58} fill="#fff" />
        </Svg>
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
          {resolvedLabel ? <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{resolvedLabel}</Text> : null}
          {resolvedValue ? <Text style={{ color: colors.text, fontSize: valueFontSize, fontWeight: '800', textAlign: 'center' }} numberOfLines={1}>{resolvedValue}</Text> : null}
        </View>
      </View>
    </View>
  );
}
