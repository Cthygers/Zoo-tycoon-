// 3D visual check of the simulation: the demo zoo simulated for a morning, then
// drawn with the real renderer, creature models and entity views, so entity
// placement (heights on terrain / water / boardwalks, guests on paths, animals
// inside fences) can be judged in context.
// URL params:
//   ?time=HH:MM     simulate from opening until this time (default 12:30)
//   ?focus=x,z      camera target in metres (default the savanna viewing path)
//   ?yaw=deg&pitch=deg&dist=m   camera orbit
//   ?q=low|medium|high
//   ?run=1          keep simulating at 1x

import * as THREE from 'three';
import type { IPropsLayer, QualityLevel } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { buildDemoZoo } from '../src/demo';
import { createCreatureFactory } from '../src/models';
import { createRenderContext } from '../src/render';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';
import { createEntityViews } from '../src/views';

const params = new URLSearchParams(location.search);
const q = (params.get('q') ?? 'medium') as QualityLevel;
const [hh, mm] = (params.get('time') ?? '12:30').split(':').map(Number);
const target = hh * 60 + (mm || 0);
const [fx, fz] = (params.get('focus') ?? '50,110').split(',').map(Number);
const yaw = (Number(params.get('yaw') ?? 200) * Math.PI) / 180;
const pitch = (Number(params.get('pitch') ?? 32) * Math.PI) / 180;
const dist = Number(params.get('dist') ?? 30);
const run = params.get('run') === '1';

const container = document.getElementById('game')!;
const info = document.getElementById('info')!;

const events = new EventBus();
const sim = createSimulation(events, 42) as Simulation;
sim.newGame();
buildDemoZoo(sim);
// a natural morning: open the gates and let guests arrive over time
sim.setSpeed(3);
let guard = 0;
while (sim.minuteOfDay < target && guard++ < 5000) sim.update(0.1);
sim.setSpeed(run ? 1 : 0);

const ctx = await createRenderContext(container, sim.world, events, q);

let props: IPropsLayer;
try {
  const mod = await import('../src/props');
  props = mod.createPropsLayer(sim.world, events, ctx.scene, ctx.quality);
} catch (err) {
  console.warn('[sim3d] props layer unavailable, using a stub', err);
  const root = new THREE.Group();
  ctx.scene.add(root);
  props = {
    root,
    update() {},
    createObjectModel: () => new THREE.Group(),
    createFenceSegmentModel: () => new THREE.Group(),
    setLitter() {},
    pickObject: () => null,
    setHighlight() {},
    setQuality() {},
    prewarm: async () => {},
    dispose() {},
  };
}
const creatures = createCreatureFactory(ctx.quality);
const present = [...new Set([...sim.animals.values()].map((a) => a.speciesId))];
await creatures.preload(present);
const views = createEntityViews(sim, ctx, creatures, props);
events.emit('worldReset', {});
props.setLitter(sim.litter.values());

const cam = ctx.camera;
const fy = sim.world.heightAt(fx, fz);
cam.position.set(fx + Math.sin(yaw) * Math.cos(pitch) * dist, fy + Math.sin(pitch) * dist, fz + Math.cos(yaw) * Math.cos(pitch) * dist);
cam.lookAt(fx, fy, fz);
ctx.setFocus(fx, fz, Math.tan((cam.fov * Math.PI) / 360) * dist * 1.6);
ctx.resize(container.clientWidth, container.clientHeight);

let last = performance.now();
let frames = 0;
const loop = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  sim.update(dt);
  ctx.setTimeOfDay(sim.minuteOfDay, sim.day);
  views.update(frames < 3 ? 0.016 : dt);
  props.update(dt, ctx.nightFactor, cam);
  ctx.update(dt);
  ctx.render();
  frames++;
  const s = sim.stats();
  info.textContent = `day ${sim.day} ${String(Math.floor(sim.minuteOfDay / 60)).padStart(2, '0')}:${String(Math.floor(sim.minuteOfDay % 60)).padStart(2, '0')}  guests ${s.guestsInZoo}  animals ${s.animalCount}  rating ${sim.rating.toFixed(0)}`;
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
(window as unknown as Record<string, unknown>).__sim = sim;
