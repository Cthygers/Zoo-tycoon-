// Selection highlight of creatures: a rim relative to the light on the model,
// never an emissive term (absolute radiance washed a selected lion out to
// white under the day exposure).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { batchedAnimalMaterials } from '../src/models/crowd/materials';
import { createAnimalMaterial } from '../src/models/material/animalMaterial';
import { createHumanBatchMaterial, createHumanMaterial, type HumanMarks } from '../src/models/humans/material';

const MARKS: HumanMarks = { collarY: 1.4, waistY: 1, shoeTop: 0.08, eyeL: [0.03, 1.6, 0.09], mouth: [0, 1.55, 0.1] };

function fragment(material: THREE.Material): string {
  const src = THREE.ShaderLib.standard;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader.fragmentShader;
}

/** The rim is applied to the lit colour after lighting and before the colour is written. */
function expectRim(fs: string, amount: string): void {
  expect(fs).toContain('vec3 crHighlight(');
  const at = fs.indexOf(`outgoingLight = crHighlightOf(outgoingLight, ${amount});`);
  expect(at).toBeGreaterThan(fs.indexOf('#include <lights_fragment_end>'));
  expect(at).toBeLessThan(fs.lastIndexOf('#include <opaque_fragment>'));
  expect(fs).not.toMatch(/totalEmissiveRadiance \+=/);
}

describe('creature selection highlight', () => {
  it('batched animals: rim from the look texel, before the underwater shading', () => {
    const fs = fragment(batchedAnimalMaterials({ skin: 'fur' }, 1).material);
    expectRim(fs, 'vCrLook0.x');
    // submerged parts do not glow
    expect(fs.indexOf('crHighlightOf(outgoingLight')).toBeLessThan(fs.indexOf('float crWd ='));
  });

  it('batched people: rim from the look texel', () => {
    expectRim(fragment(createHumanBatchMaterial(1, [MARKS]).material), 'vHm5.w');
  });

  it('standalone highlight materials use the rim, not the emissive colour', () => {
    const animal = createAnimalMaterial({ look: { skin: 'fur' }, detail: 1, highlight: true });
    expect(animal.emissive.getHex()).toBe(0);
    expectRim(fragment(animal), 'uHighlight');
    expect(fragment(createAnimalMaterial({ look: { skin: 'fur' }, detail: 1 }))).toContain('#define CR_HIGHLIGHT 0');
    const person = createHumanMaterial(
      { skin: 0xc08060, hair: 0x302010, shirt: 0x4060a0, pants: 0x303030, shoes: 0x202020, hat: 0x000000 },
      { sleeve: 0, pants: 0, coat: 0, inflate: 0 },
      MARKS,
      1,
    );
    expect(person.emissive.getHex()).toBe(0);
    expectRim(fragment(person), 'uHighlight');
  });
});
