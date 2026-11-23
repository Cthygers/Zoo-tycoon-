// Visual harness for the props layer (src/props): fences of every type
// (rectangles, an L-shape, a wall over a hill, fences along and across a
// pond), objects of every def (placeholders where no builder is registered),
// litter and a highlighted object. Own minimal sky / sun / ground.
//
// URL params:
//   ?night=1                       moonlit night with lamps
//   ?view=overview|timber|chain|stone|glass|steel|water|litter|guest|top
//   ?q=low|medium|high             quality tier (default medium)
//   ?many=1                        ~300 placed objects (draw-call test)
//   ?hl=<defId>|none               object to highlight (default tree_oak)
//   ?cam=x,y,z&at=x,y,z            explicit camera
//   ?prewarm=1                     run props.prewarm() first (logs the time)
//   ?switchq=low|medium|high       switch the props quality tier at runtime after a few frames
//   ?dispose=1                     dispose the layer after a few frames (leak / error check)
//   ?view=fade                     camera inside a tree canopy (near-camera foliage fade)
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { World, type EdgeRef } from '../src/core/world';
import { Terrain, type Litter } from '../src/core/types';
import { MAP_H, MAP_W, TILE, WATER_LEVEL } from '../src/core/constants';
import type { QualityLevel, QualitySettings } from '../src/core/contracts';
import { Noise, Rng } from '../src/core/rng';
import { OBJECTS, OBJECTS_BY_ID } from '../src/data/objects';
import { PROP_SPECS, PropsLayer, registerProp, type PropsBackend } from '../src/props';
import type { RenderContext } from '../src/render';
import { paintedMetalMaterial, projectBoxUVs, stoneMaterial, woodMaterial } from '../src/props/materials';
import { windUniforms } from '../src/props/wind';

const params = new URLSearchParams(location.search);
const night = params.get('night') === '1';
const view = params.get('view') ?? 'overview';
const qLevel = (params.get('q') ?? 'medium') as QualityLevel;
const many = params.get('many') === '1';

const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: { level: 'low', pixelRatio: 1, antialias: false, shadows: true, shadowMapSize: 1024, grassDensity: 0.25, postFX: false, detailDistance: 26, creatureDetail: 0 },
  medium: { level: 'medium', pixelRatio: 1, antialias: true, shadows: true, shadowMapSize: 2048, grassDensity: 0.5, postFX: true, detailDistance: 40, creatureDetail: 1 },
  high: { level: 'high', pixelRatio: 1, antialias: true, shadows: true, shadowMapSize: 4096, grassDensity: 1, postFX: true, detailDistance: 55, creatureDetail: 2 },
};
const quality = QUALITY[qLevel];

// ---------------------------------------------------------------------------
// Harness-only stand-in builders (used only while the real nature/structures
// builders are missing) so wind, night glow and unique animation are tested.

function leafTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const rng = new Rng(5);
  for (let i = 0; i < 70; i++) {
    const x = rng.range(20, 236);
    const y = rng.range(20, 236);
    const a = rng.range(0, Math.PI * 2);
    const l = rng.range(16, 26);
    const s = rng.range(0.75, 1.05);
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.fillStyle = `rgb(${Math.round(52 * s)},${Math.round(72 * s)},${Math.round(30 * s)})`;
    g.beginPath();
    g.ellipse(0, 0, l, l * 0.45, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function registerStandIns(): void {
  const missing = (id: string) => !PROP_SPECS[id];
  if (missing('tree_oak')) {
    const leafMat = new THREE.MeshStandardMaterial({ map: leafTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 });
    leafMat.userData.sway = 0.022;
    const bark = woodMaterial().clone();
    bark.color.setRGB(0.55, 0.5, 0.45);
    bark.userData.sway = 0.006;
    registerProp('tree_oak', {
      variants: 2,
      jitter: { yaw: true, scale: [0.85, 1.15] },
      build(v) {
        const grp = new THREE.Group();
        const trunk = new THREE.CylinderGeometry(0.16, 0.28, 4.2, 9);
        trunk.translate(0, 2.1, 0);
        grp.add(new THREE.Mesh(trunk, bark));
        const rng = new Rng(100 + v);
        const cards: THREE.BufferGeometry[] = [];
        for (let i = 0; i < 46; i++) {
          const p = new THREE.PlaneGeometry(1.7, 1.7);
          p.rotateY(rng.range(0, Math.PI));
          p.rotateX(rng.range(-0.6, 0.6));
          const r = rng.range(0.3, 2.3);
          const a = rng.range(0, Math.PI * 2);
          p.translate(Math.cos(a) * r, rng.range(3.4, 6.4) - r * 0.25, Math.sin(a) * r);
          cards.push(p);
        }
        const merged = mergeGeos(cards);
        grp.add(new THREE.Mesh(merged, leafMat));
        return grp;
      },
    });
  }
  if (missing('lamp')) {
    const post = paintedMetalMaterial(0x23302a);
    const glow = new THREE.MeshStandardMaterial({ color: 0xfff2d8, emissive: 0xffd49a, emissiveIntensity: 0, roughness: 0.3 });
    glow.userData.nightEmissive = 6;
    registerProp('lamp', {
      variants: 1,
      build() {
        const grp = new THREE.Group();
        const p = new THREE.CylinderGeometry(0.045, 0.07, 3.2, 10);
        p.translate(0, 1.6, 0);
        projectBoxUVs(p, 1, 'y');
        grp.add(new THREE.Mesh(p, post));
        const l = new THREE.CylinderGeometry(0.16, 0.11, 0.36, 8);
        l.translate(0, 3.35, 0);
        const lm = new THREE.Mesh(l, glow);
        lm.userData.noShadow = true;
        grp.add(lm);
        return grp;
      },
    });
  }
  if (missing('fountain')) {
    const stone = stoneMaterial();
    const water = new THREE.MeshStandardMaterial({ color: 0x1d3a3a, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.85 });
    registerProp('fountain', {
      variants: 1,
      unique: true,
      build() {
        const grp = new THREE.Group();
        const basin = new THREE.CylinderGeometry(1.6, 1.7, 0.5, 28, 1, true);
        basin.translate(0, 0.25, 0);
        projectBoxUVs(basin, 1.5);
        const bm = new THREE.Mesh(basin, stone);
        bm.material.side = THREE.DoubleSide;
        grp.add(bm);
        const ped = new THREE.CylinderGeometry(0.18, 0.3, 1.3, 12);
        ped.translate(0, 0.65, 0);
        projectBoxUVs(ped, 1.5);
        grp.add(new THREE.Mesh(ped, stone));
        const surf = new THREE.Mesh(new THREE.CircleGeometry(1.6, 28).rotateX(-Math.PI / 2), water);
        surf.position.y = 0.38;
        surf.name = 'water';
        grp.add(surf);
        const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.08, 0.8, 8).translate(0, 0.4, 0), new THREE.MeshStandardMaterial({ color: 0xcfe6ee, transparent: true, opacity: 0.55, roughness: 0.1 }));
        jet.position.y = 1.3;
        jet.name = 'jet';
        grp.add(jet);
        return grp;
      },
      animate(obj, t) {
        const jet = obj.getObjectByName('jet');
        if (jet) jet.scale.y = 0.85 + 0.15 * Math.sin(t * 9);
        const w = obj.getObjectByName('water');
        if (w) w.position.y = 0.38 + 0.004 * Math.sin(t * 2.3);
      },
    });
  }
}

function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  let ni = 0;
  for (const g of list) {
    n += g.getAttribute('position').count;
    ni += g.index!.count;
  }
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const idx = new Uint32Array(ni);
  let o = 0;
  let oi = 0;
  for (const g of list) {
    const c = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    uv.set(g.getAttribute('uv').array as Float32Array, o * 2);
    const gi = g.index!.array;
    for (let i = 0; i < gi.length; i++) idx[oi + i] = gi[i] + o;
    o += c;
    oi += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

registerStandIns();

// ?stress=1: synthetic builders for every missing def (3 variants × 3 meshes,
// 2 shared materials per def) to measure draw calls of realistic multi-mesh props.
if (params.get('stress') === '1') {
  const palette = [0x6b5a44, 0x4d5a3a, 0x7a7468, 0x5a4636, 0x3e4a52];
  OBJECTS.forEach((d, di) => {
    if (PROP_SPECS[d.id]) return;
    const mA = new THREE.MeshStandardMaterial({ color: palette[di % 5], roughness: 0.8 });
    const mB = new THREE.MeshStandardMaterial({ color: palette[(di + 2) % 5], roughness: 0.6 });
    const w = d.size[0] * TILE * 0.7;
    const dd = d.size[1] * TILE * 0.7;
    registerProp(d.id, {
      variants: 3,
      build(v) {
        const g = new THREE.Group();
        const h = 0.6 + v * 0.3 + (d.category === 'tree' ? 4 : 0);
        g.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, dd).translate(0, h / 2, 0), mA));
        g.add(new THREE.Mesh(new THREE.CylinderGeometry(w * 0.2, w * 0.25, h * 0.5, 8).translate(w * 0.2, h + h * 0.25, 0), mB));
        g.add(new THREE.Mesh(new THREE.SphereGeometry(w * 0.15, 8, 6).translate(-w * 0.2, h + 0.1 * v, 0), mA));
        return g;
      },
    });
  });
}

// ---------------------------------------------------------------------------
// World

const events = new EventBus();
const world = new World(events, 4242);
// a hill under the stone-wall enclosure
for (let cz = 0; cz <= MAP_H; cz++)
  for (let cx = 0; cx <= MAP_W; cx++) {
    const d2 = (cx - 27.5) ** 2 + (cz - 7.5) ** 2;
    world.relief[world.cornerIdx(cx, cz)] += 2.4 * Math.exp(-d2 / (2 * 3.3 * 3.3));
  }
world.recomputeHeights({ x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 });
// a pond between the glass and steel enclosures
{
  const n = new Noise(3);
  const pcx = 16;
  const pcz = 20.5;
  const R = { x0: 6, z0: 14, x1: 26, z1: 27 };
  world.setTerrainRect(R, Terrain.Water, (x, z) => Math.hypot((x - pcx) / 7.5, (z - pcz) / 3.6) + n.noise2(x * 0.4, z * 0.4) * 0.12 < 1);
  world.setTerrainRect(R, Terrain.DeepWater, (x, z) => Math.hypot((x - pcx) / 5, (z - pcz) / 2.2) < 1);
  world.setTerrainRect(R, Terrain.Mud, (x, z) => world.getTerrain(x, z) !== Terrain.Water && world.getTerrain(x, z) !== Terrain.DeepWater && Math.hypot((x - pcx) / 8.6, (z - pcz) / 4.6) < 1);
}
world.setTerrainRect({ x0: 4, z0: 4, x1: 10, z1: 9 }, Terrain.DryGrass);
world.setTerrainRect({ x0: 23, z0: 3, x1: 31, z1: 11 }, Terrain.Rock, (x, z) => (x * 7 + z * 3) % 5 < 2);


// ---------------------------------------------------------------------------
// Renderer: the game's RenderContext (?ctx=1) or an own minimal sky / sun / ground

const container = document.getElementById('game')!;
const info = document.getElementById('info')!;
const useCtx = params.get('ctx') === '1';
let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let sun: THREE.DirectionalLight | null = null;
let ctx: RenderContext | null = null;
const sunDir = night ? new THREE.Vector3(-0.35, 0.62, -0.5).normalize() : new THREE.Vector3(0.55, 0.62, 0.42).normalize();
if (useCtx) {
  const r = await import('../src/render');
  ctx = (await r.createRenderContext(container, world, events, qLevel)) as RenderContext;
  renderer = ctx.renderer;
  scene = ctx.scene;
  camera = ctx.camera;
} else {

  renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = night ? 3.2 : 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1500);


  function skyMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSun: { value: sunDir },
        uNight: { value: night ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun; uniform float uNight; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.2, 1.0);
          vec3 zen = mix(vec3(0.18, 0.36, 0.78), vec3(0.004, 0.007, 0.016), uNight);
          vec3 hor = mix(vec3(0.72, 0.8, 0.9), vec3(0.02, 0.025, 0.04), uNight);
          vec3 gnd = mix(vec3(0.24, 0.23, 0.2), vec3(0.006, 0.006, 0.008), uNight);
          vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor, gnd, clamp(-h * 6.0, 0.0, 1.0));
          float s = max(dot(d, uSun), 0.0);
          c += mix(vec3(1.0, 0.9, 0.7) * (pow(s, 600.0) * 40.0 + pow(s, 8.0) * 0.35), vec3(0.8, 0.85, 1.0) * pow(s, 2000.0) * 6.0, uNight);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  }

  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMaterial());
  sky.frustumCulled = false;
  scene.add(sky);
  {
    const envScene = new THREE.Scene();
    const s2 = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMaterial());
    envScene.add(s2);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = night ? 0.6 : 0.85;
    pmrem.dispose();
  }

  sun = new THREE.DirectionalLight(night ? 0x9fb4ff : 0xfff1dd, night ? 0.22 : 2.4);
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(night ? 0x223044 : 0xbfd2ff, night ? 0x0b0a08 : 0x4a4232, night ? 0.05 : 0.35);
  scene.add(hemi);

  // ground mesh (bilinear like World.heightAt) + water plane
  function terrainColor(t: Terrain, c: THREE.Color, v: number): void {
    switch (t) {
      case Terrain.DryGrass:
        c.setRGB(0.25 + v, 0.21 + v, 0.1);
        break;
      case Terrain.Rock:
        c.setRGB(0.2 + v, 0.19 + v, 0.17 + v);
        break;
      case Terrain.Mud:
        c.setRGB(0.1 + v * 0.5, 0.08 + v * 0.5, 0.05);
        break;
      case Terrain.Water:
      case Terrain.DeepWater:
        c.setRGB(0.12, 0.1, 0.07);
        break;
      default:
        c.setRGB(0.09 + v * 0.6, 0.13 + v, 0.045);
    }
  }
  {
    const N = MAP_W * 2;
    const g = new THREE.PlaneGeometry(MAP_W * TILE, MAP_H * TILE, N, N);
    g.rotateX(-Math.PI / 2);
    g.translate((MAP_W * TILE) / 2, 0, (MAP_H * TILE) / 2);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    const n = new Noise(9);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      p.setY(i, world.heightAt(x, z));
      const t = world.getTerrain(Math.floor(Math.min(x, MAP_W * TILE - 0.01) / TILE), Math.floor(Math.min(z, MAP_H * TILE - 0.01) / TILE));
      terrainColor(t, c, n.fbm2(x * 0.15, z * 0.15, 3) * 0.04);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    ground.receiveShadow = true;
    scene.add(ground);
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 20).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0c1a16, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.82 }),
    );
    water.position.set(16 * TILE, WATER_LEVEL, 20.5 * TILE);
    water.receiveShadow = true;
    scene.add(water);
  }

}

// ---------------------------------------------------------------------------
// Props layer (created before content so the event paths are exercised)

const props = new PropsLayer(world, events, scene, ctx ? ctx.quality : quality, { backend: (params.get('backend') ?? 'auto') as PropsBackend });

function fenceRect(x0: number, z0: number, x1: number, z1: number, id: number) {
  for (const e of world.edgesAroundRect({ x0, z0, x1, z1 })) world.setFence(e, id, false);
}
function fenceOutline(tiles: [number, number][], id: number) {
  const key = (x: number, z: number) => `${x},${z}`;
  const set = new Set(tiles.map(([x, z]) => key(x, z)));
  const edges: EdgeRef[] = [];
  for (const [x, z] of tiles) {
    if (!set.has(key(x, z - 1))) edges.push({ dir: 'h', x, z });
    if (!set.has(key(x, z + 1))) edges.push({ dir: 'h', x, z: z + 1 });
    if (!set.has(key(x - 1, z))) edges.push({ dir: 'v', x, z });
    if (!set.has(key(x + 1, z))) edges.push({ dir: 'v', x: x + 1, z });
  }
  for (const e of edges) world.setFence(e, id, false);
}
// 1 timber rectangle
fenceRect(4, 4, 10, 9, 1);
// 2 chain-link L-shape
{
  const t: [number, number][] = [];
  for (let z = 4; z <= 8; z++) for (let x = 13; x <= 20; x++) t.push([x, z]);
  for (let z = 9; z <= 13; z++) for (let x = 13; x <= 16; x++) t.push([x, z]);
  fenceOutline(t, 2);
}
// 3 dry-stone wall over the hill
fenceRect(23, 3, 31, 11, 3);
// 4 glass viewing wall reaching into the pond
fenceRect(4, 15, 11, 21, 4);
// 5 steel barrier along the water's edge
fenceRect(21, 16, 29, 23, 5);
// timber fence straight across the pond
for (let x = 12; x < 21; x++) world.setFence({ dir: 'h', x, z: 21 }, 1, false);
world.recomputeHabitats();

let seedN = 1;
function place(defId: string, tx: number, tz: number, rot = 0) {
  if (!OBJECTS_BY_ID[defId]) return;
  // raw add (no rules) for the harness, but never overlap
  for (const t of world.footprint({ defId, tx, tz, rot })) if (world.objectAt(t.x, t.z)) return;
  world.addObject(defId, tx, tz, rot, 7919 * seedN++);
}
// timber paddock (savanna)
place('tree_acacia', 6, 5);
place('feeder_hay', 9, 5);
place('water_trough', 5, 8);
place('rock_small', 8, 7);
place('grass_tall', 7, 8);
place('grass_tall', 9, 8);
place('bush_savanna', 5, 6);
place('tree_oak', 7, 6, 1);
// chain-link (temperate)
place('tree_oak', 14, 5);
place('tree_birch', 18, 5);
place('tree_birch', 19, 7);
place('log_fallen', 15, 7, 0);
place('climbing_frame', 17, 6);
place('toy_ball', 14, 10);
place('bush_fern', 15, 12);
place('tree_oak', 13, 12, 2);
// stone wall (rocky hill)
place('rock_outcrop', 26, 6);
place('shelter_cave', 29, 8, 3);
place('tree_pine', 24, 4);
place('tree_pine', 30, 4);
place('rock_boulder', 25, 9);
place('feeder_meat', 28, 10);
// glass (tropical / water)
place('tree_palm', 5, 16);
place('bamboo', 6, 17);
place('bamboo', 5, 18);
place('reeds', 9, 19);
place('reeds', 10, 20);
place('rock_ice', 7, 16);
// steel (big)
place('shelter_wood', 23, 17, 1);
place('tree_baobab', 26, 18);
place('cactus', 28, 17);
place('tree_acacia', 27, 21);
// guest area
place('entrance_gate', 15, 34);
place('shop_snack', 4, 25);
place('shop_drinks', 7, 25);
place('shop_icecream', 9, 25);
place('shop_gift', 11, 25);
place('restroom', 14, 25);
place('bench', 17, 26, 2);
place('bench', 19, 26, 2);
place('bin', 18, 26);
place('lamp', 16, 26);
place('lamp', 21, 26);
place('lamp', 11, 28);
place('lamp', 6, 28);
place('picnic_table', 22, 27);
place('donation_box', 20, 24);
place('fountain', 17, 29);
place('info_sign', 12, 23);
place('info_sign', 23, 24);
place('flower_bed', 20, 29);
place('flower_bed', 21, 29);
place('hedge', 24, 26);
place('hedge', 24, 27);
place('hedge', 24, 28);
// one of every def not yet placed (stragglers row)
{
  let x = 26;
  for (const d of OBJECTS) {
    if ([...world.objects.values()].some((o) => o.defId === d.id)) continue;
    place(d.id, x, 30);
    x += d.size[0] + 1;
  }
}
if (many) {
  const rng = new Rng(77);
  const ids = OBJECTS.filter((d) => !d.notBuildable).map((d) => d.id);
  let tries = 0;
  while (world.objects.size < 300 && tries++ < 5000) {
    const def = OBJECTS_BY_ID[rng.pick(ids)];
    const tx = rng.int(33, MAP_W - 3);
    const tz = rng.int(2, MAP_H - 3);
    let free = true;
    for (const t of world.footprint({ defId: def.id, tx, tz, rot: 0 })) if (world.objectAt(t.x, t.z) || !world.inBounds(t.x, t.z)) free = false;
    if (free) world.addObject(def.id, tx, tz, rng.int(0, 3), rng.int(0, 1e9));
  }
}
// exercise removal + swap-remove: add and remove a few
{
  const tmp = [world.addObject('rock_small', 40, 40, 0, 1), world.addObject('rock_small', 41, 40, 0, 2), world.addObject('tree_oak', 42, 40, 0, 3)];
  world.removeObject(tmp[0].id);
  world.removeObject(tmp[2].id);
  world.removeObject(tmp[1].id);
}

// litter: trash around the guest area, dung in the paddocks
{
  const rng = new Rng(31);
  const items: Litter[] = [];
  let id = 1;
  for (let i = 0; i < 70; i++) items.push({ id: id++, x: rng.range(8, 50), z: rng.range(52, 62), kind: 'trash' });
  for (let i = 0; i < 6; i++) items.push({ id: id++, x: rng.range(10, 20), z: rng.range(10, 18), kind: 'dung' });
  for (let i = 0; i < 6; i++) items.push({ id: id++, x: rng.range(44, 56), z: rng.range(34, 44), kind: 'dung' });
  props.setLitter(items);
}

// highlight
{
  const hl = params.get('hl') ?? 'tree_oak';
  if (hl !== 'none') {
    const o = [...world.objects.values()].find((x) => x.defId === hl);
    if (o) props.setHighlight(o.id);
  }
}

// standalone ghost / thumbnail models (UI path): one segment per fence type + an object
if (params.get('ghosts') === '1') {
  const y = world.heightAt(60, 66);
  [1, 2, 3, 4, 5].forEach((id, i) => {
    const seg = props.createFenceSegmentModel(id);
    seg.position.set(52 + i * 3.2, y, 66);
    scene.add(seg);
  });
  const ghost = props.createObjectModel('tree_oak', 3);
  ghost.position.set(70, y, 66);
  for (const m of ghost.userData.ownedMaterials as THREE.Material[]) {
    const sm = m as THREE.MeshStandardMaterial;
    sm.color?.setRGB(0.5, 1.0, 0.5);
    sm.transparent = true;
    sm.opacity = 0.6;
  }
  scene.add(ghost);
}

// ---------------------------------------------------------------------------
// Camera

const views: Record<string, { cam: [number, number, number]; at: [number, number, number] }> = {
  overview: { cam: [70, 52, 95], at: [34, 0, 30] },
  top: { cam: [36, 120, 40], at: [36, 0, 39] },
  timber: { cam: [24, 3.6, 25], at: [14, 0.8, 13] },
  chain: { cam: [45, 4.2, 33], at: [34, 1.2, 18] },
  stone: { cam: [70, 6, 32], at: [56, 2.2, 16] },
  glass: { cam: [29, 2.4, 47], at: [18, 1.1, 38] },
  steel: { cam: [33, 3.4, 54], at: [44, 2, 44] },
  water: { cam: [32, 4.5, 50], at: [28, 0, 40] },
  litter: { cam: [30, 2.6, 62], at: [28, 0, 56] },
  guest: { cam: [36, 14, 72], at: [30, 1, 52] },
  ghosts: { cam: [60, 4, 76], at: [60, 1.2, 66] },
  fade: { cam: [17, 5.2, 18], at: [13, 0.5, 8] },
  lamps: { cam: [40, 9, 66], at: [32, 0.5, 52] },
};
const v = views[view] ?? views.overview;
if (params.has('cam')) v.cam = params.get('cam')!.split(',').map(Number) as [number, number, number];
if (params.has('at')) v.at = params.get('at')!.split(',').map(Number) as [number, number, number];
camera.position.set(...v.cam);
camera.lookAt(...v.at);

// shadow frustum around the view target
if (ctx) {
  const r = view === 'overview' || view === 'top' ? 70 : 28;
  ctx.setFocus(v.at[0], v.at[2], r);
  ctx.resize(container.clientWidth, container.clientHeight);
  ctx.setTimeOfDay(night ? 22 * 60 + 30 : 14 * 60, 1);
  ctx.settle();
} else if (sun) {
  const [ax, , az] = v.at;
  const r = view === 'overview' || view === 'top' ? 70 : 28;
  sun.target.position.set(ax, 0, az);
  sun.position.set(ax + sunDir.x * 120, sunDir.y * 120, az + sunDir.z * 120);
  const sc = sun.shadow.camera;
  sc.left = -r;
  sc.right = r;
  sc.top = r;
  sc.bottom = -r;
  sc.near = 1;
  sc.far = 300;
  sc.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Loop

if (params.has('wind')) windUniforms.uWindStrength.value = Number(params.get('wind'));
let frames = 0;
let last = performance.now();
const switchTo = params.get('switchq') as QualityLevel | null;
const disposeAfter = params.get('dispose') === '1';
let disposed = false;
const loop = () => {
  if (disposed) return;
  if (switchTo && frames === 3) {
    const t0 = performance.now();
    props.setQuality(QUALITY[switchTo]);
    console.log(`[props-stats] setQuality(${switchTo}) took ${(performance.now() - t0).toFixed(0)} ms`);
  }
  if (disposeAfter && frames === 6) {
    props.dispose();
    disposed = true;
    renderer.render(scene, camera);
    console.log(`[props-stats] disposed; scene children ${scene.children.length} geoms ${renderer.info.memory.geometries} tex ${renderer.info.memory.textures}`);
    return;
  }
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (ctx) {
    ctx.setTimeOfDay(night ? 22 * 60 + 30 : 14 * 60, 1);
    if (frames < 3) ctx.settle();
    props.update(frames < 2 ? 0.016 : dt, ctx.nightFactor, camera);
    ctx.update(frames < 2 ? 0.016 : dt);
    ctx.render();
  } else {
    props.update(frames < 2 ? 0.016 : dt, night ? 1 : 0, camera);
    renderer.render(scene, camera);
  }
  frames++;
  const ri = ctx ? ctx.debugInfo() : renderer.info.render;
  const d = props.debugInfo();
  info.textContent = `${qLevel} ${view}${night ? ' night' : ''} ${d.backend}  objects ${world.objects.size}  calls ${ri.calls}  tris ${(ri.triangles / 1000).toFixed(0)}k  batches ${d.liveBatches}/${d.batches} inst ${d.instances} drawn ${d.drawn} uniq ${d.uniques} fenceMeshes ${d.fenceMeshes} lod ${d.lodObjects}/${d.lodSwitches} fade ${d.fade.toFixed(2)} pools ${d.night.poolTris} halos ${d.night.halos}`;
  if (frames === 4) console.log(`[props-stats] ${info.textContent}  programs ${renderer.info.programs?.length ?? 0} geoms ${renderer.info.memory.geometries} tex ${renderer.info.memory.textures}`);
  requestAnimationFrame(loop);
};
if (params.get('prewarm') === '1') {
  const t0 = performance.now();
  void props.prewarm().then(() => {
    console.log(`[props-stats] prewarm ${(performance.now() - t0).toFixed(0)} ms, templates ${props.debugInfo().templates}`);
    requestAnimationFrame(loop);
  });
} else requestAnimationFrame(loop);

window.addEventListener('resize', () => {
  if (ctx) return ctx.resize(container.clientWidth, container.clientHeight);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});
// picking test from the console / screenshot script
(window as unknown as Record<string, unknown>).__props = {
  props,
  world,
  camera,
  pickAt(nx: number, ny: number) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const id = props.pickObject(rc);
    return id === null ? null : { id, defId: world.objects.get(id)?.defId };
  },
};
