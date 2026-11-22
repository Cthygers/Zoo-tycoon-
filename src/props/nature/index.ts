// Nature prop builders (trees, plants, rocks). Registers into PROP_SPECS on import.
//
// Every builder is procedural (no binary assets): species skeletons meshed into
// textured bark tubes, alpha-tested leaf-cluster cards painted into atlases,
// noise-displaced rocks with triplanar detail. Textures / materials are
// generated once on first use and shared; call disposeNatureResources() when
// tearing the props layer down. setNatureQuality() scales card counts and
// radial segments for builds made after it is called.

import { registerProp, type PropSpec } from '../registry';
import { buildCactus, buildFern, buildFlowerBed, buildHedge, buildReeds, buildTallGrass, buildThornBush } from './plants';
import { buildBoulder, buildIceRocks, buildLog, buildOutcrop, buildRockSmall } from './rocks';
import { buildAcacia, buildBamboo, buildBaobab, buildBirch, buildOak, buildPalm, buildPine } from './trees';

import { atlas, hedgeTextures, soilTextures, type AtlasKind } from './atlases';
import { barkTextures, type BarkKind } from './barks';
import { prewarmRockMaterials } from './rocks';

export { disposeNatureResources, natureResourceStats, setNatureQuality } from './mats';

const ATLASES: AtlasKind[] = ['oak', 'acacia', 'baobab', 'pine', 'birch', 'bamboo', 'palm', 'fern', 'grass', 'reed', 'flowers'];
const BARKS: BarkKind[] = ['oak', 'acacia', 'baobab', 'pine', 'birch', 'palm', 'bamboo', 'cactus', 'endgrain'];

/** Every texture-generation step (each ≈ 20–200 ms on desktop, several × that on phones). */
function prewarmSteps(): (() => void)[] {
  return [
    ...ATLASES.map((k) => () => void atlas(k)),
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

const tree = (build: (v: number) => import('three').Object3D, variants = 4, scale: [number, number] = [0.88, 1.12]): PropSpec => ({
  build,
  variants,
  jitter: { yaw: true, scale },
});

registerProp('tree_acacia', tree(buildAcacia));
registerProp('tree_baobab', tree(buildBaobab, 4, [0.92, 1.08]));
registerProp('tree_oak', tree(buildOak));
registerProp('tree_pine', tree(buildPine));
registerProp('tree_birch', tree(buildBirch));
registerProp('tree_palm', tree(buildPalm));
registerProp('bamboo', tree(buildBamboo, 4, [0.9, 1.1]));

const rock = (build: (v: number) => import('three').Object3D, variants = 4, yaw = true, scale: [number, number] = [0.9, 1.1]): PropSpec => ({
  build,
  variants,
  jitter: { yaw, scale },
});

registerProp('rock_small', rock(buildRockSmall));
registerProp('rock_boulder', rock(buildBoulder));
// outcrop / log keep their footprint orientation (2×2 / 2×1): no random yaw
registerProp('rock_outcrop', rock(buildOutcrop, 4, false, [0.95, 1.05]));
registerProp('rock_ice', rock(buildIceRocks));
registerProp('log_fallen', rock(buildLog, 3, false, [0.95, 1.05]));

const plant = (build: (v: number) => import('three').Object3D, variants = 4, scale: [number, number] = [0.85, 1.15]): PropSpec => ({
  build,
  variants,
  jitter: { yaw: true, scale },
});

registerProp('bush_savanna', plant(buildThornBush));
registerProp('bush_fern', plant(buildFern));
registerProp('grass_tall', plant(buildTallGrass));
registerProp('reeds', plant(buildReeds));
registerProp('cactus', plant(buildCactus, 4, [0.9, 1.1]));
// formal planting: keep footprint alignment so rows / runs line up
registerProp('flower_bed', { build: buildFlowerBed, variants: 4 });
registerProp('hedge', { build: buildHedge, variants: 4 });
