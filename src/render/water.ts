// Water surface at WATER_LEVEL over water tiles (plus a one-tile margin so the
// shoreline intersection with the terrain is covered). MeshPhysicalMaterial
// (IOR 1.33, PMREM sky reflections, real sun glint and shadows) extended with
// animated multi-octave normals, depth-based absorption (water depth comes from
// a per-vertex attribute sampled from world.heightAt with the same
// tessellation as the terrain), soft shoreline foam and premultiplied-alpha
// compositing so the reflection is not dimmed by transparency. Per-channel
// absorption of the lake bed itself happens in the ground shader, so the
// surface only veils what is below lightly in shallows (wading legs stay
// visible) and strongly over deep pools.

import * as THREE from 'three';
import { MAP_H, MAP_W, TILE, WATER_LEVEL } from '../core/constants';
import { isWater, type Terrain } from '../core/types';
import type { World } from '../core/world';
import { nearWater } from './terrain';

const CX = MAP_W + 1;

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
      uDeep: { value: new THREE.Color(0.008, 0.03, 0.034) },
      uShallow: { value: new THREE.Color(0.06, 0.09, 0.075) },
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
          varying vec3 vWPos;`,
        )
        .replace(
          '#include <map_fragment>',
          `float wDepth = vDepth;
          if (wDepth < -0.02) discard;
          vec3 wV = normalize(cameraPosition - vWPos);
          float pathLen = max(wDepth, 0.0) / max(wV.y, 0.22);
          // clear-ish shallows (the bed is tinted per channel by the ground
          // shader; wading legs stay visible), murky dark deep pools
          float turbid = mix(0.3, 0.9, smoothstep(0.95, 1.85, wDepth));
          float absorb = 1.0 - exp(-pathLen * turbid);
          // shoreline foam: thin, broken, slowly pulsing
          float fn = texture2D(uNoise, vWPos.xz * 0.6 + vec2(uTime * 0.02, -uTime * 0.015)).b;
          float fn2 = texture2D(uNoise, vWPos.xz * 1.9 - vec2(uTime * 0.03, uTime * 0.01)).g;
          float shore = 1.0 - smoothstep(0.0, 0.025 + 0.035 * fn, wDepth);
          float foam = shore * smoothstep(0.5, 0.7, fn2 * 0.6 + fn * 0.4 + 0.1 * sin(uTime * 0.8 + vWPos.x * 0.7)) * 0.45;
          foam = max(foam, (1.0 - smoothstep(0.0, 0.01, wDepth)) * 0.25 * fn2);
          diffuseColor.rgb = mix(mix(uShallow, uDeep, smoothstep(0.6, 2.4, pathLen)), vec3(0.42, 0.43, 0.41), foam);`,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.55, foam);')
        .replace(
          '#include <normal_fragment_maps>',
          `{
            vec2 p = vWPos.xz;
            vec2 s1 = texture2D(uWaves, p / 9.0 + vec2(uTime * 0.011, uTime * 0.007)).rg - 0.5;
            vec2 s2 = texture2D(uWaves, p / 3.7 + vec2(-uTime * 0.017, uTime * 0.012)).rg - 0.5;
            vec2 s3 = texture2D(uWaves, p / 1.3 + vec2(uTime * 0.026, -uTime * 0.02)).rg - 0.5;
            vec2 sl = (s1 * 0.9 + s2 * 0.6 + s3 * 0.35) * 0.3;
            // calm water near the shore
            sl *= 0.45 + 0.55 * smoothstep(0.0, 0.4, wDepth);
            vec3 nW = normalize(vec3(-sl.x, 1.0, -sl.y));
            normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
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
            vec3 wSpec = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
            float NdV = clamp(dot(normal, geometryViewDir), 0.0, 1.0);
            float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
            float a = clamp(max(absorb, foam), 0.0, 1.0);
            float alpha = a + (1.0 - a) * F;
            gl_FragColor = vec4(wDiff * a * (1.0 - F) + wSpec * (1.0 - foam * 0.7), alpha);
            gl_FragColor.a *= smoothstep(-0.02, 0.005, wDepth);
            gl_FragColor.rgb *= smoothstep(-0.02, 0.005, wDepth);
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
  }
}
