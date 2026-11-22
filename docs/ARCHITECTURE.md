# Wildhaven Zoo — architecture & art direction

Wildhaven Zoo is an **original** 3D zoo-building management game for Android phones
(the same genre as classic zoo tycoon games, but with its own name, UI, art and content —
never copy names, characters, art, music, UI layouts or levels from any existing game).

Stack: TypeScript + three.js 0.187 (WebGL2) + Vite, packaged for Android with Capacitor 8.
Everything (models, textures, sounds) is **procedurally generated in code** — there are no
binary art assets in the repo.

## Modules

| dir | contract (src/core/contracts.ts) | purpose |
|-----|-----------|---------|
| `src/core` | — | constants, types, events, noise/RNG, `World` (tiles, fences, habitats) |
| `src/data` | — | species, objects, fences, paths catalogues |
| `src/sim` | `ISimulation` | rules, animal/guest/staff AI, economy, rating, objectives, save/load. No three.js/DOM. |
| `src/render` | `IRenderContext` | WebGL renderer, sky + time of day, sun/moon, shadows, terrain (splat-textured), paths, water, grass, post-fx, quality tiers |
| `src/models` | `ICreatureFactory` | procedural animal & human meshes, skinning, procedural animation |
| `src/props` | `IPropsLayer` | trees, plants, rocks, shelters, feeders, shops, amenities, fences, litter |
| `src/views` | `IEntityViews` | binds sim entities to creature models each frame, picking, selection |
| `src/ui` | `IGameUI` | mobile HUD, build menus, info panels, tools + ghost previews, touch camera |
| `src/main.ts` | — | loading screen, wiring, main loop, autosave, Android lifecycle |

Modules communicate only through `src/core/contracts.ts`, the shared types in
`src/core/types.ts`, the `EventBus` (`src/core/events.ts`) and the read API of `World`.

## Conventions (must follow)

* Units are metres. One tile = `TILE` = 2 m. Map is `MAP_W × MAP_H` tiles; world origin is the
  corner of tile (0,0); +Y up. Tile centre = `((x+.5)*TILE, (z+.5)*TILE)`.
* Ground height anywhere: `world.heightAt(wx, wz)`. The terrain mesh MUST use exactly this so
  entities stand on it.
* Heading θ: forward = `(sin θ, 0, cos θ)`. Models face **+Z** in local space;
  `object.rotation.y = θ`.
* Placed object origin = footprint centre on the ground (`world.objectCenter(o)`), rotation
  `o.rot * π/2` about Y.
* Fence edges: see header comment of `src/core/world.ts`.
* Water surface is a flat plane at `WATER_LEVEL`; water tiles carve the ground below it.

## Art direction — "realistic"

The game must look as close to a modern realistic zoo sim as possible on a phone:

* Physically based rendering: `MeshStandardMaterial`/`MeshPhysicalMaterial`, ACES filmic tone
  mapping, sRGB output, PMREM environment lighting from the sky, soft shadows.
* Real-world proportions and scale for animals, people, trees and buildings.
* Natural, desaturated palettes (no cartoon colours, no flat untextured surfaces). Every large
  surface gets procedural detail: albedo variation, normal/roughness detail from noise.
* Organic shapes for creatures: smooth continuous skin (SDF/implicit surfaces meshed then
  skinned), not boxes and spheres glued together. Coat patterns (zebra stripes, giraffe
  patches, tiger stripes) generated procedurally.
* Foliage: alpha-tested leaf cards with procedurally painted leaf textures, real branch
  structure, subtle wind sway. Grass: instanced blades near the camera.
* Lighting through the day: warm low sun at dawn/dusk, blue hour, moonlit night with lamps.

## Performance budget (mid-range Android, e.g. Adreno 610 / Mali-G57, 60 → 30 fps floor)

* ≤ ~250 draw calls and ≤ ~500k visible triangles on `medium` quality.
* Use `InstancedMesh` / merged geometry for repeated things (trees, fence posts, grass, litter).
* Textures ≤ 1024², generated once and shared. No per-frame allocations in hot loops.
* Shaders must compile on WebGL2 mobile GPUs (declare precision, avoid huge loops/arrays).
* Three quality tiers (`low`/`medium`/`high`, see `QualitySettings`) — honour them.

## Verifying your work

* `npx tsc --noEmit` — typecheck (only your files' errors are yours while other modules are WIP).
* `npx vitest run` — unit tests in `tests/`.
* Visual check: create `harness/<module>.html` + `harness/<module>.ts` that renders your module in
  isolation, run `npx vite --port <unique port>` in the background, then
  `node scripts/shot.cjs http://localhost:<port>/harness/<module>.html out.png --wait=6000`
  and look at the PNG (use the Read tool on it). Headless Chromium renders WebGL2 via SwiftShader
  (slow but correct). Kill your vite server when done.
