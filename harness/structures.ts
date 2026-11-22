// Visual harness for built props (src/props/structures): every def in a grid
// on a paved plaza, each with a 1.8 m reference capsule.
//
// URL params:
//   ?view=row|game|close      overview grid (default) / in-game camera / close-up
//   &id=<defId>               object to frame (game / close); close shows all its variants
//   &v=<n>                    close: only this variant
//   &night=1                  night: emissives on, a few lamp lights, moonlight
//   &layer=1                  render through the real PropsLayer + World (batching path)
//   &yaw=<deg>&pitch=<deg>&dist=<m>   camera overrides
//   &labels=0                 hide labels
//   &t=<sec>                  animation time for unique props (static frame)
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/world';
import { TILE } from '../src/core/constants';
import type { QualitySettings } from '../src/core/contracts';
import { OBJECTS_BY_ID } from '../src/data/objects';
import { PROP_SPECS, PropsLayer } from '../src/props';
import '../src/props/structures';

const params = new URLSearchParams(location.search);
const night = params.get('night') === '1';
const view = params.get('view') ?? 'row';
const focusId = params.get('id');
const onlyVariant = params.has('v') ? Number(params.get('v')) : null;
const useLayer = params.get('layer') === '1';
const showLabels = params.get('labels') !== '0';
const fixedT = params.has('t') ? Number(params.get('t')) : null;
/** In layer mode the content sits around world (72, 72) (map interior). */
const ORIGIN = useLayer ? 72 : 0;

const ORDER = [
  'entrance_gate',
  'shop_snack',
  'shop_gift',
  'restroom',
  'shop_drinks',
  'shop_icecream',
  'shelter_wood',
  'shelter_cave',
  'climbing_frame',
  'toy_ball',
  'feeder_hay',
  'feeder_meat',
  'water_trough',
  'fountain',
  'bench',
  'bin',
  'lamp',
  'picnic_table',
  'donation_box',
  'info_sign',
];

const quality: QualitySettings = {
  level: 'medium',
  pixelRatio: 1,
  antialias: true,
  shadows: true,
  shadowMapSize: 2048,
  grassDensity: 0.5,
  postFX: false,
  detailDistance: 40,
  creatureDetail: 1,
};

// ---------------------------------------------------------------------------
// Renderer / scene

const container = document.getElementById('game')!;
const labelsEl = document.getElementById('labels')!;
const info = document.getElementById('info')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = night ? 2.6 : 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.1, 1200);

const sunDir = night ? new THREE.Vector3(-0.4, 0.6, -0.5).normalize() : new THREE.Vector3(0.5, 0.62, 0.55).normalize();

function skyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uSun: { value: sunDir }, uNight: { value: night ? 1 : 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform float uNight; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -0.2, 1.0);
        vec3 zen = mix(vec3(0.2, 0.38, 0.75), vec3(0.004, 0.007, 0.016), uNight);
        vec3 hor = mix(vec3(0.75, 0.8, 0.86), vec3(0.02, 0.025, 0.04), uNight);
        vec3 gnd = mix(vec3(0.26, 0.25, 0.22), vec3(0.006, 0.006, 0.008), uNight);
        vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor, gnd, clamp(-h * 6.0, 0.0, 1.0));
        float s = max(dot(d, uSun), 0.0);
        c += mix(vec3(1.0, 0.9, 0.7) * (pow(s, 600.0) * 30.0 + pow(s, 8.0) * 0.3), vec3(0.8, 0.85, 1.0) * pow(s, 2000.0) * 6.0, uNight);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
{
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMaterial());
  sky.frustumCulled = false;
  scene.add(sky);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMaterial()));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = night ? 0.5 : 0.9;
  pmrem.dispose();
}
const sun = new THREE.DirectionalLight(night ? 0x9fb4ff : 0xfff0dc, night ? 0.15 : 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.025;
sun.shadow.radius = 3;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(night ? 0x223044 : 0xc4d4ef, night ? 0x0b0a08 : 0x4d4536, night ? 0.04 : 0.45));

// paving texture (canvas): stretcher-bond concrete pavers 0.4 × 0.2 m, 2 m repeat
function pavingTexture(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4a4843';
  g.fillRect(0, 0, S, S);
  const pw = S / 5;
  const ph = S / 10;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let row = 0; row < 10; row++)
    for (let col = -1; col < 6; col++) {
      const x = col * pw + (row % 2) * pw * 0.5;
      const y = row * ph;
      const l = 112 + Math.floor(rnd() * 22);
      g.fillStyle = `rgb(${l},${l - 4},${l - 12})`;
      g.fillRect(x + 2, y + 2, pw - 4, ph - 4);
      for (let k = 0; k < 40; k++) {
        g.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${rnd() * 0.08})`;
        g.fillRect(x + 2 + rnd() * (pw - 6), y + 2 + rnd() * (ph - 6), 2, 2);
      }
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
{
  const tex = pavingTexture();
  tex.repeat.set(60, 40);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 80).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 }));
  ground.receiveShadow = true;
  ground.position.set(ORIGIN, -0.001, ORIGIN);
  scene.add(ground);
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2c3a1c, roughness: 1 }));
  grass.position.y = -0.02;
  grass.receiveShadow = true;
  scene.add(grass);
}

// ---------------------------------------------------------------------------
// Content

const capsuleMat = new THREE.MeshStandardMaterial({ color: 0xc86b2c, roughness: 0.6 });
function capsule(x: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.3, 6, 12), capsuleMat);
  m.position.set(x, 0.9, z);
  m.castShadow = true;
  scene.add(m);
  return m;
}

interface Placed {
  id: string;
  obj: THREE.Object3D | null;
  pos: THREE.Vector3;
  label: HTMLDivElement | null;
  height: number;
}
const placed: Placed[] = [];
const nightMats = new Set<THREE.MeshStandardMaterial>();
const glowPoints: THREE.Vector3[] = [];
const box = new THREE.Box3();

function addLabel(text: string): HTMLDivElement | null {
  if (!showLabels) return null;
  const d = document.createElement('div');
  d.textContent = text;
  labelsEl.appendChild(d);
  return d;
}

function setupObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = !m.userData.noShadow;
    m.receiveShadow = true;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of mats) {
      const sm = mt as THREE.MeshStandardMaterial;
      if (typeof sm.userData.nightEmissive === 'number' && sm.emissive) {
        if (sm.emissive.r + sm.emissive.g + sm.emissive.b === 0) sm.emissive.set(0xffd9a0);
        nightMats.add(sm);
        if (night) {
          m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
          glowPoints.push(b.getCenter(new THREE.Vector3()));
        }
      }
    }
  });
}

let tris = 0;
let meshes = 0;
function count(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
}

const stats: string[] = [];
const buildMs: string[] = [];
let world: World | null = null;
let layer: PropsLayer | null = null;

if (useLayer) {
  const events = new EventBus();
  world = new World(events, 1);
  world.relief.fill(0);
  world.recomputeHeights({ x0: 0, z0: 0, x1: world.w - 1, z1: world.h - 1 });
  layer = new PropsLayer(world, events, scene, quality);
  // shift scene so the world centre region sits at the origin
}

const COLS = 5;
const CELL = 10;
if (view === 'close' && focusId && focusId.includes(',')) {
  // several defs side by side (variant v or 0)
  const ids = focusId.split(',');
  let x = 0;
  const xs: number[] = [];
  for (const id of ids) {
    const def = OBJECTS_BY_ID[id];
    const w = def.size[0] * TILE;
    xs.push(x + w / 2);
    x += w + 0.6;
  }
  const off = (x - 0.6) / 2;
  ids.forEach((id, k) => {
    const spec = PROP_SPECS[id];
    const o = spec.build(onlyVariant ?? 0);
    const px = xs[k] - off;
    o.position.set(px, 0, 0);
    scene.add(o);
    o.updateMatrixWorld(true);
    setupObject(o);
    tris = 0;
    meshes = 0;
    count(o);
    box.setFromObject(o);
    const sz = box.getSize(new THREE.Vector3());
    stats.push(`${id}: ${meshes} meshes, ${Math.round(tris)} tris, size ${sz.x.toFixed(2)}×${sz.y.toFixed(2)}×${sz.z.toFixed(2)}`);
    placed.push({ id, obj: o, pos: new THREE.Vector3(px, 0, 0), label: addLabel(id), height: sz.y });
  });
  capsule(x - off + 0.2, 0);
} else if (view === 'close' && focusId) {
  const spec = PROP_SPECS[focusId];
  const nv = spec ? spec.variants : 1;
  const vs = onlyVariant !== null ? [onlyVariant] : Array.from({ length: nv }, (_, i) => i);
  const def = OBJECTS_BY_ID[focusId];
  const span = Math.max(def.size[0], def.size[1]) * TILE + 2.5;
  vs.forEach((v, k) => {
    const x = (k - (vs.length - 1) / 2) * span;
    const o = spec.build(v);
    o.position.set(x, 0, 0);
    scene.add(o);
    o.updateMatrixWorld(true);
    setupObject(o);
    tris = 0;
    meshes = 0;
    count(o);
    box.setFromObject(o);
    const sz = box.getSize(new THREE.Vector3());
    stats.push(`${focusId}#${v}: ${meshes} meshes, ${Math.round(tris)} tris, size ${sz.x.toFixed(2)}×${sz.y.toFixed(2)}×${sz.z.toFixed(2)} (fp ${def.size[0] * TILE}×${def.size[1] * TILE})`);
    placed.push({ id: `${focusId}#${v}`, obj: o, pos: new THREE.Vector3(x, 0, 0), label: addLabel(`${focusId} v${v}`), height: sz.y });
    if (k === vs.length - 1) capsule(x + Math.min(def.size[0] * TILE * 0.5, sz.x * 0.5 + 0.2) + 0.45, 0);
  });
} else {
  ORDER.forEach((id, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = (col - (COLS - 1) / 2) * CELL + ORIGIN;
    const z = (row - 1.5) * CELL + ORIGIN;
    const def = OBJECTS_BY_ID[id];
    const spec = PROP_SPECS[id];
    let o: THREE.Object3D | null = null;
    let h = 2;
    if (world && layer) {
      // place footprint centred near (x, z) offset into the world interior
      const tx = Math.round(x / TILE - def.size[0] / 2);
      const tz = Math.round(z / TILE - def.size[1] / 2);
      world.addObject(id, tx, tz, 0, 7);
    } else if (spec) {
      const t0 = performance.now();
      o = spec.build(0);
      buildMs.push(`${id} ${(performance.now() - t0).toFixed(0)}ms`);
      o.position.set(x, 0, z);
      scene.add(o);
      o.updateMatrixWorld(true);
      setupObject(o);
      tris = 0;
      meshes = 0;
      count(o);
      box.setFromObject(o);
      h = box.max.y;
      stats.push(`${id}: ${meshes} m, ${Math.round(tris)} t`);
    } else stats.push(`${id}: MISSING`);
    placed.push({ id, obj: o, pos: new THREE.Vector3(x, 0, z), label: addLabel(spec ? id : `${id} (missing)`), height: h });
    capsule(x + def.size[0] * TILE * 0.5 + 0.6, z + def.size[1] * TILE * 0.5 + 0.2);
  });
}

// night lights at glow points (like the props layer's pooled lamp lights)
if (night) {
  scene.environmentIntensity = 0.35;
  glowPoints.slice(0, 8).forEach((p) => {
    const l = new THREE.PointLight(0xffc68a, 3.2, 16, 2);
    l.position.copy(p);
    scene.add(l);
  });
  for (const m of nightMats) m.emissiveIntensity = m.userData.nightEmissive as number;
}

// ---------------------------------------------------------------------------
// Camera

const deg = THREE.MathUtils.degToRad;
let target = new THREE.Vector3(ORIGIN, 0, ORIGIN);
let dist = 62;
let yaw = deg(25);
let pitch = deg(38);
if (view === 'game') {
  dist = 34;
  pitch = deg(48);
  const p = focusId ? placed.find((q) => q.id === focusId || q.id.startsWith(`${focusId}#`)) : null;
  if (p) target = p.pos.clone();
  else target.set(ORIGIN, 0, ORIGIN);
} else if (view === 'close' && focusId && focusId.includes(',')) {
  const w = Math.max(...placed.map((q) => Math.abs(q.pos.x))) * 2 + 2.5;
  const h = Math.max(...placed.map((q) => q.height));
  target = new THREE.Vector3(0, h * 0.35, 0);
  const hf = Math.atan(Math.tan(THREE.MathUtils.degToRad(20)) * camera.aspect);
  dist = Math.max((w / 2 / Math.tan(hf)) * 1.05, h * 2.2, 2.5);
  pitch = deg(16);
  yaw = deg(12);
} else if (view === 'close' && focusId) {
  const def = OBJECTS_BY_ID[focusId];
  const n = placed.length;
  const w = (n - 1) * (Math.max(def.size[0], def.size[1]) * TILE + 2.5) + def.size[0] * TILE + 1;
  const h = Math.max(...placed.map((q) => q.height));
  target = new THREE.Vector3(0, h * 0.4, 0);
  const hf = Math.atan(Math.tan(THREE.MathUtils.degToRad(20)) * camera.aspect);
  dist = Math.max((w / 2 / Math.tan(hf)) * 1.1, h * 2.2, 2.5);
  pitch = deg(16);
  yaw = deg(n > 1 ? 12 : 30);
}
if (params.has('yaw')) yaw = deg(Number(params.get('yaw')));
if (params.has('pitch')) pitch = deg(Number(params.get('pitch')));
if (params.has('dist')) dist = Number(params.get('dist'));
if (params.has('at')) {
  const [ax, ay, az] = params.get('at')!.split(',').map(Number);
  target.set(ax, ay, az);
}
camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
camera.lookAt(target);

// shadow frustum around the content
{
  const r = view === 'close' ? Math.max(dist * 0.6, 6) : 40;
  const cam = sun.shadow.camera;
  cam.left = -r;
  cam.right = r;
  cam.top = r;
  cam.bottom = -r;
  cam.near = 1;
  cam.far = 200;
  sun.position.copy(target).addScaledVector(sunDir, 80);
  sun.target.position.copy(target);
  cam.updateProjectionMatrix();
}

info.textContent = stats.join('\n') + (buildMs.length ? `\nbuild: ${buildMs.join(', ')}` : '');
(window as unknown as { __buildMs: string[] }).__buildMs = buildMs;

// ---------------------------------------------------------------------------
// Loop (throttled; SwiftShader is slow)

const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
const animate = params.get('anim') === '1';
let last = -1;
let frames = 0;
function frame(): void {
  // static scenes stop after a few frames so headless screenshots stay responsive
  if (!animate && frames >= 3) return;
  requestAnimationFrame(frame);
  const t = fixedT ?? clock.getElapsedTime();
  if (t - last < 0.25 && last >= 0) return;
  last = t;
  frames++;
  for (const p of placed) {
    const spec = PROP_SPECS[p.id.split('#')[0]];
    if (spec?.unique && spec.animate && p.obj) spec.animate(p.obj, t, night ? 1 : 0);
  }
  layer?.update(0.25, night ? 1 : 0, camera);
  renderer.render(scene, camera);
  const w = container.clientWidth;
  const h = container.clientHeight;
  for (const p of placed) {
    if (!p.label) continue;
    tmp.copy(p.pos).setY(p.height + 0.3);
    if (layer) tmp.y = 3;
    tmp.project(camera);
    p.label.style.left = `${((tmp.x + 1) / 2) * w}px`;
    p.label.style.top = `${((1 - tmp.y) / 2) * h}px`;
    p.label.style.display = tmp.z < 1 ? '' : 'none';
  }
}
frame();

addEventListener('resize', () => {
  renderer.setSize(container.clientWidth, container.clientHeight);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
});
