// Water surface at WATER_LEVEL over water tiles (plus a one-tile margin so the
// shoreline intersection with the terrain is covered). MeshPhysicalMaterial
// (IOR 1.33, PMREM sky reflections, real sun glint and shadows) extended with
// animated multi-octave normals, sun glitter, depth-based absorption (water
// depth comes from a per-vertex attribute sampled from world.heightAt with the
// same tessellation as the terrain), soft shoreline foam and premultiplied-alpha
// compositing so the reflection is not dimmed by transparency. Per-channel
// absorption of the lake bed itself happens in the ground shader, so the
// surface only veils what is below lightly at the shore (the bed stays
// visible) and strongly over the middle of ponds and deep pools. The visible
// waterline is bent by noise off the terrain's straight-edged contour, with
// the sheen building up over the first centimetres (no hard bright rim), and
// depth-only murk layers under the surface hide whatever stands deeper than
// ~20 cm (wading legs fade out instead of showing as dark shapes).

import * as THREE from 'three';
import { MAP_H, MAP_W, TILE, WATER_LEVEL } from '../core/constants';
import { isWater, type Terrain } from '../core/types';
import type { World } from '../core/world';
import { nearWater } from './terrain';

const CX = MAP_W + 1;

/**
 * GLSL: depth below the water plane (m) where open water starts. The terrain
 * meets the flat water plane along a straight-edged contour (bilinear tiles,
 * fan tessellation); noise at ~1.4 m and ~0.6 m bends the visible waterline
 * away from it, centred on the contour so the pond does not shrink on
 * average (a one-sided offset bared a wide band of ground under the plane).
 * Where it is negative the water fades in from the contour itself and the
 * ground shader keeps the strip above the plane wet. The ground shader calls
 * it with the same noise samples (uNoise at 0.087 and 0.41 per metre), so
 * bank and water agree.
 */
export const SHORE_OFFSET_GLSL = /* glsl */ `
float shoreOffset(vec4 nB, vec4 nC) {
  return (nB.g - 0.5) * 0.12 + (nC.r - 0.5) * 0.04;
}
`;

/**
 * Murk layers: [depth below the surface (m), share of MSAA samples hidden].
 * Depth-only copies of the surface, drawn after the ground (terrain.ts and
 * outer.ts draw it at renderOrder -2) and before everything that stands in
 * the water (creatures, props: 0). Whatever lies deeper than a layer is
 * hidden behind it, so a wading leg fades out within ~20 cm the way it does
 * in a murky pond, instead of showing as a dark shape the veil cannot match
 * (the surface only knows how deep the bed is, not the leg). With MSAA each
 * layer covers its share of the samples (alpha to coverage): a four-step fade.
 * Without MSAA one layer (MURK_SINGLE) cuts at ~9 cm.
 */
const MURK_LAYERS: readonly (readonly [number, number])[] = [
  [0.04, 0.25],
  [0.09, 0.5],
  [0.15, 0.75],
  [0.22, 1],
];
const MURK_SINGLE = 1;

export interface WaterUniforms {
  [k: string]: THREE.IUniform;
  uWaves: THREE.IUniform<THREE.Texture>;
  uNoise: THREE.IUniform<THREE.Texture>;
  uTime: THREE.IUniform<number>;
  uDeep: THREE.IUniform<THREE.Color>;
  uShallow: THREE.IUniform<THREE.Color>;
  /** Radiance of the reflected banks / tree line (set from the sky state). */
  uBank: THREE.IUniform<THREE.Color>;
}

export class WaterSurface {
  readonly mesh: THREE.Mesh;
  readonly uniforms: WaterUniforms;
  private geo = new THREE.BufferGeometry();
  private material: THREE.MeshPhysicalMaterial;
  private murk: THREE.Mesh[] = [];
  private murkMsaa: boolean | null = null;
  private vmap = new Int32Array(CX * (MAP_H + 1));

  constructor(
    private world: World,
    waves: THREE.Texture,
    noise: THREE.Texture,
    /** Ground height outside the playable map (decorative landscape). */
    private outerHeight: (x: number, z: number) => number,
  ) {
    this.uniforms = {
      uWaves: { value: waves },
      uNoise: { value: noise },
      uTime: { value: 0 },
      // body colour (in-scatter) of shallow / deep water: blue-teal (a green
      // body over the olive bed reads as lawn from above), light enough that
      // deep pools never read as holes from a high camera
      uDeep: { value: new THREE.Color(0.016, 0.05, 0.068) },
      uShallow: { value: new THREE.Color(0.05, 0.09, 0.1) },
      uBank: { value: new THREE.Color(0.02, 0.03, 0.015) },
    };
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.05,
      metalness: 0,
      ior: 1.333,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: true,
    });
    m.name = 'water';
    m.envMapIntensity = 1;
    m.customProgramCacheKey = () => 'wildhaven-water';
    const u = this.uniforms;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float depth;\nvarying float vDepth;\nvarying vec3 vWPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvDepth = depth;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D uWaves;
          uniform sampler2D uNoise;
          uniform float uTime;
          uniform vec3 uDeep;
          uniform vec3 uShallow;
          uniform vec3 uBank;
          varying float vDepth;
          varying vec3 vWPos;
          vec3 wGlintN;
          ${SHORE_OFFSET_GLSL}`,
        )
        .replace(
          '#include <map_fragment>',
          `float wDepth = vDepth;
          // depth past the visible waterline: the noisy line, or the terrain's
          // own contour where the noise lifts that line up the bank. The water
          // fades in from there, so neither line shows as a hard edge.
          float wEdge = min(wDepth - shoreOffset(texture2D(uNoise, vWPos.xz * 0.087), texture2D(uNoise, vWPos.xz * 0.41)), wDepth);
          if (wEdge <= 0.0) discard;
          vec3 wV = normalize(cameraPosition - vWPos);
          float wDist = length(cameraPosition - vWPos);
          // seen from afar, sub-pixel ripples tilt many facets toward the
          // brighter sky: rougher, more reflective water (a sky sheen)
          float wFar = smoothstep(30.0, 120.0, wDist);
          // close up, fine ripples and glitter resolve (faded out before they alias)
          float wNear = 1.0 - smoothstep(25.0, 60.0, wDist);
          float pathLen = max(wDepth, 0.0) / max(wV.y, 0.22);
          // the bed shows through near the shore (tinted per channel by the
          // ground shader); a body of murky pond water takes over within a
          // metre or so, darker over deep pools
          float turbid = mix(0.55, 0.95, smoothstep(0.95, 1.85, wDepth));
          float absorb = 1.0 - exp(-pathLen * turbid);
          // shoreline foam: thin, broken, slowly pulsing
          float fn = texture2D(uNoise, vWPos.xz * 0.6 + vec2(uTime * 0.02, -uTime * 0.015)).b;
          float fn2 = texture2D(uNoise, vWPos.xz * 1.9 - vec2(uTime * 0.03, uTime * 0.01)).g;
          float shore = 1.0 - smoothstep(0.0, 0.025 + 0.035 * fn, wEdge);
          float foam = shore * smoothstep(0.5, 0.7, fn2 * 0.6 + fn * 0.4 + 0.1 * sin(uTime * 0.8 + vWPos.x * 0.7)) * 0.45;
          foam = max(foam, (1.0 - smoothstep(0.0, 0.01, wEdge)) * 0.25 * fn2);
          diffuseColor.rgb = mix(mix(uShallow, uDeep, smoothstep(0.6, 2.4, pathLen)), vec3(0.42, 0.43, 0.41), foam);`,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(mix(roughness, 0.22, wFar), 0.55, foam);')
        .replace(
          '#include <normal_fragment_maps>',
          `{
            vec2 p = vWPos.xz;
            vec2 s1 = texture2D(uWaves, p / 9.0 + vec2(uTime * 0.011, uTime * 0.007)).rg - 0.5;
            vec2 s2 = texture2D(uWaves, p / 3.7 + vec2(-uTime * 0.017, uTime * 0.012)).rg - 0.5;
            vec2 s3 = texture2D(uWaves, p / 1.3 + vec2(uTime * 0.026, -uTime * 0.02)).rg - 0.5;
            vec2 s4 = texture2D(uWaves, p / 0.47 + vec2(-uTime * 0.05, -uTime * 0.034)).rg - 0.5;
            vec2 sl = (s1 * 0.9 + s2 * 0.6 + s3 * 0.35 + s4 * 0.3 * wNear) * 0.3;
            // calm water near the shore
            sl *= 0.45 + 0.55 * smoothstep(0.0, 0.4, wDepth);
            vec3 nW = normalize(vec3(-sl.x, 1.0, -sl.y));
            normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
            // capillary wavelets, far steeper than the normal map resolves:
            // they only matter for the sun glitter below
            vec2 sg = (s3 * 1.4 + s4 * 2.2) * 0.3;
            wGlintN = normalize((viewMatrix * vec4(normalize(vec3(-sl.x - sg.x, 1.0, -sl.y - sg.y)), 0.0)).xyz);
          }`,
        )
        .replace(
          '#include <opaque_fragment>',
          `{
            // the env map holds only sky: darken low reflections where the real
            // scene would mirror banks and the distant tree line
            vec3 rW = reflect(-wV, normalize((vec4(normal, 0.0) * viewMatrix).xyz));
            float bank = 1.0 - smoothstep(0.015, 0.16, rW.y);
            reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, uBank * (0.6 + 0.4 * fn), bank * 0.85);
            vec3 wDiff = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
            float NdV = clamp(dot(normal, geometryViewDir), 0.0, 1.0);
            // Schlick Fresnel (already part of the BRDF's specular), raised to a
            // reflectance floor: ripples always tilt some facets toward the
            // brighter low sky, so even steep views keep a sky / cloud sheen
            float Fs = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
            // a film of water a few cm deep mirrors little: the sheen builds up
            // over the first ~15 cm instead of ending in a bright hard line
            float wSheen = smoothstep(0.0, 0.15, wEdge);
            float F = max(Fs, mix(0.065, 0.1, wFar)) * wSheen;
            vec3 wSpec = (reflectedLight.directSpecular + reflectedLight.indirectSpecular * (F / Fs)) * wSheen;
            #if NUM_DIR_LIGHTS > 0
            {
              // sun glitter: the last directional light of the lighting loop
              // is the sun / moon (shadowed); wavelet facets facing the half
              // vector flash as sparse, twinkling points over a wide cone
              float nh = max(dot(wGlintN, normalize(directLight.direction + geometryViewDir)), 0.0);
              float glint = pow(nh, 900.0) * 3.0 * wNear * (1.0 - foam);
              wSpec += directLight.color * glint;
            }
            #endif
            float a = clamp(max(absorb, foam), 0.0, 1.0);
            float alpha = a + (1.0 - a) * F;
            gl_FragColor = vec4(wDiff * a * (1.0 - F) + wSpec * (1.0 - foam * 0.7), alpha);
            gl_FragColor *= smoothstep(0.0, 0.02, wEdge);
          }`,
        )
        .replace(
          '#include <fog_fragment>',
          `#ifdef USE_FOG
            #ifdef FOG_EXP2
              float wFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            #else
              float wFog = smoothstep(fogNear, fogFar, vFogDepth);
            #endif
            gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor * gl_FragColor.a, wFog);
          #endif`,
        )
        .replace('#include <premultiplied_alpha_fragment>', '');
    };
    this.material = m;
    this.mesh = new THREE.Mesh(this.geo, m);
    this.mesh.name = 'water';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = 10;
    for (const [depth, share] of MURK_LAYERS) {
      const mm = new THREE.MeshBasicMaterial({ colorWrite: false, opacity: share, alphaToCoverage: true });
      mm.name = 'water-murk';
      const layer = new THREE.Mesh(this.geo, mm);
      layer.name = 'water-murk';
      layer.position.y = -depth;
      layer.renderOrder = -1;
      layer.raycast = () => {};
      this.murk.push(layer);
      this.mesh.add(layer);
    }
    // the canvas / post target has MSAA or not for the renderer's lifetime
    this.mesh.onBeforeRender = (renderer) => {
      const msaa = !!renderer.getContextAttributes()?.antialias;
      if (msaa === this.murkMsaa) return;
      this.murkMsaa = msaa;
      this.murk.forEach((m, i) => (m.visible = msaa || i === MURK_SINGLE));
    };
    this.rebuild();
  }

  private tileNeedsWater(x: number, z: number): boolean {
    return nearWater(this.world, x, z);
  }

  /**
   * Rebuild the whole surface (cheap: a few thousand vertices). Every water
   * tile (and its one-tile margin) is a 4-triangle fan around the tile centre,
   * exactly like the terrain's tessellation there (terrain.ts draws all tiles
   * near water as fans), so the interpolated depth matches the ground.
   */
  rebuild(): void {
    const w = this.world;
    const vmap = this.vmap;
    vmap.fill(-1);
    const pos: number[] = [];
    const depth: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    const push = (x: number, z: number): number => {
      const id = pos.length / 3;
      pos.push(x, WATER_LEVEL, z);
      nrm.push(0, 1, 0);
      depth.push(WATER_LEVEL - w.heightAt(x, z));
      return id;
    };
    const corner = (i: number, j: number): number => {
      const k = j * CX + i;
      if (vmap[k] < 0) vmap[k] = push(i * TILE, j * TILE);
      return vmap[k];
    };
    for (let z = 0; z < MAP_H; z++)
      for (let x = 0; x < MAP_W; x++) {
        if (!this.tileNeedsWater(x, z)) continue;
        // skip margin tiles whose ground is entirely above the water
        let lowest = Infinity;
        for (let j = 0; j <= 2; j++)
          for (let i = 0; i <= 2; i++) lowest = Math.min(lowest, w.heightAt((x + i * 0.5) * TILE, (z + j * 0.5) * TILE));
        if (lowest >= WATER_LEVEL + 0.03) continue;
        const a = corner(x, z),
          b = corner(x + 1, z),
          c = corner(x, z + 1),
          d = corner(x + 1, z + 1);
        const m = push((x + 0.5) * TILE, (z + 0.5) * TILE);
        idx.push(a, m, b, b, m, d, d, m, c, c, m, a);
      }
    this.addOuterBand(pos, nrm, depth, idx);
    this.geo.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('depth', new THREE.Float32BufferAttribute(depth, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.geo = g;
    this.mesh.geometry = g;
    for (const m of this.murk) m.geometry = g;
    this.mesh.visible = idx.length > 0;
  }

  /**
   * Ponds touching the map border continue into the decorative landscape until
   * its ground rises above the water line (the outer ground starts at the
   * carved edge height), so they never end in a dry hollow.
   */
  private addOuterBand(pos: number[], nrm: number[], depth: number[], idx: number[]): void {
    const w = this.world;
    let touches = false;
    for (let i = 0; i < MAP_W && !touches; i++)
      touches =
        isWater(w.terrain[w.idx(i, 0)] as Terrain) ||
        isWater(w.terrain[w.idx(i, MAP_H - 1)] as Terrain) ||
        isWater(w.terrain[w.idx(0, Math.min(i, MAP_H - 1))] as Terrain) ||
        isWater(w.terrain[w.idx(MAP_W - 1, Math.min(i, MAP_H - 1))] as Terrain);
    if (!touches) return;
    const BAND = 26,
      C = 2;
    const W = MAP_W * TILE,
      H = MAP_H * TILE;
    const n = Math.round((W + 2 * BAND) / C),
      m = Math.round((H + 2 * BAND) / C);
    const vid = new Int32Array((n + 1) * (m + 1)).fill(-1);
    const hcache = new Float32Array((n + 1) * (m + 1)).fill(NaN);
    const hAt = (i: number, j: number): number => {
      const k = j * (n + 1) + i;
      if (Number.isNaN(hcache[k])) hcache[k] = this.outerHeight(-BAND + i * C, -BAND + j * C);
      return hcache[k];
    };
    const vert = (i: number, j: number): number => {
      const k = j * (n + 1) + i;
      if (vid[k] >= 0) return vid[k];
      const x = -BAND + i * C,
        z = -BAND + j * C;
      vid[k] = pos.length / 3;
      pos.push(x, WATER_LEVEL, z);
      nrm.push(0, 1, 0);
      depth.push(WATER_LEVEL - hAt(i, j));
      return vid[k];
    };
    for (let j = 0; j < m; j++)
      for (let i = 0; i < n; i++) {
        const x0 = -BAND + i * C,
          z0 = -BAND + j * C;
        if (x0 >= 0 && x0 + C <= W && z0 >= 0 && z0 + C <= H) continue; // inside the map
        // only near border water
        const cx = Math.min(Math.max(Math.floor((x0 + C / 2) / TILE), 0), MAP_W - 1);
        const cz = Math.min(Math.max(Math.floor((z0 + C / 2) / TILE), 0), MAP_H - 1);
        if (!this.tileNeedsWater(cx, cz)) continue;
        if (Math.min(hAt(i, j), hAt(i + 1, j), hAt(i, j + 1), hAt(i + 1, j + 1)) > WATER_LEVEL + 0.03) continue;
        const a = vert(i, j),
          b = vert(i + 1, j),
          c = vert(i, j + 1),
          d = vert(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
    for (const m of this.murk) (m.material as THREE.Material).dispose();
  }
}
