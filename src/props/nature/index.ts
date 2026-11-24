// Nature prop builders (trees, plants, rocks). Registers into PROP_SPECS on import.
//
// Every builder is procedural (no binary assets): species skeletons meshed into
// textured bark tubes, alpha-tested leaf-cluster cards painted into atlases,
// noise-displaced rocks with triplanar detail. Textures / materials are
// generated once on first use and shared (atlasSteps() paints the shared
// foliage sheets one atlas per call, for loading screens); call
// disposeNatureResources() when tearing the props layer down. Every
// PropSpec.build / buildLod runs at the tier of the QualitySettings it
// receives (card counts, radial segments, texture resolution; 'medium' when
// none is given). Trees, bamboo, palms, large bushes and big rocks have a
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

export { atlasSteps, paintAtlasesOffThread } from './atlases';
export { disposeNatureResources, natureResourceStats, setNatureNight, withQuality } from './mats';

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
