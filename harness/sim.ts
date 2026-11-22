// Visual harness for the simulation (src/sim): a top-down debug map of the
// live zoo (terrain, paths, fences, objects, litter, animals, guests, staff)
// plus a zoomed inset and a stats panel.
// URL params:
//   ?time=HH:MM    simulate from opening (07:30) until this time (default 13:00)
//   ?focus=x,z     centre of the zoom inset in metres (default the main promenade)
//   ?zoom=px       inset pixels per metre (default 13)
//   ?run=1         keep simulating live at 4x

import { MAP_H, MAP_W, TILE } from '../src/core/constants';
import { EventBus } from '../src/core/events';
import { Terrain, type ObjectCategory } from '../src/core/types';
import { buildDemoZoo } from '../src/demo';
import { FENCES_BY_ID } from '../src/data/fences';
import { OBJECTS_BY_ID } from '../src/data/objects';
import { SPECIES_BY_ID } from '../src/data/species';
import { createSimulation } from '../src/sim';
import type { Simulation } from '../src/sim/simulation';

const params = new URLSearchParams(location.search);
const [hh, mm] = (params.get('time') ?? '13:00').split(':').map(Number);
const focusArg = (params.get('focus') ?? '74,112').split(',').map(Number);
const zoom = Number(params.get('zoom') ?? 13);
const run = params.get('run') === '1';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const events = new EventBus();
const notes: string[] = [];
events.on('notify', (n) => {
  notes.push(`[${n.kind}] ${n.text}`);
  if (notes.length > 9) notes.shift();
});
const sim = createSimulation(events, 42) as Simulation;
sim.newGame();
const report = buildDemoZoo(sim);
sim.setSpeed(3);
const t0 = performance.now();
let warm = 0;
while (sim.minuteOfDay < hh * 60 + (mm || 0) && warm < 5000) {
  sim.update(0.1);
  warm++;
}
const warmMs = performance.now() - t0;
sim.setSpeed(run ? 3 : 0);

const TERRAIN_COL: Record<number, string> = {
  [Terrain.Grass]: '#5d7a3e',
  [Terrain.DryGrass]: '#a19858',
  [Terrain.Dirt]: '#7a6146',
  [Terrain.Sand]: '#cbb98a',
  [Terrain.Rock]: '#86857d',
  [Terrain.Snow]: '#e6eaec',
  [Terrain.Mud]: '#574634',
  [Terrain.Water]: '#5b88a6',
  [Terrain.DeepWater]: '#2e5878',
};
const PATH_COL = ['', '#cfc8b8', '#aaa290', '#8d6b47'];
const CAT_COL: Record<ObjectCategory, string> = {
  tree: '#2c5228',
  plant: '#4f7d3c',
  rock: '#6f6d66',
  shelter: '#6b4f35',
  enrichment: '#b4682e',
  feeder: '#c6a43c',
  shop: '#b5523d',
  facility: '#3f5f9e',
  amenity: '#9a9a9a',
  decoration: '#c27ea0',
};
const SPECIES_COL: Record<string, string> = {
  elephant: '#8d8a86',
  giraffe: '#d8a24a',
  zebra: '#f4f4f4',
  lion: '#c9963f',
  tiger: '#e07a28',
  grizzly: '#6b4a2e',
  polarbear: '#f2efe4',
  hippo: '#8a6f78',
  rhino: '#a7a39a',
  gazelle: '#c98d55',
  camel: '#c8a26c',
  gorilla: '#2e2e2e',
  penguin: '#1d2230',
  flamingo: '#f08aa0',
};
const FENCE_COL: Record<string, string> = { wood: '#8b5a2b', chainlink: '#b9c2c6', stone: '#5f5d58', glass: '#8ff0ff', steel: '#202428' };
const STAFF_COL: Record<string, string> = { keeper: '#6f7b3c', groundskeeper: '#2f9a4c', vet: '#ffffff' };

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

interface View {
  ox: number;
  oy: number;
  s: number; // px per metre
  wx0: number; // world x at ox
  wz0: number;
  w: number;
  h: number;
}

function drawWorld(v: View, detail: boolean) {
  const w = sim.world;
  ctx.save();
  ctx.beginPath();
  ctx.rect(v.ox, v.oy, v.w, v.h);
  ctx.clip();
  const X = (x: number) => v.ox + (x - v.wx0) * v.s;
  const Z = (z: number) => v.oy + (z - v.wz0) * v.s;
  const ts = TILE * v.s;
  for (let z = 0; z < MAP_H; z++)
    for (let x = 0; x < MAP_W; x++) {
      const i = z * MAP_W + x;
      const px = X(x * TILE),
        pz = Z(z * TILE);
      if (px > v.ox + v.w || pz > v.oy + v.h || px + ts < v.ox || pz + ts < v.oy) continue;
      ctx.fillStyle = TERRAIN_COL[w.terrain[i]];
      ctx.fillRect(px, pz, ts + 0.5, ts + 0.5);
      if (w.path[i]) {
        ctx.fillStyle = PATH_COL[w.path[i]];
        ctx.fillRect(px, pz, ts + 0.5, ts + 0.5);
      }
    }
  // view tiles (debug tint)
  if (detail) {
    ctx.fillStyle = 'rgba(80,160,255,0.12)';
    for (const hab of w.habitats.values())
      for (const t of hab.viewTiles) ctx.fillRect(X((t % MAP_W) * TILE), Z(Math.floor(t / MAP_W) * TILE), ts, ts);
  }
  // objects
  for (const o of w.objects.values()) {
    const def = OBJECTS_BY_ID[o.defId];
    const fp = w.footprint(o);
    let minx = Infinity,
      minz = Infinity,
      maxx = -Infinity,
      maxz = -Infinity;
    for (const t of fp) {
      minx = Math.min(minx, t.x);
      minz = Math.min(minz, t.z);
      maxx = Math.max(maxx, t.x + 1);
      maxz = Math.max(maxz, t.z + 1);
    }
    ctx.fillStyle = CAT_COL[def.category];
    if (def.category === 'tree' || def.category === 'plant') {
      const c = w.objectCenter(o);
      ctx.beginPath();
      ctx.arc(X(c.x), Z(c.z), ((maxx - minx) * TILE * v.s) * (def.category === 'tree' ? 0.45 : 0.3), 0, Math.PI * 2);
      ctx.fill();
    } else {
      const inset = def.category === 'rock' ? ts * 0.2 : ts * 0.08;
      ctx.fillRect(X(minx * TILE) + inset, Z(minz * TILE) + inset, (maxx - minx) * ts - 2 * inset, (maxz - minz) * ts - 2 * inset);
      if (detail && (def.category === 'shop' || def.category === 'facility' || def.category === 'amenity')) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(9, v.s * 0.9)}px sans-serif`;
        ctx.fillText(def.name.split(' ')[0], X(minx * TILE) + 2, Z(minz * TILE) + v.s * 1.1);
      }
    }
  }
  // fences
  ctx.lineWidth = Math.max(1.5, v.s * 0.18);
  for (let z = 0; z <= MAP_H; z++)
    for (let x = 0; x < MAP_W; x++) {
      const f = w.hFence[w.hIdx(x, z)];
      if (!f) continue;
      ctx.strokeStyle = FENCE_COL[FENCES_BY_ID[f]?.key ?? 'wood'];
      ctx.beginPath();
      ctx.moveTo(X(x * TILE), Z(z * TILE));
      ctx.lineTo(X((x + 1) * TILE), Z(z * TILE));
      ctx.stroke();
    }
  for (let z = 0; z < MAP_H; z++)
    for (let x = 0; x <= MAP_W; x++) {
      const f = w.vFence[w.vIdx(x, z)];
      if (!f) continue;
      ctx.strokeStyle = FENCE_COL[FENCES_BY_ID[f]?.key ?? 'wood'];
      ctx.beginPath();
      ctx.moveTo(X(x * TILE), Z(z * TILE));
      ctx.lineTo(X(x * TILE), Z((z + 1) * TILE));
      ctx.stroke();
    }
  // litter
  for (const l of sim.litter.values()) {
    ctx.fillStyle = l.kind === 'trash' ? '#f6f1e0' : '#3b2a18';
    ctx.beginPath();
    ctx.arc(X(l.x), Z(l.z), Math.max(1.2, v.s * 0.15), 0, Math.PI * 2);
    ctx.fill();
  }
  // animals: oriented bodies
  for (const a of sim.animals.values()) {
    const sp = SPECIES_BY_ID[a.speciesId];
    const len = Math.max(0.35, sp.length * (0.45 + 0.55 * a.growth)) * v.s;
    const wid = Math.max(0.25, Math.min(sp.length * 0.4, sp.height * 0.5) * (0.45 + 0.55 * a.growth)) * v.s;
    ctx.save();
    ctx.translate(X(a.x), Z(a.z));
    // heading θ: forward = (sin θ, cos θ) in (x, z); canvas y = z
    ctx.rotate(-a.heading + Math.PI / 2);
    ctx.fillStyle = SPECIES_COL[a.speciesId] ?? '#f0f';
    ctx.strokeStyle = a.escaped ? '#ff2020' : a.action === 'sleep' ? '#3050ff' : '#101010';
    ctx.lineWidth = a.escaped ? 2.5 : 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // head marker
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(len / 2, 0, Math.max(1, wid * 0.18), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (detail) {
      ctx.fillStyle = '#fff';
      ctx.font = '10px monospace';
      ctx.fillText(a.action, X(a.x) + 4, Z(a.z) - 4);
    }
  }
  // people
  for (const g of sim.guests.values()) {
    if (g.hidden) continue;
    const r = Math.max(1.3, (g.appearance.child ? 0.2 : 0.27) * v.s);
    ctx.fillStyle = hex(g.appearance.shirt);
    ctx.strokeStyle = g.action === 'watch' ? '#ffe14a' : g.action === 'sit' ? '#4af' : '#000';
    ctx.lineWidth = detail ? 1.5 : 0.8;
    ctx.beginPath();
    ctx.arc(X(g.x), Z(g.z), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (detail) {
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      ctx.moveTo(X(g.x), Z(g.z));
      ctx.lineTo(X(g.x + Math.sin(g.heading) * 0.5), Z(g.z + Math.cos(g.heading) * 0.5));
      ctx.stroke();
    }
  }
  for (const s of sim.staff.values()) {
    const r = Math.max(2, 0.32 * v.s);
    ctx.fillStyle = STAFF_COL[s.role];
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.fillRect(X(s.x) - r, Z(s.z) - r, 2 * r, 2 * r);
    ctx.strokeRect(X(s.x) - r, Z(s.z) - r, 2 * r, 2 * r);
  }
  ctx.restore();
}

function hist(values: Iterable<string>): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
}

function draw() {
  const W = (canvas.width = window.innerWidth);
  const H = (canvas.height = window.innerHeight);
  ctx.fillStyle = '#111511';
  ctx.fillRect(0, 0, W, H);
  const mapPx = Math.min(H - 16, W * 0.55);
  drawWorld({ ox: 8, oy: 8, s: mapPx / (MAP_W * TILE), wx0: 0, wz0: 0, w: mapPx, h: mapPx }, false);
  // focus frame on the overview
  const iw = W - mapPx - 24,
    ih = Math.round(H * 0.5);
  const fw = iw / zoom,
    fh = ih / zoom;
  const fx = focusArg[0] - fw / 2,
    fz = focusArg[1] - fh / 2;
  const sMap = mapPx / (MAP_W * TILE);
  ctx.strokeStyle = '#ffeb3b';
  ctx.lineWidth = 1;
  ctx.strokeRect(8 + fx * sMap, 8 + fz * sMap, fw * sMap, fh * sMap);
  drawWorld({ ox: mapPx + 16, oy: 8, s: zoom, wx0: fx, wz0: fz, w: iw, h: ih }, true);
  ctx.strokeStyle = '#ffeb3b';
  ctx.strokeRect(mapPx + 16, 8, iw, ih);
  // stats panel
  const st = sim.stats();
  const hr = Math.floor(sim.minuteOfDay / 60),
    mi = Math.floor(sim.minuteOfDay % 60);
  const lines: string[] = [];
  lines.push(
    `Day ${sim.day} ${String(hr).padStart(2, '0')}:${String(mi).padStart(2, '0')}  $${Math.round(sim.money).toLocaleString('en-US')}  rating ${sim.rating.toFixed(1)}  admission $${sim.admissionPrice}`,
  );
  lines.push(
    `guests ${st.guestsInZoo} (today ${st.guestsToday}, total ${st.totalVisitors})  happy ${(st.avgGuestHappiness * 100).toFixed(0)}%   animals ${st.animalCount} (${st.speciesCount} spp) happy ${(st.avgAnimalHappiness * 100).toFixed(0)}%   staff ${st.staffCount}  litter ${st.litterCount}`,
  );
  lines.push(`warm-up ${warm} steps in ${warmMs.toFixed(0)} ms   demo failures: ${report.failures.length}`);
  lines.push(`animal actions: ${hist([...sim.animals.values()].map((a) => a.action))}`);
  lines.push(`guest actions: ${hist([...sim.guests.values()].map((g) => g.action))}`);
  lines.push(`holding: ${hist([...sim.guests.values()].map((g) => g.holding))}`);
  lines.push('');
  for (const hab of sim.world.habitats.values()) {
    const rep = sim.habitatReport(hab.id)!;
    const rt = sim.habRt.get(hab.id);
    const s0 = rep.suitability[0];
    lines.push(
      `${hab.name.padEnd(16)} ${String(rep.animals.length).padStart(2)} anim  food ${(rt?.food ?? 0).toFixed(1).padStart(5)}  ${s0 ? `${Math.round(s0.score * 100)}%  ${s0.issues[0] ?? 'ok'}` : ''}`,
    );
  }
  lines.push('');
  lines.push('staff: ' + [...sim.staff.values()].map((s) => `${s.role}: ${s.task}`).join(' | '));
  lines.push('');
  const thoughts = [...sim.guests.values()].map((g) => g.thoughts[g.thoughts.length - 1]).filter(Boolean) as string[];
  lines.push('thoughts:');
  const th = new Map<string, number>();
  for (const t of thoughts) th.set(t, (th.get(t) ?? 0) + 1);
  for (const [t, n] of [...th.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) lines.push(`  ${n}× ${t}`);
  lines.push('');
  for (const n of notes.slice(-6)) lines.push(n);
  ctx.fillStyle = '#e8ecd8';
  ctx.font = '11px monospace';
  let y = ih + 26;
  const maxChars = Math.floor(iw / 6.6);
  for (const l of lines) {
    ctx.fillText(l.length > maxChars ? l.slice(0, maxChars - 1) + '…' : l, mapPx + 16, y);
    y += 13.5;
  }
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (run) sim.update(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
(window as unknown as Record<string, unknown>).__sim = sim;
