// On-device cryptographic account identity management.
// No cloud signup needed; user identities are generated on-device with private keys.
import { getSetting, setSetting } from '../data/repo';
import { generateRandomHex, sha256Hex } from './crypto';

export interface UserIdentity {
  id: string; // e.g., usr_9a4f2b...
  name: string;
  publicKey: string;
  secretKey: string;
  relayUrl: string;
}

export const DEFAULT_RELAY_URL = 'wss://splitmate-relay.rn45819.workers.dev/ws';

export async function getIdentity(): Promise<UserIdentity> {
  let id = await getSetting('profile.id');
  let secret = await getSetting('profile.secret');
  let name = (await getSetting('profile.name')) || 'Me';
  const customRelay = (await getSetting('sync.relay_url'))?.trim();
  const relayUrl = customRelay && customRelay.length > 0 ? customRelay : DEFAULT_RELAY_URL;

  if (!id || !secret) {
    secret = generateRandomHex(32);
    const pubHash = await sha256Hex(secret);
    id = `usr_${pubHash.slice(0, 16)}`;
    await setSetting('profile.id', id);
    await setSetting('profile.secret', secret);
    await setSetting('profile.pubkey', pubHash);
  }

  const pubKey = (await getSetting('profile.pubkey')) || (await sha256Hex(secret));

  return {
    id,
    name,
    publicKey: pubKey,
    secretKey: secret,
    relayUrl,
  };
}

export async function updateRelayUrl(url: string): Promise<void> {
  await setSetting('sync.relay_url', url.trim());
}

export async function setAccountName(name: string): Promise<void> {
  await setSetting('profile.name', name.trim().slice(0, 80));
}

/** Returns a stable, persistent device ID for this client installation. */
export async function getDeviceId(): Promise<string> {
  let deviceId = await getSetting('sync.device_id');
  if (!deviceId) {
    const rnd = generateRandomHex(16);
    deviceId = `dev_${rnd}`;
    await setSetting('sync.device_id', deviceId);
  }
  return deviceId;
}

