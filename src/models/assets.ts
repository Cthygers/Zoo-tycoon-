// Builds and caches RigAssets (geometry + rig + materials) per species variant.

import * as THREE from 'three';
import { buildGeometry, coatBaker } from './build/geometry';
import { createAnimalMaterial } from './material/animalMaterial';
import { resolveRoles } from './rig/roles';
import { unwrapDriver } from './anim/util';
import type { RigAsset } from './model';
import type { CreatureDesign, DesignContext } from './types';

export function assetFromDesign(key: string, design: CreatureDesign, detail: 0 | 1 | 2): RigAsset {
  const built = buildGeometry(
    { bones: design.bones, prims: design.prims, regions: design.regions, resolution: design.resolution },
    detail,
    coatBaker(design.coat),
    design.eyes ?? [],
  );
  const roles = resolveRoles(built.rig, design.roles);
  const size = built.bounds.getSize(new THREE.Vector3());
  const center = built.bounds.getCenter(new THREE.Vector3());
  // generous sphere: covers lying, rearing, swimming (sinks ≈ its own height)
  const r = 0.5 * Math.hypot(size.x, size.y, size.z) * 1.15 + 0.2;
  const sphere = new THREE.Sphere(new THREE.Vector3(center.x, center.y * 0.6, center.z), r + center.y * 0.4);
  return {
    key,
    geometry: built.geometry,
    rig: built.rig,
    roles,
    design,
    driver: unwrapDriver(design.anim),
    material: createAnimalMaterial({ look: design.look, detail }),
    highlightMaterial: createAnimalMaterial({ look: design.look, detail, highlight: true }),
    sphere,
    height: design.height ?? built.bounds.max.y,
    radius: design.radius ?? 0.5 * Math.max(size.x, size.z),
    triangles: built.triangles,
    buildMs: built.ms,
  };
}

export type DesignFn = (ctx: DesignContext) => CreatureDesign;

export function disposeAsset(a: RigAsset): void {
  a.geometry.dispose();
  a.material.dispose();
  a.highlightMaterial.dispose();
}
