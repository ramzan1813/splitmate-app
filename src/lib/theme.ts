export const colors = {
  primary: '#0F766E',
  primaryDark: '#0B5953',
  primaryLight: '#CCFBF1',
  accent: '#F59E0B',
  bg: '#F4F6F8',
  card: '#FFFFFF',
  text: '#111827',
  muted: '#6B7280',
  border: '#E5E7EB',
  positive: '#15803D',
  positiveBg: '#DCFCE7',
  negative: '#B91C1C',
  negativeBg: '#FEE2E2',
  white: '#FFFFFF',
};

/** Categorical palette (fixed order, validated for colour-blind separation). Used for people & categories. */
export const palette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
/** Single hue for magnitude-only charts (bars of one measure). */
export const barColor = '#0F766E';
export const barTrack = '#E5E7EB';

/** Colour for the n-th entity. Beyond 8 entities colours repeat, so charts fold extras into "Other". */
export const colorFor = (index: number) => palette[Math.abs(index) % palette.length]!;
export const OTHER_COLOR = '#9CA3AF';

export const CATEGORIES = ['General', 'Food', 'Travel', 'Stay', 'Shopping', 'Entertainment', 'Fuel', 'Groceries', 'Bills', 'Rent', 'Other'];

const CATEGORY_ICONS: Record<string, string> = {
  General: '🧾',
  Food: '🍽️',
  Travel: '✈️',
  Stay: '🏨',
  Shopping: '🛍️',
  Entertainment: '🎬',
  Fuel: '⛽',
  Groceries: '🛒',
  Bills: '💡',
  Rent: '🏠',
  Other: '📦',
};
/** Icon for a category; categories the user created get the generic receipt. */
export const categoryIcon = (category: string) => CATEGORY_ICONS[category] ?? '🧾';
