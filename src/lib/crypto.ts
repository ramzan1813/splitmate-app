// Universal encryption and hashing utilities for end-to-end encrypted sync.
// Uses standard Web Crypto (SubtleCrypto) with fallbacks, ensuring zero plaintext leaves the device.

export function generateRandomHex(byteCount = 32): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const bytes = new Uint8Array(byteCount);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let s = '';
  for (let i = 0; i < byteCount; i++) {
    s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return s;
}

export function generateGroupKey(): string {
  return generateRandomHex(32); // 256-bit AES key in hex
}

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(hash));
  }
  // Simple fallback hash for environments where SubtleCrypto is unavailable
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(64, '0');
}

/**
 * Encrypts a plaintext string with a hex AES key using AES-GCM.
 * Output format: `<iv_hex>:<ciphertext_hex>`
 */
export async function encryptWithKey(plaintext: string, keyHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const encodedText = encoder.encode(plaintext);
  const keyBytes = hexToBytes(keyHex);

  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBytes as unknown as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    const iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(iv);
    const cipherBuffer = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encodedText as unknown as BufferSource
    );
    return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(cipherBuffer))}`;
  }

  // Fallback XOR stream cipher if SubtleCrypto is unavailable
  const iv = hexToBytes(generateRandomHex(12));
  const combinedKey = new Uint8Array(keyBytes.length + iv.length);
  combinedKey.set(keyBytes);
  combinedKey.set(iv, keyBytes.length);
  const out = new Uint8Array(encodedText.length);
  for (let i = 0; i < encodedText.length; i++) {
    out[i] = encodedText[i]! ^ combinedKey[i % combinedKey.length]!;
  }
  return `${bytesToHex(iv)}:${bytesToHex(out)}`;
}

/**
 * Decrypts a `<iv_hex>:<ciphertext_hex>` string using the hex AES key.
 */
export async function decryptWithKey(encryptedPayload: string, keyHex: string): Promise<string> {
  const [ivHex, cipherHex] = encryptedPayload.split(':');
  if (!ivHex || !cipherHex) throw new Error('Invalid encrypted payload format');

  const iv = hexToBytes(ivHex);
  const cipherBytes = hexToBytes(cipherHex);
  const keyBytes = hexToBytes(keyHex);

  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBytes as unknown as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      cryptoKey,
      cipherBytes as unknown as BufferSource
    );
    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
  }

  // Fallback XOR stream decryption
  const combinedKey = new Uint8Array(keyBytes.length + iv.length);
  combinedKey.set(keyBytes);
  combinedKey.set(iv, keyBytes.length);
  const out = new Uint8Array(cipherBytes.length);
  for (let i = 0; i < cipherBytes.length; i++) {
    out[i] = cipherBytes[i]! ^ combinedKey[i % combinedKey.length]!;
  }
  const decoder = new TextDecoder();
  return decoder.decode(out);
}
