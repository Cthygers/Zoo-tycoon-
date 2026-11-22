import * as THREE from 'three';
import type { RigDef } from './rig';
import type { LegId, ResolvedRoles, RigRoles } from '../types';

export function resolveRoles(def: RigDef, r: RigRoles): ResolvedRoles {
  const f = (n: string | undefined) => def.find(n);
  const list = (a: string[] | undefined) => (a ?? []).map((n) => def.bone(n));
  const legs: ResolvedRoles['legs'] = {};
  for (const id of ['FL', 'FR', 'HL', 'HR'] as LegId[]) {
    const l = r.legs?.[id];
    if (!l) continue;
    legs[id] = {
      scap: f(l.scap),
      upper: def.bone(l.upper),
      lower: def.bone(l.lower),
      foot: def.bone(l.foot),
      toe: f(l.toe),
      contact: new THREE.Vector3(l.contact[0], l.contact[1], l.contact[2]),
    };
  }
  const arms: ResolvedRoles['arms'] = {};
  for (const s of ['L', 'R'] as const) {
    const a = r.arms?.[s];
    if (!a) continue;
    arms[s] = { clavicle: f(a.clavicle), upper: def.bone(a.upper), lower: def.bone(a.lower), hand: def.bone(a.hand) };
  }
  const chains: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(r.chains ?? {})) chains[k] = list(v);
  return {
    root: def.bone(r.root),
    spine: list(r.spine),
    chest: f(r.chest),
    neck: list(r.neck),
    head: f(r.head),
    jaw: f(r.jaw),
    tail: list(r.tail),
    ears: list(r.ears),
    legs,
    arms,
    chains,
    muzzle: r.muzzle ? new THREE.Vector3(r.muzzle[0], r.muzzle[1], r.muzzle[2]) : null,
  };
}
