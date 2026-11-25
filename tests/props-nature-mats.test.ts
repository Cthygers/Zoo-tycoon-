import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { barkTextures } from '../src/props/nature/barks';
import { FoliageMaterial, LEAF_PARAMS, RockMaterial, setNatureNight, setNatureNightGround, withQuality } from '../src/props/nature/mats';
import { buildIceRocks } from '../src/props/nature/rocks';

/** Run a material's onBeforeCompile on a copy of the physical shader source. */
function compile(m: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('nature materials honour envMapIntensity under scene.environment', () => {
  it('scales the environment light of foliage (and its clones) by envMapIntensity', () => {
    const m = new FoliageMaterial({ translucency: 0.4 });
    const sh = compile(m);
    expect(sh.fragmentShader).toContain('RE_Direct_Leaf');
    expect((sh.uniforms.envMapScale as THREE.IUniform<number>).value).toBeCloseTo(0.6);
    const c = m.clone();
    c.envMapIntensity = 0.5;
    expect((compile(c).uniforms.envMapScale as THREE.IUniform<number>).value).toBeCloseTo(0.5);
    // one program for all foliage materials
    expect(c.customProgramCacheKey()).toBe(m.customProgramCacheKey());
  });

  it('keeps the rock shader patches', () => {
    const m = new RockMaterial({ triTex: new THREE.Texture(), tile: 1, bump: 0.01, envMapIntensity: 1.1 });
    const sh = compile(m);
    expect(sh.fragmentShader).toContain('rockPerturb');
    expect((sh.uniforms.envMapScale as THREE.IUniform<number>).value).toBeCloseTo(1.1);
    expect(sh.uniforms.uTriTex).toBeDefined();
  });
});

describe('foliage at night', () => {
  it('drops light through the leaves and the silvery sheen as night falls (one shared setting)', () => {
    const a = new FoliageMaterial();
    const b = new FoliageMaterial();
    const sh = compile(a);
    expect(sh.fragmentShader).toMatch(/uLeafTrans \* \( 1\.0 - uLeafNight \)/);
    expect(sh.fragmentShader).toContain('reflectedLight.indirectSpecular *= lfUnder * ( 1.0 - 0.8 * uLeafNight );');
    // the crown's underside sees the crown and the ground, not the sky: less ambient there
    expect(sh.fragmentShader).toContain('float lfUnder = mix( 0.75, 1.0, smoothstep( -0.4, 0.6, lfUp ) );');
    setNatureNight(0.75);
    expect((sh.uniforms.uLeafNight as THREE.IUniform<number>).value).toBe(0.75);
    expect(b.leafNight.value).toBe(0.75);
    setNatureNight(0);
  });
});

describe('ground plants under the moon', () => {
  it("take the moonlit ground's look (neutral light, lift, grade mark); tree crowns do not", () => {
    const grass = new FoliageMaterial();
    grass.groundPlant.value = 1;
    const sh = compile(grass);
    expect(sh.fragmentShader).toContain('float ngK = uNightLift * (vLfGround);');
    expect(sh.fragmentShader).toContain('whLampLit = lfNightMark;');
    // tree-sheet cards: bushes by their low crown centre (crown data from the near-camera fade)
    expect(sh.vertexShader).toContain('vLfGround = max( uLfGround, 1.0 - smoothstep( 180.0, 320.0, aCrown.y ) );');
    expect((sh.uniforms.uLfGround as THREE.IUniform<number>).value).toBe(1);
    const crown = new FoliageMaterial();
    expect((compile(crown).uniforms.uLfGround as THREE.IUniform<number>).value).toBe(0);
    expect(grass.clone().groundPlant.value).toBe(1);
    setNatureNightGround(0.8);
    expect((sh.uniforms.uNightLift as THREE.IUniform<number>).value).toBe(0.8);
    setNatureNightGround(0);
    expect(LEAF_PARAMS.ground.groundPlant).toBe(true);
    expect('groundPlant' in LEAF_PARAMS.trees).toBe(false);
  });
});

describe('ice rockery', () => {
  it('is near-white glacial ice with crisp fracture planes, blue only where light runs deep', () => {
    const g = buildIceRocks(0);
    const mesh = g.children[0] as THREE.Mesh;
    const col = mesh.geometry.getAttribute('color');
    const nrm = mesh.geometry.getAttribute('normal');
    let lum = 0;
    let rb = 0;
    let flatShared = 0;
    for (let i = 0; i < col.count; i++) {
      lum += 0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i);
      rb += col.getX(i) / Math.max(col.getZ(i), 1e-3);
    }
    // creased normals: the three corners of most faces share one face normal
    for (let t = 0; t + 2 < nrm.count; t += 3) {
      const d = nrm.getX(t) * nrm.getX(t + 1) + nrm.getY(t) * nrm.getY(t + 1) + nrm.getZ(t) * nrm.getZ(t + 1);
      if (d > 0.999) flatShared++;
    }
    // the old saturated baby-blue base had red at about half of blue; smooth normals shared no corner
    expect(lum / col.count).toBeGreaterThan(0.5);
    expect(rb / col.count).toBeGreaterThan(0.6);
    expect(flatShared / (nrm.count / 3)).toBeGreaterThan(0.15);
  });
});

describe('silver birch bark', () => {
  /** Mean linear luminance and the fraction of near-black texels of an sRGB8 albedo map. */
  function albedoStats(t: THREE.DataTexture): { mean: number; dark: number } {
    const d = t.image.data as Uint8Array;
    const toLin = (c: number): number => (c <= 10 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
    const n = d.length / 4;
    let sum = 0;
    let dark = 0;
    for (let i = 0; i < n; i++) {
      const l = 0.2126 * toLin(d[i * 4]) + 0.7152 * toLin(d[i * 4 + 1]) + 0.0722 * toLin(d[i * 4 + 2]);
      sum += l;
      if (l < 0.1) dark++;
    }
    return { mean: sum / n, dark: dark / n };
  }

  it('is white bark with a sprinkle of dark lenticels at both texture sizes', () => {
    for (const q of ['medium', 'low'] as const) {
      const s = withQuality(q, () => albedoStats(barkTextures('birch').map));
      expect(s.mean).toBeGreaterThan(0.45);
      expect(s.dark).toBeGreaterThan(0.005);
      expect(s.dark).toBeLessThan(0.12);
    }
  });
});
