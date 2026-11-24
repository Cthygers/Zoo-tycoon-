// Human surface look: a bald man keeps a horseshoe of close-cropped hair above the ears and
// round the back of his head (no blank mannequin dome), and his face stays bare.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { QualitySettings } from '../src/core/contracts';
import { CreatureFactory } from '../src/models';

const QUALITY: QualitySettings = { level: 'low', pixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 1024, grassDensity: 0, postFX: false, detailDistance: 40, creatureDetail: 0 };

describe('bald heads', () => {
  it('bake a fringe at the back and sides of the scalp, thin enough to show skin, and none on the face or crown', () => {
    const f = new CreatureFactory(QUALITY);
    const man = { skin: 0xf3d5c0, hair: 0x6e6e6e, shirt: 0x335577, pants: 0x222222, shoes: 0x111111, height: 1.77, build: 1, child: false, female: false };
    const h = f.createHuman({ ...man, hairStyle: 2 }, 'guest', 3);
    const geo = (h as unknown as { asset: { geometry: THREE.BufferGeometry } }).asset.geometry;
    const pos = geo.getAttribute('position'), zone = geo.getAttribute('zone');
    let back = 0, face = 0, crown = 0, maxZ = -1;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), z = pos.getZ(i), hair = zone.getZ(i);
      if (hair <= 0) continue;
      maxZ = Math.max(maxZ, hair);
      if (z < -0.03 && y > 1.58 && y < 1.69) back++;
      if (z > 0.06) face++;
      if (y > 1.72) crown++;
    }
    expect(back).toBeGreaterThan(5);
    expect(face).toBe(0);
    expect(crown).toBe(0);
    // under the full-hair edge of the shader (4 mm): a stubble the skin shows through
    expect(maxZ).toBeLessThan(0.004);
    h.dispose();
  });
});
