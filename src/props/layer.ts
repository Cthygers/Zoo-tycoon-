// The props layer: renders every placed object, fences, litter, night lights
// and the selection highlight.
//
// Placed objects are drawn through one of two batching back-ends (see
// lod/batched.ts), chosen once:
//  - 'batched' (default when WEBGL_multi_draw exists): one BatchedMesh per
//    material — every geometry / variant / def sharing a material is a single
//    multi-draw call, with our own per-instance culling (frustum, screen-size
//    distance, LOD level) and shadow-caster selection around the camera focus.
//  - 'instanced' (fallback): one InstancedMesh per template mesh.
//
// Per instance (template part) the layer decides:
//  - max draw distance: max(tier.minCull, partRadius × tier.cullK), i.e.
//    parts vanish when they would be a few pixels big (small details of big
//    buildings go first, flower beds / hedges / boulders stay at overview);
//  - shadow casting: only parts of props big enough to matter, only within
//    tier.shadowNear / shadowFar metres of the camera focus; on the batched
//    back-end opaque casters cast from shadow-only batches (one shadow draw
//    for all their materials), only alpha-tested / swaying parts cast from
//    their own batch;
//  - LOD: templates whose PropSpec has buildLod get both versions; objects
//    swap by camera distance with hysteresis (checked every few frames).
// Vegetation materials get a near-camera fade (lod/fade.ts), structures the
// follow-mode occluder cut (lod/fade.ts applyOccluderCut); lamps and lit
// windows get ground light pools + halos (lights/nightlights.ts). Templates are
// built for the types in use while loading (prewarm), others on first use.

import * as THREE from 'three';
import { SHADOW_ONLY_LAYER, TILE } from '../core/constants';
import type { IPropsLayer, QualitySettings } from '../core/contracts';
import type { EventBus, TileRect } from '../core/events';
import { hashFloat } from '../core/rng';
import type { Litter, ObjectDef, PlacedObject } from '../core/types';
import type { World } from '../core/world';
import { useEnvMapIntensity } from '../render/envIntensity';
import { OBJECTS_BY_ID, rotatedSize } from '../data/objects';
import { createFenceSegment, disposeFenceStyles, fenceDetail, fenceStyle, FenceRenderer } from './fences';
import { Highlighter } from './highlight';
import { findEmitters, NightLights, type LocalEmitter } from './lights/nightlights';
import { LitterRenderer } from './litter';
import { frustumToArray, InstancedBatch, MultiBatch, supportsMultiDraw, type CullView, type InstParams, type PropBatch } from './lod/batched';
import { autoLod } from './lod/autolod';
import { clearBlockers, setBlocker } from './lod/blockers';
import { applyFade, applyOccluderCut, casterDepthMaterial, fadeModeOf, fadeUniforms, updateFade } from './lod/fade';
import { propsTier, type PropsTier } from './lod/tiers';
import { concreteMaterial, disposePropMaterials, projectBoxUVs, surfaceTextures } from './materials';
import { applyNightLook, atlasSteps, disposeNatureResources, paintAtlasesOffThread, setNatureNight, withQuality } from './nature';
import { PROP_SPECS, type PropSpec } from './registry';
import { disposeStructures } from './structures';
import { applyWind, cloneWithHooks, disposeWind, hasSway, setupWindMesh, updateWind } from './wind';

export { supportsMultiDraw } from './lod/batched';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const DEFAULT_GLOW = new THREE.Color(0xffd9a0);
/** Frames between LOD passes (also run whenever the camera moved > 2 m). */
const LOD_INTERVAL = 8;
/** Far LOD level starts at this multiple of the tier's lodDist. */
const LOD_FAR = 2.2;
/**
 * Sway (m per m of height) below which a part casts a still shadow from a
 * shadow-only batch: tree trunks move a few cm, less than a shadow-map texel.
 */
const SHADOW_STILL_SWAY = 0.005;

/** Categories of built props that the follow-mode occluder cut may remove near the camera. */
const OCCLUDER_CATEGORIES: ReadonlySet<ObjectDef['category']> = new Set(['amenity', 'decoration', 'enrichment', 'facility', 'feeder', 'shelter', 'shop']);
/**
 * Rocks narrower than this (half the footprint, m: boulders, ice blocks) take
 * the occluder cut too; wider ones (outcrops) are ground animals stand on, so
 * they stay and the follow camera looks around them (lod/blockers.ts).
 */
const ROCK_CUT_R = 1.8;
/** … and only rocks taller than this (m): low stones and fallen logs hide nothing. */
const ROCK_CUT_H = 0.8;

/** How far (m) a rock body reaches above the rock: a line that close over the top still loses the subject's legs behind it. */
const ROCK_BODY_OVER = 0.3;

/**
 * A large rock's body for the follow camera's blocker query: an ellipsoid
 * around the part above the ground (the buried base would sink it below the
 * rock a camera looks over), reaching ROCK_BODY_OVER above the rock's top,
 * and a bit narrower than the footprint (the ledges thin out toward the
 * corners).
 */
export function outcropBody(box: THREE.Box3, radius: number): { centre: THREE.Vector3; r: number; ry: number } {
  const base = Math.max(0, box.min.y);
  const h = Math.max(0, box.max.y - base);
  const centre = box.getCenter(new THREE.Vector3());
  centre.y = base + h / 2;
  return { centre, r: radius * 0.85, ry: h * 0.6 + ROCK_BODY_OVER };
}

// ---------------------------------------------------------------------------
// Templates

interface TemplatePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Mesh transform relative to the object origin. */
  local: THREE.Matrix4;
  /** Bounding radius in object space (m, before instance scale). */
  radius: number;
  /** May cast shadows at all. */
  cast: boolean;
  /** Glowing part (lamp glass, windows): kept visible further. */
  glow: boolean;
  /** LOD levels it is drawn at: bit 0 = full detail, bit 1 = mid distance, bit 2 = far. */
  levels: number;
  batch: PropBatch | null;
  /** Shadow-only batch it casts from (null = casts from `batch`; undefined = not decided yet). */
  shadowBatch?: MultiBatch | null;
  /** Per-instance colour when the part's material was merged into a shared tinted one. */
  tint: THREE.Color | null;
  /** Part of a structure: its batch material takes the follow-mode occluder cut. */
  occluder: boolean;
}

interface Template {
  defId: string;
  variant: number;
  spec: PropSpec;
  root: THREE.Object3D;
  /** Cheaper versions (hand-made buildLod, or automatic mid + far for vegetation). */
  lodRoots: THREE.Object3D[];
  /** Has distance levels (lodRoots non-empty). */
  hasLod: boolean;
  parts: TemplatePart[];
  radius: number;
  height: number;
  /** Tall enough that its shadow reads from afar (trees, buildings). */
  tall: boolean;
  emitters: LocalEmitter[];
  /** A large rock's body (object space) for the follow camera's blocker query, null for anything else. */
  body: { centre: THREE.Vector3; r: number; ry: number } | null;
}

interface Slot {
  batch: PropBatch;
  index: number;
}

interface ObjRec {
  obj: PlacedObject;
  tpl: Template;
  matrix: THREE.Matrix4;
  scale: number;
  slots: Slot[];
  /** Per part: its instance in a shadow-only batch (null when it casts from its own batch or not at all). */
  shadowSlots: (Slot | null)[];
  unique: THREE.Object3D | null;
  /** Current LOD level (0 = full, 1 = mid, 2 = far). */
  lod: number;
}

export type PropsBackend = 'auto' | 'instanced' | 'batched';

/** Split a multi-material mesh into one geometry per material group. */
function splitByMaterial(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): { geometry: THREE.BufferGeometry; material: THREE.Material }[] {
  if (!Array.isArray(material)) return [{ geometry, material }];
  if (geometry.groups.length === 0) return material.length ? [{ geometry, material: material[0] }] : [];
  const out: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  for (const g of geometry.groups) {
    const m = material[g.materialIndex ?? 0];
    if (!m) continue;
    const sub = new THREE.BufferGeometry();
    if (geometry.index) {
      for (const name of Object.keys(geometry.attributes)) sub.setAttribute(name, geometry.getAttribute(name));
      const src = geometry.index.array;
      const end = Math.min(g.start + g.count, src.length);
      sub.setIndex(new THREE.BufferAttribute(src.slice(g.start, end), 1));
    } else {
      for (const name of Object.keys(geometry.attributes)) {
        const a = geometry.getAttribute(name) as THREE.BufferAttribute;
        const arr = a.array.slice(g.start * a.itemSize, (g.start + g.count) * a.itemSize);
        sub.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
      }
    }
    out.push({ geometry: sub, material: m });
  }
  return out;
}

/** Attribute layout key: BatchedMesh needs identical layouts per batch. */
function layoutKey(g: THREE.BufferGeometry): string {
  const parts: string[] = [];
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    parts.push(`${name}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}`);
  }
  if (g.index) parts.push('idx');
  return parts.join(',');
}

// ---------------------------------------------------------------------------
// Placeholder for defs without a registered builder

const placeholderGeo = new Map<string, THREE.BufferGeometry>();

function placeholderSpec(def: ObjectDef | undefined): PropSpec {
  const w = (def?.size[0] ?? 1) * TILE;
  const d = (def?.size[1] ?? 1) * TILE;
  const cat = def?.category;
  const h = cat === 'tree' ? 4 : cat === 'shop' || cat === 'facility' || cat === 'shelter' ? 2.6 : cat === 'plant' || cat === 'rock' ? 0.8 : 1;
  return {
    variants: 1,
    build: () => {
      const key = `${w}x${h}x${d}`;
      let g = placeholderGeo.get(key);
      if (!g) {
        g = new THREE.BoxGeometry(w * 0.8, h, d * 0.8);
        g.translate(0, h / 2, 0);
        projectBoxUVs(g, surfaceTextures('concrete').tile);
        placeholderGeo.set(key, g);
      }
      const m = new THREE.Mesh(g, concreteMaterial());
      const grp = new THREE.Group();
      grp.add(m);
      return grp;
    },
  };
}

// ---------------------------------------------------------------------------

export class PropsLayer implements IPropsLayer {
  readonly root = new THREE.Group();
  private readonly objRoot = new THREE.Group();
  private readonly uniqueRoot = new THREE.Group();
  private readonly fences: FenceRenderer;
  private readonly litter: LitterRenderer;
  private readonly highlight: Highlighter;
  private readonly night: NightLights;

  private quality: QualitySettings;
  private tier: PropsTier;
  private templates = new Map<string, Template>();
  private placeholders = new Map<string, PropSpec>();
  /** Per def: size of the first variant built, so all variants share shadow / distance behaviour. */
  private sizeClass = new Map<string, { h: number; r: number; tall: boolean }>();
  private batches = new Map<string, PropBatch>();
  private batchList: PropBatch[] = [];
  /** Shadow-only batches by depth-pass side + index layout (also in batchList). */
  private shadowBatches = new Map<string, MultiBatch>();
  /** Position + crown-data copies of caster geometries for the shadow-only batches. */
  private shadowGeos = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  /** Zeros viewed as the crown data of casters without a crown (never written). */
  private noCrown = new Int16Array(0);
  /** Geometries created by splitting multi-material meshes (owned). */
  private splitGeos: THREE.BufferGeometry[] = [];
  readonly backend: 'instanced' | 'batched';
  private recs = new Map<number, ObjRec>();
  private uniques: ObjRec[] = [];
  private lodRecs: ObjRec[] = [];
  private nightMats: THREE.MeshStandardMaterial[] = [];
  private nightSet = new Set<THREE.Material>();
  private fadeMats = new Set<THREE.Material>();
  private seenMats = new WeakSet<THREE.Material>();
  private plainMats = new WeakSet<THREE.Material>();
  /** Material signature (everything but colour) → shared white-based batch material. */
  private mergeMats = new Map<string, THREE.MeshStandardMaterial>();
  private mergedOf = new Map<THREE.Material, { mat: THREE.Material; color: THREE.Color }>();
  private unsub: (() => void)[] = [];
  private highlightId: number | null = null;
  private time = 0;
  private nightLevel = -1;
  private disposed = false;
  private frame = 0;
  private lodSwitches = 0;
  private prewarmMs = 0;
  private lodDirty = true;
  private cullDirty = true;
  /** world.objects must be (re-)added before the next frame / pick. */
  private pendingRebuild = true;

  // culling state
  private readonly view: CullView = {
    camera: null,
    cam: new THREE.Vector3(),
    focus: new THREE.Vector3(),
    planes: new Float32Array(24),
    shadows: true,
  };
  private readonly lastCamM = new THREE.Matrix4();
  private readonly lastProjM = new THREE.Matrix4();
  private readonly lodCam = new THREE.Vector3(1e9, 0, 0);
  private haveCamera = false;

  // scratch
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private hits: THREE.Intersection[] = [];

  constructor(
    private readonly world: World,
    events: EventBus,
    scene: THREE.Scene,
    quality: QualitySettings,
    opts: { backend?: PropsBackend } = {},
  ) {
    this.quality = quality;
    this.tier = propsTier(quality);
    const want = opts.backend ?? 'auto';
    this.backend = want === 'auto' ? (supportsMultiDraw() ? 'batched' : 'instanced') : want;
    this.root.name = 'props';
    this.objRoot.name = 'objects';
    this.uniqueRoot.name = 'unique-objects';
    this.fences = new FenceRenderer(world, events, quality, this.backend === 'batched');
    this.fences.setShadowRange(this.tier.shadowNear, this.tier.shadowFar, this.tier.fenceLod);
    this.litter = new LitterRenderer(world);
    this.highlight = new Highlighter(world);
    this.night = new NightLights(world);
    this.night.setPointLights(this.tier.pointLights);
    this.night.setWarmFill(!quality.postFX);
    this.root.add(this.objRoot, this.uniqueRoot, this.fences.group, this.litter.group, this.highlight.group, this.night.group);
    scene.add(this.root);

    // The world's objects are added by prewarm() (loading screen, time-sliced)
    // or on the first update(), never here: building their templates can take
    // seconds on a phone and must not run as one task.
    this.unsub.push(
      events.on('objectAdded', ({ id }) => {
        const o = world.objects.get(id);
        if (o && !this.pendingRebuild) this.addObject(o);
      }),
      events.on('objectRemoved', ({ id }) => this.removeObject(id)),
      events.on('worldReset', () => (this.pendingRebuild = true)),
      events.on('terrainChanged', (r) => this.refreshRect(r)),
    );
  }

  // ------------------------------------------------------------ templates

  private specFor(defId: string): PropSpec {
    const s = PROP_SPECS[defId];
    if (s) return s;
    let p = this.placeholders.get(defId);
    if (!p) {
      p = placeholderSpec(OBJECTS_BY_ID[defId]);
      this.placeholders.set(defId, p);
    }
    return p;
  }

  private variantOf(spec: PropSpec, seed: number): number {
    const v = Math.max(1, spec.variants | 0);
    return ((seed % v) + v) % v;
  }

  private buildVariant(defId: string, spec: PropSpec, variant: number): THREE.Object3D {
    try {
      const o = spec.build(variant, this.quality);
      if (o) return o;
    } catch (err) {
      console.error(`[props] builder for "${defId}" failed`, err);
    }
    return placeholderSpec(OBJECTS_BY_ID[defId]).build(0, this.quality);
  }

  private buildLod(defId: string, spec: PropSpec, variant: number): THREE.Object3D | null {
    if (!spec.buildLod) return null;
    try {
      return spec.buildLod(variant, this.quality) ?? null;
    } catch (err) {
      console.error(`[props] LOD builder for "${defId}" failed`, err);
      return null;
    }
  }

  private template(defId: string, variant: number): Template {
    const key = `${defId}#${variant}`;
    let t = this.templates.get(key);
    if (t) return t;
    const spec = this.specFor(defId);
    const root = this.buildVariant(defId, spec, variant);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    const height = box.isEmpty() ? 1 : box.max.y;
    const radius = Math.max(size.x, size.z) * 0.5;
    // size class is decided once per def (first variant built) so all variants behave alike
    let cls = this.sizeClass.get(defId);
    if (!cls) {
      // tall ones keep their shadow further from the focus (see partParams for who casts at all)
      cls = { h: height, r: radius, tall: height > 2.6 || radius > 2.2 };
      this.sizeClass.set(defId, cls);
    }
    // distance versions: [root, levels bitmask]
    const lods: [THREE.Object3D, number][] = [];
    const hand = this.buildLod(defId, spec, variant);
    const cat = OBJECTS_BY_ID[defId]?.category;
    if (hand) lods.push([hand, 6]);
    else if (!spec.unique && (cat === 'tree' || cat === 'plant')) {
      // vegetation without a hand-made LOD gets automatic ones (fewer, larger cards; no twigs)
      const mid = autoLod(root, { cards: 0.45, bark: 0.5 });
      const far = mid ? autoLod(root, { cards: 0.2, bark: 0.3 }) : null;
      if (mid) lods.push([mid, far ? 2 : 6]);
      if (far) lods.push([far, 4]);
    }
    const parts: TemplatePart[] = [];
    this.collectParts(root, lods.length ? 1 : 7, parts);
    for (const [lr, bits] of lods) {
      lr.updateMatrixWorld(true);
      const lod: TemplatePart[] = [];
      this.collectParts(lr, bits, lod);
      // pieces shared unchanged between versions are drawn at all their levels
      for (const lp of lod) {
        const same = parts.find((fp) => fp.geometry === lp.geometry && fp.material === lp.material && fp.local.equals(lp.local));
        if (same) same.levels |= lp.levels;
        else parts.push(lp);
      }
    }
    // (not lamp posts: thin, and their halo would hang in the air without them)
    const lamp = cat === 'amenity' && OBJECTS_BY_ID[defId].light === true;
    const rock = cat === 'rock';
    if ((cat && OCCLUDER_CATEGORIES.has(cat) && !lamp) || (rock && cls.r < ROCK_CUT_R && cls.h > ROCK_CUT_H)) for (const p of parts) p.occluder = true;
    const body = rock && cls.r >= ROCK_CUT_R ? outcropBody(box, radius) : null;
    let emitters = findEmitters(parts.filter((p) => p.levels & 1));
    if (emitters.length === 0 && OBJECTS_BY_ID[defId]?.light) {
      // lit def without glowing parts: a soft pool in front (+Z)
      const front = (OBJECTS_BY_ID[defId].size[1] * TILE) / 2 + 0.1;
      emitters = [{ pos: new THREE.Vector3(0, Math.min(2.2, height * 0.6), front), kind: 'window', dir: new THREE.Vector2(0, 1) }];
    }
    const lodRoots = lods.map((l) => l[0]);
    t = { defId, variant, spec, root, lodRoots, hasLod: lodRoots.length > 0, parts, radius, height, tall: cls.tall, emitters, body };
    this.templates.set(key, t);
    return t;
  }

  private collectParts(root: THREE.Object3D, levels: number, out: TemplatePart[]): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let transparent = false;
      for (const m of mats) {
        this.registerMaterial(m);
        if (m.transparent && m.opacity < 0.6) transparent = true;
      }
      const scale = mesh.matrixWorld.getMaxScaleOnAxis();
      for (const sp of splitByMaterial(mesh.geometry, mesh.material)) {
        if (sp.geometry !== mesh.geometry) this.splitGeos.push(sp.geometry);
        if (!sp.geometry.boundingSphere) sp.geometry.computeBoundingSphere();
        const r = (sp.geometry.boundingSphere?.radius ?? 0.5) * scale;
        const m = sp.material;
        const glow = typeof m.userData.nightEmissive === 'number';
        out.push({
          geometry: sp.geometry,
          material: m,
          local: mesh.matrixWorld.clone(),
          radius: r,
          // tiny details (< 12 cm), glass and glowing bits never cast
          cast: !mesh.userData.noShadow && !glow && r > 0.12 && !(m.transparent && m.opacity < 0.6) && !transparent,
          glow,
          levels,
          batch: null,
          tint: null,
          occluder: false,
        });
      }
    });
  }

  private registerMaterial(m: THREE.Material): void {
    if (!this.seenMats.has(m)) {
      this.seenMats.add(m);
      // a stock MeshStandardMaterial without shader hooks can share a batch with its colour variants
      if (m.constructor === THREE.MeshStandardMaterial && !Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) this.plainMats.add(m);
      // three ignores envMapIntensity under scene.environment: honour it (after the check
      // above, so colour variants still merge; their merged copy is registered here too)
      const sm = m as THREE.MeshStandardMaterial;
      if (sm.isMeshStandardMaterial && sm.envMapIntensity !== 1) useEnvMapIntensity(sm);
      // wood and paint: moonlit like the ground at night (after the plain check: colour variants still merge)
      applyNightLook(m);
    }
    if (hasSway(m)) applyWind(m);
    const fade = this.fadeMats.has(m) ? null : fadeModeOf(m);
    if (fade) {
      applyFade(m, fade);
      // MSAA tiers: alpha to coverage anti-aliases the leaf cut-outs (the near-camera fade itself is all or nothing, lod/fade.ts)
      m.alphaToCoverage = this.quality.antialias;
      this.fadeMats.add(m);
    }
    const ne = m.userData.nightEmissive;
    if (typeof ne === 'number' && !this.nightSet.has(m) && (m as THREE.MeshStandardMaterial).emissive) {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm.emissive.r + sm.emissive.g + sm.emissive.b === 0) sm.emissive.copy(DEFAULT_GLOW);
      sm.emissiveIntensity = Math.max(this.nightLevel, 0) * ne;
      this.nightSet.add(m);
      this.nightMats.push(sm);
    }
  }

  /**
   * Colour variants of one stock material (painted metal in five colours,
   * stained boards…) share one batch: the batch material is a white-based
   * copy and each instance carries its colour (BatchedMesh per-instance colour).
   */
  private mergedFor(m: THREE.Material): { mat: THREE.Material; color: THREE.Color } | null {
    if (!this.plainMats.has(m)) return null;
    let r = this.mergedOf.get(m);
    if (r) return r;
    const sm = m as THREE.MeshStandardMaterial;
    const t = (x: THREE.Texture | null) => (x ? x.uuid : '-');
    const sig = [
      t(sm.map), t(sm.normalMap), t(sm.roughnessMap), t(sm.metalnessMap), t(sm.aoMap), t(sm.emissiveMap), t(sm.alphaMap), t(sm.bumpMap),
      t(sm.lightMap), t(sm.displacementMap), t(sm.envMap), sm.roughness, sm.metalness, sm.emissive.getHex(), sm.normalScale.x, sm.normalScale.y,
      sm.normalMapType, sm.envMapIntensity, sm.aoMapIntensity, sm.bumpScale, sm.displacementScale, sm.transparent, sm.opacity, sm.alphaTest, sm.side,
      sm.vertexColors, sm.flatShading, sm.depthWrite, sm.depthTest, sm.blending, sm.alphaToCoverage, sm.premultipliedAlpha, sm.toneMapped, sm.fog,
      sm.wireframe, sm.polygonOffset, sm.polygonOffsetFactor, sm.polygonOffsetUnits, JSON.stringify(sm.userData),
    ].join('|');
    let base = this.mergeMats.get(sig);
    if (!base) {
      base = sm.clone();
      base.color.setRGB(1, 1, 1);
      base.name = `${sm.name || 'material'}+tint`;
      this.mergeMats.set(sig, base);
      this.registerMaterial(base);
    }
    r = { mat: base, color: sm.color.clone() };
    this.mergedOf.set(m, r);
    return r;
  }

  private batchFor(part: TemplatePart): PropBatch {
    if (part.batch) return part.batch;
    const multi = this.backend === 'batched';
    const shadows = this.quality.shadows;
    let mat = part.material;
    if (multi) {
      const mm = this.mergedFor(part.material);
      if (mm) {
        mat = mm.mat;
        part.tint = mm.color;
      }
    }
    const key = multi ? `B|${mat.uuid}|${layoutKey(part.geometry)}` : `I|${part.geometry.uuid}|${mat.uuid}|${part.cast ? 1 : 0}`;
    let b = this.batches.get(key);
    if (!b) {
      b = multi ? new MultiBatch(mat, shadows, this.objRoot) : new InstancedBatch(part.geometry, mat, part.cast, shadows, this.objRoot);
      this.batches.set(key, b);
      this.batchList.push(b);
    }
    if (part.occluder) applyOccluderCut(mat);
    part.batch = b;
    return b;
  }

  /**
   * Shadow-only batch for a part, or null when it must cast from its own batch:
   * alpha-tested cards and visibly swaying parts need their material's depth shader.
   */
  private shadowBatchFor(part: TemplatePart): MultiBatch | null {
    if (part.shadowBatch !== undefined) return part.shadowBatch;
    const m = part.material;
    const sway = typeof m.userData.sway === 'number' ? m.userData.sway : 0;
    let b: MultiBatch | null = null;
    if (this.backend === 'batched' && sway < SHADOW_STILL_SWAY && !(m.alphaTest > 0) && !(m as THREE.MeshStandardMaterial).alphaMap && !m.alphaHash && !m.transparent) {
      // the depth pass draws back faces of single-sided materials (three's default shadow side)
      const side = m.shadowSide ?? (m.side === THREE.DoubleSide ? THREE.DoubleSide : m.side === THREE.BackSide ? THREE.FrontSide : THREE.BackSide);
      const key = `${side}|${part.geometry.index ? 'idx' : '-'}`;
      b = this.shadowBatches.get(key) ?? null;
      if (!b) {
        const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
        mat.name = 'prop-shadow-casters';
        mat.shadowSide = side;
        b = new MultiBatch(mat, this.quality.shadows, this.objRoot, true);
        b.mesh.layers.set(SHADOW_ONLY_LAYER);
        // still tree bark casts from here: it leaves with its tree near the camera
        b.mesh.customDepthMaterial = casterDepthMaterial();
        this.shadowBatches.set(key, b);
        this.batchList.push(b);
      }
    }
    part.shadowBatch = b;
    return b;
  }

  /**
   * Copy of a geometry for a shadow-only batch (attributes shared): position
   * and the crown data the batch's depth material reads, zeros (no crown,
   * never fades) where the geometry has none.
   */
  private shadowGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
    let s = this.shadowGeos.get(g);
    if (!s) {
      s = new THREE.BufferGeometry();
      const pos = g.getAttribute('position');
      s.setAttribute('position', pos);
      const crown = g.getAttribute('aCrown');
      const crownR = g.getAttribute('aCrownR');
      if (crown && crownR) {
        s.setAttribute('aCrown', crown);
        s.setAttribute('aCrownR', crownR);
      } else {
        if (this.noCrown.length < pos.count * 4) this.noCrown = new Int16Array(Math.max(pos.count * 4, this.noCrown.length * 2));
        s.setAttribute('aCrown', new THREE.BufferAttribute(this.noCrown.subarray(0, pos.count * 4), 4));
        s.setAttribute('aCrownR', new THREE.BufferAttribute(this.noCrown.subarray(0, pos.count * 3), 3));
      }
      if (g.index) s.setIndex(g.index);
      if (!g.boundingSphere) g.computeBoundingSphere();
      s.boundingSphere = g.boundingSphere;
      this.shadowGeos.set(g, s);
    }
    return s;
  }

  /** Culling parameters of one part of one placed object. */
  private partParams(tpl: Template, part: TemplatePart, scale: number, lod: number): InstParams {
    const T = this.tier;
    const r = part.radius * scale;
    let cull = Math.max(T.minCull, r * T.cullK);
    if (part.glow) cull = Math.max(cull, 180);
    if (cull > 420) cull = Infinity;
    let shadow = 0;
    if (part.cast && this.quality.shadows && this.castsClass(tpl.defId)) {
      // tall props (trees, buildings) cast up to shadowFar; everything else near the focus only
      shadow = tpl.tall ? T.shadowFar : T.shadowNear;
      // small parts of big objects (railings, signs) only close up
      if (r < 0.45) shadow = Math.min(shadow, T.shadowNear * 0.6);
    }
    return { cull, shadow, lodOn: ((part.levels >> lod) & 1) === 1, shadowOn: ((part.levels >> this.shadowLevel(tpl, lod)) & 1) === 1, tint: part.tint };
  }

  // ------------------------------------------------------------ objects

  private computeMatrix(o: PlacedObject, spec: PropSpec, out: THREE.Matrix4): number {
    const c = this.world.objectCenter(o);
    let yaw = (o.rot * Math.PI) / 2;
    let s = 1;
    const j = spec.jitter;
    if (j) {
      if (j.yaw) yaw += hashFloat(o.seed, 3, 17) * Math.PI * 2;
      s = j.scale[0] + (j.scale[1] - j.scale[0]) * hashFloat(o.seed, 5, 29);
    }
    this.tmpQ.setFromAxisAngle(Y_AXIS, yaw);
    this.tmpP.set(c.x, c.y, c.z);
    this.tmpS.set(s, s, s);
    out.compose(this.tmpP, this.tmpQ, this.tmpS);
    return s;
  }

  /** Is this def big enough to cast shadows on the current tier (tiny and thin props never do)? */
  private castsClass(defId: string): boolean {
    const c = this.sizeClass.get(defId);
    const T = this.tier;
    return !c || ((c.h > T.castH || c.r > T.castR) && c.r >= T.castMinR);
  }

  /** LOD level used by the shadow pass: one coarser than the view on tiers with shadowLodBias. */
  private shadowLevel(tpl: Template, lod: number): number {
    return tpl.hasLod ? Math.min(2, lod + this.tier.shadowLodBias) : lod;
  }

  /** LOD level for an object at matrix `m` from the last known camera position (±8 % hysteresis). */
  private lodFor(tpl: Template, m: THREE.Matrix4, current: number): number {
    if (!tpl.hasLod || !this.haveCamera) return 0;
    const e = m.elements;
    const c = this.view.cam;
    const d2 = (e[12] - c.x) ** 2 + (e[13] - c.y) ** 2 + (e[14] - c.z) ** 2;
    const D1 = this.tier.lodDist;
    const D2 = D1 * LOD_FAR;
    let L = current;
    if (L === 0 && d2 > D1 * D1 * 1.1664) L = 1;
    if (L === 1 && d2 > D2 * D2 * 1.1664) L = 2;
    if (L === 2 && d2 < D2 * D2 * 0.8464) L = 1;
    if (L === 1 && d2 < D1 * D1 * 0.8464) L = 0;
    return L;
  }

  private addObject(o: PlacedObject): void {
    if (this.recs.has(o.id)) this.removeObject(o.id);
    if (!OBJECTS_BY_ID[o.defId]) {
      console.warn(`[props] unknown object def "${o.defId}"`);
      return;
    }
    const spec = this.specFor(o.defId);
    const tpl = this.template(o.defId, this.variantOf(spec, o.seed));
    const rec: ObjRec = { obj: o, tpl, matrix: new THREE.Matrix4(), scale: 1, slots: [], shadowSlots: [], unique: null, lod: 0 };
    rec.scale = this.computeMatrix(o, spec, rec.matrix);
    if (spec.unique) {
      // holder carries the placement; the clone keeps the builder's own root transform
      const holder = new THREE.Group();
      holder.name = `unique-${o.defId}-${o.id}`;
      holder.add(this.cloneUnique(tpl));
      rec.matrix.decompose(holder.position, holder.quaternion, holder.scale);
      holder.userData.objectId = o.id;
      this.uniqueRoot.add(holder);
      rec.unique = holder;
      this.uniques.push(rec);
    } else {
      rec.lod = this.lodFor(tpl, rec.matrix, 0);
      for (const p of tpl.parts) {
        const b = this.batchFor(p);
        this.tmpM.multiplyMatrices(rec.matrix, p.local);
        const params = this.partParams(tpl, p, rec.scale, rec.lod);
        const sb = params.shadow > 0 ? this.shadowBatchFor(p) : null;
        let shadowSlot: Slot | null = null;
        if (sb) {
          // it casts from the shadow-only batch instead
          shadowSlot = { batch: sb, index: -1 };
          shadowSlot.index = sb.add(this.shadowGeometry(p.geometry), this.tmpM, { id: o.id, slot: shadowSlot }, { cull: Infinity, shadow: params.shadow, lodOn: false, shadowOn: params.shadowOn });
          params.shadow = 0;
        }
        rec.shadowSlots.push(shadowSlot);
        // the slot object is shared with the batch so swap-remove back-ends can re-index it
        const slot: Slot = { batch: b, index: -1 };
        rec.slots.push(slot);
        slot.index = b.add(p.geometry, this.tmpM, { id: o.id, slot }, params);
      }
      if (tpl.hasLod) this.lodRecs.push(rec);
    }
    if (tpl.emitters.length) this.night.setObject(o.id, tpl.emitters, rec.matrix);
    if (tpl.body) {
      const c = this.tmpP.copy(tpl.body.centre).applyMatrix4(rec.matrix);
      setBlocker(o.id, { x: c.x, y: c.y, z: c.z, r: tpl.body.r * rec.scale, ry: tpl.body.ry * rec.scale });
    }
    this.recs.set(o.id, rec);
    this.cullDirty = true;
    if (this.highlightId === o.id) this.showHighlight(rec);
  }

  private cloneUnique(tpl: Template): THREE.Object3D {
    const u = tpl.root.clone(true);
    const shadows = this.quality.shadows;
    const cast = this.castsClass(tpl.defId);
    u.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const transparent = mats.some((m) => m.transparent && m.opacity < 0.6);
      mesh.castShadow = shadows && cast && !mesh.userData.noShadow && !transparent;
      mesh.receiveShadow = shadows;
      setupWindMesh(mesh);
      for (const m of mats) this.registerMaterial(m);
    });
    return u;
  }

  private removeObject(id: number): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    for (const s of rec.slots) s.batch.remove(s.index);
    for (const s of rec.shadowSlots) s?.batch.remove(s.index);
    rec.slots.length = 0;
    rec.shadowSlots.length = 0;
    if (rec.unique) {
      this.uniqueRoot.remove(rec.unique);
      const i = this.uniques.indexOf(rec);
      if (i >= 0) this.uniques.splice(i, 1);
    }
    if (rec.tpl.hasLod) {
      const i = this.lodRecs.indexOf(rec);
      if (i >= 0) this.lodRecs.splice(i, 1);
    }
    this.night.setObject(id, null, null);
    setBlocker(id, null);
    this.recs.delete(id);
    this.cullDirty = true;
    if (this.highlightId === id) this.highlight.clear();
  }

  private rebuildAll(): void {
    this.pendingRebuild = false;
    for (const b of this.batchList) b.clear();
    for (const r of this.uniques) if (r.unique) this.uniqueRoot.remove(r.unique);
    this.uniques.length = 0;
    this.lodRecs.length = 0;
    this.night.clear();
    clearBlockers();
    this.recs.clear();
    this.highlight.clear();
    for (const o of this.world.objects.values()) this.addObject(o);
    if (this.highlightId !== null && !this.recs.has(this.highlightId)) this.highlightId = null;
    this.cullDirty = true;
  }

  /** Terrain heights changed: re-seat objects whose footprint touches the rect. */
  private refreshRect(r: TileRect): void {
    for (const rec of this.recs.values()) {
      const o = rec.obj;
      const def = OBJECTS_BY_ID[o.defId];
      const [w, d] = rotatedSize(def, o.rot);
      if (o.tx > r.x1 + 1 || o.tz > r.z1 + 1 || o.tx + w < r.x0 - 1 || o.tz + d < r.z0 - 1) continue;
      rec.scale = this.computeMatrix(o, rec.tpl.spec, rec.matrix);
      if (rec.unique) rec.matrix.decompose(rec.unique.position, rec.unique.quaternion, rec.unique.scale);
      rec.slots.forEach((s, i) => {
        this.tmpM.multiplyMatrices(rec.matrix, rec.tpl.parts[i].local);
        s.batch.set(s.index, this.tmpM);
        const ss = rec.shadowSlots[i];
        if (ss) ss.batch.set(ss.index, this.tmpM);
      });
      if (rec.tpl.emitters.length) this.night.setObject(o.id, rec.tpl.emitters, rec.matrix);
    }
    this.night.markDirty();
    this.cullDirty = true;
  }

  // ------------------------------------------------------------ per frame

  /** Ground point at the centre of the view (where the camera looks). */
  private computeFocus(camera: THREE.Camera, out: THREE.Vector3): void {
    const cam = this.view.cam;
    const dir = camera.getWorldDirection(this.camDir);
    const w = this.world;
    if (dir.y > -0.03) {
      out.copy(cam).addScaledVector(dir, 60);
      out.y = w.heightAt(out.x, out.z);
      return;
    }
    let h = w.heightAt(cam.x, cam.z);
    let t = 0;
    for (let i = 0; i < 4; i++) {
      t = Math.min(Math.max((cam.y - h) / -dir.y, 0), 400);
      h = w.heightAt(cam.x + dir.x * t, cam.z + dir.z * t);
    }
    out.set(cam.x + dir.x * t, h, cam.z + dir.z * t);
  }

  update(dt: number, nightFactor: number, camera: THREE.Camera): void {
    if (this.disposed) return;
    if (this.pendingRebuild) this.rebuildAll();
    this.time += dt;
    this.frame++;
    updateWind(dt);
    this.fences.update();

    camera.updateMatrixWorld();
    const view = this.view;
    view.cam.setFromMatrixPosition(camera.matrixWorld);
    this.haveCamera = true;
    const moved = !this.lastCamM.equals(camera.matrixWorld) || !this.lastProjM.equals(camera.projectionMatrix) || view.camera !== camera;
    if (moved) {
      this.lastCamM.copy(camera.matrixWorld);
      this.lastProjM.copy(camera.projectionMatrix);
      view.camera = camera;
      this.computeFocus(camera, view.focus);
      this.tmpM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.tmpM, camera.coordinateSystem);
      frustumToArray(this.frustum, view.planes);
      this.cullDirty = true;
    }
    view.shadows = this.quality.shadows;

    // LOD: every few frames, or right away after a big camera move
    if (this.lodRecs.length && (this.lodDirty || this.frame % LOD_INTERVAL === 0 || this.lodCam.distanceToSquared(view.cam) > 4)) this.updateLods();

    for (const b of this.batchList) if (this.cullDirty || b.dirty) b.cull(view);
    this.fences.cull(view, this.cullDirty);
    this.cullDirty = false;

    // lamps / windows
    if (Math.abs(nightFactor - this.nightLevel) > 0.001) {
      this.nightLevel = nightFactor;
      // moonlit crowns: no light through the leaves, no silvery sheen (nature/mats.ts)
      setNatureNight(nightFactor);
      for (const m of this.nightMats) m.emissiveIntensity = nightFactor * (m.userData.nightEmissive as number);
    }

    // unique props
    for (const r of this.uniques) r.tpl.spec.animate?.(r.unique!.children[0], this.time, nightFactor);

    this.night.update(dt, nightFactor, view.focus);
    updateFade(view.cam, view.focus, this.tier.fade, undefined, dt);
    this.highlight.update(dt, this.time);
  }

  private updateLods(): void {
    this.lodDirty = false;
    this.lodCam.copy(this.view.cam);
    for (const rec of this.lodRecs) {
      const lvl = this.lodFor(rec.tpl, rec.matrix, rec.lod);
      if (lvl === rec.lod) continue;
      rec.lod = lvl;
      this.lodSwitches++;
      const parts = rec.tpl.parts;
      const sl = this.shadowLevel(rec.tpl, lvl);
      for (let i = 0; i < rec.slots.length; i++) {
        const s = rec.slots[i];
        const shadowOn = ((parts[i].levels >> sl) & 1) === 1;
        s.batch.setLodOn(s.index, ((parts[i].levels >> lvl) & 1) === 1, shadowOn);
        const ss = rec.shadowSlots[i];
        if (ss) ss.batch.setLodOn(ss.index, false, shadowOn);
      }
    }
  }

  // ------------------------------------------------------------ models for UI

  createObjectModel(defId: string, seed: number): THREE.Object3D {
    const spec = this.specFor(defId);
    const tpl = this.template(defId, this.variantOf(spec, seed));
    const out = tpl.root.clone(true);
    const cloned = new Map<THREE.Material, THREE.Material>();
    const cloneMat = (m: THREE.Material): THREE.Material => {
      let c = cloned.get(m);
      if (!c) {
        c = cloneWithHooks(m);
        cloned.set(m, c);
      }
      return c;
    };
    out.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMat) : cloneMat(mesh.material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      setupWindMesh(mesh);
    });
    out.position.set(0, 0, 0);
    out.rotation.set(0, 0, 0);
    out.scale.set(1, 1, 1);
    out.userData.defId = defId;
    /** Materials owned by this clone (dispose them when the model is discarded; geometry is shared). */
    out.userData.ownedMaterials = Array.from(cloned.values());
    return out;
  }

  createFenceSegmentModel(fenceId: number): THREE.Object3D {
    const g = createFenceSegment(fenceId);
    const owned: THREE.Material[] = [];
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material)) owned.push(mesh.material);
    });
    g.userData.ownedMaterials = owned;
    return g;
  }

  setLitter(items: Iterable<Litter>): void {
    this.litter.set(items);
  }

  // ------------------------------------------------------------ picking / selection

  pickObject(raycaster: THREE.Raycaster): number | null {
    if (this.pendingRebuild) this.rebuildAll();
    if (this.backend === 'instanced') for (const b of this.batchList) if (b.dirty) b.cull(this.view);
    let best = Infinity;
    let bestId: number | null = null;
    const hits = this.hits;
    for (const b of this.batchList) {
      if (b.size() === 0 || b.shadowOnly) continue;
      hits.length = 0;
      b.mesh.raycast(raycaster, hits);
      for (const h of hits) {
        if (h.distance >= best) continue;
        const id = b.ownerOf(h);
        if (id === null) continue;
        best = h.distance;
        bestId = id;
      }
    }
    for (const r of this.uniques) {
      hits.length = 0;
      raycaster.intersectObject(r.unique!, true, hits);
      if (hits.length && hits[0].distance < best) {
        best = hits[0].distance;
        bestId = r.obj.id;
      }
    }
    hits.length = 0;
    return bestId;
  }

  setHighlight(objectId: number | null): void {
    this.highlightId = objectId;
    const rec = objectId === null ? undefined : this.recs.get(objectId);
    if (!rec) {
      this.highlight.clear();
      return;
    }
    this.showHighlight(rec);
  }

  private showHighlight(rec: ObjRec): void {
    const model = rec.unique ? rec.unique.clone(true) : rec.tpl.root.clone(true);
    model.position.set(0, 0, 0);
    model.quaternion.identity();
    model.scale.set(1, 1, 1);
    const o = rec.obj;
    const def = OBJECTS_BY_ID[o.defId];
    const [w, d] = rotatedSize(def, o.rot);
    const m = this.tmpM.copy(rec.matrix);
    if (!rec.unique) {
      // template root's own transform is baked in tpl.parts; keep it on the clone
      model.position.copy(rec.tpl.root.position);
      model.quaternion.copy(rec.tpl.root.quaternion);
      model.scale.copy(rec.tpl.root.scale);
      model.updateMatrix();
      m.multiply(model.matrix);
    }
    this.highlight.show(model, m, { x0: o.tx * TILE, z0: o.tz * TILE, x1: (o.tx + w) * TILE, z1: (o.tz + d) * TILE });
  }

  // ------------------------------------------------------------ misc

  /** Debug counters (not part of the contract). */
  debugInfo(): {
    backend: string;
    batches: number;
    liveBatches: number;
    instances: number;
    drawn: number;
    uniques: number;
    fenceMeshes: number;
    templates: number;
    lodObjects: number;
    lodSwitches: number;
    fade: number;
    prewarmMs: number;
    night: ReturnType<NightLights['stats']>;
  } {
    let live = 0;
    let inst = 0;
    let drawn = 0;
    for (const b of this.batchList) {
      if (b.shadowOnly) continue;
      const n = b.size();
      if (n > 0) live++;
      inst += n;
      drawn += b.drawn();
    }
    return {
      backend: this.backend,
      batches: this.batchList.length,
      liveBatches: live,
      instances: inst,
      drawn,
      uniques: this.uniques.length,
      fenceMeshes: this.fences.meshes().filter((m) => m.count > 0).length,
      templates: this.templates.size,
      lodObjects: this.lodRecs.length,
      lodSwitches: this.lodSwitches,
      fade: fadeUniforms.uFadeParams.value.w,
      prewarmMs: this.prewarmMs,
      night: this.night.stats(),
    };
  }

  setQuality(quality: QualitySettings): void {
    const prev = this.quality;
    this.quality = quality;
    this.tier = propsTier(quality);
    this.fences.setQuality(quality);
    this.fences.setShadowRange(this.tier.shadowNear, this.tier.shadowFar, this.tier.fenceLod);
    this.litter.setShadows(quality.shadows);
    this.night.setPointLights(this.tier.pointLights);
    this.night.setWarmFill(!quality.postFX);
    for (const b of this.batchList) b.setShadows(quality.shadows);
    for (const m of this.fadeMats) {
      if (m.alphaToCoverage === quality.antialias) continue;
      m.alphaToCoverage = quality.antialias;
      m.needsUpdate = true;
    }
    // builders take the tier (leaf-card counts, segments): rebuild templates
    if (prev.level !== quality.level) this.disposeTemplates(false);
    // re-add every object with the new distances / shadow rules
    this.rebuildAll();
    this.lodDirty = true;
  }

  /** Drop batches + templates (materials stay: they are shared / cached by the builders). */
  private disposeTemplates(materials: boolean): void {
    for (const r of this.uniques) if (r.unique) this.uniqueRoot.remove(r.unique);
    this.uniques.length = 0;
    this.lodRecs.length = 0;
    this.recs.clear();
    for (const b of this.batchList) b.dispose();
    this.batchList = [];
    this.batches.clear();
    for (const b of this.shadowBatches.values()) (b.mesh.material as THREE.Material).dispose();
    this.shadowBatches.clear();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    for (const t of this.templates.values())
      for (const r of [t.root, ...t.lodRoots])
        r.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          geos.add(mesh.geometry);
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m);
        });
    // geometries may be cached by builders: three re-uploads a disposed geometry if it is used again
    for (const g of geos) g.dispose();
    for (const g of this.splitGeos) g.dispose();
    this.splitGeos = [];
    if (materials) {
      for (const m of this.mergeMats.values()) mats.add(m);
      this.mergeMats.clear();
      this.mergedOf.clear();
      for (const m of mats) {
        disposeWind(m);
        m.dispose();
      }
    }
    this.templates.clear();
    this.sizeClass.clear();
  }

  /**
   * Loading screen: build what the current world draws, in short main-thread
   * tasks so the loading bar keeps moving — the foliage atlases are painted
   * in a worker, then the shared leaf sheets are composed, one template (def
   * variant with its LODs and textures) is built per object type in use,
   * the fence styles in use, and finally the instances. Other object types are
   * built on first use (build-menu thumbnail / ghost or placement), so a new
   * zoo only pays for the handful of types it starts with.
   */
  async prewarm(onProgress?: (fraction: number) => void): Promise<void> {
    const t0 = performance.now();
    await withQuality(this.quality, () => paintAtlasesOffThread((f) => onProgress?.(f * 0.5)));
    // the shared leaf sheets (and any atlas the worker could not paint), at this layer's tier
    const steps: (() => void)[] = atlasSteps().map((step) => () => withQuality(this.quality, step));
    const used = new Set<string>();
    for (const o of this.world.objects.values()) {
      if (!OBJECTS_BY_ID[o.defId]) continue;
      const variant = this.variantOf(this.specFor(o.defId), o.seed);
      const key = `${o.defId}#${variant}`;
      if (used.has(key)) continue;
      used.add(key);
      steps.push(() => void this.template(o.defId, variant));
    }
    const detail = fenceDetail(this.quality);
    for (const id of this.fencesInUse()) {
      steps.push(() => void fenceStyle(id, detail));
      // far version of detailed fences (batched back-end, see FenceRenderer)
      if (this.backend === 'batched' && detail > 0 && this.tier.fenceLod > 0) steps.push(() => void fenceStyle(id, 0));
    }
    steps.push(() => this.rebuildAll());
    let slice = performance.now();
    for (let i = 0; i < steps.length; i++) {
      if (this.disposed) return;
      try {
        steps[i]();
      } catch (err) {
        console.error('[props] prewarm step failed', err);
      }
      onProgress?.(0.5 + (0.5 * (i + 1)) / steps.length);
      if (performance.now() - slice > 12) {
        await new Promise<void>((r) => setTimeout(r, 0));
        slice = performance.now();
      }
    }
    this.prewarmMs = Math.round(performance.now() - t0);
  }

  /** Fence ids present in the world. */
  private fencesInUse(): Set<number> {
    const ids = new Set<number>();
    for (const arr of [this.world.hFence, this.world.vFence]) for (const id of arr) if (id) ids.add(id);
    return ids;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsub) u();
    this.unsub = [];
    this.disposeTemplates(true);
    for (const g of placeholderGeo.values()) g.dispose();
    placeholderGeo.clear();
    this.fences.dispose();
    disposeFenceStyles();
    this.litter.dispose();
    this.highlight.dispose();
    this.night.dispose();
    clearBlockers();
    disposePropMaterials();
    disposeNatureResources();
    disposeStructures();
    this.root.removeFromParent();
  }
}
