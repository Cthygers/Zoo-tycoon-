// Loading-screen steps for main.ts: capture the sky environment in a frame of
// its own, then compile and first-draw every shader program behind the loading
// screen, a few materials per frame.
//
// Drawing the whole scene once compiles every program in one go. Where shader
// compilation is synchronous (no KHR_parallel_shader_compile, e.g. software
// GL) or a driver compiles at the first draw, that blocks the main thread for
// many seconds and the loading screen freezes. Instead each frame shows only
// the objects that bring a few new materials, after compiling them (in
// parallel where the extension exists), so every task stays short.

import type * as THREE from 'three';
import type { IRenderContext } from './core/contracts';

/** New materials compiled and drawn per loading frame. */
const MATERIALS_PER_STEP = 3;

type Renderable = THREE.Mesh | THREE.Points | THREE.Line | THREE.Sprite;

function isRenderable(o: THREE.Object3D): o is Renderable {
  const r = o as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
  return !!(r.isMesh || r.isPoints || r.isLine || r.isSprite);
}

function materialsOf(o: Renderable): THREE.Material[] {
  const m = o.material;
  return Array.isArray(m) ? m : m ? [m] : [];
}

/** Renderables drawn this frame: visible together with all their ancestors. */
function drawnRenderables(scene: THREE.Object3D): Renderable[] {
  const drawn: Renderable[] = [];
  scene.traverseVisible((o) => {
    if (isRenderable(o)) drawn.push(o);
  });
  return drawn;
}

/**
 * Split `items` into consecutive steps that each bring at most `perStep`
 * materials no earlier item used (an item with more gets a step of its own;
 * items with nothing new join the current step). Pure; tested.
 */
export function planWarmupSteps<T, M>(items: readonly T[], materials: (item: T) => readonly M[], perStep: number): T[][] {
  const seen = new Set<M>();
  const steps: T[][] = [];
  let step: T[] = [];
  let fresh = 0;
  for (const item of items) {
    const added = new Set(materials(item).filter((m) => !seen.has(m)));
    if (fresh > 0 && fresh + added.size > perStep) {
      steps.push(step);
      step = [];
      fresh = 0;
    }
    step.push(item);
    for (const m of added) seen.add(m);
    fresh += added.size;
  }
  if (step.length) steps.push(step);
  return steps;
}

/**
 * Compile every material in the scene and draw what is visible right now (main
 * and shadow passes) a few materials per frame. Hidden objects (other LODs,
 * ghosts, off-screen litter …) are compiled but not drawn. Call after the
 * layers' per-frame updates and ctx.settle(), with the camera where play
 * starts; `nextFrame` resolves on the next animation frame.
 */
export async function warmUpShaders(
  ctx: IRenderContext,
  nextFrame: () => Promise<void>,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const { renderer, scene, camera } = ctx;
  const drawn = drawnRenderables(scene);
  const drawnSet = new Set<THREE.Object3D>(drawn);
  const hidden: Renderable[] = [];
  scene.traverse((o) => {
    if (isRenderable(o) && !drawnSet.has(o)) hidden.push(o);
  });
  const steps = planWarmupSteps([...drawn, ...hidden], materialsOf, MATERIALS_PER_STEP);

  for (const o of drawn) o.visible = false;
  try {
    // An empty frame first: unless main.ts already did (renderEmptyFrame) it
    // captures the sky's environment map, which the scene's materials compile
    // against (a long GPU job of its own).
    ctx.render();
    await nextFrame();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await Promise.all(step.map((o) => renderer.compileAsync(o, camera, scene)));
      const shown = step.filter((o) => drawnSet.has(o));
      if (shown.length > 0) {
        for (const o of shown) o.visible = true;
        // the low tier refreshes shadows every other frame: these casters need this one
        renderer.shadowMap.needsUpdate = true;
        ctx.render();
        for (const o of shown) o.visible = false;
        // let the GPU finish this group (and the loading screen animate) before the next
        await nextFrame();
      }
      onProgress?.((i + 1) / steps.length);
    }
  } finally {
    for (const o of drawn) o.visible = true;
  }
}

/**
 * Render a frame with nothing drawn: after a clock jump and ctx.settle() it
 * re-captures the sky environment (dozens of GPU passes) in a task of its own
 * instead of on top of the first full frame.
 */
export function renderEmptyFrame(ctx: IRenderContext): void {
  const drawn = drawnRenderables(ctx.scene);
  for (const o of drawn) o.visible = false;
  try {
    ctx.render();
  } finally {
    for (const o of drawn) o.visible = true;
  }
}
