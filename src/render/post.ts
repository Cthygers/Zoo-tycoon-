// Optional post-processing chain (medium/high): linear HDR render target with
// MSAA → GTAO (high only) → bloom (only while lamps glow at night) → subtle
// grade + vignette → OutputPass (ACES tone mapping + sRGB).

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { QualityLevel } from '../core/contracts';

const GradeShader = {
  name: 'WildhavenGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.28 },
    uSat: { value: 1.04 },
    uNight: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uSat;
    uniform float uNight;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // scotopic vision: colours fade and shift blue under moonlight
      vec3 col = mix(vec3(l) * vec3(0.9, 0.97, 1.12), c.rgb, mix(uSat, 0.6, uNight));
      // gentle split toning: cool shadows, warm highlights (scene-referred)
      float k = l / (l + 0.25);
      col *= mix(vec3(0.97, 0.99, 1.03), vec3(1.03, 1.0, 0.96), k);
      vec2 d = vUv - 0.5;
      float v = 1.0 - uVignette * smoothstep(0.2, 0.85, dot(d, d) * 2.2);
      gl_FragColor = vec4(col * v, c.a);
    }`,
};

/** Toggles object visibility between passes (keeps grass, sky, water out of the GTAO normal pass). */
class VisibilityPass extends Pass {
  constructor(
    private objects: () => THREE.Object3D[],
    private show: boolean,
    private saved: Map<THREE.Object3D, boolean>,
  ) {
    super();
    this.needsSwap = false;
  }
  render(): void {
    for (const o of this.objects()) {
      if (this.show) {
        o.visible = this.saved.get(o) ?? o.visible;
      } else {
        this.saved.set(o, o.visible);
        o.visible = false;
      }
    }
  }
}

export class PostFX {
  readonly composer: EffectComposer;
  private target: THREE.WebGLRenderTarget;
  private renderPass: RenderPass;
  private gtao: GTAOPass | null = null;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private output: OutputPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    level: QualityLevel,
    msaa: boolean,
    aoExcluded: () => THREE.Object3D[] = () => [],
  ) {
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
    if (level === 'high') {
      this.gtao = new GTAOPass(scene, camera, width, height);
      this.gtao.blendIntensity = 0.7;
      this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1, samples: 12 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      const saved = new Map<THREE.Object3D, boolean>();
      this.composer.addPass(new VisibilityPass(aoExcluded, false, saved));
      this.composer.addPass(this.gtao);
      this.composer.addPass(new VisibilityPass(aoExcluded, true, saved));
    }
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width / 2, height / 2), 0.35, 0.5, 1.6);
    this.bloom.enabled = false;
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
  }

  setNight(night: number): void {
    this.bloom.enabled = night > 0.15;
    this.bloom.strength = 0.25 + 0.35 * night;
    this.bloom.threshold = 1.3 - 0.5 * night;
    this.grade.uniforms.uNight.value = night;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.gtao?.dispose();
    this.bloom.dispose();
    this.grade.dispose();
    this.output.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
    this.target.dispose();
  }
}
