// Animal surfaces read as fur and skin, not plastic: matte coats without the
// white grazing reflection, a coat-tinted sheen at the silhouette, fur relief
// that fades out by its pixel footprint, pale coats without marble contours,
// thick-skin creases that vary over the body, dry skin that only shines when
// wet, and a lion whose pale inner legs stay on the upper medial side.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { batchedAnimalMaterials } from '../src/models/crowd/materials';
import { createAnimalMaterial } from '../src/models/material/animalMaterial';
import { assetFromDesign } from '../src/models/assets';
import { SPECIES_MODELS } from '../src/models/species';
import { SPECIES_BY_ID } from '../src/data/species';
import type { LookSpec } from '../src/models/types';
import { DRY_SECONDS, nextWetness } from '../src/models/model';
import { withoutFurShell } from '../src/models/build/furShell';
import { LodChain } from '../src/models/lod/lod';

function fragment(material: THREE.Material): string {
  const src = THREE.ShaderLib.standard;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader.fragmentShader;
}

const defineOf = (fs: string, name: string) => Number(new RegExp(`#define ${name} ([0-9.]+)`).exec(fs)?.[1]);

describe('animal surface shading', () => {
  it('turns the white grazing reflection down on fur and dry skin, never on glossy parts', () => {
    const f90 = (skin: LookSpec['skin']) => defineOf(fragment(createAnimalMaterial({ look: { skin }, detail: 1 })), 'CR_F90');
    expect(f90('fur')).toBeLessThanOrEqual(0.3);
    expect(f90('wrinkled')).toBeLessThanOrEqual(0.5);
    expect(f90('smooth')).toBe(1);
    const fs = fragment(createAnimalMaterial({ look: { skin: 'fur' }, detail: 1 }));
    // set after the material struct is filled and before the lights use it
    const at = fs.indexOf('material.specularF90 = mix(CR_F90, 1.0, crGloss);');
    expect(at).toBeGreaterThan(fs.indexOf('#include <lights_physical_fragment>'));
    expect(at).toBeLessThan(fs.indexOf('IncidentLight directLight;'));
  });

  it('adds a coat-tinted sheen on the silhouette of the unperturbed surface, lamp light still last', () => {
    for (const detail of [0, 1] as const) {
      const fs = fragment(batchedAnimalMaterials({ skin: 'fur' }, detail).material);
      const sheen = fs.indexOf('outgoingLight += uSheen');
      expect(sheen).toBeGreaterThan(fs.indexOf('vec3 totalDiffuse'));
      expect(fs).toMatch(/pow\(1\.0 - saturate\(dot\(nonPerturbedNormal, geometryViewDir\)\)/);
      // the selection rim and the lamp mark come after it
      expect(sheen).toBeLessThan(fs.indexOf('crHighlightFurOf(outgoingLight'));
      expect(sheen).toBeLessThan(fs.lastIndexOf('#include <opaque_fragment>'));
      expect(fs).toContain('uLampLight');
    }
  });

  it('gives pale coats a quarter of the albedo swing and short albedo locks (no marble contours)', () => {
    for (const detail of [0, 1] as const) {
      const fs = fragment(createAnimalMaterial({ look: { skin: 'fur' }, detail }));
      expect(fs).toContain('float crPale = mix(1.0, 0.25, smoothstep(0.55, 0.85, sqrt(dot(diffuseColor.rgb');
      expect(fs).toContain('diffuseColor.rgb *= 1.0 + uMottle * (crMo - 0.5) * 2.0 * amp;');
      // clump albedo: locks about 2x longer than wide; the relief keeps long locks (hair streaks) on darker coats only
      expect(fs).toContain('cr_clump(vRestPos / (crGrain * CR_CLUMP), crFlow, 0.55) - 0.5) * amp');
      if (detail > 0) expect(fs).toContain('float sq = mix(0.55, 0.8, (crPale - 0.25) / 0.75);');
    }
  });

  it('varies thick-skin creases over the body and keeps their distant tone consistent', () => {
    const fs = fragment(createAnimalMaterial({ look: { skin: 'wrinkled' }, detail: 1 }));
    // the far mean equals the filtered network: Σ groove width × band weight
    const bands = [...fs.matchAll(/cr_groove\([abc], ([0-9.]+) \* ws, fq \* [0-9.]+\) \* ([0-9.]+)/g)].map((m) => Number(m[1]) * Number(m[2]));
    expect(bands).toHaveLength(3);
    expect(bands.reduce((a, b) => a + b, 0)).toBeCloseTo(defineOf(fs, 'CR_CREASE_MEAN'), 4);
    // strength and width follow the fold weight (legs, trunk) and a slow patch noise, near and far alike
    expect(fs).toContain('float region = smoothstep(0.3, 0.8, max(-vPattern.w, 0.0));');
    expect(fs).toContain('cr_crease(vRestPos / crGrain, crFq, crWs) : CR_CREASE_MEAN * crWs) * crCw;');
    // the relief follows the same weights
    expect(fs).toContain('#define CR_H(q) ((cr_crease(q, max(crFq, e), crWs) - 1.0) * crCw');
  });

  it('fades fur strands and clumps by their own pixel footprint; relief on medium and high only', () => {
    const med = fragment(createAnimalMaterial({ look: { skin: 'fur' }, detail: 1 }));
    expect(med).toContain('#define CR_MICRO 1');
    expect(med).toContain('float wS = 1.0 - smoothstep(0.25, 0.7, crPix / crGrain);');
    expect(med).toContain('float crWC = 1.0 - smoothstep(0.25, 0.7, crPix / (crGrain * CR_CLUMP));');
    // low keeps the clumps' albedo (no relief)
    const low = fragment(createAnimalMaterial({ look: { skin: 'fur' }, detail: 0 }));
    expect(low).toContain('#define CR_MICRO 0');
    expect(low).toContain('if (crWC > 0.001) diffuseColor.rgb *=');
  });

  it('halves the clump relief of pale coats and wanders their locks across the hair flow', () => {
    const fs = fragment(createAnimalMaterial({ look: { skin: 'fur' }, detail: 1 }));
    expect(fs).toContain('float wC = crWC * (1.0 - 0.5 * pale);');
    expect(fs).toContain('vec4 jit = vec4(normalize(cross(crN0, crFlow)), pale * 0.06 / (crGrain * CR_CLUMP));');
    expect(fs).toContain('qc += jit.xyz * ((cr_vnoise(qc * 0.5 + 3.7) - 0.5) * jit.w);');
  });

  it('raises a fur shell of lock tips on long hair, faded by the lock footprint, on every tier', () => {
    const vertex = (look: LookSpec, detail: 0 | 1) => {
      const src = THREE.ShaderLib.standard;
      const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
      createAnimalMaterial({ look, detail }).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
      return shader.vertexShader;
    };
    for (const detail of [0, 1] as const) {
      const fs = fragment(batchedAnimalMaterials({ skin: 'fur' }, detail).material);
      const cut = fs.indexOf('if (crShell && lock < 1.02 - 0.55 * crNear * smoothstep(1.6, 2.1, vPattern.w)) discard;');
      expect(cut).toBeGreaterThan(fs.indexOf('vec3 crFlow ='));
      expect(fs).toContain('float crNear = 1.0 - smoothstep(0.22, 0.4, crPix / lockW);');
      // the shell flag is not a gloss
      expect(fs).toContain('float crGloss = max(vPattern.z, 0.0);');
      // shell vertices stand out along the normal before skinning
      const vs = vertex({ skin: 'fur' }, detail);
      const lift = vs.indexOf('if (pattern.z < -0.5) transformed += normal * (0.02 * (pattern.w - 1.5));');
      expect(lift).toBeGreaterThan(vs.indexOf('#include <begin_vertex>'));
      expect(lift).toBeLessThan(vs.indexOf('#include <skinning_vertex>'));
    }
    // fur only: skins compile the shell out
    const fs = fragment(createAnimalMaterial({ look: { skin: 'wrinkled' }, detail: 1 }));
    const cut = fs.indexOf('if (crShell && lock');
    const block = fs.lastIndexOf('#if ', cut);
    expect(fs.slice(block, block + 16)).toBe('#if CR_SKIN == 0');
    expect(fs.indexOf('#endif', block)).toBeGreaterThan(cut);
  });
});

/** Mean baked gloss (pattern.z) of a species' adult mesh, split by a vertex predicate. */
function glossSplit(species: string, wet: (y: number, ny: number, z: number) => boolean): { wet: number; dry: number } {
  const design = SPECIES_MODELS[species].design({ def: SPECIES_BY_ID[species], sex: 'F', detail: 0 });
  const geo = assetFromDesign(`${species}-gloss`, design, 0).geometry;
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), pat = geo.getAttribute('pattern');
  const s = { wet: [0, 0], dry: [0, 0] };
  for (let i = 0; i < pos.count; i++) {
    const k = wet(pos.getY(i), nor.getY(i), pos.getZ(i)) ? s.wet : s.dry;
    k[0] += pat.getZ(i);
    k[1]++;
  }
  return { wet: s.wet[0] / s.wet[1], dry: s.dry[0] / s.dry[1] };
}

/** Mean baked colour (linear) of a species' adult mesh over the vertices a predicate picks. */
function meanColor(species: string, pick: (y: number, ny: number, z: number) => boolean): THREE.Color {
  const design = SPECIES_MODELS[species].design({ def: SPECIES_BY_ID[species], sex: 'F', detail: 0 });
  const geo = assetFromDesign(`${species}-colour`, design, 0).geometry;
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), col = geo.getAttribute('color');
  const c = new THREE.Color(0, 0, 0);
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (!pick(pos.getY(i), nor.getY(i), pos.getZ(i))) continue;
    c.r += col.getX(i); c.g += col.getY(i); c.b += col.getZ(i);
    n++;
  }
  return c.multiplyScalar(1 / n);
}

describe('hippo skin', () => {
  it('is matte and dry all over until it swims: no baked wet band', () => {
    const look = SPECIES_MODELS.hippo.design({ def: SPECIES_BY_ID.hippo, sex: 'F', detail: 0 }).look;
    expect(look.roughness).toBeGreaterThanOrEqual(0.85);
    const low = glossSplit('hippo', (y, ny, z) => y < 0.75 && ny < -0.3 && Math.abs(z) < 1);
    const top = glossSplit('hippo', (y, ny, z) => y > 1.3 && ny > 0.5 && Math.abs(z) < 1);
    expect(top.wet).toBeLessThan(0.02);
    expect(low.wet).toBeLessThan(0.02);
  });

  it('reads grey-mauve to pinkish-brown, not charcoal, with a pinker underside', () => {
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const flank = meanColor('hippo', (y, ny, z) => y > 0.8 && y < 1.2 && Math.abs(ny) < 0.3 && Math.abs(z) < 0.9);
    const belly = meanColor('hippo', (y, ny, z) => ny < -0.6 && Math.abs(z) < 0.9);
    expect(lum(flank)).toBeGreaterThan(0.09);
    expect(flank.r / flank.b).toBeGreaterThan(1.2);
    expect(belly.r / belly.b).toBeGreaterThan(flank.r / flank.b);
  });

  it('has grey-brown flanks (green above blue, not mauve) and creases on the barrel', () => {
    const flank = meanColor('hippo', (y, ny, z) => y > 0.8 && y < 1.2 && Math.abs(ny) < 0.3 && Math.abs(z) < 0.9);
    expect(flank.g).toBeGreaterThan(flank.b * 1.05);
    const design = SPECIES_MODELS.hippo.design({ def: SPECIES_BY_ID.hippo, sex: 'F', detail: 0 });
    const pat = assetFromDesign('hippo-fold', design, 0).geometry.getAttribute('pattern');
    // fold weight is baked as −pattern.w: at least 0.35 everywhere on the skin (a faint broken network on the barrel)
    let minFold = 1;
    for (let i = 0; i < pat.count; i++) if (pat.getZ(i) < 0.4) minFold = Math.min(minFold, -pat.getW(i));
    expect(minFold).toBeGreaterThan(0.349);
  });
});

describe('wet skin after a swim', () => {
  it('soaks while swimming and dries over DRY_SECONDS', () => {
    expect(nextWetness(0, true, 0.016)).toBe(1);
    expect(nextWetness(1, false, DRY_SECONDS / 2)).toBeCloseTo(0.5);
    expect(nextWetness(0.1, false, DRY_SECONDS)).toBe(0);
  });

  it('reaches the shader of thick skins and swimming fur animals, as a gloss that drives roughness and the Fresnel', () => {
    const vs = (skin: LookSpec['skin']) => {
      const src = THREE.ShaderLib.standard;
      const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
      batchedAnimalMaterials({ skin }, 1).material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
      return shader;
    };
    const wrinkled = vs('wrinkled');
    expect(wrinkled.vertexShader).toContain('vCrWet = crTexel(crBase).z;');
    expect(wrinkled.fragmentShader).toContain('crGloss = max(crGloss, 0.5 * wet);');
    expect(wrinkled.fragmentShader).toContain('roughnessFactor = mix(roughnessFactor, 0.16, crGloss);');
    expect(vs('fur').fragmentShader).toContain('#define CR_WETS 0');
    // fur that swims (tigers, bears): darker and slicker, less glossy than skin, own program
    const src = THREE.ShaderLib.standard;
    const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
    const wetFur = batchedAnimalMaterials({ skin: 'fur', wets: true }, 1).material;
    wetFur.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('#define CR_WETS 1');
    expect(shader.fragmentShader).toContain('crGloss = max(crGloss, 0.3 * wet);');
    expect(wetFur.customProgramCacheKey()).not.toBe(batchedAnimalMaterials({ skin: 'fur' }, 1).material.customProgramCacheKey());
    for (const id of ['tiger', 'polarbear', 'grizzly']) expect(SPECIES_MODELS[id].design({ def: SPECIES_BY_ID[id], sex: 'F', detail: 0 }).look.wets).toBe(true);
  });
});

describe('lion legs', () => {
  /** Mean baked luminance (linear albedo) per region. */
  function regions(sex: 'M' | 'F') {
    const design = SPECIES_MODELS.lion.design({ def: SPECIES_BY_ID.lion, sex, detail: 0 });
    const geo = assetFromDesign(`lion-legs-${sex}`, design, 0).geometry;
    const pos = geo.getAttribute('position'), col = geo.getAttribute('color'), nor = geo.getAttribute('normal');
    const acc: Record<string, [number, number]> = {};
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), nx = nor.getX(i);
      const lum = 0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i);
      const add = (k: string) => { (acc[k] ??= [0, 0])[0] += lum; acc[k][1]++; };
      const side = Math.sign(x) * nx;
      if (Math.abs(x) > 0.14 && y > 0.75 && y < 0.88 && z > -0.2 && z < 0.1 && Math.abs(nx) > 0.6) add('flank');
      if (y > 0.35 && y < 0.6 && side < -0.4) add('innerUpper');
      if (y > 0.1 && y < 0.28 && side < -0.4) add('innerLower');
    }
    const r: Record<string, number> = {};
    for (const [k, [sum, n]] of Object.entries(acc)) r[k] = sum / n;
    return r;
  }

  it('keeps the pale inner leg to the upper medial side, at most ~1.25x the flank', () => {
    for (const sex of ['M', 'F'] as const) {
      const r = regions(sex);
      expect(r.innerUpper).toBeLessThanOrEqual(r.flank * 1.25);
      // no cream stockings: the medial lower leg stays about as tawny as the flank
      expect(r.innerLower).toBeLessThan(r.flank * 1.1);
    }
  });
});

describe('fur shell', () => {
  const asset = (species: string, sex: 'M' | 'F') =>
    assetFromDesign(`${species}-shell`, SPECIES_MODELS[species].design({ def: SPECIES_BY_ID[species], sex, detail: 0 }), 0);

  it('covers long hair only (a lion mane, not a lioness), appended after the base mesh', () => {
    expect(asset('lion', 'F').geometry.userData.furShell).toBeUndefined();
    const geo = asset('lion', 'M').geometry;
    const range = geo.userData.furShell as { vertices: number; indices: number };
    const pat = geo.getAttribute('pattern');
    const idx = geo.getIndex()!;
    expect(idx.count).toBeGreaterThan(range.indices);
    for (let i = 0; i < pat.count; i++) expect(pat.getZ(i) < -0.5).toBe(i >= range.vertices);
    for (let i = range.indices; i < idx.count; i++) expect(pat.getW(idx.getX(i))).toBeGreaterThan(1.5);
    // a close-up detail: well under a quarter of the full mesh
    expect((idx.count - range.indices) / idx.count).toBeLessThan(0.25);
  });

  it('never reaches the simplified LODs', () => {
    const a = asset('lion', 'M');
    const base = withoutFurShell(a.geometry);
    expect(base.getAttribute('position').count).toBe(a.geometry.userData.furShell.vertices);
    const lod = new LodChain(a.geometry, a.sphere, a.triangles).build(1);
    const pat = lod.getAttribute('pattern');
    for (let i = 0; i < pat.count; i++) expect(pat.getZ(i)).toBeGreaterThanOrEqual(0);
  });
});
