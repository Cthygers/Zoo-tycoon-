// Visual harness for the nature props (src/props/nature): every def in rows
// with a 1.8 m reference figure, in a self-contained daylight scene (sky
// background + PMREM sky environment, hemisphere fill, soft-shadowed sun,
// textured grass/dirt ground). Wind sway uses the real props wind patch.
//
// URL params:
//   ?view=game                 whole collection from a gameplay camera (default)
//   ?view=close&id=<defId>     close-up of one def (&v=<variant>)
//   ?view=row&id=<defId>       all variants of one def side by side
//   ?view=trees|plants|rocks   one category row, medium distance
//   ?q=low|medium|high         nature detail tier
//   ?wind=0                    freeze wind
//   ?sun=<deg elevation>       sun elevation (default 42)
//   ?az=<deg>                  camera azimuth offset for close/row views
//   ?layer=1                   place the defs through the real PropsLayer (instancing path)
//   ?lod=1                     build the distant LOD (buildLod) instead of the full model
//   ?view=lodcmp&id=<defId>    full (left) vs LOD (right) of one variant, &dist=<m> camera distance
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { World } from '../src/core/world';
import type { QualityLevel, QualitySettings } from '../src/core/contracts';
import { OBJECTS_BY_ID } from '../src/data/objects';
import { PROP_SPECS } from '../src/props/registry';
import { natureResourceStats, setNatureQuality } from '../src/props/nature';
import { setupWindMesh, updateWind } from '../src/props/wind';
import { albedoTexture, Img, lin, mix, pfbm, sat } from '../src/props/nature/tex';
import { atlas, type AtlasKind } from '../src/props/nature/atlases';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'game';
const focusId = params.get('id') ?? 'tree_oak';
const variantParam = Number(params.get('v') ?? '0');
const q = (params.get('q') ?? 'medium') as QualityLevel;
const wind = params.get('wind') !== '0';
const sunElev = (Number(params.get('sun') ?? '42') * Math.PI) / 180;
const azOff = (Number(params.get('az') ?? '0') * Math.PI) / 180;
const useLayer = params.get('layer') === '1';
const useLod = params.get('lod') === '1';
setNatureQuality(q);
const QS: QualitySettings = { level: q, pixelRatio: 1, antialias: true, shadows: true, shadowMapSize: 2048, grassDensity: 0.5, postFX: false, detailDistance: 40, creatureDetail: 1 };

const TREES = ['tree_acacia', 'tree_baobab', 'tree_oak', 'tree_pine', 'tree_birch', 'tree_palm', 'bamboo'];
const PLANTS = ['bush_savanna', 'bush_fern', 'grass_tall', 'reeds', 'cactus', 'flower_bed', 'hedge'];
const ROCKS = ['rock_small', 'rock_boulder', 'rock_outcrop', 'rock_ice', 'log_fallen'];

// ---------------------------------------------------------------------------
// Renderer / scene

const container = document.getElementById('game')!;
const info = document.getElementById('info')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const skyTop = new THREE.Color(0x5d8fcf);
const skyHorizon = new THREE.Color(0xc4d6e8);
scene.background = skyHorizon.clone();
scene.fog = new THREE.Fog(skyHorizon.clone(), 90, 420);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 1000);

// sky environment (gradient dome) → PMREM
{
  const envScene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { top: { value: skyTop }, hor: { value: skyHorizon }, ground: { value: new THREE.Color(0x4f4a3c) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader:
      'uniform vec3 top; uniform vec3 hor; uniform vec3 ground; varying vec3 vP; void main(){ float y = vP.y; vec3 c = y > 0.0 ? mix(hor, top, pow(y, 0.6)) : mix(hor, ground, pow(min(1.0, -y * 4.0), 0.5)); gl_FragColor = vec4(c * 1.2, 1.0); }',
  });
  envScene.add(new THREE.Mesh(geo, mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}

const hemi = new THREE.HemisphereLight(0xbcd4f0, 0x5a5038, 0.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dc, 3.1);
const sunAz = Number(params.get('sunaz') ?? '2.1');
sun.position.set(Math.cos(sunAz) * Math.cos(sunElev), Math.sin(sunElev), Math.sin(sunAz) * Math.cos(sunElev)).multiplyScalar(120);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 3;
scene.add(sun);
scene.add(sun.target);

// ground: grass with dirt patches
function groundTexture(): THREE.DataTexture {
  const S = 256;
  const img = new Img(S, S, 1);
  const g1 = lin(0x5a6b33);
  const g2 = lin(0x7a7d42);
  const dirt = lin(0x7a6548);
  for (let i = 0; i < S * S; i++) {
    const u = (i % S) / S;
    const v = ((i / S) | 0) / S;
    const n = pfbm(u, v, 4, 4, 4, 11);
    const fine = pfbm(u, v, 64, 64, 2, 12);
    const d = sat((pfbm(u, v, 3, 3, 3, 13) - 0.25) * 3);
    const t = sat(0.5 + n * 0.8);
    const l = 0.85 + fine * 0.25;
    img.set(i, mix(mix(g1[0], g2[0], t), dirt[0], d) * l, mix(mix(g1[1], g2[1], t), dirt[1], d) * l, mix(mix(g1[2], g2[2], t), dirt[2], d) * l, 1);
  }
  const tex = albedoTexture(img);
  tex.repeat.set(60, 60);
  return tex;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 1.8 m reference figure
const figMat = new THREE.MeshStandardMaterial({ color: 0x6a7a90, roughness: 0.6 });
const figGeo = new THREE.CapsuleGeometry(0.22, 1.36, 6, 12);
figGeo.translate(0, 0.9, 0);
function figure(x: number, z: number): void {
  const m = new THREE.Mesh(figGeo, figMat);
  m.position.set(x, 0, z);
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
}

// ---------------------------------------------------------------------------
// Placement

interface Placed {
  id: string;
  obj: THREE.Object3D;
  x: number;
  z: number;
  height: number;
  radius: number;
}
const placed: Placed[] = [];
const stats: string[] = [];

function build(id: string, variant: number, lod = useLod): THREE.Object3D {
  const spec = PROP_SPECS[id];
  if (!spec) {
    const def = OBJECTS_BY_ID[id];
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1, 1.5), new THREE.MeshStandardMaterial({ color: 0xff00ff }));
    box.position.y = 0.5;
    g.add(box);
    g.userData.missing = def ? def.name : id;
    return g;
  }
  const t0 = performance.now();
  const o = lod && spec.buildLod ? spec.buildLod(variant % spec.variants, QS) : spec.build(variant % spec.variants, QS);
  const ms = performance.now() - t0;
  let tris = 0;
  let meshes = 0;
  const parts: string[] = [];
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry;
    const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    tris += t;
    parts.push(`${m.name || 'mesh'} ${t}`);
    m.castShadow = true;
    m.receiveShadow = true;
    setupWindMesh(m);
  });
  stats.push(`${id}#${variant}${lod && spec.buildLod ? ' LOD' : ''}: ${tris} tris, ${meshes} meshes (${parts.join(', ')}), ${ms.toFixed(0)} ms`);
  return o;
}

function place(id: string, variant: number, x: number, z: number, fig = true, lod = useLod): Placed {
  const obj = build(id, variant, lod);
  obj.position.set(x, 0, z);
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const p: Placed = { id, obj, x, z, height: box.max.y, radius: Math.max(size.x, size.z) / 2 };
  placed.push(p);
  if (fig) figure(x - Math.max(1.0, p.radius + 0.6), z - 0.6);
  return p;
}

function rowOf(ids: string[], z: number, spacing: number, variant: number): void {
  const x0 = (-(ids.length - 1) * spacing) / 2;
  ids.forEach((id, i) => place(id, variant, x0 + i * spacing, z));
}

function lookFrom(target: THREE.Vector3, dist: number, elev: number, az: number): void {
  camera.position.set(target.x + Math.sin(az) * Math.cos(elev) * dist, target.y + Math.sin(elev) * dist, target.z + Math.cos(az) * Math.cos(elev) * dist);
  camera.lookAt(target);
}

function fitShadow(cx: number, cz: number, half: number): void {
  const c = sun.shadow.camera;
  c.left = -half;
  c.right = half;
  c.top = half;
  c.bottom = -half;
  c.near = 1;
  c.far = 400;
  c.updateProjectionMatrix();
  sun.target.position.set(cx, 0, cz);
  sun.position.set(cx + Math.cos(sunAz) * Math.cos(sunElev) * 150, Math.sin(sunElev) * 150, cz + Math.sin(sunAz) * Math.cos(sunElev) * 150);
}

const t0 = performance.now();
let layerInfo = '';
if (view === 'atlas') {
  // atlas debug: the texture on an unlit quad over a dark backdrop
  const a = atlas(focusId as AtlasKind);
  const img = a.tex.image as { width: number; height: number };
  const asp = img.width / img.height;
  const mat = new THREE.MeshBasicMaterial({ map: a.tex, alphaTest: 0.5, side: THREE.DoubleSide });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(10 * asp, 10), mat);
  quad.position.set(0, 50, 0);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x6f86a0 }));
  back.position.set(0, 50, -0.1);
  scene.add(back, quad);
  camera.position.set(0, 50, 12);
  camera.lookAt(0, 50, 0);
  scene.fog = null;
  renderer.toneMapping = THREE.NoToneMapping;
} else if (useLayer) {
  // integration path: real World + PropsLayer (instanced batches)
  const events = new EventBus();
  const world = new World(events, 7);
  const ids = [...TREES, ...PLANTS, ...ROCKS];
  void import('../src/props').then(({ createPropsLayer }) => {
    const layer = createPropsLayer(world, events, scene, QS);
    let tx = 10;
    for (const id of ids) {
      for (let k = 0; k < 3; k++) world.addObject(id, tx, 30 + k * 3, 0, k * 13 + 1);
      tx += OBJECTS_BY_ID[id].size[0] + (id.startsWith('tree') ? 3 : 1);
    }
    const c = new THREE.Vector3(((10 + tx) / 2) * 2 + 8, 0, 36 * 2 + 2);
    lookFrom(c, 58, 0.62, 0.2 + azOff);
    fitShadow(c.x, c.z, 70);
    ground.position.set(c.x, world.heightAt(c.x, c.z), c.z);
    const loop = (): void => {
      layer.update(1 / 30, 0, camera);
      renderer.render(scene, camera);
      layerInfo = JSON.stringify((layer as unknown as { debugInfo(): object }).debugInfo());
      info.textContent = `layer mode ${layerInfo}\ncalls ${renderer.info.render.calls} tris ${renderer.info.render.triangles}`;
      requestAnimationFrame(loop);
    };
    loop();
  });
} else if (view === 'lodcmp') {
  // full vs LOD of one variant, side by side, from a chosen distance
  const probe = build(focusId, variantParam, false);
  const pbox = new THREE.Box3().setFromObject(probe);
  const psize = pbox.getSize(new THREE.Vector3());
  const gap = Math.max(psize.x, psize.z) * 0.6 + 1;
  place(focusId, variantParam, -gap, 0, false, false);
  place(focusId, variantParam, gap, 0, false, true);
  const h = pbox.max.y;
  const dist = Number(params.get('dist') ?? String(Math.max(gap * 4, h * 2.2)));
  lookFrom(new THREE.Vector3(0, h * 0.45, 0), dist, Number(params.get('elev') ?? '0.3'), azOff);
  fitShadow(0, 0, Math.max(12, gap * 3));
} else if (view === 'close' || view === 'row') {
  const spec = PROP_SPECS[focusId];
  const n = view === 'row' ? (spec?.variants ?? 1) : 1;
  const probe = build(focusId, variantParam);
  const pbox = new THREE.Box3().setFromObject(probe);
  const psize = pbox.getSize(new THREE.Vector3());
  const spacing = Math.max(psize.x, psize.z) + 1.5;
  const x0 = (-(n - 1) * spacing) / 2;
  for (let i = 0; i < n; i++) place(focusId, view === 'row' ? i : variantParam, x0 + i * spacing, 0, true);
  const h = Math.max(...placed.map((p) => p.height));
  const span = view === 'row' ? n * spacing : Math.max(psize.x, psize.z, h);
  const target = new THREE.Vector3(0, h * 0.48, 0);
  const dist = view === 'row' ? Math.max(span * 1.05, h * 1.9) : Math.max(span * 1.25, h * 1.55, 3.2);
  lookFrom(target, dist, view === 'row' ? 0.32 : 0.28, 0.45 + azOff);
  fitShadow(0, 0, Math.max(10, span * 0.9));
} else {
  if (view === 'game' || view === 'trees') rowOf(TREES, 0, 15, variantParam);
  if (view === 'game' || view === 'plants') rowOf(PLANTS, view === 'game' ? 17 : 0, 5, variantParam);
  if (view === 'game' || view === 'rocks') rowOf(ROCKS, view === 'game' ? 27 : 0, 6.5, variantParam);
  if (view === 'game') {
    lookFrom(new THREE.Vector3(0, 2, 12), 62, 0.62, 0.12 + azOff);
    fitShadow(0, 10, 65);
  } else if (view === 'trees') {
    lookFrom(new THREE.Vector3(0, 6, 0), 70, 0.22, azOff);
    fitShadow(0, 0, 60);
  } else {
    lookFrom(new THREE.Vector3(0, 0.8, 0), view === 'plants' ? 22 : 20, 0.5, azOff);
    fitShadow(0, 0, 22);
  }
}
const genMs = performance.now() - t0;

let last = performance.now();
let frames = 0;
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  updateWind(wind ? dt : 0);
  renderer.render(scene, camera);
  frames++;
  if (frames % 10 === 1) {
    const r = renderer.info.render;
    const rs = natureResourceStats();
    info.textContent = `${view} ${view === 'close' || view === 'row' ? focusId : ''} q=${q}  gen ${genMs.toFixed(0)} ms  calls ${r.calls}  tris ${r.triangles}  tex ${rs.textures} mats ${rs.materials}\n${stats.join('\n')}`;
  }
  requestAnimationFrame(frame);
}
if (!useLayer) frame();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
