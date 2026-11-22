// Release GPU copies of every texture / material owned by the structures
// module (they are regenerated / re-uploaded if a builder runs again).
import { disposeStructMaterials } from './mats';
import { disposeSignTextures } from './signs';
import { disposeSurfaces } from './tex';

export function disposeStructures(): void {
  disposeStructMaterials();
  disposeSurfaces();
  disposeSignTextures();
}
