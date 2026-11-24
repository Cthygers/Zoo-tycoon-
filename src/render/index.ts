// Rendering core public API.
//
//   createRenderContext(container, world, events, level) → RenderContext (an IRenderContext)
//   detectQuality()                                      → QualityLevel
//   qualitySettings(level)                               → QualitySettings
//   useEnvMapIntensity(material)  (envIntensity.ts)      → honour envMapIntensity
//
// The context owns the WebGL2 renderer, camera, sky / time of day, sun & moon
// lighting with shadows, PMREM environment, terrain (+ decorative outer
// landscape), water, boardwalk decks, grass and post-processing.

import type { QualityLevel } from '../core/contracts';
import type { EventBus } from '../core/events';
import type { World } from '../core/world';
import { RenderContext } from './context';

export { detectQuality, qualitySettings } from './quality';
export { RenderContext } from './context';
export { useEnvMapIntensity } from './envIntensity';
/** Re-exported for compatibility; the source of truth is core/constants. */
export { DECK_Y } from '../core/constants';

/**
 * Create the renderer and the natural environment. Resolves once the
 * procedural textures are ready. The result is the full RenderContext so the
 * loading screen can use its extras (holdEnvironment).
 */
export async function createRenderContext(
  container: HTMLElement,
  world: World,
  events: EventBus,
  level: QualityLevel,
): Promise<RenderContext> {
  const ctx = new RenderContext(container, world, events, level);
  // Let the browser breathe once (loading screen can update), then render the
  // procedural textures in small passes. Shaders are compiled later, once the
  // environment map exists (main.ts warm-up): lit materials compiled before it
  // would be compiled again with it.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await ctx.prepare();
  return ctx;
}
