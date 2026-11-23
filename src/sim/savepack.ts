// Compact save encoding. Entity lists are stored column-keyed ({ k: keys,
// r: rows }) instead of repeating every property name per entity, nested plain
// objects (needs, appearance) are flattened to dotted keys, and the world's tile
// grids are run-length encoded. Loading accepts both these and the plain arrays
// of older saves.

/** Rows of homogeneous objects sharing one key list. */
export interface PackedRows {
  k: string[];
  r: unknown[][];
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function packRows(list: readonly object[]): PackedRows {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (k: string) => {
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };
  for (const o of list as Record<string, unknown>[]) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (isPlain(v)) for (const k2 of Object.keys(v)) add(`${k}.${k2}`);
      else add(k);
    }
  }
  const r: unknown[][] = [];
  for (const o of list as Record<string, unknown>[]) {
    const row: unknown[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const dot = key.indexOf('.');
      const v = dot < 0 ? o[key] : (o[key.slice(0, dot)] as Record<string, unknown> | undefined)?.[key.slice(dot + 1)];
      row[i] = v === undefined ? null : v;
    }
    r.push(row);
  }
  return { k: keys, r };
}

/** Inverse of packRows; plain arrays (older saves) pass through. */
export function unpackRows<T>(p: unknown): T[] {
  if (Array.isArray(p)) return p as T[];
  if (!isPlain(p) || !Array.isArray(p.k) || !Array.isArray(p.r)) return [];
  const keys = p.k as string[];
  const out: T[] = [];
  for (const row of p.r as unknown[][]) {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const v = row[i];
      const dot = key.indexOf('.');
      if (dot < 0) o[key] = v;
      else {
        const top = key.slice(0, dot);
        let n = o[top] as Record<string, unknown> | undefined;
        if (!n) o[top] = n = {};
        n[key.slice(dot + 1)] = v;
      }
    }
    out.push(o as T);
  }
  return out;
}

/** Run-length encode an integer grid as [value, count, value, count, ...]. */
export function rleEncode(a: ArrayLike<number>): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i];
    let n = 1;
    while (i + n < a.length && a[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return out;
}

export function rleDecode(rle: readonly number[], length: number): number[] {
  const out = new Array<number>(length).fill(0);
  let p = 0;
  for (let k = 0; k + 1 < rle.length && p < length; k += 2) {
    const v = rle[k] | 0,
      n = rle[k + 1] | 0;
    for (let j = 0; j < n && p < length; j++) out[p++] = v;
  }
  return out;
}
