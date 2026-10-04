// Universal encryption and hashing utilities for end-to-end encrypted sync.
// Pure, deterministic, zero-dependency implementation ensuring 100% cross-platform compatibility
// across React Native (Hermes on Android/iOS), Web Browsers, and Node.js.

export function stringToUtf8(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  const utf8: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let charcode = str.charCodeAt(i);
    if (charcode < 0x80) utf8.push(charcode);
    else if (charcode < 0x800) {
      utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
    } else if (charcode < 0xd800 || charcode >= 0xe000) {
      utf8.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
    } else {
      i++;
      charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      utf8.push(0xf0 | (charcode >> 18), 0x80 | ((charcode >> 12) & 0x3f), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
    }
  }
  return new Uint8Array(utf8);
}

export function utf8ToString(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  let out = '';
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const c = bytes[i++]!;
    if (c < 128) {
      out += String.fromCharCode(c);
    } else if (c > 191 && c < 224) {
      const c2 = bytes[i++]!;
      out += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
    } else if (c > 223 && c < 240) {
      const c2 = bytes[i++]!;
      const c3 = bytes[i++]!;
      out += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
    } else {
      const c2 = bytes[i++]!;
      const c3 = bytes[i++]!;
      const c4 = bytes[i++]!;
      const u = (((c & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63)) - 0x10000;
      out += String.fromCharCode((u >> 10) + 0xd800, (u & 0x3ff) + 0xdc00);
    }
  }
  return out;
}

export function generateRandomHex(byteCount = 32): string {
  const bytes = new Uint8Array(byteCount);
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteCount; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateGroupKey(): string {
  return generateRandomHex(32); // 256-bit AES/ChaCha key in hex
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

/** Standard FIPS 180-4 SHA-256 implementation in pure TypeScript. */
export function sha256(input: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const len = input.length;
  const bitLen = len * 8;
  const padLen = len % 64 < 56 ? 56 - (len % 64) : 120 - (len % 64);
  const totalLen = len + padLen + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(input);
  padded[len] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);

  const W = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ((W[i - 15] >>> 7) | (W[i - 15] << 25)) ^ ((W[i - 15] >>> 18) | (W[i - 15] << 14)) ^ (W[i - 15] >>> 3);
      const s1 = ((W[i - 2] >>> 17) | (W[i - 2] << 15)) ^ ((W[i - 2] >>> 19) | (W[i - 2] << 13)) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const result = new Uint8Array(32);
  const outView = new DataView(result.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return result;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > 64) {
    k = sha256(k);
  }
  const keyPad = new Uint8Array(64);
  keyPad.set(k);

  const oPad = new Uint8Array(64 + 32);
  const iPad = new Uint8Array(64 + message.length);

  for (let i = 0; i < 64; i++) {
    oPad[i] = keyPad[i]! ^ 0x5c;
    iPad[i] = keyPad[i]! ^ 0x36;
  }
  iPad.set(message, 64);
  const innerHash = sha256(iPad);
  oPad.set(innerHash, 64);
  return sha256(oPad);
}

function chacha20Block(key: Uint32Array, nonce: Uint32Array, counter: number): Uint32Array {
  const state = new Uint32Array(16);
  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) state[4 + i] = key[i]!;
  state[12] = counter;
  state[13] = nonce[0]!;
  state[14] = nonce[1]!;
  state[15] = nonce[2]!;

  const working = new Uint32Array(state);

  const QR = (a: number, b: number, c: number, d: number) => {
    working[a] = (working[a]! + working[b]!) >>> 0;
    working[d] = working[d]! ^ working[a]!;
    working[d] = ((working[d]! << 16) | (working[d]! >>> 16)) >>> 0;

    working[c] = (working[c]! + working[d]!) >>> 0;
    working[b] = working[b]! ^ working[c]!;
    working[b] = ((working[b]! << 12) | (working[b]! >>> 20)) >>> 0;

    working[a] = (working[a]! + working[b]!) >>> 0;
    working[d] = working[d]! ^ working[a]!;
    working[d] = ((working[d]! << 8) | (working[d]! >>> 24)) >>> 0;

    working[c] = (working[c]! + working[d]!) >>> 0;
    working[b] = working[b]! ^ working[c]!;
    working[b] = ((working[b]! << 7) | (working[b]! >>> 25)) >>> 0;
  };

  for (let i = 0; i < 10; i++) {
    QR(0, 4, 8, 12);
    QR(1, 5, 9, 13);
    QR(2, 6, 10, 14);
    QR(3, 7, 11, 15);
    QR(0, 5, 10, 15);
    QR(1, 6, 11, 12);
    QR(2, 7, 8, 13);
    QR(3, 4, 9, 14);
  }

  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = (working[i]! + state[i]!) >>> 0;
  }
  return out;
}

function chacha20Xor(keyBytes: Uint8Array, nonceBytes: Uint8Array, input: Uint8Array): Uint8Array {
  const keyU32 = new Uint32Array(8);
  const keyView = new DataView(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength);
  for (let i = 0; i < 8; i++) keyU32[i] = keyView.getUint32(i * 4, true);

  const nonceU32 = new Uint32Array(3);
  const nonceView = new DataView(nonceBytes.buffer, nonceBytes.byteOffset, nonceBytes.byteLength);
  for (let i = 0; i < 3; i++) nonceU32[i] = nonceView.getUint32(i * 4, true);

  const out = new Uint8Array(input.length);
  let counter = 1;

  for (let offset = 0; offset < input.length; offset += 64) {
    const block = chacha20Block(keyU32, nonceU32, counter++);
    const blockBytes = new Uint8Array(block.buffer);
    const chunkLen = Math.min(64, input.length - offset);
    for (let i = 0; i < chunkLen; i++) {
      out[offset + i] = input[offset + i]! ^ blockBytes[i]!;
    }
  }

  return out;
}

/** Computes standard 64-hex SHA-256 string for any text. */
export async function sha256Hex(text: string): Promise<string> {
  const data = stringToUtf8(text);
  const hashBytes = sha256(data);
  return bytesToHex(hashBytes);
}

/**
 * Authenticated Encryption using ChaCha20 + HMAC-SHA256 (128-bit MAC).
 * Output format: `<iv_hex>:<mac_hex>:<ciphertext_hex>`
 */
export async function encryptWithKey(plaintext: string, keyHex: string): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  const iv = hexToBytes(generateRandomHex(12));
  const plainBytes = stringToUtf8(plaintext);
  const cipherBytes = chacha20Xor(keyBytes, iv, plainBytes);

  // Authenticate IV + Ciphertext with HMAC-SHA256
  const authPayload = new Uint8Array(iv.length + cipherBytes.length);
  authPayload.set(iv);
  authPayload.set(cipherBytes, iv.length);
  const mac = hmacSha256(keyBytes, authPayload).slice(0, 16); // 128-bit MAC tag

  return `${bytesToHex(iv)}:${bytesToHex(mac)}:${bytesToHex(cipherBytes)}`;
}

/**
 * Decrypts a `<iv_hex>:<mac_hex>:<ciphertext_hex>` string using the hex key.
 */
export async function decryptWithKey(encryptedPayload: string, keyHex: string): Promise<string> {
  const parts = encryptedPayload.split(':');
  const keyBytes = hexToBytes(keyHex);

  if (parts.length === 3) {
    const [ivHex, macHex, cipherHex] = parts;
    const iv = hexToBytes(ivHex!);
    const mac = hexToBytes(macHex!);
    const cipherBytes = hexToBytes(cipherHex!);

    const authPayload = new Uint8Array(iv.length + cipherBytes.length);
    authPayload.set(iv);
    authPayload.set(cipherBytes, iv.length);
    const expectedMac = hmacSha256(keyBytes, authPayload).slice(0, 16);

    let match = true;
    for (let i = 0; i < 16; i++) {
      if (mac[i] !== expectedMac[i]) match = false;
    }
    if (!match) throw new Error('Decryption authentication failed: invalid MAC tag');

    const decryptedBytes = chacha20Xor(keyBytes, iv, cipherBytes);
    return utf8ToString(decryptedBytes);
  }

  // Backward compatibility with legacy 2-part format
  if (parts.length === 2) {
    const [ivHex, cipherHex] = parts;
    const iv = hexToBytes(ivHex!);
    const cipherBytes = hexToBytes(cipherHex!);
    const decryptedBytes = chacha20Xor(keyBytes, iv, cipherBytes);
    return utf8ToString(decryptedBytes);
  }

  throw new Error('Invalid encrypted payload format');
}
