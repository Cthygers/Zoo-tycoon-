# Crowd rendering + LOD (src/models/crowd, src/models/lod)

How creatures reach the screen cheaply. Read this before touching materials,
geometry attributes or per-instance looks.

## Pipeline per frame

```
views.update()            sets model.object position / rotation / visible, calls model.update(dt, anim)
  RiggedModel.update      driver → blended Pose → skinMatrices() → bone rows written straight
                          into the instance block of the model's SkinnedBatch (no THREE.Bone)
creatures.update(camera)  CrowdRenderer.update:
                          · world matrix + visibility of every batched model's object
                          · LOD pick (lod/lod.ts pickLod, size-normalised distance + hysteresis)
                          · shadow decision (castsShadow) + coarser shadow-pass mesh
                          · held items (humans) → item batch
                          · lazily builds missing LOD meshes (≤ 4 ms / frame, one
                            clustering pass at a time)
                          · uploads the rows of each batch data texture in use
renderer.render()         three.js BatchedMesh: per pass (shadow + main) culls instances against the
                          camera, compacts + sorts them, ONE multi-draw per batch
```

Batches: one per animal mesh variant (`animal:<species>:<sex|->:<detail>`, all
LOD levels inside), one for all people of a quality tier (`human:<detail>`, all
body / hair variants × LOD levels), one for hand-held items. The demo zoo
(150 guests, 6 staff, 51 animals) renders in ≈ 13 draw calls in the main pass
(+ shadow pass for the few batches with near instances).

A model whose object is NOT in the scene that contains `factory.root` (UI
thumbnails, tests) renders standalone: a classic `THREE.SkinnedMesh` built
lazily under `object` (RiggedModel.ensureStandalone, the old path). Switching
happens automatically on `added` / `removed` events.

## Data layout (crowd/skinning.ts)

Each SkinnedBatch owns an RGBA32F DataTexture `crData`; instance `id` owns
`crStride` texels starting at `id * crStride`:

```
[ look texels (crLook) | bone 0: row0 row1 row2 | bone 1 … ]
```

Bones are affine 3×4 skin matrices in model space (joint × inverse bind); the
world matrix is BatchedMesh's per-instance matrix. In GLSL (after
`patchCrowdVertex`): `crInst`, `crBase` (first texel of the instance),
`crTexel(i)`, and the blended rows `crR0..2`.

Look texels:

* animals (`ANIMAL_LOOK_TEXELS = 1`, crowd/materials.ts): texel 0 = (highlight,
  growth 0..1, free, free) → fragment `flat varying vec4 vCrLook0`; plus
  `flat varying vec2 vCrYaw` (instance yaw) — `normalMatrix` is redefined in the
  fragment shader as normalMatrix × instance rotation, so object-space
  micro-normals keep working.
* people (`HUMAN_LOOK_TEXELS = 6`, humans/material.ts writeHumanLook):
  skin / hair / shirt / pants / shoes / hat colours, sleeve / trouser / coat
  cut, girth, body id, highlight → `vHm0..5`.

## Extension points (for species / material work)

* **New uniform or shader code on the animal material**: just add it in
  `material/animalMaterial.ts`. The batched material is created BY
  `createAnimalMaterial` and only chained with the skinning patch
  (`batchedAnimalMaterials`), so uniforms, defines and varyings reach every
  batched and LOD mesh. Keep `#include <skinbase_vertex>`,
  `<skinnormal_vertex>`, `<skinning_vertex>`, `<emissivemap_fragment>` and the
  `void main() {` line of the fragment shader intact (the patch hooks them).
  If the fragment shader declares `uniform mat3 normalMatrix;` it gets the
  per-instance rotation automatically.
* **New per-vertex attribute** (coat baker): nothing to do. LOD meshes copy
  every attribute of level 0 (`lod/simplify.ts`), BatchedMesh requires all
  levels of a variant to share the attribute set — they do.
* **Per-instance value (e.g. a juvenile tint)**: growth is already there
  (`vCrLook0.y`, 0 = newborn … 1 = adult) — use it in the fragment shader. For
  more: bump `ANIMAL_LOOK_TEXELS`, write the values in
  `RiggedModel.writeLook()` (model.ts), read them in the `afterBase` string of
  `batchedAnimalMaterials` with `crTexel(crBase + k)` into another flat
  varying. Values that change per frame: write them in `syncFrame()` (called
  every frame for visible batched models, see highlight pulse).
* **Animal-specific shadow / LOD tuning**: `LOD_RATIOS` and the per-tier
  `POLICY` table in `lod/lod.ts`; `CrowdRenderer.shadowLodBias` (shadow casters
  use the coarsest level).
* **Thin parts that must survive LODs**: the simplifier never merges vertices
  whose normals point to different major axes, so plates (ears) and thin limbs
  flatten instead of vanishing; glossy (eye) vertices (`pattern.z > 0.9`) use a
  2.5× finer grid. Check `?species=x&lod=2` in the harness.

## Harness

```
harness/creatures.html?species=zebra&lod=2         force a LOD level
harness/creatures.html?humans=1&standalone=1        old per-model SkinnedMesh path (A/B)
harness/creatures.html?crowd=150                    150 people + herds over 120 m (draw calls / LOD stats)
```
