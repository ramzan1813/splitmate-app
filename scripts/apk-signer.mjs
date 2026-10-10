// Prints the SHA-256 fingerprint of the certificate(s) an APK is signed with (APK Signature Scheme v2/v3).
//
// Android only updates an installed app with an APK signed by the same key. If installing a new version fails
// with "App not installed" although the package name is the same and versionCode is higher, compare this
// fingerprint for the new APK and for the APK that is installed on the phone.
//
// Usage: node scripts/apk-signer.mjs <file.apk> [...]
// Prints one line per signer: "<scheme> <sha256-hex>". Exits 1 if a file has no v2/v3 signature.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCHEMES = new Map([
  [0x7109871a, 'v2'],
  [0xf05368c0, 'v3'],
  [0x1b93ad61, 'v3.1'],
]);

function signingBlock(buf) {
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocd < 0) throw new Error('not a zip/APK file');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.toString('latin1', cdOffset - 16, cdOffset) !== 'APK Sig Block 42') return new Map();
  const size = Number(buf.readBigUInt64LE(cdOffset - 24));
  const pairs = new Map();
  for (let pos = cdOffset - size - 8 + 8; pos < cdOffset - 24; ) {
    const len = Number(buf.readBigUInt64LE(pos));
    pairs.set(buf.readUInt32LE(pos + 8), buf.subarray(pos + 12, pos + 8 + len));
    pos += 8 + len;
  }
  return pairs;
}

/** Length-prefixed (uint32) slice at pos; returns [slice, next position]. */
const lp = (b, pos) => {
  const n = b.readUInt32LE(pos);
  return [b.subarray(pos + 4, pos + 4 + n), pos + 4 + n];
};

function certificates(block) {
  const out = [];
  const [signers] = lp(block, 0);
  for (let p = 0; p < signers.length; ) {
    const [signer, next] = lp(signers, p);
    p = next;
    const [signedData] = lp(signer, 0);
    const [, afterDigests] = lp(signedData, 0);
    const [certs] = lp(signedData, afterDigests);
    for (let c = 0; c < certs.length; ) {
      const [cert, nc] = lp(certs, c);
      c = nc;
      out.push(cert);
    }
  }
  return out;
}

let failed = false;
for (const file of process.argv.slice(2)) {
  const found = [];
  for (const [id, block] of signingBlock(readFileSync(file))) {
    const scheme = SCHEMES.get(id);
    if (!scheme) continue;
    for (const cert of certificates(block)) found.push(`${scheme} ${createHash('sha256').update(cert).digest('hex')}`);
  }
  if (!found.length) {
    console.error(`${file}: no v2/v3 signature found`);
    failed = true;
  }
  for (const line of new Set(found)) console.log(process.argv.length > 3 ? `${file} ${line}` : line);
}
process.exit(failed ? 1 : 0);
