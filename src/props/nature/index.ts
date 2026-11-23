// Nature prop builders (trees, plants, rocks). Registers into PROP_SPECS on import.
//
// Every builder is procedural (no binary assets): species skeletons meshed into
// textured bark tubes, alpha-tested leaf-cluster cards painted into atlases,
// noise-displaced rocks with triplanar detail. Textures / materials are
// generated once on first use and shared; call disposeNatureResources() when
// tearing the props layer down. Every PropSpec.build / buildLod runs at the
// tier of the QualitySettings it receives (card counts, radial segments,
// texture resolution); setNatureQuality() sets the default tier for callers
// that pass none. Trees, bamboo, palms, large bushes and big rocks have a
// hand-made distant LOD (buildLod, ≈ 15–25 % of the triangles).

import type * as THREE from 'three';
import type { QualitySettings } from '../../core/contracts';
import { registerProp, type PropSpec } from '../registry';
import { withQuality } from './mats';
import { buildCactus, buildCactusLod, buildFern, buildFlowerBed, buildHedge, buildReeds, buildTallGrass, buildThornBush, buildThornBushLod } from './plants';
import { buildBoulder, buildBoulderLod, buildIceRocks, buildLog, buildOutcrop, buildOutcropLod, buildRockSmall } from './rocks';
import {
  buildAcacia,
  buildAcaciaLod,
  buildBamboo,
  buildBambooLod,
  buildBaobab,
  buildBaobabLod,
  buildBirch,
  buildBirchLod,
  buildOak,
  buildOakLod,
  buildPalm,
  buildPalmLod,
  buildPine,
  buildPineLod,
} from './trees';

import { atlasSteps, hedgeTextures, soilTextures } from './atlases';
import { barkTextures, type BarkKind } from './barks';
import { prewarmRockMaterials } from './rocks';

export { disposeNatureResources, natureResourceStats, setNatureQuality, withQuality } from './mats';

const BARKS: BarkKind[] = ['oak', 'acacia', 'baobab', 'pine', 'birch', 'palm', 'bamboo', 'cactus', 'endgrain'];

/** Every texture-generation step (each ≈ 20–200 ms on desktop, several × that on phones). */
function prewarmSteps(): (() => void)[] {
  return [
    // foliage: each atlas painted in its own step, then the two shared sheets
    ...atlasSteps(),
    ...BARKS.map((k) => () => void barkTextures(k)),
    () => void hedgeTextures(),
    () => void soilTextures(),
    prewarmRockMaterials,
  ];
}

/**
 * Generate all nature textures now instead of on the first placement of each
 * species (avoids a hitch mid-game). Synchronous.
 */
export function prewarmNature(onProgress?: (fraction: number) => void): void {
  const steps = prewarmSteps();
  steps.forEach((s, i) => {
    s();
    onProgress?.((i + 1) / steps.length);
  });
}

/** As prewarmNature, yielding to the event loop between steps (loading screens). */
export async function prewarmNatureAsync(onProgress?: (fraction: number) => void): Promise<void> {
  const steps = prewarmSteps();
  for (let i = 0; i < steps.length; i++) {
    steps[i]();
    onProgress?.((i + 1) / steps.length);
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

type Builder = (v: number) => THREE.Object3D;
/** Wrap a builder so it runs at the tier of the QualitySettings it is given. */
const tiered = (b: Builder) => (v: number, q?: QualitySettings) => withQuality(q, () => b(v));

function spec(build: Builder, lod: Builder | undefined, variants: number, jitter: PropSpec['jitter']): PropSpec {
  const s: PropSpec = { build: tiered(build), variants };
  if (lod) s.buildLod = tiered(lod);
  if (jitter) s.jitter = jitter;
  return s;
}

const tree = (build: Builder, lod: Builder, variants = 4, scale: [number, number] = [0.88, 1.12]): PropSpec => spec(build, lod, variants, { yaw: true, scale });

registerProp('tree_acacia', tree(buildAcacia, buildAcaciaLod));
registerProp('tree_baobab', tree(buildBaobab, buildBaobabLod, 4, [0.92, 1.08]));
registerProp('tree_oak', tree(buildOak, buildOakLod));
registerProp('tree_pine', tree(buildPine, buildPineLod));
registerProp('tree_birch', tree(buildBirch, buildBirchLod));
registerProp('tree_palm', tree(buildPalm, buildPalmLod));
registerProp('bamboo', tree(buildBamboo, buildBambooLod, 4, [0.9, 1.1]));

const rock = (build: Builder, lod?: Builder, variants = 4, yaw = true, scale: [number, number] = [0.9, 1.1]): PropSpec => spec(build, lod, variants, { yaw, scale });

registerProp('rock_small', rock(buildRockSmall));
registerProp('rock_boulder', rock(buildBoulder, buildBoulderLod));
// outcrop / log keep their footprint orientation (2×2 / 2×1): no random yaw
registerProp('rock_outcrop', rock(buildOutcrop, buildOutcropLod, 4, false, [0.95, 1.05]));
registerProp('rock_ice', rock(buildIceRocks));
registerProp('log_fallen', rock(buildLog, undefined, 3, false, [0.95, 1.05]));

const plant = (build: Builder, lod?: Builder, variants = 4, scale: [number, number] = [0.85, 1.15]): PropSpec => spec(build, lod, variants, { yaw: true, scale });

registerProp('bush_savanna', plant(buildThornBush, buildThornBushLod));
registerProp('bush_fern', plant(buildFern));
registerProp('grass_tall', plant(buildTallGrass));
registerProp('reeds', plant(buildReeds));
registerProp('cactus', plant(buildCactus, buildCactusLod, 4, [0.9, 1.1]));
// formal planting: keep footprint alignment so rows / runs line up
registerProp('flower_bed', spec(buildFlowerBed, undefined, 4, undefined));
registerProp('hedge', spec(buildHedge, undefined, 4, undefined));
