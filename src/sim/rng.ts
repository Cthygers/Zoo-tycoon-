// Serializable PRNG for the simulation. Same algorithm as core's mulberry32,
// but the state is exposed so a saved game continues with the exact same
// random sequence after loading (save → load → identical future).

export class SimRng {
  state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** float in [0, 1) */
  float(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }
  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }
  chance(p: number): boolean {
    return this.float() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.float() * arr.length)];
  }
  /** Approximately normal(0, 1). */
  gauss(): number {
    let u = 0;
    for (let i = 0; i < 4; i++) u += this.float();
    return (u - 2) * 1.732;
  }
}

/** Cheap deterministic integer hash → [0, 1). Used for stable per-entity tie-breaks. */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
