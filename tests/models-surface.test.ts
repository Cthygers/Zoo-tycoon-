// Animal surfaces read as fur and skin, not plastic: matte coats without the
// white grazing reflection, a coat-tinted sheen at the silhouette, fur relief
// that fades out by its pixel footprint, dry skin that only shines where wet,
// and a lion whose pale inner legs stay on the upper medial side.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { batchedAnimalMaterials } from '../src/models/crowd/materials';
import { createAnimalMaterial } from '../src/models/material/animalMaterial';
import { assetFromDesign } from '../src/models/assets';
import { SPECIES_MODELS } from '../src/models/species';
import { SPECIES_BY_ID } from '../src/data/species';
import type { LookSpec } from '../src/models/types';
import { DRY_SECONDS, nextWetness } from '../src/models/model';

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

describe('hippo skin', () => {
  it('is matte and dry above the wet band, glossy only in it', () => {
    const look = SPECIES_MODELS.hippo.design({ def: SPECIES_BY_ID.hippo, sex: 'F', detail: 0 }).look;
    expect(look.roughness).toBeGreaterThanOrEqual(0.85);
    const g = glossSplit('hippo', (y, ny) => y < 0.75 && ny < -0.3);
    const top = glossSplit('hippo', (y, ny, z) => y > 1.3 && ny > 0.5 && Math.abs(z) < 1);
    expect(top.wet).toBeLessThan(0.02);
    expect(g.wet).toBeGreaterThan(0.15);
  });
});

describe('wet skin after a swim', () => {
  it('soaks while swimming and dries over DRY_SECONDS', () => {
    expect(nextWetness(0, true, 0.016)).toBe(1);
    expect(nextWetness(1, false, DRY_SECONDS / 2)).toBeCloseTo(0.5);
    expect(nextWetness(0.1, false, DRY_SECONDS)).toBe(0);
  });

  it('reaches the shader of thick skins only, as a gloss that drives roughness and the Fresnel', () => {
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
