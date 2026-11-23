// Entity views: keep a CreatureModel in the scene for every animal, guest and
// staff member in the simulation, animate them, and handle picking/selection.

import * as THREE from 'three';
import {
  SPEED_MULTIPLIERS,
  type CreatureAnim,
  type CreatureModel,
  type ICreatureFactory,
  type IEntityViews,
  type IPropsLayer,
  type IRenderContext,
  type ISimulation,
} from '../core/contracts';
import type { SelectionRef } from '../core/types';
import { WATER_LEVEL } from '../core/constants';

type Kind = 'animal' | 'guest' | 'staff';

interface EntityView {
  kind: Kind;
  id: number;
  model: CreatureModel;
  heading: number;
  growth: number;
  anim: CreatureAnim;
  /** Seconds until the next off-screen animation tick (cheap LOD). */
  lodTimer: number;
  /** Scaled time accumulated since the model was last animated. */
  animDt: number;
}

const TWO_PI = Math.PI * 2;

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

export function createEntityViews(
  sim: ISimulation,
  ctx: IRenderContext,
  creatures: ICreatureFactory,
  props: IPropsLayer,
): IEntityViews {
  const root = new THREE.Group();
  root.name = 'entities';
  ctx.scene.add(root);

  const views = new Map<string, EntityView>();
  const key = (k: Kind, id: number) => `${k}:${id}`;

  // ---------------------------------------------------------------- selection ring
  const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x9fe870,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.renderOrder = 5;
  ring.visible = false;
  ctx.scene.add(ring);
  let selected: SelectionRef | null = null;
  let ringPulse = 0;

  // ---------------------------------------------------------------- create / remove
  // Species whose meshes are built. Building one takes a long task (up to a few
  // hundred ms on a phone), so an animal of a new species bought during play is
  // created after the next frame instead of inside the tap / sim event.
  const builtSpecies = new Set<string>();
  const pendingSpecies = new Map<string, Promise<void>>();
  const afterNextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function createAnimalSoon(id: number): void {
    const a = sim.animals.get(id);
    if (!a) return;
    if (builtSpecies.has(a.speciesId)) return create('animal', id);
    let p = pendingSpecies.get(a.speciesId);
    if (!p) {
      const speciesId = a.speciesId;
      p = afterNextFrame()
        .then(() => creatures.preload([speciesId]))
        .catch((err) => console.error(`[views] failed to build ${speciesId}`, err))
        .finally(() => {
          builtSpecies.add(speciesId);
          pendingSpecies.delete(speciesId);
        });
      pendingSpecies.set(speciesId, p);
    }
    void p.then(() => create('animal', id));
  }

  function create(kind: Kind, id: number): void {
    const k = key(kind, id);
    if (views.has(k)) return;
    let model: CreatureModel | null = null;
    let heading = 0;
    let growth = 1;
    try {
      if (kind === 'animal') {
        const a = sim.animals.get(id);
        if (!a) return;
        model = creatures.createAnimal(a.speciesId, { seed: a.seed, sex: a.sex, growth: a.growth });
        builtSpecies.add(a.speciesId);
        heading = a.heading;
        growth = a.growth;
      } else if (kind === 'guest') {
        const g = sim.guests.get(id);
        if (!g) return;
        model = creatures.createHuman(g.appearance, 'guest', g.seed);
        heading = g.heading;
      } else {
        const s = sim.staff.get(id);
        if (!s) return;
        model = creatures.createHuman(s.appearance, s.role, s.seed);
        heading = s.heading;
      }
    } catch (err) {
      console.error(`[views] failed to create ${k}`, err);
      return;
    }
    if (!model) return;
    model.object.userData.entity = { kind, id };
    root.add(model.object);
    const v: EntityView = {
      kind,
      id,
      model,
      heading,
      growth,
      anim: { action: 'idle', speed: 0, swimming: false, actionTime: 0, holding: 'none' },
      lodTimer: Math.random() * 0.2,
      animDt: 0,
    };
    views.set(k, v);
    sync(v, 0, true);
  }

  function remove(kind: Kind, id: number): void {
    const k = key(kind, id);
    const v = views.get(k);
    if (!v) return;
    root.remove(v.model.object);
    v.model.dispose();
    views.delete(k);
    if (selected && selected.kind === kind && selected.id === id) setSelected(null);
  }

  function rebuildAll(): void {
    for (const v of Array.from(views.values())) remove(v.kind, v.id);
    for (const id of sim.animals.keys()) create('animal', id);
    for (const id of sim.guests.keys()) create('guest', id);
    for (const id of sim.staff.keys()) create('staff', id);
  }

  const offs = [
    sim.events.on('animalAdded', (e) => createAnimalSoon(e.id)),
    sim.events.on('animalRemoved', (e) => remove('animal', e.id)),
    sim.events.on('guestAdded', (e) => create('guest', e.id)),
    sim.events.on('guestRemoved', (e) => remove('guest', e.id)),
    sim.events.on('staffAdded', (e) => create('staff', e.id)),
    sim.events.on('staffRemoved', (e) => remove('staff', e.id)),
    sim.events.on('worldReset', () => rebuildAll()),
  ];

  // Periodic reconcile in case an event was missed (e.g. load before views existed).
  let reconcileTimer = 0;
  function reconcile(): void {
    for (const id of sim.animals.keys()) if (!views.has(key('animal', id))) createAnimalSoon(id);
    for (const id of sim.guests.keys()) if (!views.has(key('guest', id))) create('guest', id);
    for (const id of sim.staff.keys()) if (!views.has(key('staff', id))) create('staff', id);
    for (const v of Array.from(views.values())) {
      const exists =
        v.kind === 'animal' ? sim.animals.has(v.id) : v.kind === 'guest' ? sim.guests.has(v.id) : sim.staff.has(v.id);
      if (!exists) remove(v.kind, v.id);
    }
  }

  // ---------------------------------------------------------------- per-frame sync
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const camPos = new THREE.Vector3();

  function sync(v: EntityView, dt: number, snap = false): void {
    const obj = v.model.object;
    let x = 0,
      y = 0,
      z = 0,
      heading = 0,
      visible = true;
    const anim = v.anim;
    if (v.kind === 'animal') {
      const a = sim.animals.get(v.id);
      if (!a) return;
      x = a.x;
      y = a.y;
      z = a.z;
      heading = a.heading;
      anim.action = a.action;
      anim.speed = a.speed;
      // The sim sets action 'swim' and puts the origin exactly at the water
      // surface while swimming (the model sinks itself). Waders stand on the
      // pond bed below WATER_LEVEL and must not be treated as swimmers.
      anim.swimming = a.action === 'swim' || Math.abs(a.y - WATER_LEVEL) < 1e-3;
      anim.actionTime = a.actionTime;
      if (Math.abs(a.growth - v.growth) > 0.01) {
        v.growth = a.growth;
        v.model.setGrowth(a.growth);
      }
    } else if (v.kind === 'guest') {
      const g = sim.guests.get(v.id);
      if (!g) return;
      x = g.x;
      y = g.y;
      z = g.z;
      heading = g.heading;
      visible = !g.hidden;
      anim.action = g.action === 'leave' ? 'walk' : g.action;
      anim.speed = g.speed;
      anim.actionTime = g.actionTime;
      anim.holding = g.holding;
    } else {
      const s = sim.staff.get(v.id);
      if (!s) return;
      x = s.x;
      y = s.y;
      z = s.z;
      heading = s.heading;
      anim.action = s.action;
      anim.speed = s.speed;
      anim.actionTime = s.actionTime;
    }
    obj.position.set(x, y, z);
    v.heading = snap ? heading : angleLerp(v.heading, heading, Math.min(1, dt * 7));
    obj.rotation.y = v.heading;
    obj.visible = visible;
  }

  function update(dt: number): void {
    const scaled = dt * SPEED_MULTIPLIERS[sim.speed];
    reconcileTimer -= dt;
    if (reconcileTimer <= 0) {
      reconcileTimer = 1;
      reconcile();
    }
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    cam.getWorldPosition(camPos);

    for (const v of views.values()) {
      sync(v, dt);
      const obj = v.model.object;
      if (!obj.visible) continue;
      sphere.center.copy(obj.position);
      sphere.center.y += v.model.height * 0.5;
      sphere.radius = Math.max(v.model.radius, v.model.height * 0.6) + 0.5;
      const onScreen = frustum.intersectsSphere(sphere);
      const dist = camPos.distanceTo(obj.position);
      // Animation (bone matrices) is the main per-creature CPU cost. Distant and
      // coarse-LOD creatures animate at a reduced rate; their position and
      // heading still update every frame (the factory reads object transforms).
      v.animDt += scaled;
      const lod = v.model.lod ?? -1;
      const interval = !onScreen ? 0.5 : lod >= 3 || dist > 90 ? 1 / 12 : lod === 2 ? 1 / 20 : 0;
      // Came closer / on screen: catch up soon, at a random phase so creatures
      // that switch rate together still re-pose on different frames.
      if (v.lodTimer > interval) v.lodTimer = interval * Math.random();
      v.lodTimer -= dt;
      if (v.lodTimer <= 0) {
        v.model.update(v.animDt, v.anim);
        v.animDt = 0;
        // Advance by one interval (not reset to it) so each creature keeps its phase.
        v.lodTimer = interval > 0 ? Math.max(0, v.lodTimer + interval) : 0;
      }
    }

    // selection ring follows the selected entity
    if (selected && selected.kind !== 'object' && selected.kind !== 'habitat') {
      const v = views.get(key(selected.kind as Kind, selected.id));
      if (v && v.model.object.visible) {
        ringPulse += dt;
        const r = Math.max(0.5, v.model.radius * 1.25);
        ring.visible = true;
        ring.position.copy(v.model.object.position);
        ring.position.y += 0.06;
        const s = r * (1 + Math.sin(ringPulse * 4) * 0.05);
        ring.scale.set(s, 1, s);
      } else ring.visible = false;
    } else ring.visible = false;
  }

  // ---------------------------------------------------------------- picking
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmp = new THREE.Vector3();

  function pick(ndcX: number, ndcY: number): SelectionRef | null {
    ndc.set(ndcX, ndcY);
    raycaster.setFromCamera(ndc, ctx.camera);
    const ray = raycaster.ray;
    let best: SelectionRef | null = null;
    let bestDist = Infinity;
    for (const v of views.values()) {
      const obj = v.model.object;
      if (!obj.visible) continue;
      // Generous capsule-ish test: sphere around the body centre, sized for fat fingers.
      sphere.center.copy(obj.position);
      sphere.center.y += v.model.height * 0.5;
      sphere.radius = Math.max(v.model.radius, v.model.height * 0.5) * 1.15 + 0.25;
      const hit = ray.intersectSphere(sphere, tmp);
      if (!hit) continue;
      // Prefer the entity whose centre is closest to the ray (helps in crowds).
      const d = ray.distanceSqToPoint(sphere.center) / (sphere.radius * sphere.radius) + ray.origin.distanceTo(tmp) * 0.002;
      if (d < bestDist) {
        bestDist = d;
        best = { kind: v.kind, id: v.id } as SelectionRef;
      }
    }
    if (best) return best;
    const objId = props.pickObject(raycaster);
    if (objId !== null) return { kind: 'object', id: objId };
    const p = ctx.pickGround(ndcX, ndcY);
    if (p) {
      const t = sim.world.tileOfWorld(p.x, p.z);
      const hab = sim.world.habitatAt(t.x, t.z);
      if (hab) return { kind: 'habitat', id: hab.id };
    }
    return null;
  }

  function setSelected(sel: SelectionRef | null): void {
    if (selected && (selected.kind === 'animal' || selected.kind === 'guest' || selected.kind === 'staff')) {
      views.get(key(selected.kind, selected.id))?.model.setHighlighted(false);
    }
    if (selected && selected.kind === 'object') props.setHighlight(null);
    selected = sel;
    if (sel && (sel.kind === 'animal' || sel.kind === 'guest' || sel.kind === 'staff')) {
      views.get(key(sel.kind, sel.id))?.model.setHighlighted(true);
    }
    if (sel && sel.kind === 'object') props.setHighlight(sel.id);
    ringPulse = 0;
  }

  function positionOf(sel: SelectionRef): THREE.Vector3 | null {
    if (sel.kind === 'animal' || sel.kind === 'guest' || sel.kind === 'staff') {
      const v = views.get(key(sel.kind, sel.id));
      return v ? v.model.object.position.clone() : null;
    }
    if (sel.kind === 'object') {
      const o = sim.world.objects.get(sel.id);
      if (!o) return null;
      const c = sim.world.objectCenter(o);
      return new THREE.Vector3(c.x, c.y, c.z);
    }
    const hab = sim.world.habitats.get(sel.id);
    if (!hab) return null;
    const cx = ((hab.minX + hab.maxX + 1) / 2) * 2;
    const cz = ((hab.minZ + hab.maxZ + 1) / 2) * 2;
    return new THREE.Vector3(cx, sim.world.heightAt(cx, cz), cz);
  }

  function dispose(): void {
    offs.forEach((off) => off());
    for (const v of Array.from(views.values())) remove(v.kind, v.id);
    ctx.scene.remove(root);
    ctx.scene.remove(ring);
    ringGeo.dispose();
    ringMat.dispose();
  }

  rebuildAll();
  return { update, pick, setSelected, positionOf, dispose };
}
