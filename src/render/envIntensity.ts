// Per-material strength of the scene's environment (PMREM sky) light.
//
// three.js ignores `material.envMapIntensity` for materials lit by
// `scene.environment`: it uploads `scene.environmentIntensity` instead, which
// the render context drives with the sky brightness through the day. A
// material passed to `useEnvMapIntensity` gets its image-based light (diffuse
// irradiance, specular and clearcoat radiance) multiplied by its own
// `envMapIntensity` on top of that, read live on every upload, so the usual
// three.js property just works: 0.6 for dense foliage that sees little open
// sky, 1.3 for polished metal.
//
// Standalone on purpose (depends on three only): other modules can import it
// without pulling in the render context.

import * as THREE from 'three';

const patched = new WeakSet<THREE.Material>();

/**
 * Make three.js honour `material.envMapIntensity` under `scene.environment`
 * (standard and physical materials).
 * Idempotent; chains an existing `onBeforeCompile` (and extends the program
 * cache key, so materials with different hooks never share a program). Call
 * it once per material, again on clones (`Material.copy` does not carry
 * hooks), before the material is first rendered.
 */
export function useEnvMapIntensity(material: THREE.MeshStandardMaterial): void {
  if (patched.has(material)) return;
  patched.add(material);
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  // the default key is the hook's source: keep keying on the original hook
  const baseKey =
    prevKey === THREE.Material.prototype.customProgramCacheKey ? () => prevCompile.toString() : () => prevKey.call(material);
  // an explicit material.envMap already gets envMapIntensity from three.js
  const scale: THREE.IUniform<number> = {
    get value() {
      return material.envMap ? 1 : material.envMapIntensity;
    },
    set value(_v: number) {
      /* derived from the material */
    },
  };
  material.onBeforeCompile = function (shader, renderer) {
    prevCompile.call(this, shader, renderer);
    shader.uniforms.envMapScale = scale;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float envMapScale;')
      .replace(
        '#include <lights_fragment_maps>',
        // (these accumulate nothing but the environment map's light)
        `#include <lights_fragment_maps>
        #if defined( RE_IndirectDiffuse )
          iblIrradiance *= envMapScale;
        #endif
        #if defined( RE_IndirectSpecular )
          radiance *= envMapScale;
          clearcoatRadiance *= envMapScale;
        #endif`,
      );
  };
  material.customProgramCacheKey = () => `${baseKey()}|envMapScale`;
  material.needsUpdate = true;
}
