// Visual harness for the rendering core.
// URL params:
//   ?view=game|low|far|top   camera preset (default game)
//   ?time=HH:MM              game clock (default 12:00)
//   ?q=low|medium|high       quality tier (default medium)
//   ?focus=x,z&yaw=deg&pitch=deg&dist=m   override the preset
//   ?anim=1                  let the clock run (1 game-minute per real second)
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/world';
import { PathType, Terrain } from '../src/core/types';
import { MAP_H, MAP_W, TILE } from '../src/core/constants';
import type { QualityLevel } from '../src/core/contracts';
import { createRenderContext, RenderContext } from '../src/render';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'game';
const q = (params.get('q') ?? 'medium') as QualityLevel;
const [hh, mm] = (params.get('time') ?? '12:00').split(':').map(Number);
let minute = hh * 60 + (mm || 0);

const events = new EventBus();
const world = new World(events, 12345);
world.generateStarterMap();

// ---------------------------------------------------------------- demo terrain
const rect = (x0: number, z0: number, x1: number, z1: number) => ({ x0, z0, x1, z1 });
const blob = (cx: number, cz: number, rx: number, rz: number, t: Terrain) => {
  world.setTerrainRect(rect(cx - rx, cz - rz, cx + rx, cz + rz), t, (x, z) => {
    const d = Math.hypot((x - cx) / rx, (z - cz) / rz) + Math.sin(x * 1.7 + z * 0.9) * 0.12;
    return d < 1;
  });
};
// savanna with a sandy patch and a rocky outcrop area
blob(52, 40, 11, 9, Terrain.DryGrass);
blob(55, 38, 4, 3, Terrain.Sand);
blob(22, 43, 4, 4, Terrain.Rock);
blob(47, 46, 3, 2, Terrain.Dirt);
// arctic corner
blob(10, 54, 5, 4, Terrain.Snow);
// an extra deep pond with a muddy margin
blob(52, 17, 6, 5, Terrain.Mud);
blob(52, 17, 5, 4, Terrain.Water);
blob(52, 17, 3, 2, Terrain.DeepWater);
// desert strip
blob(64, 56, 4, 5, Terrain.Sand);

// find the starter pond and lay a boardwalk across it
let px = 0,
  pz = 0,
  pn = 0;
for (let z = 0; z < MAP_H / 2; z++)
  for (let x = 0; x < MAP_W / 2; x++)
    if (world.getTerrain(x, z) === Terrain.DeepWater) {
      px += x;
      pz += z;
      pn++;
    }
const pondX = Math.round(px / Math.max(1, pn)),
  pondZ = Math.round(pz / Math.max(1, pn));
const clearTile = (x: number, z: number) => {
  const o = world.objectAt(x, z);
  if (o && o.defId !== 'entrance_gate') world.removeObject(o.id);
};
const path = (x: number, z: number, t: PathType) => {
  clearTile(x, z);
  world.setPath(x, z, t);
};
for (let x = pondX - 9; x <= pondX + 9; x++) path(x, pondZ, PathType.Boardwalk);
// gravel path from the plaza cross-path west and north to the boardwalk
const crossZ = MAP_H - 1 - 14;
for (let x = 18; x <= 28; x++) path(x, crossZ, PathType.Gravel);
for (let z = pondZ + 1; z <= crossZ; z++) path(18, z, PathType.Gravel);
for (let x = pondX + 10; x <= 18; x++) path(x, pondZ, PathType.Gravel);
// paved path north from the cross path through the savanna
for (let z = 28; z < crossZ; z++) path(44, z, PathType.Paved);
for (let x = 44; x <= 60; x++) path(x, 28, PathType.Paved);
path(45, 28, PathType.Paved);
path(45, 29, PathType.Paved);
path(43, 40, PathType.Paved);
// gravel spur to the second pond
for (let z = 23; z < 28; z++) path(52, z, PathType.Gravel);

// ---------------------------------------------------------------- render ctx
const container = document.getElementById('game')!;
const info = document.getElementById('info')!;
const ctx = (await createRenderContext(container, world, events, q)) as RenderContext;

interface Preset {
  focus: [number, number];
  yaw: number; // degrees, 0 = camera south of focus looking north
  pitch: number;
  dist: number;
}
const presets: Record<string, Preset> = {
  game: { focus: [40 * TILE, 50 * TILE], yaw: 25, pitch: 50, dist: 45 },
  low: { focus: [(pondX + 1) * TILE, (pondZ - 1) * TILE], yaw: 200, pitch: 6, dist: 20 },
  far: { focus: [MAP_W, MAP_H], yaw: 20, pitch: 38, dist: 190 },
  top: { focus: [MAP_W, MAP_H], yaw: 0, pitch: 89, dist: 220 },
  pond: { focus: [(pondX + 0) * TILE, (pondZ + 2) * TILE], yaw: 160, pitch: 35, dist: 28 },
  savanna: { focus: [52 * TILE, 38 * TILE], yaw: 30, pitch: 30, dist: 32 },
};
const p: Preset = { ...(presets[view] ?? presets.game) };
if (params.has('focus')) {
  const [fx, fz] = params.get('focus')!.split(',').map(Number);
  p.focus = [fx, fz];
}
if (params.has('yaw')) p.yaw = Number(params.get('yaw'));
if (params.has('pitch')) p.pitch = Number(params.get('pitch'));
if (params.has('dist')) p.dist = Number(params.get('dist'));

const cam = ctx.camera;
function applyView(pp: Preset, low = false) {
  const fy = world.heightAt(pp.focus[0], pp.focus[1]);
  const yaw = (pp.yaw * Math.PI) / 180,
    pitch = (pp.pitch * Math.PI) / 180;
  cam.position.set(
    pp.focus[0] + Math.sin(yaw) * Math.cos(pitch) * pp.dist,
    fy + Math.sin(pitch) * pp.dist,
    pp.focus[1] + Math.cos(yaw) * Math.cos(pitch) * pp.dist,
  );
  if (low) cam.position.y = Math.max(cam.position.y, world.heightAt(cam.position.x, cam.position.z) + 1.7);
  cam.lookAt(pp.focus[0], fy + (low ? 1.2 : 0), pp.focus[1]);
  // same heuristic as the game camera (ui/camera.ts)
  const cp = Math.cos(pitch);
  ctx.setFocus(pp.focus[0], pp.focus[1], pp.dist * (0.85 + 1.5 * cp * cp));
}
applyView(p, view === 'low');
ctx.resize(container.clientWidth, container.clientHeight);
ctx.setTimeOfDay(minute, 1);
ctx.settle();

// ?atlas=1: show the foliage clump atlas in a corner (texture debug)
let atlasScene: THREE.Scene | null = null;
const atlasCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
if (params.get('atlas') === '1') {
  atlasScene = new THREE.Scene();
  const tex = (ctx as unknown as { textures: { foliage: THREE.Texture } }).textures.foliage;
  const mat = new THREE.ShaderMaterial({
    uniforms: { t: { value: tex } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'uniform sampler2D t; varying vec2 vUv; void main(){ vec4 c = texture2D(t, fract(vUv * vec2(2.0, 1.0))); vec3 col = vUv.x < 0.5 ? vec3(c.r) * c.a + vec3(0.3, 0.5, 0.8) * (1.0 - c.a) : vec3(c.gb, 1.0) * c.a; gl_FragColor = vec4(col, 1.0); }',
    toneMapped: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5 * (container.clientWidth / container.clientHeight) * 0.5), mat);
  quad.position.set(0.25, 0.75, 0);
  atlasScene.add(quad);
}

const anim = params.get('anim') === '1';
let frames = 0;
let last = performance.now();
const loop = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (anim) minute = (minute + dt) % 1440;
  ctx.setTimeOfDay(minute, 1);
  if (frames < 3) ctx.settle();
  ctx.update(frames < 2 ? 0.016 : dt);
  ctx.render();
  if (atlasScene) {
    const r = ctx.renderer;
    r.autoClear = false;
    r.render(atlasScene, atlasCam);
    r.autoClear = true;
  }
  frames++;
  const d = ctx.debugInfo();
  const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(Math.floor(minute % 60)).padStart(2, '0')}`;
  info.textContent = `${q} ${view} ${hhmm}  calls ${d.calls}  tris ${(d.triangles / 1000).toFixed(0)}k  terrain ${(d.terrainTris / 1000).toFixed(1)}k  forest ${(d.forestTris / 1000).toFixed(1)}k  grass ${d.grassTufts}  shadow ${d.shadowBox.map((v) => v.toFixed(0)).join('x')}  exp ${d.exposure.toFixed(2)}  night ${ctx.nightFactor.toFixed(2)}`;
  if (frames === 6 || frames === 16) console.log(`[render-stats] frame=${frames} q=${q} view=${view} calls=${d.calls} triangles=${d.triangles} grass=${d.grassTufts}`);
  if (frames === 8) (window as unknown as { __ready: boolean }).__ready = true;
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
window.addEventListener('resize', () => ctx.resize(container.clientWidth, container.clientHeight));

// ---- automation hooks (scripts drive several shots per page load)
const hooks = {
  /** Jump the clock ('HH:MM') and snap exposure. */
  setTime(hhmmStr: string) {
    const [h, m] = hhmmStr.split(':').map(Number);
    minute = h * 60 + (m || 0);
    ctx.setTimeOfDay(minute, 1);
    ctx.settle();
  },
  /** Camera preset name, optionally overridden. */
  setView(name: string, over: Partial<Preset> = {}) {
    const pp = { ...(presets[name] ?? presets.game), ...over };
    applyView(pp, name === 'low');
  },
  stats() {
    return ctx.debugInfo();
  },
  /** Switch quality tier at runtime (exercises setQuality). */
  setQuality(level: QualityLevel) {
    ctx.setQuality(level);
    ctx.resize(container.clientWidth, container.clientHeight);
  },
};
Object.assign(window as unknown as Record<string, unknown>, { ctx, world, THREE, hooks });
