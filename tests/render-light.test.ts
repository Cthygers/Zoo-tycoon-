import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AtmosphereModel } from '../src/render/atmosphere';
import { computeCelestial } from '../src/render/celestial';
import { RenderContext, airOfDay, cameraFov, daylight, daylightFill, gradeToneMap, moonFill, morningLift } from '../src/render/context';

const DEG = Math.PI / 180;
const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('daylight fill', () => {
  // the 11:00 sun of the showcase views
  const atm = new AtmosphereModel(1.35);
  const elev = 44 * DEG;
  atm.compute(elev);
  const sunCol = new THREE.Color();
  const dl = daylight(atm, elev, sunCol);
  const sunH = sunCol.clone().multiplyScalar(dl.skyE * dl.sunLight * dl.sunTrim * Math.sin(elev));
  const sky = atm.skyIrradiance.clone().multiplyScalar(dl.skyE);

  /** Displayed (linear) shade / sunlit luminance of a horizontal surface, as the context meters exposure. */
  const shadeRatio = (fill: THREE.Color, albedo: THREE.Color) => {
    const amb = sky.clone().add(fill);
    const exposure = dl.displayB / (dl.sunLumMeter + lum(sky) + lum(fill));
    const lit = gradeToneMap(sunH.clone().add(amb).multiply(albedo).multiplyScalar(1 / Math.PI), exposure, new THREE.Color());
    const shade = gradeToneMap(amb.multiply(albedo).multiplyScalar(1 / Math.PI), exposure, new THREE.Color());
    return { ratio: lum(shade) / lum(lit), shade };
  };
  const paving = new THREE.Color(0.32, 0.3, 0.27);

  it('lifts clear-sky shade on paving to a realistic share of sunlit, grey-blue rather than cobalt', () => {
    const fill = new THREE.Color();
    daylightFill(sky, sunH, 1, 0, fill, new THREE.Color());
    const none = shadeRatio(new THREE.Color(0, 0, 0), paving);
    const lit = shadeRatio(fill, paving);
    expect(none.ratio).toBeLessThan(0.1);
    expect(lit.ratio).toBeGreaterThan(0.15);
    expect(lit.ratio).toBeLessThan(0.3);
    expect(lit.shade.b / lit.shade.r).toBeLessThan(none.shade.b / none.shade.r);
  });

  it('adds a neutral bounce from below and nothing at night', () => {
    const fill = new THREE.Color();
    const ground = new THREE.Color();
    daylightFill(sky, sunH, 1, 0, fill, ground);
    expect(lum(ground)).toBeGreaterThan(0.15 * lum(sunH));
    expect(ground.b).toBeLessThan(ground.r);
    daylightFill(sky, sunH, 0, 0, fill, ground);
    expect(lum(fill)).toBe(0);
    expect(lum(ground)).toBe(0);
  });

  it('gives the morning more fill, and cooler shade', () => {
    const plain = new THREE.Color();
    const morning = new THREE.Color();
    daylightFill(sky, sunH, 1, 0, plain, new THREE.Color());
    daylightFill(sky, sunH, 1, 1, morning, new THREE.Color());
    expect(lum(morning)).toBeGreaterThan(lum(plain) * 1.1);
    expect(morning.b / morning.r).toBeGreaterThan((plain.b / plain.r) * 1.05);
  });

  it('keeps the darkest daylight shade near black instead of a milky grey', () => {
    // a dark coat or a crevice in deep shade at noon: ≈ 1 % of the metered ground
    const exposure = dl.displayB / (dl.sunLumMeter + lum(sky));
    const deep = gradeToneMap(new THREE.Color(1, 1, 1).multiplyScalar(0.01 / exposure), exposure, new THREE.Color());
    const srgb = deep.clone().convertLinearToSRGB();
    expect(srgb.g * 255).toBeLessThan(14);
  });
});

describe('time of day air', () => {
  const sun = new THREE.Vector3();
  const moon = new THREE.Vector3();
  const at = (h: number, m = 0) => {
    const se = computeCelestial(h * 60 + m, 1, sun, moon).sunElev / DEG;
    const tint = new THREE.Color();
    const morning = airOfDay(h + m / 60, se, tint);
    return { se, tint, morning, lift: morningLift(se, morning) };
  };

  it('keeps the low morning sun golden and cools it once it is high', () => {
    const early = at(7, 30);
    expect(early.morning).toBe(1);
    // as warm as the afternoon sun
    expect(early.tint.b).toBeLessThan(0.9);
    expect(early.tint.b).toBeCloseTo(at(17).tint.b, 2);
    const mid = at(9, 30);
    expect(mid.tint.b).toBeGreaterThan(1.02);
    expect(at(16).tint.b).toBeLessThan(0.95);
    expect(at(13).morning).toBe(0);
  });

  it('lifts the low morning sun only', () => {
    expect(at(7, 30).lift).toBeGreaterThan(1.1);
    expect(at(8).lift).toBeGreaterThan(1.1);
    expect(at(11).lift).toBe(1);
    expect(at(18, 30).lift).toBe(1);
    expect(at(6, 0).lift).toBe(1);
  });
});

describe('moonlight fill', () => {
  it('lights what the moon misses with a share of its light, bounced warmer from the ground', () => {
    const moonH = new THREE.Color(0.52, 0.68, 1.0).multiplyScalar(0.05);
    const sky = new THREE.Color();
    const ground = new THREE.Color();
    moonFill(moonH, sky, ground);
    expect(lum(sky) / lum(moonH)).toBeGreaterThan(0.2);
    expect(lum(sky) / lum(moonH)).toBeLessThan(0.5);
    expect(sky.b).toBeGreaterThan(sky.r);
    expect(lum(ground)).toBeGreaterThan(0);
    expect(ground.b / ground.r).toBeLessThan(sky.b / sky.r);
    moonFill(new THREE.Color(0, 0, 0), sky, ground);
    expect(lum(sky) + lum(ground)).toBe(0);
  });
});

describe('sun clock', () => {
  const sun = new THREE.Vector3();
  const moon = new THREE.Vector3();
  const elevAt = (h: number, m = 0) => computeCelestial(h * 60 + m, 1, sun, moon).sunElev / DEG;

  it('sets at ≈ 19:30 and rises at ≈ 06:30, so the last visitor hour gets golden light', () => {
    expect(elevAt(19, 20)).toBeGreaterThan(0);
    expect(elevAt(19, 40)).toBeLessThan(0);
    expect(elevAt(6, 20)).toBeLessThan(0);
    expect(elevAt(6, 40)).toBeGreaterThan(0);
    // golden hour while the zoo is open
    expect(elevAt(18, 30)).toBeGreaterThan(6);
    expect(elevAt(18, 30)).toBeLessThan(14);
    // a high summer-ish noon
    expect(elevAt(13)).toBeGreaterThan(50);
  });
});

describe('camera field of view', () => {
  const hfov = (aspect: number) => (2 * Math.atan(Math.tan((cameraFov(aspect) / 2) * DEG) * aspect)) / DEG;

  it('keeps 45° vertical up to 16:10 and caps the horizontal FOV on wide phones', () => {
    expect(cameraFov(4 / 3)).toBe(45);
    expect(cameraFov(1.6)).toBe(45);
    expect(hfov(915 / 412)).toBeCloseTo(68, 5);
    expect(hfov(800 / 360)).toBeCloseTo(68, 5);
    expect(hfov(16 / 9)).toBeLessThanOrEqual(68 + 1e-9);
    // continuous where the cap takes over
    expect(Math.abs(cameraFov(1.63) - 45)).toBeLessThan(0.3);
  });
});

describe('PMREM sample count', () => {
  const STOCK = 'uniform float lodBias;\n#define GGX_SAMPLES 256u\nfloat lod = max( log2( d ) + lodBias, 0.0 );';
  const proto = RenderContext.prototype as unknown as { setPmremSamples(this: object, n: number): void };
  const ctx = (fs: string) => ({ pmrem: { _ggxMaterial: new THREE.ShaderMaterial({ fragmentShader: fs }) } });

  it('lowers the GGX samples with a matching source-mip bias and restores the stock shader', () => {
    const c = ctx(STOCK);
    const m = c.pmrem._ggxMaterial;
    const v0 = m.version;
    proto.setPmremSamples.call(c, 64);
    expect(m.fragmentShader).toContain('#define GGX_SAMPLES 64u');
    expect(m.fragmentShader).toContain('log2( d ) + lodBias + 1.000');
    expect(m.version).toBeGreaterThan(v0);
    const v1 = m.version;
    proto.setPmremSamples.call(c, 64);
    expect(m.version).toBe(v1);
    proto.setPmremSamples.call(c, 256);
    expect(m.fragmentShader).toBe(STOCK);
  });

  it('leaves an unknown shader alone and copes with no generator material yet', () => {
    const other = 'void main() {}';
    const c = ctx(other);
    proto.setPmremSamples.call(c, 64);
    expect(c.pmrem._ggxMaterial.fragmentShader).toBe(other);
    expect(() => proto.setPmremSamples.call({ pmrem: {} }, 64)).not.toThrow();
  });
});
