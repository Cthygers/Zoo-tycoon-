// The object selection highlight adds colour but must leave the target's
// alpha alone: on high the HDR target's alpha carries the lamp-lit mark to the
// colour grade, so a highlight that raised it kept a selected object's colour
// at night.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/world';
import { Highlighter } from '../src/props/highlight';

describe('object selection highlight', () => {
  it('blends additively without touching the alpha channel', () => {
    const hl = new Highlighter(new World(new EventBus(), 3));
    const model = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    hl.show(model, new THREE.Matrix4(), { x0: 10, z0: 10, x1: 12, z1: 12 });
    const mats: THREE.Material[] = [];
    hl.group.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) mats.push(...(Array.isArray(m) ? m : [m]));
    });
    expect(mats.length).toBe(2); // rim overlay + ground outline
    for (const m of mats) {
      expect(m.blending).toBe(THREE.CustomBlending);
      expect([m.blendSrc, m.blendDst]).toEqual([THREE.SrcAlphaFactor, THREE.OneFactor]);
      expect([m.blendSrcAlpha, m.blendDstAlpha]).toEqual([THREE.ZeroFactor, THREE.OneFactor]);
    }
    hl.dispose();
  });
});
