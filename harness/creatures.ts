// Visual harness for the creature module.
//   ?species=zebra&action=walk&speed=1.5&t=1.3&sex=M&yaw=30&dist=5&pitch=12&detail=1&growth=1
//   ?grid=1                 all species side by side (+ a 1.8 m human for scale)
//   ?humans=1               a crowd of people with different actions / held items
//   ?live=1                 keep animating (default: freeze at t when t is given)

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CreatureAnim, CreatureModel, QualitySettings } from '../src/core/contracts';
import type { HumanAppearance, StaffRole } from '../src/core/types';
import { SPECIES } from '../src/data/species';
import { CreatureFactory } from '../src/models';

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
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 38), innerWidth / innerHeight, 0.05, 400);

// ---- sky + environment
const sky = new Sky();
sky.scale.setScalar(1000);
const sun = new THREE.Vector3();
const elev = THREE.MathUtils.degToRad(num('sunElev', 38));
const azim = THREE.MathUtils.degToRad(num('sunAzim', 140));
sun.setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
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
const env = pmrem.fromScene(envScene, 0.02).texture;
scene.environment = env;
scene.environmentIntensity = num('env', 0.35);

const sunLight = new THREE.DirectionalLight(0xfff1dc, 3.2);
sunLight.position.copy(sun).multiplyScalar(30);
sunLight.castShadow = !q.get('noshadow');
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = num('nbias', 0.02);
sunLight.shadow.radius = 3;
const sc = sunLight.shadow.camera as THREE.OrthographicCamera;
sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 80;
scene.add(sunLight, sunLight.target);

// ---- ground: procedural dry grass / earth
function groundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f5f45';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 26000; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const l = 28 + Math.random() * 22;
    g.fillStyle = `hsl(${38 + Math.random() * 18}, ${22 + Math.random() * 18}%, ${l}%)`;
    g.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(30, 30);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const factory = new CreatureFactory(quality);
const info = document.getElementById('info')!;

interface Entry {
  model: CreatureModel;
  anim: CreatureAnim;
}
const entries: Entry[] = [];

function human(app: Partial<HumanAppearance>, role: 'guest' | StaffRole, seed: number): CreatureModel {
  const a: HumanAppearance = {
    skin: 0xc68e6a, hair: 0x3b2a1e, shirt: 0x4f6d8f, pants: 0x3a3f4a, shoes: 0x2a2724,
    hairStyle: 0, height: 1.8, build: 1, child: false, female: false, ...app,
  };
  return factory.createHuman(a, role, seed);
}

async function build(): Promise<THREE.Vector3> {
  const target = new THREE.Vector3();
  if (q.get('grid')) {
    const ids = SPECIES.map((s) => s.id);
    await factory.preload(ids);
    let x = 1.2;
    const action = q.get('action') ?? 'idle';
    for (const s of SPECIES) {
      const m = factory.createAnimal(s.id, { seed: 3, sex: (q.get('sex') as 'M' | 'F') ?? 'M', growth: 1 });
      const w = Math.max(0.8, m.radius * 2.0);
      x += w / 2;
      m.object.position.set(x, 0, 0);
      m.object.rotation.y = Math.PI / 2 - 0.5;
      x += w / 2 + 0.6;
      scene.add(m.object);
      entries.push({ model: m, anim: { action, speed: 0 } });
    }
    try {
      const h = human({}, 'guest', 1);
      h.object.position.set(0, 0, 0);
      h.object.rotation.y = 0.3;
      scene.add(h.object);
      entries.push({ model: h, anim: { action: 'idle', speed: 0 } });
    } catch (e) {
      console.warn(e);
    }
    target.set(x / 2, 0.8, 0);
    return target;
  }
  if (q.get('humans')) {
    const actions = ['walk', 'idle', 'watch', 'eat', 'drink', 'sit', 'walk', 'shop', 'work', 'work', 'work', 'walk'];
    const holds = ['none', 'balloon', 'none', 'icecream', 'drink', 'food', 'gift', 'none', 'none', 'none', 'none', 'balloon'];
    const roles: ('guest' | StaffRole)[] = ['guest', 'guest', 'guest', 'guest', 'guest', 'guest', 'guest', 'guest', 'keeper', 'groundskeeper', 'vet', 'guest'];
    const skins = [0xf1c8a8, 0xc68e6a, 0x8d5a3b, 0x5a3825, 0xe0b090, 0xa56f4e];
    const hairs = [0x2a1d14, 0x5a3b22, 0xa77d45, 0x1b1410, 0xc9a66b, 0x6b6461];
    const shirts = [0xb03a2e, 0x2e5d8f, 0xe2d8c4, 0x3f7a4b, 0xd9a43c, 0x6a4c93, 0x223344, 0xc96f8a];
    const pants = [0x2f3a4f, 0x4a4036, 0x7a6f5c, 0x222222, 0x3c5a7a];
    const n = actions.length;
    for (let i = 0; i < n; i++) {
      const child = i === 3 || i === 11 || i === 6;
      const female = i % 2 === 1;
      const m = human(
        {
          skin: skins[i % skins.length], hair: hairs[(i * 3) % hairs.length], shirt: shirts[(i * 5) % shirts.length], pants: pants[i % pants.length],
          hairStyle: ([0, 1, 2, 3, 1, 0, 3, 1, 0, 3, 2, 1] as const)[i], height: child ? 1.15 + (i % 3) * 0.08 : 1.6 + ((i * 7) % 5) * 0.07,
          build: 0.9 + ((i * 3) % 4) * 0.08, child, female,
        },
        roles[i],
        i * 17 + 3,
      );
      const col = i % 6, row = Math.floor(i / 6);
      m.object.position.set((col - 2.5) * 1.1, 0, row * -1.6);
      m.object.rotation.y = (i * 0.7) % 1.2 - 0.6;
      scene.add(m.object);
      entries.push({ model: m, anim: { action: actions[i], speed: actions[i] === 'walk' ? (child ? 1.0 : 1.3) : 0, holding: holds[i] } });
    }
    target.set(0, 0.9, -0.8);
    return target;
  }
  if (q.get('person')) {
    const h = human({ female: q.get('sex') === 'F', child: !!q.get('child'), hairStyle: Number(q.get('hair') ?? 0) as 0, shirt: 0x8a3b2e }, (q.get('role') as StaffRole) ?? 'guest', num('seed', 4));
    scene.add(h.object);
    const action = q.get('action') ?? 'idle';
    entries.push({ model: h, anim: { action, speed: num('speed', action === 'walk' ? 1.3 : 0), holding: q.get('hold') ?? 'none' } });
    target.set(0, 0.9, 0);
    return target;
  }
  const id = q.get('species') ?? 'zebra';
  const sex = (q.get('sex') as 'M' | 'F') ?? 'M';
  await factory.preload([id]);
  const m = factory.createAnimal(id, { seed: num('seed', 5), sex, growth: num('growth', 1) });
  scene.add(m.object);
  const action = q.get('action') ?? 'idle';
  entries.push({ model: m, anim: { action, speed: num('speed', action === 'walk' ? 1.4 : action === 'run' ? 6 : 0), swimming: action === 'swim' } });
  if (q.get('human')) {
    const h = human({}, 'guest', 2);
    h.object.position.set(-m.radius - 0.8, 0, 0);
    scene.add(h.object);
    entries.push({ model: h, anim: { action: 'idle', speed: 0 } });
  }
  target.set(0, num('ty', m.height * 0.5), num('tz', 0));
  return target;
}

const t0 = performance.now();
const target = await build();
const buildMs = performance.now() - t0;
const yaw = THREE.MathUtils.degToRad(num('yaw', 35));
const pitch = THREE.MathUtils.degToRad(num('pitch', 10));
const dist = num('dist', q.get('grid') ? 22 : q.get('humans') ? 8 : Math.max(3, entries[0].model.height * 2.6));
camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
camera.lookAt(target);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(target);
controls.update();
sunLight.target.position.copy(target);
sunLight.position.copy(target).addScaledVector(sun, 30);

if (q.get('wire')) {
  scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
      const sm = o as THREE.SkinnedMesh;
      const w = new THREE.SkinnedMesh(sm.geometry, new THREE.MeshBasicMaterial({ wireframe: true, color: 0xff3300 }));
      w.bind(sm.skeleton, sm.bindMatrix);
      w.frustumCulled = false;
      sm.parent!.add(w);
    }
  });
}
const stats = factory.stats();
info.textContent = `build ${buildMs.toFixed(0)} ms\n` + stats.map((s) => `${s.key}  ${s.triangles} tris  ${s.ms.toFixed(0)} ms`).join('\n');

const live = !!q.get('live') || !q.has('t');
const tEnd = num('t', 0);
// advance to t deterministically
const step = 1 / 30;
let simT = 0;
function stepAll(dt: number) {
  for (const e of entries) {
    if (e.anim.actionTime !== undefined) e.anim.actionTime += dt;
    else e.anim.actionTime = dt;
    e.model.update(dt, e.anim);
  }
}
while (simT < tEnd) {
  stepAll(step);
  simT += step;
}
stepAll(0);
renderer.render(scene, camera);
(window as unknown as { __ready: boolean }).__ready = true;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (live) stepAll(dt);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
