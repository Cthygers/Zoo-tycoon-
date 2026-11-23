// Post-processing chain (high tier only): linear HDR render target with MSAA
// → bloom (only while lamps glow at night) → OutputPass (tone mapping with
// the colour grade from grade.ts + sRGB).
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
    // half-resolution bloom chain
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width / 2, height / 2), 0.35, 0.5, 1.6);
    this.bloom.enabled = false;
    this.composer.addPass(this.bloom);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
  }

  setNight(night: number): void {
    this.bloom.enabled = night > 0.15;
    this.bloom.strength = 0.25 + 0.35 * night;
    this.bloom.threshold = 1.3 - 0.5 * night;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(dt: number): void {
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
