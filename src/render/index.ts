// Rendering core public API.
//
//   createRenderContext(container, world, events, level) → IRenderContext
//   detectQuality()                                      → QualityLevel
//   qualitySettings(level)                               → QualitySettings
//
// The context owns the WebGL2 renderer, camera, sky / time of day, sun & moon
// lighting with shadows, PMREM environment, terrain (+ decorative outer
// landscape), water, boardwalk decks, grass and post-processing.

import type { IRenderContext, QualityLevel } from '../core/contracts';
import type { EventBus } from '../core/events';
import type { World } from '../core/world';
import { RenderContext } from './context';

export { detectQuality, qualitySettings } from './quality';
export { RenderContext } from './context';
/** Re-exported for compatibility; the source of truth is core/constants. */
export { DECK_Y } from '../core/constants';

/**
 * Create the renderer and the natural environment. Resolves once the
 * procedural textures and the first sky / environment map are ready.
 */
export async function createRenderContext(
  container: HTMLElement,
  world: World,
  events: EventBus,
  level: QualityLevel,
): Promise<IRenderContext> {
  const ctx = new RenderContext(container, world, events, level);
  // Let the browser breathe once (loading screen can update), then warm up
  // shaders so the first real frame does not hitch.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    await ctx.renderer.compileAsync(ctx.scene, ctx.camera);
  } catch {
    /* compileAsync is an optimisation only */
  }
  return ctx;
}
