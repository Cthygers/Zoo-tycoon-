# src/models — procedural creatures (animals + people)

Everything is code: animals and humans are sculpted from signed-distance
primitives, meshed with multi-resolution surface nets, auto-skinned to a
data-driven skeleton, coloured by a coat function and animated procedurally.
Public entry: `createCreatureFactory(quality)` in `index.ts` (implements
`ICreatureFactory` from `src/core/contracts.ts`).

```
index.ts            CreatureFactory (cache per species × sex × detail, preload with progress,
                    juvenile mesh choice, re-applies the detail to live models on setQuality)
model.ts            RiggedModel: per-instance bones, action crossfades, growth, highlight,
                    runtime mesh swaps (setAsset)
assets.ts           design → RigAsset (geometry + rig + materials)
types.ts            SpeciesModel, CreatureDesign, CoatSample, AnimDriver, AnimCtx …  ← read this
sdf/prims.ts        primitives + helpers (ellipsoid, cone, capsule, roundBox, sphere, tube,
                    symmetric, mirrorX, transformPrims, transformPoint, scalePrims)
sdf/mesher.ts       surface nets (block culling, Newton projection, SDF normals)
build/geometry.ts   regions/ownership, skin weights, vertex baking, eyes
build/furShell.ts   raised shell of lock tips over long hair (fur ≥ 2.6) on the full mesh only
rig/rig.ts          RigDef, Pose, RigRuntime (FK), TwoBoneChain (IK), rotLocal/rotParent
anim/quadruped.ts   quadruped driver + building blocks (gait IK, lie, sit, swim, call …)
anim/biped.ts       two-legged animal driver (birds, penguins; primate starting point)
anim/human.ts       human driver (walk, idle, watch, sit, eat/drink, staff work)
anim/util.ts        noise, glance(), pulses(), smooth(), driver() …
coat/coat.ts        coat helpers (fbm, voronoi, mixHex, blendHex, belly …)
kit/quadruped.ts    quadSkeleton(), legPrims(), hoof(), surfacePoint(), seat(), withRegion()
kit/generic.ts      genericQuadruped(), genericUpright(), paletteCoat() (placeholders)
material/*.ts       animal material (vertex colours + per-pixel pattern, fur strands / clumps and hide
                    micro-normals faded by pixel footprint, long hair with darker partings and a fur shell of lock
                    tips up close, matte grazing reflection, coat-tinted sheen)
humans/*.ts         human body design (bald fringe baked in the zone attribute), skin / fabric / hair / face material, held items, HumanFactory
species/*.ts        ONE FILE PER SPECIES (default export SpeciesModel); index.ts = registry
```

Reference implementations: **`species/zebra.ts`** (hoofed, stripes, mane) and
**`species/lion.ts`** (big cat, sexual dimorphism, shaggy mane, custom roar).
The other 12 files are placeholders built with `kit/generic.ts` — replace them.

Rendering in the game is batched (GPU-instanced skinning) with distance LODs: see
[`crowd/README.md`](crowd/README.md) for batches, LOD levels, per-instance data and
extension points. The harness `wire=1` option needs `&standalone=1`.

## Conventions

* Metres, model space, **+Y up, facing +Z**, feet on `y = 0`, origin on the
  ground between the feet. Author the adult at `SpeciesDef.height`
  (shoulder height) — the factory applies per-instance / sex / growth scale.
* Bone rest rotations are identity: a bone's frame is parallel to model space
  at rest. Rest pose = the modelling pose. Bone names used by the kits:
  `hips, spine_1.., chest, neck_1.., head, jaw, ear.L/R, tail_1..,
  FL_scap, FL_upper, FL_lower, FL_foot, FL_toe` (FR_, HL_, HR_ likewise).
* Left side = +X. `mirrorX` / `symmetric` swap `FL↔FR`, `HL↔HR`, `x.L↔x.R`,
  `x_L↔x_R` in bone / part / region names. **`mirrorX` returns only the
  mirrored copies — use `symmetric([...])` for "left + right".**

## A species file

```ts
import type { SpeciesModel } from '../types';
const okapi: SpeciesModel = {
  id: 'okapi',                       // = SpeciesDef.id
  dimorphic: false,                  // true → separate M / F meshes (lion mane); young
                                     // males use the F mesh below growth maturesAt (0.7)
  design: (ctx) => ({ ... }),        // ctx: { def: SpeciesDef, sex, detail: 0|1|2 }
  instanceScale: (sex, r) => (sex === 'M' ? 1.03 : 0.96) * (0.97 + r * 0.06),
};
export default okapi;
```

`design()` returns a `CreatureDesign` (see `types.ts`):

| field | meaning |
|---|---|
| `bones`, `roles` | skeleton + semantic roles. `quadSkeleton(joints)` builds both from joint positions (left side). Add extra chains with `joints.extra` (BoneSpec[]) + `joints.chains` (e.g. `{ trunk: [...] }`) → `ctx.roles.chains.trunk`. |
| `prims` | SDF primitives (below). Order matters: smooth union in order, `sub` carves what came before. |
| `regions` | detail regions keyed by `Prim.region` (`{ scale?, aniso? }`). |
| `resolution` | base grid multiplier (bulky animals ≈ 0.7). |
| `coat` | `(c: CoatSample) => void` — baked per vertex. |
| `look` | `{ skin: 'fur'|'hide'|'wrinkled'|'smooth'|'feather', pattern: 'none'|'stripes'|'field', roughness, sheen, grain, bump, mottle, wets?, juvenile? }` — `'wrinkled'` = crease network plus deep folds across limbs and trunk (readable at mid range) for thick skins (elephant, rhino, hippo; `'hide'` = cell plates) — grooves thinner than a pixel are filtered to their average tone (no pinhole speckle), and its folds and stripe rings get an irregular spacing; `bump` sets how dark creases and folds shade in; creases are deep on the folds (`fold`: legs, trunk, throat) and faint and broken on the back and flanks; pale coats (polar bear, white bellies) get about a quarter of the albedo clumps and mottle, so their texture comes from relief and sheen; `wets` makes a coat darker and slicker after a swim, drying from the top down (default: `'wrinkled'`; set on tigers and bears); `juvenile: { color, amount?, until?, keep? }` tints young animals (penguin chicks' grey down) per instance from their growth |
| `eyes` | `[{ bone, pos (left eye), radius, color? }]` — glossy spheres rigidly bound to the bone (mirrored). Use `surfacePoint()` + `seat()` to sit them on the head. |
| `anim` | `driver(myDriver)` — see Animation. |
| `babyScale`, `babyHead` | growth 0 → root scale / extra head scale. |
| `babyLegs` | newborn scale of the legs' `lower` bones (forearm / gaskin and below), easing linearly to 1: foals and calves stand on long legs (≈ 1.1–1.3), cubs on short ones (≈ 0.8–0.85). The quadruped driver lifts / lowers the standing trunk so the feet stay planted; lying and swimming heights stay the adult ones. |
| `babyBones` | per-bone newborn scale easing to 1 over growth 0.15 … 0.95: tusks / horns that grow in (put them on their own bone at the base, ≈ 0.05–0.1), oversized cub paws (> 1, `CUB_PAWS` in kit/quadruped.ts), a young male's mane (lion: mane volumes on `mane_*` bones inside the parts they cover). |
| `height`, `radius` | optional overrides (selection ring / picking). |

### Primitives (`sdf/prims.ts`)

```ts
ellipsoid(bone, centre, radii, { rot?: [x,y,z] (Euler XYZ), ...opts })
cone(bone, a, b, ra, rb, opts)        // tapered capsule a→b
capsule(bone, a, b, r, opts) · sphere(bone, c, r, opts) · roundBox(bone, c, half, round, opts)
tube(bones, points[], radii[], opts)  // chained cones (trunks, tails, necks)
opts: { part?, blend? (smooth-union radius, default 0.03), sub?, region?,
        noise?: { amp, freq, octaves?, stretch?, ridged?, seed? },   // shaggy manes, lumpy hide
        skin? (falloff ×), skinWeight?, noSkin? }
transformPrims(prims, { scale, about, offset }) · transformPoint(p, t)   // move / scale groups (heads)
```

* `bone` = the bone the surface deforms with. Weights are automatic: smooth
  falloff of the distance to each primitive, top-4 bones, and only bones
  within 2 ancestor/descendant steps of the vertex's dominant bone (so a
  hanging hand never picks up thigh weights). Split long masses (torso) into
  several primitives on successive spine bones so they bend smoothly.
* `part` = coat tag (default: bone name). Read it as `c.part`, `c.pw(part)`
  (smooth 0..1 membership) and `c.pd(part)` (distance to that part).
* **Regions**: thin things (lower legs, ears, tails, manes, heads) need a finer
  grid. Give their primitives `region: 'FL'` etc.; the base grid skips cells
  owned by the region and a finer grid (cell = thinnest radius / k, or
  `scale × base cell`, times `aniso`) meshes them, with an overlap band where
  the coarse mesh sinks under the fine one (no cracks, no z-fighting).
  Region names are mirrored like bone names (`FL`→`FR`). `withRegion(prims,
  'head')` tags a group. Keep detail regions apart (a primitive belongs to one).
* Budget at medium: big animals ≈ 6–10k triangles, small ≈ 4–6k. Check the
  numbers printed in the harness overlay; lower `regions.*.scale`/`aniso` or
  `resolution` if needed. Thin plates (ears) need ≥ 3 cells across their
  thickness or they break up. Don't carve cups into them (`sub`): the
  remaining wall folds into back-facing slivers that show as holes — paint
  the inside of the ear in the coat (by normal / facing) instead.
  Seams: the coarse mesh sinks under the fine one from just before the fine
  mesh ends to the junction itself (`SEAM` in build/geometry.ts; harness
  `?legacy=1` / `?seamSink=` for A/B), never past the middle of a thin part.
  `RegionOpts.cell` caps the fine cell in metres on every tier (thin bills,
  flippers); `RegionOpts.noBase` leaves the region's primitives out of the
  coarse grids entirely — use it when a thin part sits within ~1 base cell of
  another surface (penguin flippers, flamingo neck/legs), otherwise the
  coarse grid bridges the gap with a flat sheet.
* Carving primitives (`sub`) with an explicit `part` are measured by
  `c.pd(part)` (mouth lines, nostrils), but never weight or own a vertex.

### Coat (`CoatSample`)

Inputs: rest position `x,y,z`, normal `nx,ny,nz`, `part`, `bone`, `t` (cone
axis parameter), `pw()`, `pd()`. Outputs: `color` (base, **linear** —
`color.setHex(0xRRGGBB)` converts from sRGB), `color2` + `s` + `w` (pattern),
`gloss` (0 fur … 1 wet nose / eye), `fur` (strand length ×, manes ≈ 3–4).

* `look.pattern = 'stripes'`: per pixel, colour2 where `fract(s)` is within
  `w/2` of an integer. Bake `s = distance / period` along the stripe normal.
  Stripes stay crisp on coarse meshes. Where two phase fields blend, offset
  them so they have the **same value at the junction** (see zebra.ts
  `sBody/sRump/sNeckAt`) — otherwise you get bull's-eyes.
* `look.pattern = 'field'`: colour2 where `s > 0` (signed distance, metres) —
  giraffe patches (`voronoi(...).edge - lineWidth`), spots, rosettes.
* Helpers: `fbm`, `voronoi`, `mixHex`, `blendHex`, `belly`, `smooth`, `clamp01`.
* `c.ao(radius)`: ambient occlusion 0 … 1 from the shape itself (SDF steps
  along the normal). Multiply it into the colour to bake skin folds, horn
  bases and the gaps between legs and belly — they then read on the low tier
  too, where there is no micro detail (rhino, elephant). A few field
  evaluations per vertex: call it once per sample, with one or two radii.

## Animation

A driver (`AnimDriver<S>` in `types.ts`) has per-instance state `init(ctx)`,
`pre(ctx, s)` once per frame, one `ActionFn` per action
`(ctx, s, pose) => void`, optional `post(ctx, s, pose)` (additive layers),
`aliases` (e.g. `{ run: 'walk', sit: 'rest' }`), `fade` / `fades` / `transitions`
(per-transition crossfade keyed `'from>to'`, `'from>*'`, `'*>to'` — e.g. a slow
`'sleep>*'` get-up; the default quadruped driver ships with one) (crossfade
seconds). Action functions start from the rest pose and write local
rotations (`rotLocal(pose, bone, 'x'|'y'|'z', rad)`, `rotParent`) and offsets
(`pose.p[bone]`). The framework crossfades between actions, sets
`ctx.speed` (model-scale m/s), `ctx.actionTime`, `ctx.turnRate`,
`ctx.swimming` (origin = water surface), `ctx.holding`, `ctx.role`.

Signs: +X rotation pitches a forward-pointing bone **down**; negative = up.
Positive Y = turn left; Z = roll.

Quadrupeds: `quadrupedDriver(quadParams(height, walkSpeed, runSpeed, overrides))`
gives idle, walk/run (walk→trot→gallop gait blending, stride from speed so
feet don't skate, leg IK), eat, drink, sleep, rest, sit, play, social, call,
swim. Tune with `QuadParams` (gait offsets / duty / stride, foot flex, scapula
swing, lie & sit style, graze reach, call head/jaw, swim sink). Lying
(`LieParams`): long-legged hoofed animals fold their legs under the body —
`carpusZ` ≈ 0 puts the folded carpus under the chest with the cannon lying
back beneath it, `hockZ` ≈ 0 rests the hock beside the belly instead of
behind the rump (giraffe, camel); side-lying predators (`SideLie.bend`, bears)
draw their paws in with bent knees and elbows, and bears lying on the belly
fold their hind legs beside it (knee forward, hock on the ground, sole flat)
instead of stretching them out behind. Override or add actions by
spreading:

```ts
const base = quadrupedDriver(p);
anim: driver({ ...base, actions: { ...base.actions, call: trumpet }, post: swingTrunk })
```

Building blocks for custom actions (all exported from `anim/quadruped.ts`):
`standingBase` (body bob + planted legs), `body`, `legs`, `plantLeg`,
`placeLeg`, `reachMuzzle` (neck down until the muzzle hits a height; scans
the pitch range and falls back to the lowest reachable muzzle instead of
curling the head under the chest — e.g.
giraffe browsing high: target y = 4.5), `neckHead`, `lookAround`, `tail`,
`ears`, `jaw`, `lie`, `act*` defaults. `post` is ideal for extra chains
(trunk sway, ear flaps) because it runs on top of every action.

Juvenile proportions (`babyHead`, `babyLegs`, `babyBones`) are per-instance
bone scales on the rig runtime (`RigRuntime.boneScale`), so FK, `reachMuzzle`
and the two-bone IK see the proportions that are drawn. A custom action that
stands on its feet without `body()` calls `standingLift(st, pose, root)`
first (as `crouch` and `rearUp` do); one that sets an absolute trunk height
(lying, sitting on the rump, swimming) does not. For planting and reach use
`leg.kFoot` / `leg.kToe` (or `plantLeg` / `ankleFor`), `leg.reach` and
`leg.scaledLen` instead of the rest `chain.a + chain.b` / `legLen`.

## Adding a rig kind (bird, penguin, primate …)

No framework edits are needed: a rig kind is just bones + roles + a driver.

1. Put the skeleton builder and driver in your own files (e.g.
   `species/primate-kit.ts`, imported by `gorilla.ts`) or inside the species
   file. Use any bone names; declare `roles` (root, spine, chest, neck, head,
   jaw, tail, ears, `legs.HL/HR` for two legs, `arms.L/R`, `chains`).
2. Write an `AnimDriver<MyState>`; reuse `LegRT` + `plantLeg`/`placeLeg` for
   planted feet (they only need `roles.legs`), `TwoBoneChain` for arms,
   `reachMuzzle` for pecking / drinking. `anim/biped.ts` is a complete small
   example (birds/penguins); `anim/human.ts` shows arms & gestures.
3. Wrap with `driver(...)` and return it in the design.

## Juveniles and quality changes

A model draws one cached mesh variant (`RigAsset`) at a time and can switch
at runtime (`RiggedModel.setAsset`: it leaves its batch and enters the batch
of the new mesh; poses and driver state carry over between builds of the same
skeleton). The factory gives every model a picker:

* dimorphic species: males below `maturesAt` use the female mesh (cubs have no
  mane, calves no bull features) and switch when they grow up;
* `setQuality` with a new `creatureDetail` moves every live model (batched or
  standalone) to the new tier's mesh within a small budget per frame (about one
  mesh build per frame), then frees the previous tier's meshes, LODs and
  batches. LODs of the new meshes build lazily as usual.

## Humans

`createHuman(appearance, role, seed)`: geometry cached per (female, child,
hair/hat variant: short, long, bald, cap, bushhat, + an A-line skirt variant
worn by about a third of female guests — a dress when top and skirt share
the shirt colour, bare legs or leggings below); hands have a palm, cupped
fingers and a thumb on their own grid (medium / high); height = root scale; build
= shader inflation along normals; clothing colours / sleeve & trouser length /
lab coat are per-instance uniforms of a per-instance material (shared
program); a darker waistband separates top and bottom. Guest outfits come
from `fitOutfit` in sim/names.ts: never skin-coloured, top and bottom apart
in lightness, no pale top (or dress) under grey / blonde hair. The walk caps
the step at ≈ 0.42 × height (faster = quicker cadence), rolls the planted
foot heel → ball and folds the swing knee ≈ 55°. Staff: keeper (khaki + bush hat), groundskeeper (dark green + cap,
broom while working), vet (white coat). Held items (`anim.holding`) attach to
the right hand; balloons float on a string. ≈ 2.6–3.1k triangles at medium.

## Preview

```
npx vite --port 5302
http://localhost:5302/harness/creatures.html?species=okapi&action=walk&speed=1.4&t=1.2&yaw=90&dist=5
  params: species, sex=M|F, action, speed, t (freeze time), yaw, pitch, dist, ty/tz (look-at),
          detail=0|1|2, growth, seed, wire=1 (wireframe), live=1, noshadow=1
?grid=1     all species side by side (+ 1.8 m human)       ?humans=1  crowd with actions / items
?grid=1&species=zebra,lion&ages=1,0.5,0.2&action=sleep     chosen species at several growths
?person=1&action=sit&hold=icecream&sex=F&hair=1&role=vet   single human   (?humans=1&hseed=5 varies outfits)
?legacy=1 | ?seamSink=0.35&seamFull=1.2 …   region seam A/B (see SEAM in build/geometry.ts)
node scripts/shot.cjs "<url>" out.png --wait=8000 --size=1280x720
```

The overlay lists triangles and build ms per cached mesh. `npx vitest run
tests/models.test.ts` builds every species (detail 0) and checks bounds and
skin weights.
