// Public types of the creature framework (species authors read this file
// together with src/models/README.md).

import type * as THREE from 'three';
import type { SpeciesDef } from '../core/types';
import type { Prim, Vec3 } from './sdf/prims';
import type { BoneSpec, Pose, RigDef, RigRuntime } from './rig/rig';

export type { Prim, Vec3 } from './sdf/prims';
export type { BoneSpec } from './rig/rig';

// ---------------------------------------------------------------------------
// Rig roles (semantic bone mapping)

/** One leg: bone names from the body outward. */
export interface LegSpec {
  /** Optional shoulder-blade bone (rotates with the stride: big cats, bears). */
  scap?: string;
  /** Joint at shoulder / hip. */
  upper: string;
  /** Joint at elbow / knee (stifle). */
  lower: string;
  /** Joint at wrist (carpus) / ankle (hock). */
  foot: string;
  /** Optional joint at fetlock / toes (pastern+hoof or paw). */
  toe?: string;
  /** Ground-contact point at rest (model space, y = 0) under the hoof / paw. */
  contact: Vec3;
}

export type LegId = 'FL' | 'FR' | 'HL' | 'HR';

export interface RigRoles {
  /** Skeleton root (pelvis / hips). */
  root: string;
  /** Spine chain from hips (exclusive) towards the chest (exclusive). */
  spine?: string[];
  chest?: string;
  /** Neck chain from chest towards the head (exclusive). */
  neck?: string[];
  head?: string;
  jaw?: string;
  /** Tail chain from the base outward. */
  tail?: string[];
  /** Ears (left first). */
  ears?: string[];
  /** Four legs for quadrupeds; bipeds use HL / HR (and arms below). */
  legs?: Partial<Record<LegId, LegSpec>>;
  /** Biped arms / bird wings: [shoulder?, upper, lower, hand]. */
  arms?: Partial<Record<'L' | 'R', { clavicle?: string; upper: string; lower: string; hand: string }>>;
  /** Extra named chains (trunk, ...) for species-specific animation. */
  chains?: Record<string, string[]>;
  /** Model-space rest position of the mouth / muzzle tip (eat & drink reach the ground with it). */
  muzzle?: Vec3;
}

// ---------------------------------------------------------------------------
// Coat

/**
 * One surface sample handed to a coat function. Inputs are rest-pose model
 * space. Write the outputs (colours are LINEAR RGB; `color.setHex(0xRRGGBB)`
 * converts from sRGB automatically).
 */
export interface CoatSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Part tag of the primitive the sample most belongs to. */
  readonly part: string;
  /** Bone of that primitive. */
  readonly bone: string;
  /** Axis parameter of that primitive (cones: 0 at `a` … 1 at `b`; others 0). */
  readonly t: number;
  /** Smooth membership 0..1 of a part tag (weights over all parts sum to 1). */
  pw(part: string): number;
  /** Smallest raw SDF distance (m) from the sample to any primitive tagged `part` (1e3 if none). */
  pd(part: string): number;
  /**
   * Ambient occlusion 0 (open) … 1 (deep crease) within `radius` metres of
   * the surface, from the shape itself: bake skin folds, horn bases and other
   * cavities into the colour (they read on every tier, also without micro
   * detail). Costs a few field evaluations per vertex — call it only where needed.
   */
  ao(radius: number): number;
  /** Base coat colour (linear). */
  readonly color: THREE.Color;
  /** Pattern colour (stripes / patches), used where the pattern mask is on. */
  readonly color2: THREE.Color;
  /**
   * Pattern scalar. With look.pattern 'stripes': stripes where fract(s) is
   * within w/2 of an integer (so `s` = distance / stripe period). With
   * 'field': colour2 where s > 0 (signed distance-like, metres). Evaluated
   * per pixel, so stripes stay crisp on coarse meshes.
   */
  s: number;
  /** Stripe duty (0 = no stripe … 1 = all stripe). Ignored for 'field'. */
  w: number;
  /** 0 = matte fur … 1 = wet / glossy (nose leather, eyes). */
  gloss: number;
  /** Fur strand length multiplier for the micro-normal (1 = look.grain; manes ≈ 3–4). */
  fur: number;
  /**
   * 'wrinkled' skin: depth 0..1 of the deep skin folds that run across the
   * part (legs, trunk, neck; 0 = fine creases only). Ignored where fur > 1.
   */
  fold: number;
}

export type CoatFn = (c: CoatSample) => void;

// ---------------------------------------------------------------------------
// Look (material)

/**
 * Juvenile colouring (penguin chicks' grey down, grey flamingo chicks): the
 * albedo is tinted toward `color` by `amount` at growth 0, fading out by
 * growth `until`. Works per instance in the batched / LOD renderer.
 */
export interface JuvenileTint {
  /** sRGB hex of the juvenile down / coat. */
  color: number;
  /** Tint strength at growth 0 (default 0.85). */
  amount?: number;
  /** Growth (0..1) at which the tint is gone (default 0.65). */
  until?: number;
  /** How much of the adult light/dark pattern survives under the tint 0..1 (default 0.35). */
  keep?: number;
}

export interface LookSpec {
  /**
   * Micro-surface: fur strands, cracked hide (cells), smooth skin, feathers,
   * or 'wrinkled' — a crease network of fine grooves for thick-skinned
   * species (elephant, rhino, hippo), darkened in the grooves.
   */
  skin: 'fur' | 'hide' | 'smooth' | 'feather' | 'wrinkled';
  /** Per-pixel pattern mode (see CoatSample.s). Default 'none'. */
  pattern?: 'none' | 'stripes' | 'field';
  /**
   * Base roughness (default 0.88 fur, 0.8 hide / wrinkled, 0.55 smooth); the
   * shader spreads it by about ±0.06 in clumps and lowers it where the coat
   * bakes gloss (eyes, nose leather, wet skin).
   */
  roughness?: number;
  /**
   * Silhouette sheen 0..1: a halo in the coat's hue where the surface turns
   * away from the view — tight on short coats, broad on long hair (default
   * 0.3 fur, 0.2 feathers, 0.05 otherwise). Fur, feathers and dry skin also
   * get a weak grazing reflection instead of the white plastic rim.
   */
  sheen?: number;
  /** Fur strand / wrinkle scale in metres (default 0.006); fur clumps are 5.5× this. */
  grain?: number;
  /** Micro-normal strength 0..1 (default 0.5). */
  bump?: number;
  /** Albedo clump variation 0..1 (default 0.12); pale coats get about a quarter of it. */
  mottle?: number;
  /**
   * Darker and slicker for a while after a swim, drying from the top down
   * (the instance's wetness, RiggedModel). Default: thick ('wrinkled') skins;
   * set it on fur animals that swim (tigers, bears).
   */
  wets?: boolean;
  /** Growth-dependent juvenile tint (see JuvenileTint). */
  juvenile?: JuvenileTint;
}

export interface EyeSpec {
  bone: string;
  /** Centre of the LEFT eye (x > 0) in model space; mirrored to the right. */
  pos: Vec3;
  radius: number;
  /** sRGB hex (default very dark brown). */
  color?: number;
}

export interface RegionOpts {
  /** Cell size relative to the base cell (default: auto from the thinnest primitive). */
  scale?: number;
  /**
   * Upper bound of the fine cell size in metres (before `aniso`), on every
   * tier. Use it for thin parts (flippers, bills, ears) that need ≥ 2–3 cells
   * across even where the base cell of the low tier is coarse.
   */
  cell?: number;
  /** Per-axis multiplier applied on top (e.g. [1, 2.2, 1] for long vertical legs). */
  aniso?: Vec3;
  /**
   * Exclude this region's primitives from the coarser grids (base grid and
   * other coarser regions). Use it for thin parts that lie within about one
   * base cell of another surface (penguin flippers against the flank, a
   * flamingo's lower bill under the throat): the coarse grid would otherwise
   * bridge the gap with a flat sheet. The region's own fine grid still
   * meshes the junction with the rest of the body.
   */
  noBase?: boolean;
}

// ---------------------------------------------------------------------------
// Animation

/** Per-frame animation context handed to drivers and action functions. */
export interface AnimCtx {
  readonly rig: RigRuntime;
  readonly def: RigDef;
  readonly roles: ResolvedRoles;
  readonly design: CreatureDesign;
  /** Seconds since creation plus a random per-instance offset. */
  time: number;
  dt: number;
  /** Ground speed in MODEL units per second (world speed / root scale). */
  speed: number;
  actionTime: number;
  swimming: boolean;
  holding: string;
  /** Yaw rate of the root object (rad/s, + = turning left / counter-clockwise from above). */
  turnRate: number;
  seed: number;
  /** Per-instance random in [0,1). */
  rand: number;
  sex: 'M' | 'F';
  growth: number;
  /** Humans: 'guest' | 'keeper' | 'groundskeeper' | 'vet'; animals: ''. */
  role: string;
  /** The action currently requested (after alias resolution). */
  action: string;
}

/** Bone indices resolved from RigRoles (-1 = missing). */
export interface ResolvedRoles {
  root: number;
  spine: number[];
  chest: number;
  neck: number[];
  head: number;
  jaw: number;
  tail: number[];
  ears: number[];
  legs: Partial<Record<LegId, ResolvedLeg>>;
  arms: Partial<Record<'L' | 'R', { clavicle: number; upper: number; lower: number; hand: number }>>;
  chains: Record<string, number[]>;
  muzzle: THREE.Vector3 | null;
}

export interface ResolvedLeg {
  scap: number;
  upper: number;
  lower: number;
  foot: number;
  toe: number;
  contact: THREE.Vector3;
}

export type ActionFn<S> = (ctx: AnimCtx, state: S, pose: Pose) => void;

/**
 * An animation driver: per-instance state + one pose function per action.
 * Action functions start from a reset (rest) pose and write local rotations /
 * offsets; the framework crossfades between actions and applies the result.
 */
export interface AnimDriver<S> {
  /** Create per-instance state (called once per model instance). */
  init(ctx: AnimCtx): S;
  /** Called once per frame before any action function (advance gait phase, timers…). */
  pre?(ctx: AnimCtx, state: S): void;
  actions: Record<string, ActionFn<S>>;
  /** Called after blending with the final pose (additive layers: trunk swing, breathing). */
  post?(ctx: AnimCtx, state: S, pose: Pose): void;
  /** Map requested action names to implemented ones (e.g. { run: 'walk', sit: 'sleep' }). */
  aliases?: Record<string, string>;
  /** Action used for unknown names (default 'idle'). */
  fallback?: string;
  /** Crossfade time in seconds (default 0.4). */
  fade?: number;
  /** Per-action crossfade times (e.g. { sleep: 1.2 } for slow lying down). */
  fades?: Record<string, number>;
  /**
   * Per-transition crossfade times keyed 'from>to' (also 'from>*' and
   * '*>to'), checked before `fades` — e.g. { 'sleep>*': 1.6 } for a slow
   * get-up so the body never passes through the ground.
   */
  transitions?: Record<string, number>;
}

/** Type-erased driver stored in a design (use `driver()` to create one). */
export interface AnyDriver {
  readonly __erased: true;
}

// ---------------------------------------------------------------------------
// Design

export interface CreatureDesign {
  bones: BoneSpec[];
  roles: RigRoles;
  prims: Prim[];
  /** Detail regions keyed by Prim.region. */
  regions?: Record<string, RegionOpts>;
  /** Grid resolution multiplier (default 1). */
  resolution?: number;
  coat: CoatFn;
  look: LookSpec;
  eyes?: EyeSpec[];
  anim: AnyDriver;
  /** Root scale of a newborn (growth 0), default 0.4. */
  babyScale?: number;
  /** Extra head scale of a newborn, default 1.3. */
  babyHead?: number;
  /**
   * Lower-leg scale of a newborn (the legs' `lower` bones: forearm / gaskin
   * and everything below), easing linearly to 1 with growth. Foals and calves
   * have long legs for their size (≈ 1.1–1.3), cubs short ones (≈ 0.8–0.9).
   * The quadruped driver lifts or lowers the standing body to match, so the
   * feet stay on the ground; lying and swimming heights are unchanged.
   */
  babyLegs?: number;
  /**
   * Juvenile scale of single bones (children inherit it), easing to 1 over
   * growth 0.15 … 0.95: features that grow in with age (tusks, horns ≈ 0.05–0.1;
   * give them their own bone at the base) or that young animals have
   * oversized (cub paws > 1).
   */
  babyBones?: Record<string, number>;
  /** Override computed standing height (m). */
  height?: number;
  /** Override computed radius (m). */
  radius?: number;
}

export interface DesignContext {
  def: SpeciesDef;
  sex: 'M' | 'F';
  detail: 0 | 1 | 2;
}

/** What a species file exports (default export). */
export interface SpeciesModel {
  id: string;
  /**
   * Male and female use different meshes (e.g. lion mane). Young animals show
   * no sexual dimorphism: below growth `maturesAt` males use the female mesh.
   */
  dimorphic?: boolean;
  /** Growth (0..1) from which a dimorphic male uses the male mesh (default 0.7). */
  maturesAt?: number;
  design(ctx: DesignContext): CreatureDesign;
  /** Per-instance uniform scale (default: males 1.0, females 0.94, ±3% jitter). */
  instanceScale?(sex: 'M' | 'F', rand: number): number;
}
