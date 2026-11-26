// Save encoding for the cloud layer (spec §3.4): fflate gzip (level 6, mtime 0 so the same JSON
// always gives the same bytes and the same sha256 on every device), base64, a cheap cyrb53
// "did it change?" hash and SHA-256 (crypto.subtle when available, else a small pure-JS version;
// the synchronous one is used on page hide, where nothing may await).
// No @capacitor/* imports and no DOM access at import time: the server's contract test imports this.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';

/** gzip a JSON string: fflate level 6, mtime 0 (deterministic output). */
export function gzipString(text: string): Uint8Array {
  return gzipSync(strToU8(text), { level: 6, mtime: 0 });
}

/** Inverse of gzipString. Throws on corrupt input. */
export function gunzipToString(gz: Uint8Array): string {
  return strFromU8(gunzipSync(gz));
}

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

/** Throws on input that is not base64. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** JSON → base64(gzip(JSON)): the string kept in a slot record and sent to the server unchanged. */
export function encodeSave(json: string): string {
  return bytesToBase64(gzipString(json));
}

/** base64(gzip(JSON)) → JSON. Throws on corrupt input. */
export function decodeSave(b64: string): string {
  return gunzipToString(base64ToBytes(b64));
}

/** cyrb53 (a fast 53-bit string hash) as 14 hex digits. */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

// ------------------------------------------------------------------ SHA-256
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

/** SHA-256 of `bytes` as lowercase hex, synchronously (pure JS; ~1 ms for a 30 KiB save). */
export function sha256HexSync(bytes: Uint8Array): string {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const bitLenHi = Math.floor(len / 0x20000000);
  const bitLenLo = (len << 3) >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenHi);
  dv.setUint32(padded.length - 4, bitLenLo);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += h[i]!.toString(16).padStart(8, '0');
  return out;
}

/** SHA-256 hex via crypto.subtle (falls back to the pure-JS version in insecure contexts). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    try {
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      const d = new Uint8Array(await subtle.digest('SHA-256', copy.buffer));
      let out = '';
      for (const x of d) out += x.toString(16).padStart(2, '0');
      return out;
    } catch {
      /* fall through */
    }
  }
  return sha256HexSync(bytes);
}

/** SHA-256 hex of a UTF-8 string (device hardware id → wh2:device.hw). */
export function sha256HexOfString(s: string): Promise<string> {
  return sha256Hex(strToU8(s));
}

/** sha256 of the gzip bytes behind a base64 save string (what the server checks). */
export function sha256OfB64Sync(b64: string): string {
  return sha256HexSync(base64ToBytes(b64));
}

/** UTF-8 byte length of a string (keepalive budgets). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Random uuid v4 (crypto.randomUUID when available). */
export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* insecure context */
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * SimSave.version of a save JSON without parsing all of it: `JSON.stringify(sim.serialize())`
 * starts with `{"version":N`. Falls back to a full parse; null when there is no numeric version.
 */
export function saveVersionOf(json: string): number | null {
  const m = /^\s*\{\s*"version"\s*:\s*(\d+)/.exec(json.slice(0, 64));
  if (m) return Number(m[1]);
  try {
    const v = (JSON.parse(json) as { version?: unknown })?.version;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
