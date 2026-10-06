// On-device identity: a random user id and device id generated on first use (no sign-up),
// plus the sync server URL. The user id is what the server records as a change's author.
import { getSetting, setSetting } from '../data/settings';

export interface UserIdentity {
  id: string; // e.g. usr_9a4f2b...
  name: string;
  /** Base URL of the SplitMate sync server, e.g. https://splitmate-relay.rn45819.workers.dev */
  serverUrl: string;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Hermes has no Web Crypto; these ids are identifiers, not secrets.
    for (let i = 0; i < byteCount; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Accepts what users (or older app versions) stored and returns a plain HTTP(S) base URL.
 * Older builds saved the WebSocket relay address (wss://host/ws), so map that to https://host.
 */
export function normalizeServerUrl(url: string): string {
  return url
    .trim()
    .replace(/^ws(s)?:\/\//i, 'http$1://')
    .replace(/\/ws\/?$/i, '')
    .replace(/\/+$/, '');
}

// EXPO_PUBLIC_SERVER_URL is inlined at build time (e.g. the local Docker server); production builds leave it unset.
export const DEFAULT_SERVER_URL = normalizeServerUrl(process.env.EXPO_PUBLIC_SERVER_URL || 'https://splitmate-relay.rn45819.workers.dev');

// Setting key kept from the relay era so a custom URL saved by an older build still applies.
const SERVER_URL_SETTING = 'sync.relay_url';

export async function getServerUrl(): Promise<string> {
  const custom = normalizeServerUrl((await getSetting(SERVER_URL_SETTING)) ?? '');
  return custom || DEFAULT_SERVER_URL;
}

/** Saves a custom server URL; an empty string restores the default. */
export async function updateServerUrl(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  if (normalized && !/^https?:\/\/[^/\s]+/i.test(normalized)) {
    throw new Error('Server URL must start with http:// or https://');
  }
  await setSetting(SERVER_URL_SETTING, normalized === DEFAULT_SERVER_URL ? '' : normalized);
}

export async function getIdentity(): Promise<UserIdentity> {
  let id = await getSetting('profile.id');
  if (!id) {
    id = `usr_${randomHex(8)}`;
    await setSetting('profile.id', id);
  }
  return {
    id,
    name: (await getSetting('profile.name')) || 'Me',
    serverUrl: await getServerUrl(),
  };
}

export async function setAccountName(name: string): Promise<void> {
  await setSetting('profile.name', name.trim().slice(0, 80));
}

/** Returns a stable, persistent device ID for this client installation. */
export async function getDeviceId(): Promise<string> {
  let deviceId = await getSetting('sync.device_id');
  if (!deviceId) {
    deviceId = `dev_${randomHex(16)}`;
    await setSetting('sync.device_id', deviceId);
  }
  return deviceId;
}
