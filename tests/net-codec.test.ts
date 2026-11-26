import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { buildDemoZoo } from '../src/demo';
import {
  base64ToBytes, bytesToBase64, cyrb53, decodeSave, encodeSave, gunzipToString, gzipString, saveVersionOf, sha256Hex, sha256HexSync,
  sha256OfB64Sync, utf8Length, uuid,
} from '../src/net/codec';
import { cleanMeta, metaFromSaveJson, metaFromSim } from '../src/net/meta';
import { SUPPORTED_SAVE_VERSION } from '../src/net/sync';
import { createSimulation } from '../src/sim';

/** Oracle: WebCrypto's SHA-256 (independent of the pure-JS one under test). */
async function webSha(b: Uint8Array): Promise<string> {
  const copy = new Uint8Array(b);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const PINNED_WILDHAVEN = '0daf53a28d5b2c'; // cyrb53 must never change: stored records compare it

describe('net codec', () => {
  it('gzip is deterministic (mtime 0) and round-trips', () => {
    const json = JSON.stringify({ version: 1, a: 'x'.repeat(5000), n: [1, 2, 3] });
    const a = gzipString(json);
    const b = gzipString(json);
    expect(sameBytes(a, b)).toBe(true);
    expect([a[4], a[5], a[6], a[7]]).toEqual([0, 0, 0, 0]); // gzip MTIME field
    expect(gunzipToString(a)).toBe(json);
    expect(a.length).toBeLessThan(json.length / 10);
  });

  it('base64 round-trips binary data longer than one chunk', () => {
    const bytes = new Uint8Array(100_003);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 255;
    const b64 = bytesToBase64(bytes);
    expect(b64.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(sameBytes(base64ToBytes(b64), bytes)).toBe(true);
    expect(bytesToBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(bytesToBase64(new Uint8Array([0xff, 0xfe]))).toBe('//4=');
  });

  it('sha256 (pure JS and async) matches WebCrypto', async () => {
    const cases = [new Uint8Array(0), new TextEncoder().encode('abc'), new Uint8Array(55), new Uint8Array(56), new Uint8Array(64), new Uint8Array(1_000_001).map((_, i) => i * 31)];
    for (const c of cases) {
      const want = await webSha(c);
      expect(sha256HexSync(c)).toBe(want);
      expect(await sha256Hex(c)).toBe(want);
    }
    expect(sha256HexSync(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('cyrb53 is stable and content-sensitive', () => {
    expect(cyrb53('hello')).toBe(cyrb53('hello'));
    expect(cyrb53('hello')).not.toBe(cyrb53('hellp'));
    expect(cyrb53('')).toMatch(/^[0-9a-f]{14}$/);
    expect(cyrb53('wildhaven')).toBe(PINNED_WILDHAVEN);
  });

  it('encodeSave / decodeSave round-trip the real showcase save; sha256 of the gzip bytes is what the server checks', async () => {
    const sim = createSimulation(new EventBus(), 4242);
    sim.newGame(4242);
    buildDemoZoo(sim, 4242);
    const json = JSON.stringify(sim.serialize());
    const gz = encodeSave(json);
    expect(decodeSave(gz)).toBe(json);
    expect(encodeSave(json)).toBe(gz); // same JSON → same bytes → same sha on every device
    expect(sha256OfB64Sync(gz)).toBe(await webSha(base64ToBytes(gz)));
    expect(gz.length).toBeLessThan(json.length / 2);
    expect(saveVersionOf(json)).toBe(SUPPORTED_SAVE_VERSION);
    // the build supports exactly the sim's save version
    expect((sim.serialize() as { version: number }).version).toBe(SUPPORTED_SAVE_VERSION);
    // meta from the sim and from the save JSON agree
    const m1 = metaFromSim(sim, 123);
    const m2 = metaFromSaveJson(json, 123)!;
    expect(m2).toEqual(m1);
    expect(m1.animals).toBeGreaterThan(10);
    expect(m1.species).toBeGreaterThan(3);
    expect(m1.playSeconds).toBe(123);
  });

  it('saveVersionOf reads the leading version or parses', () => {
    expect(saveVersionOf('{"version":7,"x":1}')).toBe(7);
    expect(saveVersionOf('{ "x": 1, "version": 3 }')).toBe(3);
    expect(saveVersionOf('not json')).toBeNull();
    expect(saveVersionOf('{"x":1}')).toBeNull();
  });

  it('metaFromSaveJson estimates play from sim time when none is stored, and cleanMeta clamps to server bounds', () => {
    const m = metaFromSaveJson(JSON.stringify({ version: 1, day: 4, minuteOfDay: 700.6, money: 1234.5, rating: 55.4, totalVisitors: 9, time: 5000, animals: [] }))!;
    expect(m).toEqual({ day: 4, minute: 700, money: 1235, rating: 55, animals: 0, species: 0, visitors: 9, playSeconds: 5000 });
    expect(cleanMeta({ day: 0, minute: 2000, money: -5e12, rating: 300, animals: -1, species: 5000, visitors: NaN, playSeconds: 1e12 })).toEqual({
      day: 1, minute: 1439, money: -1e9, rating: 100, animals: 0, species: 1000, visitors: 0, playSeconds: 1e9,
    });
    expect(metaFromSaveJson('{')).toBeNull();
  });

  it('utf8Length and uuid', () => {
    for (const s of ['', 'abc', 'é', '€', '🦁 zoo', 'a\u0000b']) expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
    const ids = new Set(Array.from({ length: 50 }, () => uuid()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
