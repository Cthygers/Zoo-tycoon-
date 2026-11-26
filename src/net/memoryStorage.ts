// An in-memory `Storage` (tests, and a fallback when localStorage is unavailable). An optional
// quota (in UTF-16 code units of keys + values, the way browsers count) makes setItem throw a
// QuotaExceededError DOMException like a full localStorage; `failSet` can make chosen writes fail.

function quotaError(): Error {
  const D = (globalThis as { DOMException?: typeof DOMException }).DOMException;
  if (D) return new D('The quota has been exceeded.', 'QuotaExceededError');
  const e = new Error('The quota has been exceeded.');
  e.name = 'QuotaExceededError';
  return e;
}

export class MemoryStorage implements Storage {
  [name: string]: unknown;
  private readonly map = new Map<string, string>();
  private used = 0;
  /** Max total characters (keys + values); undefined = unlimited. */
  quota: number | undefined;
  /** When it returns true for a key, setItem throws a QuotaExceededError (fault injection). */
  failSet: ((key: string, value: string) => boolean) | null = null;

  constructor(opts: { quota?: number } = {}) {
    this.quota = opts.quota;
  }

  get length(): number {
    return this.map.size;
  }

  /** Characters in use (keys + values). */
  get usedChars(): number {
    return this.used;
  }

  key(index: number): string | null {
    if (index < 0 || index >= this.map.size) return null;
    let i = 0;
    for (const k of this.map.keys()) if (i++ === index) return k;
    return null;
  }

  getItem(key: string): string | null {
    const v = this.map.get(String(key));
    return v === undefined ? null : v;
  }

  setItem(key: string, value: string): void {
    const k = String(key);
    const v = String(value);
    if (this.failSet && this.failSet(k, v)) throw quotaError();
    const old = this.map.get(k);
    const next = this.used - (old === undefined ? 0 : k.length + old.length) + k.length + v.length;
    if (this.quota !== undefined && next > this.quota) throw quotaError();
    this.map.set(k, v);
    this.used = next;
  }

  removeItem(key: string): void {
    const k = String(key);
    const old = this.map.get(k);
    if (old === undefined) return;
    this.map.delete(k);
    this.used -= k.length + old.length;
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }

  /** All keys (tests). */
  keys(): string[] {
    return [...this.map.keys()];
  }
}
