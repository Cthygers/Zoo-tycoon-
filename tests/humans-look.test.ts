// Human surface look: a bald man keeps a horseshoe of close-cropped hair above the ears and
// round the back of his head (no blank mannequin dome), and his face stays bare; guests wear
// varied prints, dark skin keeps a moonlit toe, hair is tousled.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { QualitySettings } from '../src/core/contracts';
import { CreatureFactory } from '../src/models';
import {
  HUMAN_BODIES,
  HUMAN_LOOK_TEXELS,
  HUMAN_PRINTS,
  createHumanBatchMaterial,
  createHumanMaterial,
  humanStyle,
  writeHumanLook,
  type HumanMarks,
} from '../src/models/humans/material';

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

function compiled(material: THREE.Material): { vs: string; fs: string } {
  const src = THREE.ShaderLib.standard;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return { vs: shader.vertexShader, fs: shader.fragmentShader };
}

const MARKS: HumanMarks = { collarY: 1.43, waistY: 0.985, shoeTop: 0.1, eyeL: [0.032, 1.655, 0.083], mouth: [0, 1.585, 0.084] };

describe('guest outfits and close-range detail', () => {
  it('packs the style bits next to the body id in one exact float texel', () => {
    const style = humanStyle({ print: HUMAN_PRINTS.graphic, lightSole: true, stubble: false, neckline: 'deepV' });
    expect(style).toBe(4 + 8 + 32 + 64);
    expect(humanStyle({ print: HUMAN_PRINTS.plain, lightSole: false, stubble: true, neckline: 'v' })).toBe(16 + 32);
    const dst = new Float32Array(HUMAN_LOOK_TEXELS * 4);
    const colors = { skin: 0x5c3a25, hair: 0x16110e, shirt: 0xe6e6e2, pants: 0x2c3e5c, shoes: 0xe8e6e1, hat: 0x2c3e5c };
    writeHumanLook(dst, 0, colors, { sleeve: 0.13, pants: 1.1, coat: -1, inflate: 0, style }, 3, 0);
    const packed = Math.floor(dst[4 * 4 + 3] + 0.5);
    expect(packed % HUMAN_BODIES).toBe(3);
    expect(Math.floor(packed / HUMAN_BODIES)).toBe(style);
  });

  it('dresses guests in varied prints while staff keep plain uniforms', () => {
    const f = new CreatureFactory(QUALITY);
    const app = { skin: 0xc89070, hair: 0x33241a, shirt: 0x335577, pants: 0x2c3e5c, shoes: 0x222222, height: 1.75, build: 1, child: false, female: false, hairStyle: 0 as const };
    const styleOf = (m: unknown) => (m as { cut: { style: number } }).cut.style;
    const prints = new Set<number>();
    let stubble = 0;
    for (let seed = 0; seed < 60; seed++) {
      const g = f.createHuman(app, 'guest', seed);
      prints.add(styleOf(g) & 7);
      if (styleOf(g) & 16) stubble++;
      g.dispose();
    }
    expect(prints.size).toBe(6);
    expect(stubble).toBeGreaterThan(10);
    expect(stubble).toBeLessThan(40);
    // V-necks: a shallow cut on men, a deeper one on women, none on children
    const necks = { man: new Set<number>(), woman: new Set<number>(), child: new Set<number>() };
    for (let seed = 0; seed < 80; seed++) {
      for (const [k, who] of [['man', app], ['woman', { ...app, female: true }], ['child', { ...app, child: true }]] as const) {
        const g = f.createHuman(who, 'guest', seed);
        necks[k].add(styleOf(g) & 96);
        g.dispose();
      }
    }
    expect([...necks.man].sort()).toEqual([0, 32]);
    expect([...necks.woman].sort()).toEqual([0, 96]);
    expect([...necks.child]).toEqual([0]);
    for (const role of ['keeper', 'groundskeeper', 'vet'] as const) {
      const s = f.createHuman(app, role, 7);
      expect(styleOf(s)).toBe(0);
      s.dispose();
    }
    // children and women grow no stubble
    for (let seed = 0; seed < 30; seed++) {
      const c = f.createHuman({ ...app, child: true }, 'guest', seed);
      const w = f.createHuman({ ...app, female: true }, 'guest', seed);
      expect(styleOf(c) & 16).toBe(0);
      expect(styleOf(w) & 16).toBe(0);
      c.dispose();
      w.dispose();
    }
  });

  it('shares one outfit shader between the crowd and standalone people, with the dark-skin moonlit toe and tousled hair', () => {
    const batched = compiled(createHumanBatchMaterial(1, [MARKS, MARKS, MARKS, MARKS]).material);
    const person = compiled(
      createHumanMaterial({ skin: 0x5c3a25, hair: 0x16110e, shirt: 0xe6e6e2, pants: 0x2c3e5c, shoes: 0x222222, hat: 0 }, { sleeve: 0.13, pants: 1.1, coat: -1, inflate: 0, style: 9 }, MARKS, 1),
    );
    for (const { vs, fs } of [batched, person]) {
      expect(fs).toContain('#define LF_SKIN (hmSkin * hmSkinDark)');
      expect(fs).toContain('float hm_stripe(float x, float w)');
      expect(fs).toContain('if (hmPrint == 1.0)');
      // the toe reads the mask after the colour stage sets it
      expect(fs.indexOf('float hmSkinDark =')).toBeLessThan(fs.indexOf('(LF_SKIN)'));
      expect(vs).toContain('if (zone.z > 0.0 && zone.w <= 0.0) transformed += normal *');
      expect(vs.indexOf('float cr_vnoise(')).toBeLessThan(vs.indexOf('if (zone.z > 0.0'));
      // no fragment-only derivatives in the vertex stage
      expect(vs).not.toMatch(/dFd[xy]|fwidth/);
    }
    expect(batched.fs).toContain('int hmBody = clamp(int(mod(hmPacked, 4.0)), 0, 3);');
    expect(batched.fs).toContain('float hmStyle = floor(hmPacked / 4.0);');
    expect(person.fs).toContain('float hmStyle = uStyle;');
  });

  it('takes the figures’ moonlit night look: neutral moonlight before the lamp light, the lamp field last', () => {
    const batched = compiled(createHumanBatchMaterial(0, [MARKS, MARKS, MARKS, MARKS]).material);
    const person = compiled(
      createHumanMaterial({ skin: 0x45291a, hair: 0x16110e, shirt: 0xe6e6e2, pants: 0x2c3e5c, shoes: 0x222222, hat: 0 }, { sleeve: 0.13, pants: 1.1, coat: -1, inflate: 0 }, MARKS, 0),
    );
    for (const { fs } of [batched, person]) {
      const night = fs.indexOf('float fnK = uFigureNight');
      const lamp = fs.indexOf('uLampLight * (lfPool');
      const crease = fs.indexOf('reflectedLight.indirectDiffuse *= 1.0 - 0.7 * vOccl');
      expect(night).toBeGreaterThan(0);
      // the lamps' warm light is added after the moonlight turns neutral; the creases dim both
      expect(lamp).toBeGreaterThan(night);
      expect(crease).toBeGreaterThan(lamp);
      // the darkest skins' albedo lifts with the night level (0 by day)
      expect(fs).toMatch(/\(1\.0 \+ 0\.\d+ \* uFigureNight \* hmSkin \* hmSkinDark\)/);
      expect(fs.indexOf('uniform float uFigureNight')).toBeLessThan(fs.indexOf('* uFigureNight * hmSkin'));
      // the night grade mark never overwrites the lamp's, and the dark-skin toe still runs last
      expect(fs).toContain('whLampLit = max( whLampLit, figNightMark )');
      expect(fs.lastIndexOf('(LF_SKIN)')).toBeGreaterThan(night);
    }
  });

  it('settles box-filtered stripes to their mean as they shrink toward the pixel size', () => {
    // the shader's hm_stripe in TS
    const stripe = (x: number, w: number) => {
      const I = (a: number) => Math.floor(a) * 0.5 + Math.max(a - Math.floor(a) - 0.5, 0);
      return (I(x + 0.5 * w) - I(x - 0.5 * w)) / w;
    };
    expect(stripe(0.75, 0.01)).toBeCloseTo(1, 5);
    expect(stripe(0.25, 0.01)).toBeCloseTo(0, 5);
    for (let x = 0; x < 2; x += 0.07) expect(stripe(x, 1)).toBeCloseTo(0.5, 5);
  });

  it('draws the finger grooves as box-filtered lines that settle to their mean, in a hand frame from each body’s wrist', () => {
    // the shader's hm_lines in TS: lines of half-width hw centred on the integers
    const lines = (x: number, hw: number, w: number) => {
      const I = (a: number) => Math.floor(a) * 2 * hw + Math.min(a - Math.floor(a), 2 * hw);
      return (I(x + hw + 0.5 * w) - I(x + hw - 0.5 * w)) / w;
    };
    expect(lines(0, 0.14, 0.01)).toBeCloseTo(1, 5);
    expect(lines(1.05, 0.14, 0.01)).toBeCloseTo(1, 5);
    expect(lines(0.5, 0.14, 0.01)).toBeCloseTo(0, 5);
    for (let x = 0; x < 2; x += 0.07) expect(lines(x, 0.14, 1)).toBeCloseTo(0.28, 5);
    const wrists: HumanMarks[] = [0.3, 0.31, 0.32, 0.33].map((x) => ({ ...MARKS, wristL: [x, 0.9, -0.01] }));
    const mat = createHumanBatchMaterial(0, wrists).material;
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms), defines: {} };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect((shader.uniforms as Record<string, { value: THREE.Vector3[] }>).uHmWrist.value.map((v) => v.x)).toEqual([0.3, 0.31, 0.32, 0.33]);
    expect(shader.fragmentShader).toContain('- uHmWrist[hmBody];');
  });

  it('shades the cloth folds as a bump of the normal, set by the colour stage and faded with the pixel footprint', () => {
    for (const { fs } of [compiled(createHumanBatchMaterial(1, [MARKS, MARKS, MARKS, MARKS]).material), compiled(createHumanMaterial({ skin: 0xc08060, hair: 0x302010, shirt: 0x4060a0, pants: 0x303030, shoes: 0x202020, hat: 0 }, { sleeve: 0.56, pants: 1.1, coat: -1, inflate: 0 }, MARKS, 0))]) {
      const set = fs.indexOf('hmFold = 0.0035 * hmBs * folds;');
      const bump = fs.indexOf('normal = hm_bump(normal, hmFold, faceDirection);');
      expect(set).toBeGreaterThan(0);
      expect(bump).toBeGreaterThan(set);
      expect(bump).toBeGreaterThan(fs.indexOf('#include <normal_fragment_maps>'));
      expect(fs).toContain('* (1.0 - smoothstep(0.01, 0.018, hmPix));');
    }
  });
});
