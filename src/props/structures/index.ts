// Built prop builders (shelters, feeders, enrichment, shops, facilities,
// amenities). Registers into PROP_SPECS on import. Registration is cheap:
// geometry, textures and materials are generated lazily on first build(), or
// up front by prewarmStructuresAsync() (loading screen). Builders honour the
// QualitySettings tier and provide distant LODs (see tiers.ts).
import { registerAmenities } from './amenities';
import { registerFacilities } from './facilities';
import { BALL_COLORS, registerHabitat } from './habitat';
import { PARASOL, registerShops } from './shops';
import * as M from './mats';
import { interiorTexture, signTexture } from './signs';
import { surface, type StructSurface } from './tex';

registerHabitat();
registerShops();
registerFacilities();
registerAmenities();

export { disposeStructures } from './dispose';

const SURFACES: StructSurface[] = ['boards', 'hardwood', 'thatch', 'clayTiles', 'corrugated', 'render', 'brick', 'ashlar', 'hay', 'rope', 'net', 'water', 'falls', 'foam', 'meat'];

/** Every texture-generation step of the module (surfaces, sign / interior atlases, tinted materials). */
function prewarmSteps(): (() => void)[] {
  return [
    ...SURFACES.map((k) => () => void surface(k)),
    () => void signTexture(),
    () => void interiorTexture(),
    // per-colour surfaces: enrichment balls, parasol fabrics
    ...BALL_COLORS.map((c) => () => void M.ball(c)),
    ...PARASOL.map(([a, b]) => () => void M.fabric(a, b)),
  ];
}

/**
 * Generate all structure textures / materials incrementally, yielding to the
 * event loop between steps (each ≈ 10–60 ms on desktop) so the loading screen
 * stays responsive. Idempotent.
 */
export async function prewarmStructuresAsync(onProgress?: (fraction: number) => void): Promise<void> {
  const steps = prewarmSteps();
  for (let i = 0; i < steps.length; i++) {
    steps[i]();
    onProgress?.((i + 1) / steps.length);
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}
