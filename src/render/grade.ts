// Global shader-chunk patches owned by the renderer:
//
//  - CustomToneMapping: a colour grade folded into the tone-mapping curve so
//    every tier gets it for free (no extra full-screen pass): a little
//    daylight veiling glare (DAY_FLARE), mesopic /
//    scotopic vision when the view is dark-adapted (high exposure → dim
//    parts lose colour and shift blue, reds darken — the Purkinje effect;
//    bright lamp-lit parts keep their colour), a touch of daylight
//    saturation and split toning, then three's ACES filmic curve. The
//    adaptation state is the exposure itself (≈1.8 at noon, 2.5–4 at golden
//    hour and sunset, 5–10 at blue hour, ≥ 12 under the moon), so no extra
//    uniform is needed.
//  - Lamp-lit mark (post-FX tier): real lamp light is tens of times brighter
//    than moonlight and seen in colour, but the game shows it only a few
//    times brighter (so lit paving keeps its texture), which is still in the
//    mesopic range. The night light pools therefore raise the HDR target's
//    alpha above 1 where they light the ground (props/lights/nightlights.ts),
//    and the OutputPass hands the excess to the grade (whLampLit, see
//    readLampMark), which drops the Purkinje shift there. Materials that
//    tone-map themselves (low / medium) leave whLampLit at 0; their pools
//    blend after the grade, in display space. Lamp-lit creatures and people
//    (props/lights/lampField.ts) set whLampLit themselves (WH_LAMP_LIT marks
//    the grade being present) or, on the post-FX tier, mark the alpha too.
//  - Directional shadow fade: shadows fade out over the outer few percent of
//    the (camera-fitted) shadow frustum instead of ending in a hard line.
//
// Patches are string replacements on THREE.ShaderChunk; if three changes a
// chunk so a pattern no longer matches, the patch is skipped (the game still
// renders, just without that refinement).

import * as THREE from 'three';

/** Exposure at which mesopic desaturation starts / is complete. */
export const MESOPIC_EXPOSURE = [4.5, 10.0] as const;
/**
 * Veiling glare in daylight (displayed units, ≈ 0.5 % of sunlit ground): lens
 * and eye scatter lift the deepest shade a little, where ACES's toe would
 * otherwise crush dark lawn and coats in shadow to black. Kept small: the
 * daylight fill (context.ts) already lifts shade, and more glare greys every
 * dark pixel into a milky veil. Fades out over FLARE_EXPOSURE (golden hour →
 * blue hour), so night keeps its blacks.
 */
export const DAY_FLARE = 0.0015;
export const FLARE_EXPOSURE = [3.5, 6.0] as const;

const CUSTOM_TM = /* glsl */ `#define WH_LAMP_LIT
float whLampLit = 0.0;
vec3 CustomToneMapping( vec3 color ) {
	float whEx = toneMappingExposure;
	// daylight veiling glare: lifts the deepest shade out of ACES's toe
	color += ${DAY_FLARE.toFixed(4)} * ( 1.0 - smoothstep( ${FLARE_EXPOSURE[0].toFixed(2)}, ${FLARE_EXPOSURE[1].toFixed(2)}, whEx ) ) / whEx;
	float whLum = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	float whDisp = whLum * whEx;
	// rods: peak sensitivity near 500 nm, blind to red; blue-shifted percept
	float whMeso = smoothstep( ${MESOPIC_EXPOSURE[0].toFixed(2)}, ${MESOPIC_EXPOSURE[1].toFixed(2)}, whEx ) * ( 1.0 - smoothstep( 0.06, 0.5, whDisp ) ) * ( 1.0 - smoothstep( 0.0, 0.4, whLampLit ) );
	float whRod = dot( color, vec3( 0.03, 0.55, 0.62 ) );
	color = mix( color, whRod * vec3( 0.6, 0.8, 1.28 ), whMeso * 0.82 );
	// daylight: slight saturation, cool shadows / warm highlights
	float whK = whDisp / ( whDisp + 0.3 );
	color = max( mix( vec3( whLum ), color, 1.06 ), 0.0 );
	color *= mix( vec3( 0.965, 0.99, 1.045 ), vec3( 1.035, 1.0, 0.96 ), whK );
	return ACESFilmicToneMapping( color );
}`;

const SHADOW_RETURN = 'return mix( 1.0, shadow, shadowIntensity );';
const SHADOW_FADE = `vec2 whEdge = min( shadowCoord.xy, 1.0 - shadowCoord.xy );
			return mix( 1.0, shadow, shadowIntensity * smoothstep( 0.0, 0.07, min( whEdge.x, whEdge.y ) ) );`;

let installed = false;

/** Install the chunk patches once (before any material compiles). */
export function installShaderPatches(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;

  const tm = chunks.tonemapping_pars_fragment;
  const stub = /vec3 CustomToneMapping\( vec3 color \) \{ return color; \}/;
  if (stub.test(tm)) chunks.tonemapping_pars_fragment = tm.replace(stub, CUSTOM_TM);

  // only the directional / spot getShadow variants (not getPointShadow)
  const sm = chunks.shadowmap_pars_fragment;
  const cut = sm.indexOf('getPointShadow');
  if (cut > 0) {
    const head = sm.slice(0, cut).split(SHADOW_RETURN).join(SHADOW_FADE);
    chunks.shadowmap_pars_fragment = head + sm.slice(cut);
  }
}

const OUTPUT_TM = 'gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );';

/**
 * Patch the OutputPass fragment shader to pass the lamp-lit mark (HDR alpha
 * above 1, see header) to the grade; its output alpha is reset to 1.
 */
export function readLampMark(outputFragment: string): string {
  return outputFragment.replace(
    OUTPUT_TM,
    `whLampLit = clamp( gl_FragColor.a - 1.0, 0.0, 1.0 );\n${OUTPUT_TM}\ngl_FragColor.a = 1.0;`,
  );
}

/** True when the custom grade is available (patch applied). */
export function customToneMappingAvailable(): boolean {
  return /whMeso/.test((THREE.ShaderChunk as unknown as Record<string, string>).tonemapping_pars_fragment);
}
