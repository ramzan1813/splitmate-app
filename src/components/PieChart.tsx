import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { colors } from '@/lib/theme';

export interface Slice {
  label: string;
  value: number;
  color: string;
}

function arc(cx: number, cy: number, r: number, start: number, end: number) {
  const s = { x: cx + r * Math.cos(start), y: cy + r * Math.sin(start) };
  const e = { x: cx + r * Math.cos(end), y: cy + r * Math.sin(end) };
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y} Z`;
}

export function PieChart({ data, size = 220, centerLabel, centerValue }: { data: Slice[]; size?: number; centerLabel?: string; centerValue?: string }) {
  const slices = data.filter((d) => d.value > 0);
  const total = slices.reduce((a, b) => a + b.value, 0);
  const r = size / 2;
  // precompute each slice's start/end angle (no mutation during render)
  const arcs = slices.reduce<{ start: number; end: number }[]>((acc, s) => {
    const start = acc.length ? acc[acc.length - 1]!.end : -Math.PI / 2;
    acc.push({ start, end: start + (total ? (s.value / total) * Math.PI * 2 : 0) });
    return acc;
  }, []);

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
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          {centerLabel ? <Text style={{ color: colors.muted, fontSize: 12 }}>{centerLabel}</Text> : null}
          {centerValue ? <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{centerValue}</Text> : null}
        </View>
      </View>
    </View>
  );
}
