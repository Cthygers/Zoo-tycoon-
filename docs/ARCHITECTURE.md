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
| `src/audio` | `IAudio` | procedural WebAudio ambience, animal calls, UI cues (no audio files); `harness/audio.html` renders and analyses every sound |
| `src/net` | `CloudHandle` (`src/core/cloud-types.ts`) | offline-first cloud saves: `LocalStore`, sign-in, players, the sync engine (epoch + CAS, lease), versus outbox. Disabled (zero network) without `VITE_API_BASE` |
| `src/versus` | `VersusController` | a versus match on this device: boot, countdown, real-time budget, snapshot outbox, opponent, end |
| `src/ui/tutorial`, `src/ui/account`, `src/ui/versus` | `UIExtension` (`src/core/ui-ext.ts`) | in-game feature plug-ins mounted by the game UI (see "UI extensions") |
| `shared/` | — | pure TS used by the app **and** the server: `api-types` (every request/response), `versus-rules`, `names`, `limits`, `wordlist` |
| `server/` | — | the Wildhaven API (Fastify 5 + `node:sqlite`, Docker): Google sign-in, players, cloud saves, versus. See `server/README.md` |
| `src/main.ts` | — | boot intent → title menu → open the slot → loading screen, wiring, main loop, autosave, one hide/show lifecycle, `switchSlot` |

Modules communicate only through `src/core/contracts.ts`, the shared types in
`src/core/types.ts`, the `EventBus` (`src/core/events.ts`) and the read API of `World`.

## Accounts, cloud saves, versus and the tutorial (feature round 14)

The design is `scratchpad/features14/spec.md` (decisions) and `api.md` (the HTTP contract); this is
the map of how the pieces connect.

**Ground rule.** A build without `VITE_API_BASE` behaves exactly as before: `createCloud()` returns a
disabled handle, the guest zoo stays plain JSON in `wildhaven-save-v1`, no `wh2:*` key is written and
nothing touches the network (checked by e2e E2E-6). The tutorial is the only new feature there.

**Storage keys** all come from `src/core/storage-keys.ts` (`KEYS`, `slotKey`, `parseSlotKey`). A zoo
lives in a *slot* `<player>/<slot>`: player `guest` or a profile id; slot `main`, `practice` or
`vs-<matchId>`. The guest's slots are the plain-JSON keys (`wildhaven-save-v1`,
`wildhaven-practice-v1`); a profile's are `wh2:slot:<pid>/<slot>` records (gzip+base64, `seq`,
`base`, push ring). Only a profile's `main` slot is synced; `practice` and `vs-*` are local-only.
Per-player state (`src/core/player-state.ts`): the tutorial status (`wildhaven-tutorial` /
`wh2:p:<pid>:tutorial`, mirrored to the server's `profile.prefs.tutorial`) and the active slot.

**`src/net`** (`createCloud`, `src/net/index.ts`): `LocalStore` (`storage.ts`: every save goes
through `write`, the quota purge order, guest adoption, backups, a *fence* that ignores a running
zoo's writes once the slot's content was replaced under it), `AuthManager` (one opaque `whs_`
session; 401 → `needs-signin`, play goes on), `ProfileService` (cached list in `wh2:index`, works
offline), `SyncEngine` (`sync.ts`: server `{epoch, rev}` compare-and-swap, never device clocks; the
divergence rule by unique play time; whatever loses is kept as a local backup and a server stash or
pin; a 150 s lease so one device plays a zoo at a time), `VersusApi` + a per-account, per-match
outbox. `FakeCloud` (`fakeCloud.ts`) is an in-memory model of the server used by every net unit
test; `server/test/contract.test.ts` runs one scenario list against it and against the real app
(through `HttpCloudApi` + `injectFetch`) and fails on any difference.

**Boot and switching** (`src/main.ts`, spec §7):
1. `consumeBootIntent()` reads and removes `sessionStorage['wildhaven-boot']`.
2. `createCloud(...).init()` (local only), `createSyncPrompts` (account-ui dialogs, also usable over
   the loading screen), `window.__cloud`.
3. The title menu (`showMainMenu`, `src/ui/screens.ts`) resolves a `MenuResult {kind, player, slot,
   matchId?, startTutorial?, discard?}` — skipped for `?demo`/`?soak` and for a non-menu boot intent.
4. `discard`, `setLast`, `writeActiveSlot`; `continue` (and `new` on a profile's main slot) runs
   `cloud.sync.openSlot` before loading: lease (takeover prompt), head check, pull or the conflict
   dialog; `cancelled`/`blocked` go back to the menu.
5. A load failure keeps the old save through `cloud.local.markUnreadable` (guest: the same
   `-unreadable` keys as before; profile: `wh2:bad`, and the next push pins the cloud copy) and
   `mayWriteSave`.
6. Versus: `createVersusController` + `ctrl.boot(sim)` (loads the `vs-` slot or starts the match's
   zoo); a `VersusBootError` shows its text with a Back button. `?demo/?seed/?time/?paused` are
   ignored in a match; the sky re-captures at most every 20 s (`ctx.setEnvCaptureFloor(20, false)`).
7. `createGameUI(..., { player, switchSlot, extensions: [tutorial, account (cloud builds), versus
   (in a match)] })`; after the loading screen, `versusCtrl.startCountdown()`.

`switchSlot(target: BootIntent)` is the only way to change zoo: `save()` → `cloud.sync.onLeave`
(push + lease release, ≤ 3 s; in a match the versus keepalive instead) → write the boot intent →
`location.reload()`. Switch player, sign-in/out, practice ↔ main, pulled-newer, lease lost, profile
gone, the family hand-off and leaving a match all use it.

**Saving and play time.** `save()` = `cloud.local.write(key, JSON, metaFromSim(sim, playSeconds))`
then `cloud.sync.noteSaved(key)` (never in a match: `vs-*` slots go up only with the match's finish).
`playSeconds` is cumulative per slot (never reset, not even by New zoo): real foreground seconds
while the clock runs — the "unique play" that decides between two zoos.

**Frame loop additions** (§7.4): `simDt = versusCtrl ? versusCtrl.frameDt(raw) : min(0.1, raw)`, held
at 0 while `holdUntil` (the ≤ 2 s resume check, an open lease-lost choice); the UI, views and camera
always get real `dt`. Then `versusCtrl.update(raw)`, the soak recorder, the play-time clock, and the
autosave (90 s, or `versusCtrl.wantsSave()` in a match). A match and `?soak` run at ≤ 30 fps.

**Lifecycle** (§7.5): one `onHidden` (visibilitychange → hidden, `pagehide`, Capacitor `pause`):
`save()` → versus keepalive → save-push keepalive within `KEEPALIVE_BUDGET` (64 KiB) + lease release
→ stop speech → stop the loop, `audio.suspend()`. One `onVisible` (visibilitychange → visible,
Capacitor `resume`): restart the loop; in a match `versusCtrl.onVisible()` (budget check, 3-2-1
countdown); a signed-in main zoo hidden > 60 s holds the clock ≤ 2 s for `cloud.sync.onVisible`.
Sync events stay subscribed for the session: `leaseLost` → hold + `prompts.chooseLeaseLost` (a notice
up to 120 s of local play, else the two-card choice) → `resolveLeaseLost`; `pulledNewer` → toast +
reload; `profileGone` → notice + menu. The account extension handles `conflict` (badge → dialog).

**UI extensions.** `src/ui/index.ts` (`GameUI`) *is* the `UIExtensionHost` (`src/core/ui-ext.ts`):
`createGameUI` mounts `deps.extensions` in order; `ui.ext` / `ui.addExtension()` exist at runtime
(e2e). Extensions get `update(dt)` every frame after the shell; `handleBack` is asked after dialogs
and before panels (last-mounted first); `onKey` before the shell's keys. They reach the game only
through the host: HUD slots (`hudSlot('speed')` replaces the speed group while it has children,
`hudSlot('badge')` sits left of the menu button), Settings sections, `showDialog`, `runCommand`,
`cameraDemo`, gesture summaries, reserved rects (toasts and the camera's clear area avoid them),
`.wh-pill-off` on the root hides the goal pill. Every speed change goes through `SpeedControl`
(`src/ui/hud.ts`): in a versus match every source is refused and the speed group is not built; a
`SpeedLock` (the tutorial holding the clock) refuses everything but `'ext'`. The old coach-mark tour
is gone: `coach.ts` is the goal pill (and its tutorial step form). `src/ui/avatars.ts`
(`avatarSvg`, `AVATAR_COLOR_HEX`) draws the 10 animals × 8 colours for players and seats.
- `src/ui/tutorial/` — the tutorial (script, machine, phase, facts, plot, place, overlay, ground,
  speech, help, profile, index): 12 chapters of one-action steps, yellow ground markers, Help me,
  read-aloud, practice zoo. Automation: `window.__tutorial` in dev builds or with `?tutdebug`
  (`view()`, `debugJump(step)`, `debugFinish()`, `hintInfo()`, `debugLayout()`);
  `node scripts/tutorial-e2e.cjs <url> <out> [--wired] [--scenario=…]` drives it by real touch.
- `src/ui/account/` — `menuModel` (the pure title-menu model), the account layer (z-index 150 above
  the menu and loading screens, its own modal/page stack, `menuHandleBack()` for Android back in the
  menu), the pages (sign-in, first player, "Whose zoo is this?", "Who's playing?", Manage players,
  Backups), the grown-up check, `createSyncPrompts` and `createAccountExtension` (cloud badge,
  Settings › Account section order 10, conflict badge → `resolveConflict` → `switchSlot`).
- `src/ui/versus/` — the Versus hub (menu) and the in-match extension (the two-line chip in the
  speed slot, breakdown sheet, countdown, "Give up this match", results with podium and crown).
  Dev builds expose `window.__versusDebug` (`skipHours`, `addWallMs`, `state`).

**Debug globals:** `window.__game` = `{sim, ctx, props, creatures, views, events, save, ui, audio,
cloud, versus, switchSlot, menu, player, activeKey, playSeconds()}`; `window.__cloud` from the title
menu on.

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
* People stand on `world.walkHeightAt(x, z)` (boardwalk decks at `DECK_Y` over water);
  animals use `world.heightAt`. Swimming animals have their origin at `WATER_LEVEL`.
* Models from `IPropsLayer.createObjectModel` / `createFenceSegmentModel` share geometry with
  the layer: callers dispose only `object.userData.ownedMaterials`.
* `CommandResult.cost` is negative for refunds (booked as income); `warning` on a successful or dry-run result flags an outcome the player probably doesn't want (e.g. fences that won't make a habitat, removing a fence that opens a habitat, an animal put in a habitat that is unsafe or poor for it); `severity: 'confirm'` marks a warning serious enough that the UI asks before going ahead (a dialog for bulldoze and animal moves/adoptions, 'Paint anyway' in amber for terrain that floods non-swimmers), and `shortWarning` (adoptions and moves that ask) is its text cut down for the confirm bar while the dialog shows it in full; `cutsEntrance` on a bulldoze result means the removal cuts the entrance off from every exhibit, which closes the gate until it is reconnected; `reason` on a successful result is an informational note.
* Per frame order (main.ts): sim.update → ctx.setTimeOfDay → ui.update → views.update →
  creatures.update(camera) → props.update → audio.update → ctx.update → ctx.render.
* Draw order around water (`renderOrder`): the terrain and the near outer ring draw at −2, the
  pond murk layers (depth-only copies of the water surface, `src/render/water.ts`) at −1,
  creatures and props at 0 and the water surface at 10. The murk layers hide whatever stands more
  than ~20 cm under water (wading legs fade out), so any solid mesh that must stay visible
  deeper than ~20 cm under water needs a `renderOrder` below −1.

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

* Full game: `npx vite --port <port> --strictPort`, then
  `node scripts/gameshots.cjs "http://localhost:<port>/index.html?demo=1&time=11:00&q=low" /tmp/.../x '[{"name":"a","x":44,"z":95,"d":45,"yaw":200,"pitch":35}]'`
  (`?demo` builds a showcase zoo; views can target `"species":"zebra"`, set `"time":"21:30"`,
  run `"eval":"js"`; it prints draw calls / triangles per shot). `window.__game` exposes
  `{sim, ctx, props, creatures, views, ui, audio, events}`.

* `npx tsc --noEmit` — typecheck (only your files' errors are yours while other modules are WIP).
* `npx vitest run` — unit tests in `tests/`. `cd server && npm test` — the server suites and the
  contract test (`server/test/contract.test.ts`, FakeCloud vs the real app).
* `node scripts/e2e/run.mjs [--only=E2E-1,E2E-5]` — the end-to-end scenarios (spec §10.2): starts the
  fake Google issuer (:8799), the built server on a temp DB (:8787, `LEASE_SECONDS=20`,
  `VERSUS_TEST_LENGTH=1`) and Vite (:5199, `VITE_API_BASE`, `VITE_FAKE_GOOGLE_URL`, private
  cacheDir), drives two or three Chromium contexts as phones (`?fakeSub=` picks the Google user) and
  stops every process it started. E2E-6 first builds and serves a production bundle without any
  `VITE_*` variable. Screenshots and `e2e-report.json` go to `--out`.
* Visual check: create `harness/<module>.html` + `harness/<module>.ts` that renders your module in
  isolation, run `npx vite --port <unique port>` in the background, then
  `node scripts/shot.cjs http://localhost:<port>/harness/<module>.html out.png --wait=6000`
  and look at the PNG (use the Read tool on it). Headless Chromium renders WebGL2 via SwiftShader
  (slow but correct). Kill your vite server when done.
