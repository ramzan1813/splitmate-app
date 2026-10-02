'use strict';
// Linear-time replacement for decode-uri-component@0.2.x (used by query-string@7).
// Decodes a URI component; malformed %-sequences are left as-is instead of throwing,
// and %-sequences are decoded once per position, so input cannot trigger exponential work.
function decodeChunk(chunk) {
  try {
    return decodeURIComponent(chunk);
  } catch {
    return null;
  }
}

module.exports = function decodeUriComponent(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expected `encodedURI` to be of type `string`, got `' + typeof input + '`');
  }
  const str = input;
  const whole = decodeChunk(str);
  if (whole !== null) return whole;
  // Fall back: decode each run of %XX tokens independently.
  return str.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const d = decodeChunk(run);
    if (d !== null) return d;
    // decode byte-by-byte boundaries greedily, keeping invalid bytes untouched
    let out = '';
    let i = 0;
    while (i < run.length) {
      let done = false;
      for (let len = Math.min(12, run.length - i); len >= 3; len -= 3) {
        const piece = decodeChunk(run.slice(i, i + len));
        if (piece !== null) {
          out += piece;
          i += len;
          done = true;
          break;
        }
      }
      if (!done) {
        out += run.slice(i, i + 3);
        i += 3;
      }
    }
    return out;
  });
};
