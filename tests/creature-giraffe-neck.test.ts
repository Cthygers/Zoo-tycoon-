// A drinking giraffe reaches forward and down with its neck, the head hanging
// below the poll; it never folds the head back toward the chest into a hook
// beside the forelegs, neither while drinking nor while walking off. Lying,
// its folded lower legs shade down (the instance's lying amount, look texel w).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CreatureFactory } from '../src/models';
import type { QualitySettings } from '../src/core/contracts';
import type { RigRuntime, Pose } from '../src/models/rig/rig';
import type { RiggedModel } from '../src/models/model';
import { createAnimalMaterial } from '../src/models/material/animalMaterial';

const LOW: QualitySettings = {
  level: 'low', pixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 1024,
  grassDensity: 0, postFX: false, detailDistance: 40, creatureDetail: 0,
};
interface Rigged { rt: RigRuntime; out: Pose; asset: { roles: { neck: number[]; head: number; muzzle: THREE.Vector3 | null } } }

describe('giraffe neck', () => {
  it('stays forward through walk → drink → walk', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(LOW);
    await f.preload(['giraffe']);
    const mz = new THREE.Vector3();
    for (const sex of ['M', 'F'] as const) {
      for (const growth of [0.3, 1]) {
        for (const seed of [1, 2]) {
          const m = f.createAnimal('giraffe', { seed, sex, growth });
          const r = m as unknown as Rigged;
          const R = r.asset.roles;
          let lowest = Infinity;
          const check = (what: string) => {
            r.rt.fk(r.out);
            const base = r.rt.wp[R.neck[0]];
            const poll = r.rt.wp[R.head];
            r.rt.pointOn(R.head, R.muzzle!, mz);
            lowest = Math.min(lowest, mz.y);
            // the muzzle stays well ahead of the chest and never tucks back behind the poll
            expect(mz.z - base.z, what).toBeGreaterThan(0.6);
            expect(mz.z - poll.z, what).toBeGreaterThan(-0.15);
          };
          for (let t = 0; t < 2; t += 0.1) m.update(0.1, { action: 'walk', speed: 1.2, actionTime: t });
          for (let t = 0; t < 4; t += 0.1) {
            m.update(0.1, { action: 'drink', speed: 0, actionTime: t });
            check(`${sex} ${growth} drink ${t.toFixed(1)}`);
          }
          for (let t = 0; t < 2; t += 0.1) {
            m.update(0.1, { action: 'walk', speed: 1.2, actionTime: t });
            check(`${sex} ${growth} walk ${t.toFixed(1)}`);
          }
          // and the head still gets down to the water
          expect(lowest).toBeLessThan(growth < 1 ? 0.7 : 0.35);
          m.dispose();
        }
      }
    }
  });
});

describe('giraffe lying shade', () => {
  it('the lying amount (look texel w) follows the lie-down and get-up sequence', { timeout: 60_000 }, async () => {
    const f = new CreatureFactory(LOW);
    const scene = new THREE.Scene();
    scene.add(f.root);
    await f.preload(['giraffe']);
    const m = f.createAnimal('giraffe', { seed: 1, sex: 'F', growth: 1 });
    scene.add(m.object);
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    cam.position.set(0, 4, 12);
    cam.lookAt(0, 1, 0);
    cam.updateMatrixWorld();
    const lying = () => {
      const r = m as unknown as RiggedModel;
      return r.batch!.data[r.batch!.offset(r.slot) + 3];
    };
    const run = (action: string, s: number) => {
      for (let t = 0; t < s; t += 0.1) {
        m.update(0.1, { action, speed: action === 'walk' ? 1.2 : 0, actionTime: t });
        f.update(cam);
      }
    };
    run('walk', 1);
    expect(lying()).toBe(0);
    // kneeling on the way down (hips still high, cannons folded back under the
    // chest): the folded legs are shaded already, not only once the body is down
    const trace: number[] = [];
    for (let t = 0; t < 9; t += 0.1) {
      run('rest', 0.1);
      trace.push(lying());
    }
    expect(trace[0]).toBeLessThan(0.5);
    expect(trace[10]).toBeGreaterThan(0.9);
    expect(trace[trace.length - 1]).toBeGreaterThan(0.95);
    // rising hind-first, still on the carpi: still shaded; standing: none
    run('walk', 0.8);
    expect(lying()).toBeGreaterThan(0.9);
    run('walk', 6);
    expect(lying()).toBe(0);
    m.dispose();
  });

  it('shades only species that ask for it, below their knee line', () => {
    const src = THREE.ShaderLib.standard;
    const fs = (lieShade?: { amount: number; below: number }) => {
      const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms), defines: {} };
      createAnimalMaterial({ look: { skin: 'fur', lieShade }, detail: 1 }).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
      return shader;
    };
    expect(fs().fragmentShader).toContain('#define CR_LIE 0');
    const on = fs({ amount: 0.8, below: 1.2 });
    expect(on.fragmentShader).toContain('#define CR_LIE 1');
    expect(on.vertexShader).toContain('vCrLie = crTexel(crBase).w;');
    expect((on.uniforms.uLieShade.value as THREE.Vector2).toArray()).toEqual([0.8, 1.2]);
  });
});
