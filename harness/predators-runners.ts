// Multi-view sheet for tiger / grizzly / polar bear / gazelle (and any species):
//   ?species=tiger&sex=M&actions=idle,walk@1.2,run@8,sleep&view=side&t=2
//     one viewport per action (same camera); "a@speed" sets the ground speed
//   ?species=tiger&action=walk&views=side,front,top,head&t=1.3
//     one action from several angles
//   views: side | front | rear | top | head | game (top-down gameplay angle) | free (&yaw &pitch &dist)
//   &times=0.5,1,1.5  one viewport per time (same action), &human=1 scale person,
//   &lineup=1 tiger, grizzly, polar bear, gazelle (+ human) side by side,
//   &zoom=1.5, &cols=3, &seed=5, &detail=0|1|2, &growth=1

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { CreatureAnim, CreatureModel, QualitySettings } from '../src/core/contracts';
import { SPECIES_BY_ID } from '../src/data/species';
import { CreatureFactory } from '../src/models';
import { setDebugRegions } from '../src/models/build/geometry';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const detail = Math.max(0, Math.min(2, num('detail', 1))) as 0 | 1 | 2;
const quality: QualitySettings = {
  level: (['low', 'medium', 'high'] as const)[detail],
  pixelRatio: 1,
  antialias: true,
  shadows: true,
  shadowMapSize: 2048,
  grassDensity: 1,
  postFX: false,
  detailDistance: 60,
  creatureDetail: detail,
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 0.5);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = new Sky();
sky.scale.setScalar(1000);
const sun = new THREE.Vector3();
sun.setFromSphericalCoords(1, Math.PI / 2 - THREE.MathUtils.degToRad(num('sunElev', 38)), THREE.MathUtils.degToRad(num('sunAzim', 140)));
const su = sky.material.uniforms;
su.sunPosition.value.copy(sun);
su.turbidity.value = 6;
su.rayleigh.value = 1.4;
su.mieCoefficient.value = 0.004;
su.mieDirectionalG.value = 0.8;
scene.add(sky);
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.add(sky.clone());
scene.environment = pmrem.fromScene(envScene, 0.02).texture;
scene.environmentIntensity = num('env', 0.35);

const sunLight = new THREE.DirectionalLight(0xfff1dc, 3.2);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.02;
sunLight.shadow.radius = 3;
const sc = sunLight.shadow.camera as THREE.OrthographicCamera;
sc.left = -7; sc.right = 7; sc.top = 7; sc.bottom = -7; sc.near = 1; sc.far = 80;
scene.add(sunLight, sunLight.target);

function groundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f5f45';
  g.fillRect(0, 0, 512, 512);
  let s = 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26000; i++) {
    const x = rnd() * 512, y = rnd() * 512;
    g.fillStyle = `hsl(${38 + rnd() * 18}, ${22 + rnd() * 18}%, ${28 + rnd() * 22}%)`;
    g.fillRect(x, y, 1 + rnd() * 2, 1 + rnd() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(30, 30);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x2b4846, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.82 }),
);
water.rotation.x = -Math.PI / 2;
water.receiveShadow = true;
scene.add(water);

if (q.get('debugRegions')) setDebugRegions(true);
const factory = new CreatureFactory(quality);
const human = () =>
  factory.createHuman(
    { skin: 0xc68e6a, hair: 0x3b2a1e, shirt: 0x4f6d8f, pants: 0x3a3f4a, shoes: 0x2a2724, hairStyle: 0, height: 1.8, build: 1, child: false, female: false },
    'guest',
    2,
  );

interface Entry { model: CreatureModel; anim: CreatureAnim; stopAt: number }
const entries: Entry[] = [];
const sex = (q.get('sex') as 'M' | 'F') ?? 'M';
const seed = num('seed', 5);
const step = 1 / 30;

function speedFor(id: string, a: string, explicit?: string): number {
  if (explicit !== undefined && explicit !== '') return Number(explicit);
  if (q.has('speed')) return num('speed', 0);
  const d = SPECIES_BY_ID[id];
  return a === 'walk' ? d?.walkSpeed ?? 1.3 : a === 'run' ? d?.runSpeed ?? 5 : 0;
}

interface Slot { models: CreatureModel[]; action: string; swim: boolean; view: string; label: string; center: THREE.Vector3; size: number }
const slots: Slot[] = [];

if (q.get('lineup')) {
  const ids = (q.get('ids') ?? 'tiger,grizzly,polarbear,gazelle').split(',');
  await factory.preload(ids);
  const action = q.get('action') ?? 'idle';
  let x = 0;
  const models: CreatureModel[] = [];
  for (const id of ids) {
    const m = factory.createAnimal(id, { seed, sex, growth: num('growth', 1) });
    const len = SPECIES_BY_ID[id]?.length ?? 2;
    m.object.position.set(x, 0, 0);
    x += Math.max(1.2, m.radius * 2 + 0.5);
    scene.add(m.object);
    models.push(m);
    entries.push({ model: m, anim: { action, speed: speedFor(id, action), actionTime: 0 }, stopAt: Infinity });
    void len;
  }
  const h = human();
  h.object.position.set(x, 0, 0);
  scene.add(h.object);
  entries.push({ model: h, anim: { action: 'idle', speed: 0 }, stopAt: Infinity });
  models.push(h);
  const size = x * 0.55;
  slots.push({ models, action, swim: false, view: q.get('view') ?? 'side', label: 'lineup', center: new THREE.Vector3(x / 2, 0.8, 0), size });
} else {
  const id = q.get('species') ?? 'tiger';
  await factory.preload([id]);
  const times = q.get('times')?.split(',').map(Number);
  const actionSpecs = q.get('actions')?.split(',') ?? (times ? times.map(() => q.get('action') ?? 'idle') : [q.get('action') ?? 'idle']);
  const views = q.get('actions') || times ? actionSpecs.map(() => q.get('view') ?? 'side') : (q.get('views') ?? 'side').split(',');
  const tEnd = num('t', 1);
  const def = SPECIES_BY_ID[id];
  const H = def?.height ?? 1;
  const L = def?.length ?? 1.5;
  const size = Math.max(H * 1.4, L * 0.75);
  if (q.get('actions') || times) {
    const seeds = q.get('seeds')?.split(',').map(Number);
    const sexes = q.get('sexes')?.split(',') as ('M' | 'F')[] | undefined;
    actionSpecs.forEach((spec, i) => {
      const [a, sp] = spec.split('@');
      const m = factory.createAnimal(id, { seed: seeds?.[i] ?? seed, sex: sexes?.[i] ?? sex, growth: num('growth', 1) });
      scene.add(m.object);
      const swim = a === 'swim';
      entries.push({ model: m, anim: { action: a, speed: speedFor(id, a, sp), swimming: swim, actionTime: 0 }, stopAt: times ? times[i] : tEnd });
      const models = [m];
      if (q.get('human')) {
        const h = human();
        h.object.position.set(-H * 1.2, 0, 0);
        scene.add(h.object);
        entries.push({ model: h, anim: { action: 'idle', speed: 0 }, stopAt: tEnd });
        models.push(h);
      }
      slots.push({ models, action: a, swim, view: views[i], label: times ? `${a} @${times[i]}s` : spec, center: new THREE.Vector3(0, swim ? 0.25 : H * 0.55, 0), size });
    });
  } else {
    const a = actionSpecs[0].split('@')[0];
    const sp = actionSpecs[0].split('@')[1];
    const m = factory.createAnimal(id, { seed, sex, growth: num('growth', 1) });
    scene.add(m.object);
    const swim = a === 'swim';
    entries.push({ model: m, anim: { action: a, speed: speedFor(id, a, sp), swimming: swim, actionTime: 0 }, stopAt: tEnd });
    const models = [m];
    if (q.get('human')) {
      const h = human();
      h.object.position.set(-H * 1.2, 0, 0);
      scene.add(h.object);
      entries.push({ model: h, anim: { action: 'idle', speed: 0 }, stopAt: tEnd });
      models.push(h);
    }
    for (const v of views) slots.push({ models, action: a, swim, view: v, label: `${a} ${v}`, center: new THREE.Vector3(0, swim ? 0.25 : H * 0.55, 0), size });
  }
}

// advance time; walking models move forward so feet planting is visible
const tMax = Math.max(...entries.map((e) => (isFinite(e.stopAt) ? e.stopAt : num('t', 1))));
let simT = 0;
const stepAll = (dt: number) => {
  for (const e of entries) {
    if (simT > e.stopAt + 1e-6) continue;
    e.anim.actionTime = (e.anim.actionTime ?? 0) + dt;
    e.model.update(dt, e.anim);
  }
};
while (simT < tMax - 1e-6) {
  stepAll(step);
  simT += step;
}
stepAll(0);
scene.updateMatrixWorld(true);

const allModels = entries.map((e) => e.model);
function headOf(m: CreatureModel): THREE.Vector3 {
  let p: THREE.Vector3 | null = null;
  m.object.traverse((o) => {
    if ((o as THREE.Bone).isBone && o.name === 'head' && !p) p = o.getWorldPosition(new THREE.Vector3());
  });
  const out: THREE.Vector3 = p ?? new THREE.Vector3(0, m.height, 0);
  return out.add(new THREE.Vector3(0, num('hty', 0), num('htz', 0)));
}

interface View { yaw: number; pitch: number; dist: number; target: THREE.Vector3; fov: number }
function view(name: string, s: Slot): View {
  const k = num('zoom', 1);
  const c = s.center;
  const size = s.size;
  switch (name) {
    case 'side': return { yaw: 90, pitch: 4, dist: (size * 2.3) / k, target: c, fov: 34 };
    case 'rside': return { yaw: -90, pitch: 4, dist: (size * 2.3) / k, target: c, fov: 34 };
    case 'front': return { yaw: 38, pitch: 10, dist: (size * 2.3) / k, target: c, fov: 34 };
    case 'face': return { yaw: 0, pitch: 6, dist: (size * 1.6) / k, target: c, fov: 34 };
    case 'rear': return { yaw: 215, pitch: 14, dist: (size * 2.3) / k, target: c, fov: 34 };
    case 'top': return { yaw: 30, pitch: 75, dist: (size * 3.0) / k, target: c, fov: 34 };
    case 'game': return { yaw: 25, pitch: 50, dist: (size * 5.5) / k, target: c, fov: 40 };
    case 'head': return { yaw: num('hyaw', 55), pitch: num('hpitch', 8), dist: num('hdist', size * 0.7) / k, target: headOf(s.models[0]), fov: 34 };
    case 'headside': return { yaw: 90, pitch: 4, dist: num('hdist', size * 0.7) / k, target: headOf(s.models[0]), fov: 34 };
    case 'headfront': return { yaw: 0, pitch: 4, dist: num('hdist', size * 0.7) / k, target: headOf(s.models[0]), fov: 34 };
    default: return { yaw: num('yaw', 60), pitch: num('pitch', 10), dist: num('dist', size * 2.3) / k, target: c, fov: 34 };
  }
}
const n = slots.length;
const cols = num('cols', n > 2 ? (n > 4 ? 3 : 2) : n);
const rows = Math.ceil(n / cols);
const W = innerWidth, Hh = innerHeight;
const vw = Math.floor(W / cols), vh = Math.floor(Hh / rows);
slots.forEach((s, i) => {
  for (const m of allModels) m.object.visible = s.models.includes(m);
  ground.visible = !s.swim;
  water.visible = s.swim;
  const v = view(s.view, s);
  sunLight.target.position.copy(v.target);
  sunLight.position.copy(v.target).addScaledVector(sun, 30);
  sunLight.target.updateMatrixWorld();
  const cam = new THREE.PerspectiveCamera(v.fov, vw / vh, 0.05, 400);
  const yaw = THREE.MathUtils.degToRad(v.yaw), pitch = THREE.MathUtils.degToRad(v.pitch);
  cam.position.set(v.target.x + Math.sin(yaw) * Math.cos(pitch) * v.dist, v.target.y + Math.sin(pitch) * v.dist, v.target.z + Math.cos(yaw) * Math.cos(pitch) * v.dist);
  cam.lookAt(v.target);
  const c = i % cols, r = Math.floor(i / cols);
  const y = Hh - (r + 1) * vh;
  renderer.setViewport(c * vw, y, vw, vh);
  renderer.setScissor(c * vw, y, vw, vh);
  renderer.render(scene, cam);
  const lbl = document.createElement('div');
  lbl.className = 'lbl';
  lbl.style.left = `${c * vw + 8}px`;
  lbl.style.top = `${r * vh + vh - 20}px`;
  lbl.textContent = s.label;
  document.body.appendChild(lbl);
});
const stats = factory.stats();
document.getElementById('info')!.textContent = stats.map((s) => `${s.key}  ${s.triangles} tris  ${s.ms.toFixed(0)} ms`).join('\n');
(window as unknown as { __ready: boolean }).__ready = true;
