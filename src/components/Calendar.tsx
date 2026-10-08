// In-app calendar in the app's own style (the system date pickers look different on every phone).
import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Button, Row, styles as ui } from './ui';
import { colors } from '@/lib/theme';
import { prettyDate, todayISO } from '@/lib/format';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => String(n).padStart(2, '0');
const toISO = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? { y, m: m - 1, d } : null;
};

/** Monday-first grid of the month: leading blanks, then day numbers. */
function monthCells(y: number, m: number): (number | null)[] {
  const first = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = Array.from({ length: first }, () => null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** Date input (YYYY-MM-DD) that opens the in-app calendar. */
export function DateField({ label, value, onChange, testID }: { label?: string; value: string; onChange: (iso: string) => void; testID?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginBottom: 14 }}>
      {label ? <Text style={ui.label}>{label}</Text> : null}
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [ui.input, { flexDirection: 'row', alignItems: 'center' }, pressed && { borderColor: colors.primary }]}
        accessibilityRole="button"
        accessibilityLabel={`${label ?? 'Date'}: ${prettyDate(value)}`}
        testID={testID}
      >
        <Text style={{ flex: 1, fontSize: 16, color: colors.text }}>{prettyDate(value)}</Text>
        <Text style={{ fontSize: 16 }}>📅</Text>
      </Pressable>
      <CalendarModal visible={open} value={value} onSelect={onChange} onClose={() => setOpen(false)} />
    </View>
  );
}

function CalendarModal({ visible, value, onSelect, onClose }: { visible: boolean; value: string; onSelect: (iso: string) => void; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(17,24,39,0.45)', justifyContent: 'center', padding: 20 }}>
        {/* inner Pressable stops taps on the card from closing it */}
        <Pressable onPress={() => {}} style={{ backgroundColor: colors.card, borderRadius: 20, overflow: 'hidden', maxWidth: 400, width: '100%', alignSelf: 'center' }}>
          {visible && <Calendar value={value} onSelect={onSelect} onClose={onClose} />}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Calendar({ value, onSelect, onClose }: { value: string; onSelect: (iso: string) => void; onClose: () => void }) {
  const today = todayISO();
  const initial = parse(value) ?? parse(today)!;
  const [view, setView] = useState({ y: initial.y, m: initial.m });
  const [picked, setPicked] = useState(parse(value) ? value : today);
  const [pickingMonth, setPickingMonth] = useState(false);
  const p = parse(picked)!;

  const shift = (months: number) => setView(({ y, m }) => ({ y: y + Math.floor((m + months) / 12), m: (((m + months) % 12) + 12) % 12 }));
  const choose = (iso: string) => {
    setPicked(iso);
    const q = parse(iso)!;
    setView({ y: q.y, m: q.m });
  };
  const yesterday = (() => {
    const t = parse(today)!;
    const d = new Date(t.y, t.m, t.d - 1);
    return toISO(d.getFullYear(), d.getMonth(), d.getDate());
  })();

  return (
    <View>
      {/* header: the selected date, large, on the brand colour */}
      <View style={{ backgroundColor: colors.primary, paddingHorizontal: 20, paddingVertical: 16 }}>
        <Text style={{ color: colors.primaryLight, fontSize: 13, fontWeight: '600' }}>Select date</Text>
        <Text style={{ color: colors.white, fontSize: 26, fontWeight: '800', marginTop: 2 }}>
          {DAY_NAMES[new Date(p.y, p.m, p.d).getDay()]}, {p.d} {MONTHS[p.m]!.slice(0, 3)} {p.y}
        </Text>
      </View>

      <View style={{ padding: 14 }}>
        <Row style={{ marginBottom: 8 }}>
          <NavButton label="‹" onPress={() => (pickingMonth ? setView((v) => ({ ...v, y: v.y - 1 })) : shift(-1))} testID="cal-prev" />
          <Pressable onPress={() => setPickingMonth((x) => !x)} style={{ flex: 1, alignItems: 'center', paddingVertical: 6 }} testID="cal-title">
            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>
              {pickingMonth ? view.y : `${MONTHS[view.m]} ${view.y}`} <Text style={{ color: colors.primary, fontSize: 12 }}>▾</Text>
            </Text>
          </Pressable>
          <NavButton label="›" onPress={() => (pickingMonth ? setView((v) => ({ ...v, y: v.y + 1 })) : shift(1))} testID="cal-next" />
        </Row>

        {pickingMonth ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 4 }}>
            {MONTHS.map((name, m) => {
              const active = m === view.m;
              return (
                <Pressable
                  key={name}
                  onPress={() => {
                    setView((v) => ({ ...v, m }));
                    setPickingMonth(false);
                  }}
                  style={{ width: '33.33%', padding: 4 }}
                >
                  <View style={{ paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: active ? colors.primary : colors.bg }}>
                    <Text style={{ fontWeight: '700', color: active ? colors.white : colors.text }}>{name.slice(0, 3)}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <>
            <View style={{ flexDirection: 'row' }}>
              {WEEKDAYS.map((w, i) => (
                <Text key={w} style={{ flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '700', color: i >= 5 ? colors.primary : colors.muted, paddingVertical: 4 }}>
                  {w}
                </Text>
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {monthCells(view.y, view.m).map((d, i) => {
                if (d === null) return <View key={i} style={{ width: `${100 / 7}%`, aspectRatio: 1 }} />;
                const iso = toISO(view.y, view.m, d);
                const selected = iso === picked;
                const isToday = iso === today;
                return (
                  <Pressable key={i} onPress={() => setPicked(iso)} style={{ width: `${100 / 7}%`, aspectRatio: 1, padding: 3 }} testID={`cal-day-${d}`}>
                    <View
                      style={{
                        flex: 1,
                        borderRadius: 999,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: selected ? colors.primary : 'transparent',
                        borderWidth: isToday && !selected ? 1.5 : 0,
                        borderColor: colors.primary,
                      }}
                    >
                      <Text style={{ fontSize: 15, fontWeight: selected || isToday ? '800' : '500', color: selected ? colors.white : isToday ? colors.primary : colors.text }}>{d}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        <Row style={{ gap: 8, marginTop: 10 }}>
          <QuickChip label="Today" active={picked === today} onPress={() => choose(today)} />
          <QuickChip label="Yesterday" active={picked === yesterday} onPress={() => choose(yesterday)} />
        </Row>

        <Row style={{ gap: 10, marginTop: 14 }}>
          <Button title="Cancel" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
          <Button
            title="Select"
            onPress={() => {
              onSelect(picked);
              onClose();
            }}
            style={{ flex: 1 }}
            testID="cal-select"
          />
        </Row>
      </View>
    </View>
  );
}

function NavButton({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? colors.primaryLight : colors.bg })}
    >
      <Text style={{ fontSize: 22, fontWeight: '700', color: colors.primary, marginTop: -2 }}>{label}</Text>
    </Pressable>
  );
}

function QuickChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primaryLight : colors.white }}>
      <Text style={{ fontWeight: '700', fontSize: 13, color: active ? colors.primaryDark : colors.text }}>{label}</Text>
    </Pressable>
  );
}
