// Build-menu thumbnails. 3D items (objects, fences, animals, staff) are
// rendered offscreen with the game's own renderer and models into a small
// multisampled render target, read back, and cached as data URLs. Terrain and
// path swatches are painted procedurally on a 2D canvas. Work is queued and
// processed a little per frame so opening a drawer never stalls the game.
// Finished thumbnails are also persisted in IndexedDB (versioned keys), so on
// the next launch the drawers fill instantly; any storage failure (private
// mode, quota, no IndexedDB) silently falls back to rendering.

import * as THREE from 'three';
import type { CreatureModel, ICreatureFactory, IPropsLayer } from '../core/contracts';
import { Noise } from '../core/rng';
import { PathType, Terrain, type HumanAppearance, type StaffRole } from '../core/types';
import { FENCES_BY_ID, PATHS_BY_TYPE } from '../data/fences';
import { OBJECTS_BY_ID } from '../data/objects';
import { SPECIES_BY_ID } from '../data/species';
import type { ThumbSpec } from './catalog';
import { disposeOwned } from './preview';

/**
 * Bump whenever thumbnail framing / lighting or the procedural models change
 * enough that cached images from an older build would look wrong. Keys also
 * hash the item's catalogue entry, so data edits invalidate single entries.
 */
export const THUMB_CACHE_VERSION = 5;
const DB_NAME = 'wildhaven-thumbs';
const DB_STORE = 'thumbs';

export const THUMB_W = 228;
export const THUMB_H = 192;

type Listener = (url: string) => void;

export function thumbKey(s: ThumbSpec): string {
  switch (s.kind) {
    case 'object':
      return `o:${s.defId}`;
    case 'fence':
      return `f:${s.fenceId}`;
    case 'animal':
      return `a:${s.speciesId}`;
    case 'staff':
      return `s:${s.role}`;
    case 'terrain':
      return `t:${s.terrain}`;
    case 'path':
      return `p:${s.pathType}`;
    default:
      return `i:${s.icon}`;
  }
}

const STAFF_LOOK: Record<StaffRole, HumanAppearance> = {
  keeper: { skin: 0xc58c6a, hair: 0x3b2a1e, shirt: 0x5d6b3a, pants: 0x4a4334, shoes: 0x2a241d, hairStyle: 3, height: 1.76, build: 1.0, child: false, female: false },
  groundskeeper: { skin: 0x8d5a3b, hair: 0x1d1714, shirt: 0x3f5d6f, pants: 0x34383c, shoes: 0x222222, hairStyle: 0, height: 1.72, build: 1.05, child: false, female: false },
  vet: { skin: 0xe0b394, hair: 0x6a4a2c, shirt: 0xe9ece8, pants: 0x3e4a5a, shoes: 0x2b2b2b, hairStyle: 1, height: 1.68, build: 0.95, child: false, female: true },
};

function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Catalogue data a thumbnail depends on (so edits re-render just that item). */
function specData(s: ThumbSpec): unknown {
  switch (s.kind) {
    case 'object':
      return OBJECTS_BY_ID[s.defId];
    case 'fence':
      return FENCES_BY_ID[s.fenceId];
    case 'animal':
      return SPECIES_BY_ID[s.speciesId];
    case 'staff':
      return STAFF_LOOK[s.role];
    case 'path':
      return PATHS_BY_TYPE[s.pathType];
    case 'terrain':
      return TERRAIN_PAL[s.terrain];
    default:
      return null;
  }
}

/**
 * Tiny IndexedDB key/value store for thumbnail data URLs. Every operation is
 * best-effort: errors, a blocked upgrade or a slow disk just mean "no cache".
 */
class ThumbStore {
  private db: IDBDatabase | null = null;
  private writes = new Map<string, string>();
  private timer = 0;
  private closed = false;

  /**
   * Load every entry with the given key prefix (removing entries written by
   * other cache versions). Resolves with an empty map on any failure. There is
   * no wall-clock timeout here (a busy main thread during loading would trip
   * it); the caller stops waiting after a number of rendered frames instead.
   */
  load(prefix: string): Promise<Map<string, string>> {
    const version = prefix.slice(0, prefix.indexOf('|') + 1);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (m: Map<string, string>) => {
        if (settled) return;
        settled = true;
        resolve(m);
      };
      try {
        const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
        if (!idb) return finish(new Map());
        const req = idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          try {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
          } catch {
            /* ignore */
          }
        };
        req.onerror = () => finish(new Map());
        req.onblocked = () => finish(new Map());
        req.onsuccess = () => {
          const db = req.result;
          if (this.closed) {
            db.close();
            return finish(new Map());
          }
          this.db = db;
          db.onversionchange = () => {
            db.close();
            this.db = null;
          };
          const out = new Map<string, string>();
          try {
            // two bulk reads (one round trip each) instead of a cursor step per entry
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            const keysReq = store.getAllKeys();
            const valsReq = store.getAll();
            valsReq.onsuccess = () => {
              const keys = keysReq.result;
              const vals = valsReq.result;
              for (let i = 0; i < keys.length; i++) {
                const k = String(keys[i]);
                const v = vals[i];
                if (k.startsWith(prefix)) {
                  if (typeof v === 'string' && v.startsWith('data:image/')) out.set(k.slice(prefix.length), v);
                } else if (!k.startsWith(version)) store.delete(keys[i]); // written by an older build
              }
              finish(out); // don't wait for the stale-entry deletes to commit
            };
            tx.onerror = () => finish(out);
            tx.onabort = () => finish(out);
          } catch {
            finish(out);
          }
        };
      } catch {
        finish(new Map());
      }
    });
  }

  /** Queue a write (flushed in one transaction shortly after). */
  put(key: string, url: string): void {
    if (this.closed) return;
    this.writes.set(key, url);
    if (!this.timer) this.timer = window.setTimeout(() => this.flush(), 400);
  }

  private flush(): void {
    this.timer = 0;
    const db = this.db;
    if (!db || !this.writes.size) {
      this.writes.clear();
      return;
    }
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      for (const [k, v] of this.writes) store.put(v, k);
      tx.onerror = (e) => e.preventDefault(); // quota etc.: just don't persist
    } catch {
      /* storage unavailable */
    }
    this.writes.clear();
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.flush();
    }
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }
}

export class ThumbnailService {
  private cache = new Map<string, string>();
  private store = new ThumbStore();
  /** Persistent entries loaded from IndexedDB (key → data URL), null until loaded. */
  private persisted: Map<string, string> | null = null;
  private prefix: string;
  /** Frames spent waiting for the persistent cache before rendering anyway. */
  private waitFrames = 0;
  private failed = new Set<string>();
  private queue: { key: string; spec: ThumbSpec }[] = [];
  private queued = new Set<string>();
  private listeners = new Map<string, Listener[]>();
  private busy = false;
  private frame = 0;
  private rt: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(26, THUMB_W / THUMB_H, 0.05, 400);
  private pixels = new Uint8Array(THUMB_W * THUMB_H * 4);
  private disposed = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private props: IPropsLayer,
    private creatures: ICreatureFactory,
    private envScene: THREE.Scene,
    /** Variant tag for persisted thumbnails (e.g. the quality tier models were built at); null disables persistence. */
    variant: string | null = 'default',
  ) {
    this.prefix = `v${THUMB_CACHE_VERSION}|${variant ?? ''}|`;
    if (variant !== null) {
      this.store.load(this.prefix).then((m) => {
        if (this.disposed) return;
        // keep anything rendered while the store was opening
        if (this.persisted) for (const [k, v] of this.persisted) m.set(k, v);
        this.persisted = m;
        // serve everything that was requested while the store was opening
        const waiting = this.queue.splice(0);
        for (const job of waiting) {
          const hit = m.get(this.persistKey(job.key, job.spec));
          if (hit) this.resolve(job.key, hit, false);
          else this.queue.push(job);
        }
      });
    } else this.persisted = new Map();
    const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x5d5140, 1.35);
    const key = new THREE.DirectionalLight(0xfff0da, 2.3);
    key.position.set(4, 7, 5);
    const rim = new THREE.DirectionalLight(0xcfe0ff, 0.8);
    rim.position.set(-5, 3, -4);
    this.scene.add(hemi, key, rim);
  }

  get(spec: ThumbSpec): string | null {
    return this.cache.get(thumbKey(spec)) ?? null;
  }

  private pkCache = new Map<string, string>();
  private persistKey(key: string, spec: ThumbSpec): string {
    let pk = this.pkCache.get(key);
    if (pk) return pk;
    let fp = '';
    try {
      fp = hashStr(JSON.stringify(specData(spec)) ?? '');
    } catch {
      fp = '';
    }
    pk = `${key}#${fp}`;
    this.pkCache.set(key, pk);
    return pk;
  }

  /** Ask for a thumbnail; cb fires (possibly later) once it is ready. */
  request(spec: ThumbSpec, cb: Listener, priority = false): void {
    const key = thumbKey(spec);
    let hit = this.cache.get(key);
    if (!hit && this.persisted && spec.kind !== 'icon') {
      hit = this.persisted.get(this.persistKey(key, spec));
      if (hit) this.cache.set(key, hit);
    }
    if (hit) {
      cb(hit);
      return;
    }
    if (this.failed.has(key) || spec.kind === 'icon') return;
    const ls = this.listeners.get(key);
    if (ls) ls.push(cb);
    else this.listeners.set(key, [cb]);
    if (!this.queued.has(key)) {
      this.queued.add(key);
      if (priority) this.queue.unshift({ key, spec });
      else this.queue.push({ key, spec });
    }
  }

  private resolve(key: string, url: string | null, spec: ThumbSpec | false): void {
    this.queued.delete(key);
    const ls = this.listeners.get(key);
    this.listeners.delete(key);
    if (!url) {
      this.failed.add(key);
      return;
    }
    this.cache.set(key, url);
    if (spec && this.persisted) {
      const pk = this.persistKey(key, spec);
      this.persisted.set(pk, url);
      this.store.put(this.prefix + pk, url);
    }
    if (ls) for (const fn of ls) fn(url);
  }

  /** Process queued work (call once per frame, before the main render). */
  update(): void {
    if (this.disposed || this.busy || !this.queue.length) return;
    // give the persistent cache a moment to open before rendering anything it may hold
    if (!this.persisted) {
      if (++this.waitFrames < 150) return;
      this.persisted = new Map(); // storage is too slow: render now, merge when it arrives
    }
    this.frame++;
    if (this.frame % 2) return; // at most one thumbnail every other frame
    const job = this.queue.shift()!;
    const s = job.spec;
    if (s.kind === 'terrain') this.resolve(job.key, terrainSwatch(s.terrain), s);
    else if (s.kind === 'path') this.resolve(job.key, pathSwatch(s.pathType), s);
    else if (s.kind === 'animal') {
      this.busy = true;
      this.creatures
        .preload([s.speciesId])
        .catch(() => undefined)
        .then(() => {
          this.busy = false;
          if (this.disposed) return;
          this.resolve(job.key, this.renderCreature(() => this.creatures.createAnimal(s.speciesId, { seed: 11, sex: 'M', growth: 1 }), 'animal'), s);
        });
    } else if (s.kind === 'staff') {
      this.resolve(job.key, this.renderCreature(() => this.creatures.createHuman(STAFF_LOOK[s.role], s.role, 5), 'human'), s);
    } else if (s.kind === 'object') {
      this.resolve(job.key, this.renderModel(() => this.props.createObjectModel(s.defId, 3), 0.62), s);
    } else if (s.kind === 'fence') {
      this.resolve(job.key, this.renderModel(() => this.props.createFenceSegmentModel(s.fenceId), 0.5), s);
    }
  }

  // ------------------------------------------------------------ 3D rendering
  private renderModel(make: () => THREE.Object3D, yaw: number): string | null {
    let obj: THREE.Object3D | null = null;
    try {
      obj = make();
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return null;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const url = this.shoot(obj, sphere.center, sphere.radius, yaw, 0.38, box.min.y);
      return url;
    } catch (err) {
      console.warn('[ui] thumbnail failed', err);
      return null;
    } finally {
      if (obj) disposeOwned(obj);
    }
  }

  private renderCreature(make: () => CreatureModel, kind: 'animal' | 'human'): string | null {
    let model: CreatureModel | null = null;
    try {
      model = make();
      model.update(0.016, { action: 'idle', speed: 0 });
      model.object.updateMatrixWorld(true);
      const h = Math.max(0.3, model.height);
      let center: THREE.Vector3;
      let radius: number;
      const box = new THREE.Box3().setFromObject(model.object, true);
      if (!box.isEmpty() && box.max.y > 0.05) {
        const sp = box.getBoundingSphere(new THREE.Sphere());
        center = sp.center;
        radius = sp.radius * 0.92;
      } else {
        center = new THREE.Vector3(0, h * 0.5, 0);
        radius = Math.max(h * 0.6, model.radius * 1.2);
      }
      return this.shoot(model.object, center, radius, kind === 'human' ? 0.35 : 0.95, kind === 'human' ? 0.12 : 0.22, 0);
    } catch (err) {
      console.warn('[ui] creature thumbnail failed', err);
      return null;
    } finally {
      model?.dispose();
    }
  }

  private shoot(obj: THREE.Object3D, center: THREE.Vector3, radius: number, yaw: number, pitch: number, groundY: number): string | null {
    const r = this.renderer;
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(THUMB_W, THUMB_H, {
        samples: 4,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: true,
      });
    }
    this.scene.add(obj);
    this.scene.environment = this.envScene.environment;
    this.scene.environmentIntensity = 0.55;
    const fov = (this.cam.fov * Math.PI) / 180;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.cam.aspect));
    const dist = (radius / Math.sin(fit / 2)) * 1.02;
    const cp = Math.cos(pitch);
    this.cam.position.set(center.x + Math.sin(yaw) * cp * dist, center.y + Math.sin(pitch) * dist, center.z + Math.cos(yaw) * cp * dist);
    this.cam.near = Math.max(0.02, dist - radius * 3);
    this.cam.far = dist + radius * 3;
    this.cam.lookAt(center);
    this.cam.updateProjectionMatrix();

    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAutoClear = r.autoClear;
    let url: string | null = null;
    try {
      r.autoClear = false;
      this.pass();
      // second pass: re-frame tightly around what was actually drawn
      const region = this.tightRegion();
      if (region) {
        this.cam.setViewOffset(THUMB_W, THUMB_H, region.x, region.y, region.w, region.h);
        this.pass();
      }
      // where does the ground under the object project to? (for a soft contact shadow)
      const g = new THREE.Vector3(center.x, groundY, center.z).project(this.cam);
      const gs = new THREE.Vector3(center.x + radius * 0.8, groundY, center.z).project(this.cam);
      url = this.toDataUrl((g.x * 0.5 + 0.5) * THUMB_W, (1 - (g.y * 0.5 + 0.5)) * THUMB_H, Math.abs(gs.x - g.x) * 0.5 * THUMB_W);
    } finally {
      this.cam.clearViewOffset();
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevClear, prevAlpha);
      r.autoClear = prevAutoClear;
      this.scene.remove(obj);
      this.scene.environment = null;
    }
    return url;
  }

  private pass(): void {
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(this.scene, this.cam);
    r.readRenderTargetPixels(this.rt!, 0, 0, THUMB_W, THUMB_H, this.pixels);
  }

  /** Sub-window (top-down pixel coords) that frames the drawn pixels with padding, or null if already tight. */
  private tightRegion(): { x: number; y: number; w: number; h: number } | null {
    const px = this.pixels;
    let x0 = THUMB_W,
      x1 = -1,
      y0 = THUMB_H,
      y1 = -1;
    for (let y = 0; y < THUMB_H; y++) {
      const row = y * THUMB_W * 4;
      for (let x = 0; x < THUMB_W; x++) {
        if (px[row + x * 4 + 3] < 12) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    // GL rows are bottom-up → convert to top-down
    const top = THUMB_H - 1 - y1,
      bottom = THUMB_H - 1 - y0;
    let w = (x1 - x0 + 1) * 1.16,
      h = (bottom - top + 1) * 1.2;
    const aspect = THUMB_W / THUMB_H;
    if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
    if (w > THUMB_W * 0.92) return null; // already fills the frame
    const minW = THUMB_W / 6;
    if (w < minW) {
      w = minW;
      h = w / aspect;
    }
    const cx = (x0 + x1 + 1) / 2;
    const cy = (top + bottom + 1) / 2 + h * 0.03; // a little room for the ground shadow
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  private toDataUrl(gx: number, gy: number, gr: number): string | null {
    const cv = document.createElement('canvas');
    cv.width = THUMB_W;
    cv.height = THUMB_H;
    const c = cv.getContext('2d');
    if (!c) return null;
    const img = c.createImageData(THUMB_W, THUMB_H);
    const src = this.pixels,
      dst = img.data;
    let drawn = 0;
    for (let y = 0; y < THUMB_H; y++) {
      const sy = THUMB_H - 1 - y; // GL rows are bottom-up
      for (let x = 0; x < THUMB_W; x++) {
        const si = (sy * THUMB_W + x) * 4,
          di = (y * THUMB_W + x) * 4;
        const a = src[si + 3];
        if (a) {
          drawn++;
          // un-premultiply edge pixels
          const k = a < 255 ? 255 / a : 1;
          dst[di] = Math.min(255, src[si] * k);
          dst[di + 1] = Math.min(255, src[si + 1] * k);
          dst[di + 2] = Math.min(255, src[si + 2] * k);
          dst[di + 3] = a;
        }
      }
    }
    if (drawn < 20) return null;
    // soft contact shadow under the model, then the model on top
    if (gr > 2) {
      const grad = c.createRadialGradient(gx, gy, 0, gx, gy, gr);
      grad.addColorStop(0, 'rgba(0,0,0,0.42)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      c.save();
      c.translate(gx, gy);
      c.scale(1, 0.32);
      c.translate(-gx, -gy);
      c.fillStyle = grad;
      c.beginPath();
      c.arc(gx, gy, gr, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    const layer = document.createElement('canvas');
    layer.width = THUMB_W;
    layer.height = THUMB_H;
    layer.getContext('2d')!.putImageData(img, 0, 0);
    c.drawImage(layer, 0, 0);
    return encodeCanvas(cv);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.listeners.clear();
    this.rt?.dispose();
    this.rt = null;
    this.store.close();
  }
}

// ---------------------------------------------------------------------------
// Procedural 2D swatches

const SW = 128;
const noise = new Noise(9071);

let webpOk: boolean | null = null;
/** WebP (with alpha) is ~3× smaller than PNG for these images; fall back to PNG where unsupported. */
function encodeCanvas(cv: HTMLCanvasElement): string {
  if (webpOk !== false) {
    const u = cv.toDataURL('image/webp', 0.9);
    webpOk = u.startsWith('data:image/webp');
    if (webpOk) return u;
  }
  return cv.toDataURL('image/png');
}

function swatchCanvas(): { cv: HTMLCanvasElement; c: CanvasRenderingContext2D; img: ImageData } | null {
  const cv = document.createElement('canvas');
  cv.width = SW;
  cv.height = SW;
  const c = cv.getContext('2d');
  if (!c) return null;
  return { cv, c, img: c.createImageData(SW, SW) };
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const TERRAIN_PAL: [RGB, RGB, number, number][] = [
  // [dark, light, noise scale, grain]
  [[62, 86, 38], [118, 142, 66], 0.09, 0.5],
  [[146, 124, 70], [204, 182, 118], 0.08, 0.55],
  [[104, 78, 54], [150, 116, 82], 0.07, 0.45],
  [[198, 176, 128], [232, 214, 168], 0.05, 0.35],
  [[104, 100, 94], [158, 154, 146], 0.11, 0.6],
  [[208, 218, 226], [246, 249, 251], 0.06, 0.25],
  [[70, 54, 38], [112, 90, 64], 0.06, 0.35],
  [[62, 116, 128], [120, 170, 172], 0.05, 0.25],
  [[22, 62, 84], [52, 104, 124], 0.04, 0.2],
];

export function terrainSwatch(t: Terrain): string | null {
  const s = swatchCanvas();
  if (!s) return null;
  const [dark, light, sc, grain] = TERRAIN_PAL[t] ?? TERRAIN_PAL[0];
  const d = s.img.data;
  for (let y = 0; y < SW; y++)
    for (let x = 0; x < SW; x++) {
      let v = noise.fbm2(x * sc + t * 13, y * sc, 4) * 0.5 + 0.5;
      const fine = noise.noise2(x * 0.9 + t * 7, y * 0.9) * 0.5 + 0.5;
      v = v * (1 - grain * 0.4) + fine * grain * 0.4;
      if (t === Terrain.Water || t === Terrain.DeepWater) {
        const ripple = Math.sin(x * 0.18 + noise.noise2(x * 0.03, y * 0.05) * 6) * 0.5 + 0.5;
        v = v * 0.7 + ripple * 0.3;
      }
      if (t === Terrain.Rock) {
        const crack = Math.abs(noise.noise2(x * 0.06 + 40, y * 0.06));
        if (crack < 0.05) v *= 0.55;
      }
      const c = mix(dark, light, Math.max(0, Math.min(1, v)));
      const i = (y * SW + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  s.c.putImageData(s.img, 0, 0);
  if (t === Terrain.Grass || t === Terrain.DryGrass) {
    // short blade strokes
    const col = t === Terrain.Grass ? 'rgba(150,178,88,0.55)' : 'rgba(226,206,140,0.5)';
    s.c.strokeStyle = col;
    s.c.lineWidth = 1;
    for (let k = 0; k < 260; k++) {
      const x = (Math.sin(k * 12.9898) * 43758.5453) % 1;
      const y = (Math.sin(k * 78.233) * 12345.6789) % 1;
      const px = Math.abs(x) * SW,
        py = Math.abs(y) * SW;
      s.c.beginPath();
      s.c.moveTo(px, py);
      s.c.lineTo(px + ((k % 5) - 2) * 0.8, py - 4 - (k % 4));
      s.c.stroke();
    }
  }
  if (t === Terrain.Water || t === Terrain.DeepWater) {
    const g = s.c.createLinearGradient(0, 0, SW, SW);
    g.addColorStop(0, 'rgba(255,255,255,0.18)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    s.c.fillStyle = g;
    s.c.fillRect(0, 0, SW, SW);
  }
  return encodeCanvas(s.cv);
}

export function pathSwatch(p: PathType): string | null {
  const s = swatchCanvas();
  if (!s) return null;
  const c = s.c;
  if (p === PathType.Gravel) {
    const d = s.img.data;
    for (let y = 0; y < SW; y++)
      for (let x = 0; x < SW; x++) {
        const v = noise.noise2(x * 0.55, y * 0.55) * 0.5 + 0.5;
        const w = noise.fbm2(x * 0.05, y * 0.05, 2) * 0.5 + 0.5;
        const base = mix([132, 120, 102], [196, 184, 162], v * 0.7 + w * 0.3);
        const i = (y * SW + x) * 4;
        d[i] = base[0];
        d[i + 1] = base[1];
        d[i + 2] = base[2];
        d[i + 3] = 255;
      }
    c.putImageData(s.img, 0, 0);
    for (let k = 0; k < 180; k++) {
      const x = Math.abs(Math.sin(k * 91.7) * 9871.3) % SW,
        y = Math.abs(Math.sin(k * 17.3) * 4471.9) % SW;
      c.fillStyle = k % 3 ? 'rgba(90,80,66,0.35)' : 'rgba(240,232,214,0.45)';
      c.beginPath();
      c.ellipse(x, y, 1.6 + (k % 3), 1.2 + (k % 2), k, 0, Math.PI * 2);
      c.fill();
    }
  } else if (p === PathType.Boardwalk) {
    const boards = 6;
    const bw = SW / boards;
    for (let b = 0; b < boards; b++) {
      const tone = 0.85 + ((b * 37) % 7) / 40;
      for (let y = 0; y < SW; y++) {
        const grain = noise.noise2(b * 10 + 0.2, y * 0.08) * 0.5 + 0.5;
        const col = mix([108, 78, 50], [160, 122, 82], grain * tone);
        c.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
        c.fillRect(b * bw, y, bw, 1);
      }
      c.fillStyle = 'rgba(30,20,12,0.7)';
      c.fillRect(b * bw, 0, 1.5, SW);
      c.fillStyle = 'rgba(50,36,22,0.55)';
      for (const ny of [18, 82]) {
        c.beginPath();
        c.arc(b * bw + bw / 2, ny + (b % 2) * 22, 1.6, 0, Math.PI * 2);
        c.fill();
      }
    }
  } else {
    // stone pavers in a running bond
    c.fillStyle = 'rgb(112,106,96)';
    c.fillRect(0, 0, SW, SW);
    const rows = 5,
      rh = SW / rows;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? rh * 0.75 : 0;
      for (let k = -1; k < 4; k++) {
        const x0 = k * rh * 1.5 + off + 1.5,
          y0 = r * rh + 1.5;
        const tone = noise.noise2(k * 3.1 + r, r * 2.7) * 0.5 + 0.5;
        const col = mix([168, 160, 146], [214, 206, 190], tone);
        c.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
        c.fillRect(x0, y0, rh * 1.5 - 3, rh - 3);
      }
    }
    const d = c.getImageData(0, 0, SW, SW);
    for (let i = 0; i < d.data.length; i += 4) {
      const n = (noise.noise2((i / 4) % SW * 0.7, Math.floor(i / 4 / SW) * 0.7) * 10) | 0;
      d.data[i] += n;
      d.data[i + 1] += n;
      d.data[i + 2] += n;
    }
    c.putImageData(d, 0, 0);
  }
  return encodeCanvas(s.cv);
}
