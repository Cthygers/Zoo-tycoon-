// Physically based single-scattering atmosphere (Rayleigh + Mie + ozone) with
// a cheap multiple-scattering term, evaluated on the CPU into a small
// sky-view lookup table. The table is parameterised by view elevation and the
// azimuth relative to the sun (the sky is symmetric about the sun's vertical
// plane), so a 48×48 LUT is enough; the Mie phase is applied per pixel in the
// sky shader so the sun halo stays sharp.
//
// The same model gives the direct sun colour (transmittance), the fog /
// horizon colour and the sky irradiance used for the hemisphere light, so all
// lighting is consistent with the sky the player sees.
//
// Units: values are per unit of top-of-atmosphere sun irradiance; the render
// context multiplies by its sun irradiance constant.

import * as THREE from 'three';

const RG = 6360; // ground radius km
const RT = 6460; // atmosphere top km
const HR = 8; // rayleigh scale height km
const HM = 1.2; // mie scale height km
const BETA_R = [5.802e-3, 13.558e-3, 33.1e-3];
const BETA_O = [0.65e-3, 1.881e-3, 0.085e-3];
const MIE_G = 0.78;

const TH = 32; // transmittance table: altitude samples
const TMU = 128; // transmittance table: zenith-cosine samples

export const SKY_LUT_W = 48; // relative azimuth 0..π
export const SKY_LUT_H = 48; // elevation -π/2..π/2 (non-linear)
const VIEW_STEPS = 18;

const PI = Math.PI;

function rayleighPhase(c: number): number {
  return (3 / (16 * PI)) * (1 + c * c);
}
export function miePhase(c: number, g = MIE_G): number {
  const g2 = g * g;
  const k = (3 / (8 * PI)) * ((1 - g2) / (2 + g2));
  return (k * (1 + c * c)) / Math.pow(1 + g2 - 2 * g * c, 1.5);
}

/** Distance from radius r along direction with zenith cosine mu to sphere of radius R (outer intersection). */
function distToSphere(r: number, mu: number, R: number): number {
  const disc = r * r * (mu * mu - 1) + R * R;
  return -r * mu + Math.sqrt(Math.max(0, disc));
}
/** Distance to the ground along a ray, or -1 if the ray misses it. */
function distToGround(r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + RG * RG;
  if (mu >= 0 || disc < 0) return -1;
  return -r * mu - Math.sqrt(disc);
}
function ozone(h: number): number {
  return Math.max(0, 1 - Math.abs(h - 25) / 15);
}

export class AtmosphereModel {
  /** Mie scattering multiplier (1 = clear, 2–3 = hazy summer day). */
  turbidity: number;
  readonly mieScatter: number;
  readonly mieExtinction: number;

  /** Observer altitude for the sky view (km). */
  readonly observerKm = 0.15;

  private trans = new Float32Array(TH * TMU * 3);

  // Sky-view LUT (half floats, RGBA)
  private rayData = new Uint16Array(SKY_LUT_W * SKY_LUT_H * 4);
  private mieData = new Uint16Array(SKY_LUT_W * SKY_LUT_H * 4);
  readonly rayTex: THREE.DataTexture;
  readonly mieTex: THREE.DataTexture;

  /** Irradiance on a horizontal surface from the whole sky (per unit TOA sun). */
  readonly skyIrradiance = new THREE.Color();
  /** Mean horizon radiance (fog colour basis). */
  readonly horizon = new THREE.Color();
  /** Zenith radiance. */
  readonly zenith = new THREE.Color();

  // per-row scratch
  private sH = new Float32Array(VIEW_STEPS);
  private sR = new Float32Array(VIEW_STEPS);
  private sT = new Float32Array(VIEW_STEPS);
  private sMuH = new Float32Array(VIEW_STEPS);
  private sRay = new Float32Array(VIEW_STEPS * 3); // T_view * rhoR * ds
  private sMie = new Float32Array(VIEW_STEPS * 3); // T_view * rhoM * ds
  private tmp = new Float32Array(3);

  constructor(turbidity = 1.8) {
    this.turbidity = turbidity;
    this.mieScatter = 3.996e-3 * turbidity;
    this.mieExtinction = 4.4e-3 * turbidity;
    this.buildTransmittance();
    const mk = (data: Uint16Array) => {
      const t = new THREE.DataTexture(data, SKY_LUT_W, SKY_LUT_H, THREE.RGBAFormat, THREE.HalfFloatType);
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
      return t;
    };
    this.rayTex = mk(this.rayData);
    this.mieTex = mk(this.mieData);
  }

  private buildTransmittance() {
    const steps = 40;
    for (let i = 0; i < TH; i++) {
      const hx = i / (TH - 1);
      const h = hx * hx * (RT - RG);
      const r = RG + h;
      const muH = -Math.sqrt(Math.max(0, 1 - (RG / r) * (RG / r)));
      for (let j = 0; j < TMU; j++) {
        const t = (j / (TMU - 1)) * 2 - 1;
        let mu = Math.sign(t) * t * t;
        mu = Math.max(mu, muH + 1e-4); // grazing for rays that would hit the ground
        const d = distToSphere(r, mu, RT);
        const ds = d / steps;
        let oR = 0,
          oM = 0,
          oO = 0;
        for (let s = 0; s < steps; s++) {
          const tt = (s + 0.5) * ds;
          const rr = Math.sqrt(r * r + tt * tt + 2 * r * mu * tt);
          const hh = Math.max(0, rr - RG);
          oR += Math.exp(-hh / HR) * ds;
          oM += Math.exp(-hh / HM) * ds;
          oO += ozone(hh) * ds;
        }
        const k = (i * TMU + j) * 3;
        for (let c = 0; c < 3; c++) this.trans[k + c] = Math.exp(-(BETA_R[c] * oR + this.mieExtinction * oM + BETA_O[c] * oO));
      }
    }
  }

  /** Transmittance from altitude h (km) toward zenith cosine mu, without ground occlusion. Writes to this.tmp. */
  private lookupT(h: number, mu: number): Float32Array {
    const hx = Math.sqrt(Math.min(Math.max(h, 0), RT - RG) / (RT - RG)) * (TH - 1);
    const t = Math.sign(mu) * Math.sqrt(Math.abs(Math.min(Math.max(mu, -1), 1)));
    const mx = ((t + 1) / 2) * (TMU - 1);
    const i0 = Math.min(Math.floor(hx), TH - 2),
      j0 = Math.min(Math.floor(mx), TMU - 2);
    const fi = hx - i0,
      fj = mx - j0;
    const tr = this.trans;
    const a = (i0 * TMU + j0) * 3,
      b = a + 3,
      c = a + TMU * 3,
      d = c + 3;
    for (let k = 0; k < 3; k++) {
      const top = tr[a + k] * (1 - fj) + tr[b + k] * fj;
      const bot = tr[c + k] * (1 - fj) + tr[d + k] * fj;
      this.tmp[k] = top * (1 - fi) + bot * fi;
    }
    return this.tmp;
  }

  /** Sun (or moon) light colour reaching altitude `km` at elevation angle `elev` (radians), incl. horizon occlusion. */
  transmittance(elev: number, km: number, out: THREE.Color): THREE.Color {
    const r = RG + km;
    const mu = Math.sin(elev);
    const muH = -Math.sqrt(Math.max(0, 1 - (RG / r) * (RG / r)));
    const vis = smooth(muH - 0.0045, muH + 0.0045, mu);
    const t = this.lookupT(km, mu);
    return out.setRGB(t[0] * vis, t[1] * vis, t[2] * vis);
  }

  /** Map LUT row index to view elevation (radians). */
  static rowElevation(v: number): number {
    const x = (v / (SKY_LUT_H - 1)) * 2 - 1;
    return Math.sign(x) * x * x * (PI / 2);
  }

  // ---- amortised computation state
  private jobElev = 0;
  private jobRow = -1;
  private accIrr = [0, 0, 0];
  private accHor = [0, 0, 0, 0];
  private accZen = [0, 0, 0];

  /** True while a LUT update is in progress. */
  get busy(): boolean {
    return this.jobRow >= 0;
  }

  /** Start recomputing the LUT for a sun at elevation `sunElev` (radians). */
  request(sunElev: number): void {
    this.jobElev = sunElev;
    this.jobRow = 0;
    this.accIrr.fill(0);
    this.accHor.fill(0);
    this.accZen.fill(0);
  }

  /**
   * Advance a pending LUT update by up to `rows` rows (~0.1 ms per row on a
   * desktop CPU). Returns true when the update completed during this call
   * (textures flagged for upload, derived colours refreshed).
   */
  step(rows: number): boolean {
    if (this.jobRow < 0) return false;
    const end = Math.min(SKY_LUT_H, this.jobRow + rows);
    for (let v = this.jobRow; v < end; v++) this.computeRow(v);
    this.jobRow = end;
    if (end < SKY_LUT_H) return false;
    this.jobRow = -1;
    this.skyIrradiance.setRGB(this.accIrr[0], this.accIrr[1], this.accIrr[2]);
    const n = Math.max(1, this.accHor[3]);
    this.horizon.setRGB(this.accHor[0] / n, this.accHor[1] / n, this.accHor[2] / n);
    this.zenith.setRGB(this.accZen[0], this.accZen[1], this.accZen[2]);
    this.rayTex.needsUpdate = true;
    this.mieTex.needsUpdate = true;
    return true;
  }

  /** Synchronous full update (start-up, time jumps). */
  compute(sunElev: number): void {
    this.request(sunElev);
    this.step(SKY_LUT_H);
  }

  private computeRow(v: number): void {
    const sunElev = this.jobElev;
    const r0 = RG + this.observerKm;
    const sinS = Math.sin(sunElev),
      cosS = Math.cos(sunElev);
    const W = SKY_LUT_W,
      H = SKY_LUT_H;
    const bR0 = BETA_R[0],
      bR1 = BETA_R[1],
      bR2 = BETA_R[2],
      bMs = this.mieScatter,
      bMe = this.mieExtinction;
    const toHalf = THREE.DataUtils.toHalfFloat;
    const horizonRow = Math.round((0.5 + 0.5 * Math.sqrt(0.035 / (PI / 2))) * (H - 1));
    const el = AtmosphereModel.rowElevation(v);
    const sinE = Math.sin(el),
      cosE = Math.cos(el);
    const dg = distToGround(r0, sinE);
    const dEnd = dg > 0 ? dg : distToSphere(r0, sinE, RT);
    // per-row samples (independent of azimuth)
    let oR = 0,
      oM = 0,
      oO = 0;
    const sH = this.sH,
      sR = this.sR,
      sT = this.sT,
      sMuH = this.sMuH,
      sRay = this.sRay,
      sMie = this.sMie;
    for (let s = 0; s < VIEW_STEPS; s++) {
      const u = (s + 0.5) / VIEW_STEPS;
      const t = u * u * dEnd;
      const tNext = ((s + 1) / VIEW_STEPS) ** 2 * dEnd;
      const tPrev = (s / VIEW_STEPS) ** 2 * dEnd;
      const seg = tNext - tPrev;
      const rr = Math.sqrt(r0 * r0 + t * t + 2 * r0 * sinE * t);
      const h = Math.max(0, rr - RG);
      const rhoR = Math.exp(-h / HR),
        rhoM = Math.exp(-h / HM),
        rhoO = ozone(h);
      oR += rhoR * seg * 0.5;
      oM += rhoM * seg * 0.5;
      oO += rhoO * seg * 0.5;
      sH[s] = h;
      sR[s] = rr;
      sT[s] = t;
      sMuH[s] = -Math.sqrt(Math.max(0, 1 - (RG / rr) * (RG / rr)));
      for (let c = 0; c < 3; c++) {
        const tv = Math.exp(-(BETA_R[c] * oR + bMe * oM + BETA_O[c] * oO));
        sRay[s * 3 + c] = tv * rhoR * seg;
        sMie[s * 3 + c] = tv * rhoM * seg;
      }
      oR += rhoR * seg * 0.5;
      oM += rhoM * seg * 0.5;
      oO += rhoO * seg * 0.5;
    }
    const elA = AtmosphereModel.rowElevation(Math.max(0, v - 0.5));
    const elB = AtmosphereModel.rowElevation(Math.min(H - 1, v + 0.5));
    const band = Math.abs(elB - elA);
    const tr = this.trans;
    const HSPAN = RT - RG;
    const msK = 0.4 / (4 * PI);

    for (let uI = 0; uI < W; uI++) {
      const phi = (uI / (W - 1)) * PI;
      const dDotS = cosE * Math.cos(phi) * cosS + sinE * sinS;
      let aR0 = 0,
        aR1 = 0,
        aR2 = 0,
        aM0 = 0,
        aM1 = 0,
        aM2 = 0,
        ms0 = 0,
        ms1 = 0,
        ms2 = 0;
      for (let s = 0; s < VIEW_STEPS; s++) {
        const muS = (r0 * sinS + sT[s] * dDotS) / sR[s];
        const muH = sMuH[s];
        const dd = muS - muH;
        if (dd <= -0.12) continue;
        const vis = dd >= 0.0045 ? 1 : dd <= -0.0045 ? 0 : smooth(-0.0045, 0.0045, dd);
        const msVis = dd >= 0.08 ? 1 : smooth(-0.12, 0.08, dd);
        // inlined bilinear transmittance lookup
        const hx = Math.sqrt(Math.min(sH[s], HSPAN) / HSPAN) * (TH - 1);
        const mc = muS > 1 ? 1 : muS < -1 ? -1 : muS;
        const tq = mc >= 0 ? Math.sqrt(mc) : -Math.sqrt(-mc);
        const mx = ((tq + 1) / 2) * (TMU - 1);
        const i0 = hx >= TH - 1 ? TH - 2 : hx | 0;
        const j0 = mx >= TMU - 1 ? TMU - 2 : mx | 0;
        const fi = hx - i0,
          fj = mx - j0;
        const a = (i0 * TMU + j0) * 3,
          c2 = a + TMU * 3;
        const w00 = (1 - fi) * (1 - fj),
          w01 = (1 - fi) * fj,
          w10 = fi * (1 - fj),
          w11 = fi * fj;
        const t0 = tr[a] * w00 + tr[a + 3] * w01 + tr[c2] * w10 + tr[c2 + 3] * w11;
        const t1 = tr[a + 1] * w00 + tr[a + 4] * w01 + tr[c2 + 1] * w10 + tr[c2 + 4] * w11;
        const t2 = tr[a + 2] * w00 + tr[a + 5] * w01 + tr[c2 + 2] * w10 + tr[c2 + 5] * w11;
        const k = s * 3;
        const r0s = sRay[k],
          r1s = sRay[k + 1],
          r2s = sRay[k + 2],
          m0s = sMie[k],
          m1s = sMie[k + 1],
          m2s = sMie[k + 2];
        aR0 += r0s * t0 * vis;
        aR1 += r1s * t1 * vis;
        aR2 += r2s * t2 * vis;
        aM0 += m0s * t0 * vis;
        aM1 += m1s * t1 * vis;
        aM2 += m2s * t2 * vis;
        ms0 += (r0s * bR0 + m0s * bMs) * t0 * msVis;
        ms1 += (r1s * bR1 + m1s * bMs) * t1 * msVis;
        ms2 += (r2s * bR2 + m2s * bMs) * t2 * msVis;
      }
      const pr = rayleighPhase(dDotS);
      const R0 = aR0 * bR0 * pr + ms0 * msK;
      const R1 = aR1 * bR1 * pr + ms1 * msK;
      const R2 = aR2 * bR2 * pr + ms2 * msK;
      const M0 = aM0 * bMs,
        M1 = aM1 * bMs,
        M2 = aM2 * bMs;
      const idx = (v * W + uI) * 4;
      this.rayData[idx] = toHalf(R0);
      this.rayData[idx + 1] = toHalf(R1);
      this.rayData[idx + 2] = toHalf(R2);
      this.rayData[idx + 3] = 15360; // 1.0
      this.mieData[idx] = toHalf(M0);
      this.mieData[idx + 1] = toHalf(M1);
      this.mieData[idx + 2] = toHalf(M2);
      this.mieData[idx + 3] = 15360;

      const pm = miePhase(dDotS);
      const L0 = R0 + M0 * pm,
        L1 = R1 + M1 * pm,
        L2 = R2 + M2 * pm;
      if (el > 0) {
        const w = Math.sin(el) * Math.cos(el) * band * (PI / (W - 1)) * 2 * (uI === 0 || uI === W - 1 ? 0.5 : 1);
        this.accIrr[0] += L0 * w;
        this.accIrr[1] += L1 * w;
        this.accIrr[2] += L2 * w;
      }
      if (v === horizonRow) {
        this.accHor[0] += L0;
        this.accHor[1] += L1;
        this.accHor[2] += L2;
        this.accHor[3]++;
      }
      if (v === H - 1 && uI === 0) {
        this.accZen[0] = L0;
        this.accZen[1] = L1;
        this.accZen[2] = L2;
      }
    }
  }

  dispose(): void {
    this.rayTex.dispose();
    this.mieTex.dispose();
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

export { MIE_G };
