// Quality tiers and device heuristics for the renderer.
//
//  low:    1× pixels, no MSAA, 1024² shadows over a short distance, sparse
//          short grass, ~450 impostor trees, no post-processing.
//  medium: ≤1.5× pixels, MSAA canvas, 2048² shadows, grass, ~900 trees; still
//          no post chain (colour grade is part of the tone-mapping curve).
//  high:   ≤2× pixels, 3072² shadows, dense grass, ~1500 trees, HDR target
//          with night bloom.

import type { QualityLevel, QualitySettings } from '../core/contracts';

const TIERS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low',
    pixelRatio: 1,
    antialias: false,
    shadows: true,
    shadowMapSize: 1024,
    grassDensity: 0.25,
    postFX: false,
    detailDistance: 26,
    creatureDetail: 0,
  },
  medium: {
    level: 'medium',
    pixelRatio: 1.5,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    grassDensity: 0.5,
    // direct rendering into the MSAA canvas: no float target / resolve /
    // extra full-screen passes (the grade lives in the tone-mapping curve)
    postFX: false,
    detailDistance: 40,
    creatureDetail: 1,
  },
  high: {
    level: 'high',
    pixelRatio: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 3072,
    grassDensity: 1,
    postFX: true,
    detailDistance: 55,
    creatureDetail: 2,
  },
};

/** Settings for a quality tier (a fresh copy; callers may keep it). */
export function qualitySettings(level: QualityLevel): QualitySettings {
  return { ...TIERS[level] };
}

interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number;
}

let cachedGpu: string | null | undefined;

/** Unmasked GPU renderer string ("" when unavailable). Creates a throw-away context once. */
export function gpuRendererString(): string {
  if (cachedGpu !== undefined) return cachedGpu ?? '';
  cachedGpu = null;
  try {
    if (typeof document === 'undefined') return '';
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    cachedGpu = typeof s === 'string' ? s : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cachedGpu = '';
  }
  return cachedGpu ?? '';
}

/** Score a GPU renderer string: -1 unknown, 0 weak, 1 mid, 2 strong. */
function gpuScore(gpu: string): number {
  const g = gpu.toLowerCase();
  if (!g) return -1;
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic/.test(g)) return 0;
  // Desktop-class GPUs
  if (/nvidia|geforce|quadro|rtx|radeon(?!.*vega 3)|amd |apple m\d|apple gpu|intel.*(iris|arc|uhd graphics 7)/.test(g)) return 2;
  // Qualcomm Adreno
  const adreno = /adreno[^\d]*(\d{3})/.exec(g);
  if (adreno) {
    const n = Number(adreno[1]);
    if (n >= 730) return 2;
    if (n >= 640) return 1;
    if (n >= 610) return 1;
    return 0;
  }
  // ARM Mali
  if (/immortalis/.test(g)) return 2;
  const mali = /mali-g(\d+)/.exec(g);
  if (mali) {
    const n = Number(mali[1]);
    if (n >= 710 || (n >= 77 && n < 100)) return 2;
    if (n >= 57) return 1;
    return 0;
  }
  if (/mali-t|powervr|sgx|videocore|adreno.*[34]\d\d/.test(g)) return 0;
  if (/xclipse/.test(g)) return 2;
  if (/intel/.test(g)) return 1;
  return -1;
}

/**
 * Pick a quality tier from device memory, CPU cores, screen size and the GPU
 * renderer string. Conservative: unknown phones get `medium`, weak ones `low`.
 */
export function detectQuality(): QualityLevel {
  if (typeof navigator === 'undefined') return 'medium';
  const nav = navigator as NavigatorWithMemory;
  const mem = nav.deviceMemory ?? 4;
  const cores = nav.hardwareConcurrency ?? 4;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const sw = typeof screen !== 'undefined' ? screen.width : 1280;
  const sh = typeof screen !== 'undefined' ? screen.height : 720;
  const physicalPixels = sw * sh * dpr * dpr;
  const mobile = /android|iphone|ipad|mobile/i.test(nav.userAgent ?? '');
  const gpu = gpuScore(gpuRendererString());

  let score = 1; // medium baseline
  if (gpu === 0) score = 0;
  else if (gpu === 2) score = 2;
  if (mem <= 2 || cores <= 2) score = 0;
  else if (mem <= 3 && score > 0) score -= 1;
  if (mobile && score === 2 && (mem < 6 || cores < 8)) score = 1;
  // very high-resolution panels on mid GPUs cost a lot of fill-rate
  if (score === 1 && gpu < 2 && physicalPixels > 3.5e6 && mem < 4) score = 0;
  return score >= 2 ? 'high' : score === 1 ? 'medium' : 'low';
}
