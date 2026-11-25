// Props module entry: placed objects (trees, rocks, buildings…), fences,
// litter, lamp lights and selection highlight. See IPropsLayer.

import type * as THREE from 'three';
import type { IPropsLayer, QualitySettings } from '../core/contracts';
import type { EventBus } from '../core/events';
import type { World } from '../core/world';
// side-effect registration of prop builders into PROP_SPECS
import './nature';
import './structures';
import { PropsLayer } from './layer';

export { PropsLayer, supportsMultiDraw, type PropsBackend } from './layer';
export { setFollowCut } from './lod/fade';
export { paintAtlasesOffThread, setNatureNightGround } from './nature';
export { PROP_SPECS, registerProp, type PropSpec } from './registry';

/** Create the props layer; its root group is added to `scene`. */
export function createPropsLayer(world: World, events: EventBus, scene: THREE.Scene, quality: QualitySettings): IPropsLayer {
  return new PropsLayer(world, events, scene, quality);
}
