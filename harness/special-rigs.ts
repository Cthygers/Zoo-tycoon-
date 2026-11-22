// Multi-view sheet for the special-rig species (gorilla, penguin, flamingo):
// renders one species / action from several angles in one image.
//   ?species=elephant&action=walk&speed=1.3&t=2&sex=M&views=side,front,rear,top
//   views: side | front | rear | top | head | under | free(yaw,pitch,dist via &yaw= &pitch= &dist=)
//   &water=1 (auto for swim) draws a water surface at y = 0
//   &human=1 puts a 1.8 m person next to the animal (scale check)
//   &actions=walk,eat,drink,call&view=front  one viewport per action (same camera)
//   &seq=sleep:6,idle:2.5&times=6.5,7,7.5,8  play an action sequence (getting up …)

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { CreatureAnim, CreatureModel, QualitySettings } from '../src/core/contracts';
import { SPECIES_BY_ID } from '../src/data/species';
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
sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 80;
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
const action = q.get('action') ?? 'idle';
const water = !!q.get('water') || action === 'swim' || !!q.get('actions')?.includes('swim');
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = water ? -4 : 0;
ground.receiveShadow = true;
scene.add(ground);
if (water) {
  const w = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x2f4a48, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.86 }),
  );
  w.rotation.x = -Math.PI / 2;
  w.receiveShadow = true;
  scene.add(w);
}

const factory = new CreatureFactory(quality);
const id = q.get('species') ?? 'gorilla';
const sex = (q.get('sex') as 'M' | 'F') ?? 'M';
await factory.preload([id]);
const entries: { model: CreatureModel; anim: CreatureAnim }[] = [];
const timeList = q.get('times')?.split(',').map(Number);
const actionList = q.get('actions')?.split(',') ?? (timeList ? timeList.map(() => action) : undefined);
const models: CreatureModel[] = [];
for (const a of actionList ?? [action]) {
  const m = factory.createAnimal(id, { seed: num('seed', 5), sex, growth: num('growth', 1) });
  scene.add(m.object);
  models.push(m);
  const speedList = q.get('speeds')?.split(',').map(Number);
  const si = models.length - 1;
  const sp = speedList && si < speedList.length ? speedList[si] : q.has('speed') ? num('speed', 0) : a === 'walk' ? SPECIES_BY_ID[id]?.walkSpeed ?? 1.3 : a === 'run' ? SPECIES_BY_ID[id]?.runSpeed ?? 5 : 0;
  entries.push({ model: m, anim: { action: a, speed: sp, swimming: a === 'swim', actionTime: 0 } });
}
const model = models[0];
if (q.get('human')) {
  const h = factory.createHuman(
    { skin: 0xc68e6a, hair: 0x3b2a1e, shirt: 0x4f6d8f, pants: 0x3a3f4a, shoes: 0x2a2724, hairStyle: 0, height: 1.8, build: 1, child: false, female: false },
    'guest',
    2,
  );
  h.object.position.set(0, 0, -(SPECIES_BY_ID[id]?.length ?? 3) * 0.5 - 1.2);
  h.object.rotation.y = Math.PI / 2;
  scene.add(h.object);
  entries.push({ model: h, anim: { action: 'idle', speed: 0 } });
}

const tEnd = timeList ? Math.max(...timeList) : num('t', 1);
const step = 1 / 30;
let simT = 0;
const seq = q.get('seq')?.split(',').map((s) => s.split(':')).map(([a, t]) => [a, Number(t)] as const);
const seqAction = (t: number): string => {
  if (!seq) return '';
  let acc = 0;
  for (const [a, d] of seq) {
    acc += d;
    if (t < acc) return a;
  }
  return seq[seq.length - 1][0];
};
const stepAll = (dt: number) => {
  entries.forEach((e, i) => {
    if (timeList && i < timeList.length && simT >= timeList[i]) return;
    if (seq && i < models.length) {
      const a = seqAction(simT);
      if (a !== e.anim.action) {
        e.anim.action = a;
        e.anim.actionTime = 0;
      }
    }
    e.anim.actionTime = (e.anim.actionTime ?? 0) + dt;
    e.model.update(dt, e.anim);
  });
};
while (simT < tEnd) {
  stepAll(step);
  simT += step;
}
stepAll(0);
scene.updateMatrixWorld(true);

const H = model.height;
const L = SPECIES_BY_ID[id]?.length ?? H;
const size = Math.max(H, L * 0.8);
let headPos = new THREE.Vector3(0, H * 0.8, L * 0.4);
model.object.traverse((o) => {
  if ((o as THREE.Bone).isBone && o.name === 'head') headPos = o.getWorldPosition(new THREE.Vector3());
});
const center = new THREE.Vector3(0, num('ty', water ? 0.3 : H * 0.45), num('tz', 0));

interface View { yaw: number; pitch: number; dist: number; target: THREE.Vector3; fov: number }
function view(name: string): View {
  const k = num('zoom', 1);
  switch (name) {
    case 'side': return { yaw: 90, pitch: 4, dist: size * 2.3 / k, target: center, fov: 34 };
    case 'front': return { yaw: 38, pitch: 10, dist: size * 2.3 / k, target: center, fov: 34 };
    case 'rear': return { yaw: 215, pitch: 14, dist: size * 2.3 / k, target: center, fov: 34 };
    case 'top': return { yaw: 30, pitch: 52, dist: size * 3.4 / k, target: center, fov: 34 };
    case 'head': return { yaw: num('hyaw', 60), pitch: num('hpitch', 8), dist: num('hdist', size * 0.75), target: headPos, fov: 34 };
    case 'under': return { yaw: 90, pitch: -4, dist: size * 2.0 / k, target: center, fov: 34 };
    default: return { yaw: num('yaw', 60), pitch: num('pitch', 10), dist: num('dist', size * 2.3) / k, target: center, fov: 34 };
  }
}
const views = actionList ? actionList.map(() => q.get('view') ?? 'front') : (q.get('views') ?? 'side,front,rear,top').split(',');
const cols = views.length > 2 ? (views.length > 4 ? 3 : 2) : views.length;
const rows = Math.ceil(views.length / cols);
const W = innerWidth, Hh = innerHeight;
const vw = Math.floor(W / cols), vh = Math.floor(Hh / rows);
sunLight.target.position.copy(center);
sunLight.position.copy(center).addScaledVector(sun, 30);
const labels: string[] = [];
views.forEach((name, i) => {
  if (actionList) models.forEach((m, j) => (m.object.visible = j === i));
  const v = view(name);
  const cam = new THREE.PerspectiveCamera(v.fov, vw / vh, 0.05, 400);
  const yaw = THREE.MathUtils.degToRad(v.yaw), pitch = THREE.MathUtils.degToRad(v.pitch);
  cam.position.set(v.target.x + Math.sin(yaw) * Math.cos(pitch) * v.dist, v.target.y + Math.sin(pitch) * v.dist, v.target.z + Math.cos(yaw) * Math.cos(pitch) * v.dist);
  cam.lookAt(v.target);
  const c = i % cols, r = Math.floor(i / cols);
  const y = Hh - (r + 1) * vh;
  renderer.setViewport(c * vw, y, vw, vh);
  renderer.setScissor(c * vw, y, vw, vh);
  renderer.render(scene, cam);
  labels.push(timeList ? `${actionList![i]}@${timeList[i]}` : actionList ? actionList[i] : name);
});
const stats = factory.stats();
document.getElementById('info')!.textContent = stats.map((s) => `${s.key}  ${s.triangles} tris  ${s.ms.toFixed(0)} ms`).join('\n') + `\n${id} ${sex} t=${tEnd} [${labels.join(' | ')}]`;
(window as unknown as { __ready: boolean }).__ready = true;
