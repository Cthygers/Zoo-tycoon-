import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AtmosphereModel } from '../src/render/atmosphere';
import { SUN_FACING_MAX, daylight } from '../src/render/context';
import { createGroundMaterial } from '../src/render/groundMaterial';
import { installShaderPatches, readLampMark } from '../src/render/grade';
import { OutputShader } from 'three/examples/jsm/shaders/OutputShader.js';
import type { GroundTextureSet } from '../src/render/textures';

const DEG = Math.PI / 180;

describe('daylight', () => {
  const atm = new AtmosphereModel(1.35);
  const sunCol = new THREE.Color();
  const at = (deg: number) => {
    atm.compute(deg * DEG);
    const dl = daylight(atm, deg * DEG, sunCol);
    // displayed brightness of a surface facing the sun: direct normal luminance × exposure
    const sunNormal = deg > 0 ? dl.sunLumMeter / Math.sin(deg * DEG) : 0;
    return { ...dl, facing: (sunNormal * dl.sunTrim * dl.displayB) / dl.meterE };
  };

  it('keeps sun-facing surfaces below the cap at every elevation', () => {
    for (let deg = 0.5; deg <= 70; deg += 0.5) expect(at(deg).facing).toBeLessThanOrEqual(SUN_FACING_MAX * (1 + 1e-9));
  });

  it('trims the low sun (sunrise / late sunset) and leaves the day untouched', () => {
    expect(at(5).sunTrim).toBeLessThan(0.6);
    for (const deg of [32, 45, 60]) expect(at(deg).sunTrim).toBe(1);
  });
});

describe('ground material options', () => {
  const tex: GroundTextureSet = {
    albedo: new THREE.DataArrayTexture(),
    detail: new THREE.DataArrayTexture(),
    noise: new THREE.Texture(),
    waves: new THREE.Texture(),
    foliage: new THREE.Texture(),
  };
  const low = { antiTile: false, cloudShadows: false, caustics: false };
  const high = { antiTile: true, cloudShadows: true, caustics: true };

  it('switches shader features (defines + program key) on a quality change', () => {
    const g = createGroundMaterial(tex, new THREE.Texture(), low);
    const m = g.material;
    expect(m.defines).toEqual({});
    const key = m.customProgramCacheKey();
    const v = m.version;
    g.setOptions(high);
    expect(m.defines).toEqual({ ANTI_TILE: 1, CLOUD_SHADOWS: 1, CAUSTICS: 1 });
    expect(m.customProgramCacheKey()).not.toBe(key);
    expect(m.version).toBe(v + 1);
    g.setOptions({ ...high });
    expect(m.version).toBe(v + 1); // unchanged options: no recompile
  });
});

describe('night grade', () => {
  it('lets the night light pools mark lamp-lit pixels for the grade (high tier)', () => {
    installShaderPatches();
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).toMatch(/float whLampLit = 0\.0;[\s\S]*whLampLit/);
    const fs = readLampMark(OutputShader.fragmentShader);
    // the mark (HDR alpha above 1) is read before the grade runs, and not passed on to the canvas
    const read = fs.indexOf('whLampLit = clamp( gl_FragColor.a - 1.0');
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(fs.indexOf('CustomToneMapping( gl_FragColor.rgb )'));
    expect(fs).toContain('gl_FragColor.a = 1.0;');
  });
});
