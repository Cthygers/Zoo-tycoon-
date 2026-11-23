// Post-processing chain (high tier only): linear HDR render target with MSAA
// → bloom (only while lamps glow at night) → OutputPass (tone mapping with
// the colour grade from grade.ts + sRGB). The target's alpha carries the
// lamp-lit mark to the grade (grade.ts), so bloom must leave it alone.
//
// Medium and low render straight into the canvas: on tile-based mobile GPUs a
// float MSAA target costs a full multisample resolve plus extra full-screen
// passes every frame, while the grade is free inside the tone-mapping curve.
// Screen-space AO was dropped: it needs a second full scene render (normal /
// depth pass) which doubles draw calls; ground AO comes from the procedural
// cavity maps and contact shadows instead.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { readLampMark } from './grade';

// Bloom works on the HDR target before exposure, and the night exposure is
// ≈15× the noon one: fixed HDR thresholds made whole lamp-lit walls bloom into
// a screen-sized blob. Threshold and ceiling are therefore set in displayed
// (post-exposure) units each frame, the bloom source is clipped to the
// ceiling, and the blur favours the small mips, so lamp heads and windows get
// a tight halo and no bright surface can flood the frame.
/** Displayed brightness where bloom starts (≈ white; no diffusely lit surface reaches it). */
const BLOOM_THRESHOLD = 1.6;
/** Displayed brightness above which a pixel adds no more bloom. */
const BLOOM_CEILING = 3.2;
/** Weights of the five blur mips (fine → coarse); the stock ramp is 1 … 0.2. */
const BLOOM_MIPS = [1.0, 0.55, 0.25, 0.1, 0.04];

const HIGH_PASS_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float luminosityThreshold;
uniform float smoothWidth;
uniform float uCeiling;
varying vec2 vUv;
void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  float v = luminance(texel.rgb);
  float k = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v) * min(1.0, uCeiling / max(v, 1e-6));
  gl_FragColor = vec4(texel.rgb * k, texel.a);
}
`;

export class PostFX {
  readonly composer: EffectComposer;
  private target: THREE.WebGLRenderTarget;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private output: OutputPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number, msaa: boolean) {
    const pr = renderer.getPixelRatio();
    this.target = new THREE.WebGLRenderTarget(Math.max(1, width * pr), Math.max(1, height * pr), {
      type: THREE.HalfFloatType,
      samples: msaa ? 4 : 0,
    });
    this.composer = new EffectComposer(renderer, this.target);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(width, height);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    // half-resolution bloom chain (thresholds set per frame in render())
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width / 2, height / 2), 0.3, 0, BLOOM_THRESHOLD);
    this.bloom.enabled = false;
    this.bloom.compositeMaterial.uniforms.bloomFactors.value = BLOOM_MIPS;
    const hp = this.bloom.materialHighPassFilter;
    hp.uniforms.uCeiling = { value: BLOOM_CEILING };
    hp.fragmentShader = HIGH_PASS_FRAG;
    // add the glow to the colour only: the alpha holds the lamp-lit mark
    const blend = this.bloom.blendMaterial;
    blend.blending = THREE.CustomBlending;
    blend.blendSrc = THREE.OneFactor;
    blend.blendDst = THREE.OneFactor;
    blend.blendSrcAlpha = THREE.ZeroFactor;
    blend.blendDstAlpha = THREE.OneFactor;
    this.composer.addPass(this.bloom);
    this.output = new OutputPass();
    this.output.material.fragmentShader = readLampMark(this.output.material.fragmentShader);
    this.composer.addPass(this.output);
  }

  setNight(night: number): void {
    this.bloom.enabled = night > 0.15;
    this.bloom.strength = 0.15 + 0.2 * night;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(dt: number): void {
    if (this.bloom.enabled) {
      const exposure = Math.max(this.composer.renderer.toneMappingExposure, 1e-3);
      this.bloom.threshold = BLOOM_THRESHOLD / exposure;
      this.bloom.materialHighPassFilter.uniforms.uCeiling.value = BLOOM_CEILING / exposure;
    }
    this.composer.render(dt);
  }

  dispose(): void {
    this.bloom.dispose();
    this.output.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
    this.target.dispose();
  }
}
