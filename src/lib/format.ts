import { findCurrency } from './currencies';

export function currencySymbol(code: string) {
  return findCurrency(code)?.symbol ?? `${code} `;
}

/** Format integer cents as money, e.g. 123456 -> "$1,234.56" */
export function money(cents: number, currency = 'USD', opts: { sign?: boolean } = {}) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100).toString().padStart(2, '0');
  const sign = neg ? '-' : opts.sign && cents > 0 ? '+' : '';
  return `${sign}${currencySymbol(currency)}${whole}.${frac}`;
}

/** Parse user-typed decimal into a number (not cents). Returns NaN when invalid. */
export function parseAmount(text: string): number {
  const cleaned = String(text).replace(/,/g, '').trim();
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

export const toCents = (n: number) => Math.round(n * 100);

export function todayISO() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function prettyDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}
