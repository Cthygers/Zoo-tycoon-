// Moonlit night look of animals (models/material/figureNight.ts): at night an
// animal's diffuse light turns neutral in its coat's own hue (as the moonlit
// ground's does) instead of taking the blue sky fill, and it is marked for the
// night grade, combined with (never overwriting) the lamp field's mark. The
// lamp field's patch stays last.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createAnimalMaterial } from '../src/models/material/animalMaterial';
import { batchedAnimalMaterials } from '../src/models/crowd/materials';
import { FIGURE_NIGHT, figureNightUniforms, setFigureNightGround } from '../src/models/material/figureNight';
import { setFigureNightGround as exported } from '../src/models';

function patched(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const src = THREE.ShaderLib.standard;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader as unknown as THREE.WebGLProgramParametersWithUniforms;
}

describe('animal night look', () => {
  afterEach(() => setFigureNightGround(0));

  it('one shared night level, exported for main.ts', () => {
    expect(exported).toBe(setFigureNightGround);
    const shader = patched(createAnimalMaterial({ look: { skin: 'fur' }, detail: 1 }));
    exported(0.7);
    expect(shader.uniforms.uFigureNight).toBe(figureNightUniforms.uFigureNight);
    expect(shader.uniforms.uFigureNight.value).toBe(0.7);
  });

  it('neutral light before the lamp light, the grade mark combined with the lamp mark, lamp field last', () => {
    for (const m of [createAnimalMaterial({ look: { skin: 'wrinkled' }, detail: 0 }), batchedAnimalMaterials({ skin: 'fur', pattern: 'stripes' }, 1).material]) {
      const fs = patched(m).fragmentShader;
      const night = fs.indexOf('float fnK = uFigureNight');
      const lamp = fs.indexOf('uLampLight * (lfPool');
      const ao = fs.indexOf('#include <aomap_fragment>');
      expect(night).toBeGreaterThan(0);
      // the lamp's warm light is added after the moonlight is made neutral, so it keeps its colour
      expect(lamp).toBeGreaterThan(night);
      expect(ao).toBeGreaterThan(lamp);
      // tiers that tone-map in the material: the larger of the two marks, applied as tone mapping runs
      expect(fs).toMatch(/whLampLit = max\( whLampLit, figNightMark \)/);
      expect(fs).toMatch(/#define toneMapping figNightToneMapping/);
      // the post-FX tier: the HDR alpha keeps the lamp's mark if it is larger
      const tm = fs.indexOf('#include <tonemapping_fragment>');
      expect(fs.indexOf('whLampLit = lfMark')).toBeLessThan(tm);
      expect(fs.indexOf('gl_FragColor.a = max(gl_FragColor.a, 1.0 + figNightMark)')).toBeGreaterThan(tm);
      // only one tone-mapping include, and the lamp field's moonlit shoulder still right before it
      expect(fs.split('#include <tonemapping_fragment>').length).toBe(2);
      expect(fs.lastIndexOf('lfTone', tm)).toBeGreaterThan(fs.indexOf('fnK'));
    }
  });

  it('keeps the light (no glow) and the grade mark at the moonlit ground share', () => {
    expect(FIGURE_NIGHT.light).toBeGreaterThan(0.4);
    expect(FIGURE_NIGHT.light).toBeLessThanOrEqual(1);
    expect(FIGURE_NIGHT.mark).toBeLessThanOrEqual(0.2);
  });
});
