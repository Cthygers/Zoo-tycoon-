// Every creature program's vertex stage must be free of derivative functions
// (dFdx / dFdy / fwidth exist only in fragment shaders): a shared GLSL chunk
// that carries one into a vertex shader fails to compile on load (round 11
// saw it once from the shared noise chunk).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { batchedAnimalMaterials, crowdDepthMaterial } from '../src/models/crowd/materials';
import { crowdUniforms } from '../src/models/crowd/skinning';
import { createAnimalMaterial } from '../src/models/material/animalMaterial';
import { HIGHLIGHT_FN_GLSL, NOISE_GLSL } from '../src/models/material/shaderChunks';
import { createHumanBatchMaterial, createHumanMaterial, type HumanMarks } from '../src/models/humans/material';
import type { LookSpec } from '../src/models/types';

const MARKS: HumanMarks = { collarY: 1.4, waistY: 1, shoeTop: 0.08, eyeL: [0.03, 1.6, 0.09], mouth: [0, 1.55, 0.1] };
const DERIVATIVE = /\b(dFdx|dFdy|fwidth)\s*\(/;

/** The material's shaders after its onBeforeCompile, with three's #include chunks expanded. */
function compiled(material: THREE.Material, lib: 'standard' | 'depth' = 'standard'): { vs: string; fs: string } {
  const src = THREE.ShaderLib[lib];
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  const expand = (s: string, depth = 0): string =>
    depth > 8 ? s : s.replace(/#include <(\w+)>/g, (_, name: string) => expand((THREE.ShaderChunk as Record<string, string>)[name] ?? '', depth + 1));
  return { vs: expand(shader.vertexShader), fs: expand(shader.fragmentShader) };
}

const SKINS: LookSpec['skin'][] = ['fur', 'hide', 'smooth', 'feather', 'wrinkled'];

describe('creature shaders: no derivatives in the vertex stage', () => {
  it('shared chunks are stage-agnostic (NOISE_GLSL) or fragment-only by contract (HIGHLIGHT_FN_GLSL)', () => {
    expect(NOISE_GLSL).not.toMatch(DERIVATIVE);
    expect(HIGHLIGHT_FN_GLSL).not.toMatch(DERIVATIVE);
  });

  it('animal materials (every skin, tier, highlight, batched) and their depth material', () => {
    for (const skin of SKINS) {
      for (const detail of [0, 1, 2] as const) {
        const look: LookSpec = { skin, pattern: 'stripes', juvenile: { color: 0x808080 }, wets: true };
        for (const m of [createAnimalMaterial({ look, detail }), createAnimalMaterial({ look, detail, highlight: true }), batchedAnimalMaterials(look, detail).material]) {
          const { vs, fs } = compiled(m);
          expect(vs, `${skin} detail ${detail}`).not.toMatch(DERIVATIVE);
          // sanity: the fragment stage does use them (the check sees real code)
          expect(fs).toMatch(DERIVATIVE);
        }
      }
    }
    expect(compiled(crowdDepthMaterial(crowdUniforms()), 'depth').vs).not.toMatch(DERIVATIVE);
  });

  it('human materials (standalone and batched, every tier)', () => {
    const colors = { skin: 0xc08060, hair: 0x302010, shirt: 0x4060a0, pants: 0x303030, shoes: 0x202020, hat: 0x000000 };
    for (const detail of [0, 1, 2] as const) {
      const person = createHumanMaterial(colors, { sleeve: 0, pants: 0, coat: 0, inflate: 0 }, MARKS, detail);
      expect(compiled(person).vs).not.toMatch(DERIVATIVE);
      expect(compiled(createHumanBatchMaterial(detail, [MARKS]).material).vs).not.toMatch(DERIVATIVE);
    }
  });
});
