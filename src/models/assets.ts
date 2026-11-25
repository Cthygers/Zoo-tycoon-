// Builds and caches RigAssets (geometry + rig + materials) per species variant.

import * as THREE from 'three';
import { buildGeometry, coatBaker } from './build/geometry';
import { addFurShell } from './build/furShell';
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
  // long hair on fur coats gets a raised shell of lock tips (LOD 0 only, see furShell.ts)
  const geometry = design.look.skin === 'fur' ? addFurShell(built.geometry) : built.geometry;
  const furShell = geometry !== built.geometry;
  const roles = resolveRoles(built.rig, design.roles);
  const size = built.bounds.getSize(new THREE.Vector3());
  const center = built.bounds.getCenter(new THREE.Vector3());
  // generous sphere: covers lying, rearing, swimming (sinks ≈ its own height)
  const r = 0.5 * Math.hypot(size.x, size.y, size.z) * 1.15 + 0.2;
  const sphere = new THREE.Sphere(new THREE.Vector3(center.x, center.y * 0.6, center.z), r + center.y * 0.4);
  return {
    key,
    geometry,
    rig: built.rig,
    roles,
    design,
    driver: unwrapDriver(design.anim),
    material: createAnimalMaterial({ look: design.look, detail, furShell }),
    highlightMaterial: createAnimalMaterial({ look: design.look, detail, highlight: true, furShell }),
    furShell,
    sphere,
    body: new THREE.Box3().setFromBufferAttribute(built.geometry.getAttribute('position') as THREE.BufferAttribute),
    height: design.height ?? built.bounds.max.y,
    radius: design.radius ?? 0.5 * Math.max(size.x, size.z),
    triangles: geometry.getIndex()!.count / 3,
    buildMs: built.ms,
    detail,
  };
}

export type DesignFn = (ctx: DesignContext) => CreatureDesign;

export function disposeAsset(a: RigAsset): void {
  a.lod?.dispose();
  a.geometry.dispose();
  a.material.dispose();
  a.highlightMaterial.dispose();
}
