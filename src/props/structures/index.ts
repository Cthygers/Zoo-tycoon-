// Built prop builders (shelters, feeders, enrichment, shops, facilities,
// amenities). Registers into PROP_SPECS on import. Registration is cheap:
// geometry, textures and materials are generated lazily on first build().
// Builders honour the QualitySettings tier and provide distant LODs (see tiers.ts).
import { registerAmenities } from './amenities';
import { registerFacilities } from './facilities';
import { registerHabitat } from './habitat';
import { registerShops } from './shops';

registerHabitat();
registerShops();
registerFacilities();
registerAmenities();

export { disposeStructures } from './dispose';
