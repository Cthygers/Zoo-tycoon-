// A composed signed-distance field: ordered list of compiled primitives
// folded with smooth union / smooth subtraction.

import { CompiledPrim, smax, smin } from './prims';

export const FAR = 1e3;

export class SdfField {
  readonly prims: CompiledPrim[];
  /** Index list containing every primitive (for unculled evaluation). */
  readonly all: Int32Array;

  constructor(prims: CompiledPrim[]) {
    this.prims = prims;
    this.all = new Int32Array(prims.length);
    for (let i = 0; i < prims.length; i++) this.all[i] = i;
  }

  /** Evaluate using only primitives listed in `list[0..n)` (ascending order). */
  evalList(x: number, y: number, z: number, list: Int32Array, n: number): number {
    let f = FAR;
    const prims = this.prims;
    for (let i = 0; i < n; i++) {
      const p = prims[list[i]];
      const d = p.dist(x, y, z);
      if (p.sub) f = smax(f, -d, p.k);
      else f = smin(f, d, p.k);
    }
    return f;
  }

  evalAll(x: number, y: number, z: number): number {
    return this.evalList(x, y, z, this.all, this.all.length);
  }

  /** Indices of primitives whose influence box overlaps the given box. */
  cull(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Int32Array {
    const tmp: number[] = [];
    const prims = this.prims;
    let anyAdd = false;
    for (let i = 0; i < prims.length; i++) {
      if (prims[i].overlaps(x0, y0, z0, x1, y1, z1)) {
        tmp.push(i);
        if (!prims[i].sub) anyAdd = true;
      }
    }
    // A block with only subtractive primitives is empty space.
    return anyAdd ? Int32Array.from(tmp) : new Int32Array(0);
  }
}
