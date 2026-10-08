// Optional 4-digit app lock. Only a salted SHA-256 hash of the PIN is stored, never the PIN itself.
import * as Crypto from 'expo-crypto';
import { getSetting, setSetting } from '@/data/settings';

const HASH_KEY = 'pin.hash';
const SALT_KEY = 'pin.salt';
const FAILS_KEY = 'pin.fails';
const LOCK_UNTIL_KEY = 'pin.lockUntil';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function hash(pin: string, salt: string) {
  // a few rounds make brute-forcing a copied database slower
  let h = `${salt}:${pin}`;
  for (let i = 0; i < 500; i++) h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}${h}`);
  return h;
}

const isValidPin = (pin: string) => /^\d{4}$/.test(pin);

export async function isPinEnabled() {
  return !!(await getSetting(HASH_KEY));
}

export async function setPin(pin: string) {
  if (!isValidPin(pin)) throw new Error('PIN must be exactly 4 digits');
  const salt = toHex(Crypto.getRandomBytes(16));
  await setSetting(SALT_KEY, salt);
  await setSetting(HASH_KEY, await hash(pin, salt));
  await setSetting(FAILS_KEY, null);
  await setSetting(LOCK_UNTIL_KEY, null);
}

export async function removePin() {
  await setSetting(HASH_KEY, null);
  await setSetting(SALT_KEY, null);
  await setSetting(FAILS_KEY, null);
  await setSetting(LOCK_UNTIL_KEY, null);
}

/** Seconds the user must wait before trying again (0 = can try now). */
export async function lockoutRemaining() {
  const until = Number((await getSetting(LOCK_UNTIL_KEY)) || 0);
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** Checks a PIN. After 5 wrong tries the lock screen waits 30s, doubling each further miss (max 15 min). */
export async function verifyPin(pin: string): Promise<{ ok: boolean; wait: number }> {
  const wait = await lockoutRemaining();
  if (wait > 0) return { ok: false, wait };
  const salt = await getSetting(SALT_KEY);
  const stored = await getSetting(HASH_KEY);
  if (!salt || !stored) return { ok: true, wait: 0 };
  if ((await hash(pin, salt)) === stored) {
    await setSetting(FAILS_KEY, null);
    await setSetting(LOCK_UNTIL_KEY, null);
    return { ok: true, wait: 0 };
  }
  const fails = Number((await getSetting(FAILS_KEY)) || 0) + 1;
  await setSetting(FAILS_KEY, String(fails));
  if (fails >= 5) {
    const seconds = Math.min(900, 30 * 2 ** (fails - 5));
    await setSetting(LOCK_UNTIL_KEY, String(Date.now() + seconds * 1000));
    return { ok: false, wait: seconds };
  }
  return { ok: false, wait: 0 };
}
