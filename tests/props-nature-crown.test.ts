// Near-camera foliage fade (props/lod/fade.ts): tree crowns on the camera's
// view line go as a whole, card by card, never as half-transparent sheets.
// Every geometry drawn with the shared tree foliage material carries the
// crown attributes (BatchedMesh wants one attribute layout per batch).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { QualitySettings } from '../src/core/contracts';
import { PROP_SPECS } from '../src/props/registry';
import '../src/props/nature';
import { applyFade, fadeModeOf, updateFade, fadeUniforms } from '../src/props/lod/fade';
import { addCrownFade, connectedPieces } from '../src/props/nature/geo';

const QUALITY: QualitySettings = { level: 'low', pixelRatio: 1, antialias: false, shadows: true, shadowMapSize: 1024, grassDensity: 0.25, postFX: false, detailDistance: 26, creatureDetail: 0 };

function compile(m: THREE.Material): { vertexShader: string; fragmentShader: string } {
  const src = THREE.ShaderLib.standard;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: {}, defines: {} };
  m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => (c as THREE.Mesh).isMesh && out.push(c as THREE.Mesh));
  return out;
}

describe('tree crown dissolve data', () => {
  it('gives every card one rank and every vertex the crown ellipsoid (cm)', () => {
    // two separate quads
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 0, 0, 6, 0, 0, 6, 1, 0, 5, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    expect([...connectedPieces(g)]).toEqual([0, 0, 0, 0, 4, 4, 4, 4]);
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial();
    mat.userData.crownFade = true;
    group.add(new THREE.Mesh(g, mat));
    // meshes without the flag (rocks, ground litter in the same group) stay plain
    const plain = new THREE.Mesh(new THREE.BoxGeometry());
    group.add(plain);
    addCrownFade(group, { c: new THREE.Vector3(0.5, 6, -1), r: new THREE.Vector3(3, 1.5, 4) });
    const c = g.getAttribute('aCrown') as THREE.BufferAttribute;
    const r = g.getAttribute('aCrownR') as THREE.BufferAttribute;
    expect(c.array).toBeInstanceOf(Int16Array);
    expect([c.getX(5), c.getY(5), c.getZ(5)]).toEqual([50, 600, -100]);
    // horizontal radius = the larger of x / z, vertical separately
    expect([r.getX(0), r.getY(0)]).toEqual([400, 150]);
    for (let i = 1; i < 4; i++) expect(c.getW(i)).toBe(c.getW(0));
    for (let i = 5; i < 8; i++) expect(c.getW(i)).toBe(c.getW(4));
    expect(c.getW(0)).not.toBe(c.getW(4));
    expect(plain.geometry.getAttribute('aCrown')).toBeUndefined();
  });

  it('is on every geometry of the shared tree foliage material (full and distant builds)', () => {
    for (const id of ['tree_acacia', 'tree_baobab', 'tree_oak', 'tree_pine', 'tree_birch', 'tree_palm', 'bamboo', 'bush_savanna']) {
      const spec = PROP_SPECS[id];
      for (const obj of [spec.build(0, QUALITY), spec.buildLod!(0, QUALITY)]) {
        const leaves = meshes(obj).filter((m) => fadeModeOf(m.material as THREE.Material) === 'crown');
        expect(leaves.length, id).toBe(1);
        const g = leaves[0].geometry;
        expect(g.getAttribute('aCrown')?.count, id).toBe(g.getAttribute('position').count);
        expect(g.getAttribute('aCrownR')?.count, id).toBe(g.getAttribute('position').count);
      }
    }
  }, 60000);

  it('is on the bark that goes with a crown, with one rank per limb; a fallen log keeps plain bark', () => {
    for (const id of ['tree_acacia', 'tree_oak', 'tree_palm', 'bamboo', 'bush_savanna']) {
      const spec = PROP_SPECS[id];
      for (const obj of [spec.build(0, QUALITY), spec.buildLod!(0, QUALITY)]) {
        const bark = meshes(obj).filter((m) => fadeModeOf(m.material as THREE.Material) === 'crownSolid');
        expect(bark.length, id).toBe(1);
        const g = bark[0].geometry;
        const c = g.getAttribute('aCrown') as THREE.BufferAttribute;
        expect(c?.count, id).toBe(g.getAttribute('position').count);
        expect(g.getAttribute('aCrownR')?.count, id).toBe(g.getAttribute('position').count);
        // branching trees: the limbs are separate tubes and drop out one by one
        if (id !== 'tree_palm') expect(new Set(Array.from({ length: c.count }, (_, i) => c.getW(i))).size, id).toBeGreaterThan(1);
      }
    }
    const log = meshes(PROP_SPECS.log_fallen.build(0, QUALITY));
    for (const m of log) {
      expect(fadeModeOf(m.material as THREE.Material)).not.toBe('crownSolid');
      expect(m.geometry.getAttribute('aCrown')).toBeUndefined();
    }
  }, 60000);
});

describe('near-camera fade shader', () => {
  it('drops whole fragments by the card rank (no partial coverage or dither) and cuts limbs, not trunks', () => {
    const leaf = new THREE.MeshStandardMaterial();
    leaf.userData.foliage = true;
    leaf.userData.crownFade = true;
    expect(fadeModeOf(leaf)).toBe('crown');
    applyFade(leaf, 'crown');
    const crown = compile(leaf);
    expect(crown.vertexShader).toContain('#define PROP_FADE_CROWN');
    expect(crown.vertexShader).toContain('attribute vec4 aCrown;');
    expect(crown.fragmentShader).toContain('if ( vPropFade > vPropRank ) discard;');
    expect(crown.fragmentShader).not.toMatch(/diffuseColor\.a \*=|FD_BAYER/);

    const bark = new THREE.MeshStandardMaterial();
    bark.userData.fadeNear = true;
    applyFade(bark, fadeModeOf(bark)!);
    const solid = compile(bark).vertexShader;
    expect(solid).toContain('#define PROP_FADE_SOLID');
    // the view hole reaches solid parts only above the trunk (LIMB_Y = 2.5 m) and off its axis
    expect(solid).toMatch(/float limb = smoothstep\( 2\.30, 2\.70, p\.y - o\.y \) \* smoothstep\( PROP_TRUNK_R/);
    expect(solid).toContain('#define PROP_TRUNK_R 0.90');
    expect(solid).not.toContain('#define PROP_FADE_CROWN');

    // a tree's bark: the solid terms, and the whole tree goes with its crown
    const treeBark = new THREE.MeshStandardMaterial();
    treeBark.userData.fadeNear = true;
    treeBark.userData.crownFade = true;
    expect(fadeModeOf(treeBark)).toBe('crownSolid');
    applyFade(treeBark, 'crownSolid');
    const tb = compile(treeBark).vertexShader;
    expect(tb).toContain('#define PROP_FADE_SOLID');
    expect(tb).toContain('#define PROP_FADE_CROWN');
    expect(tb).toContain('f = max( f, propCrownF( M, uFadeCam + dir * max( tEnd, 0.0 ) ) );');
    expect(treeBark.customProgramCacheKey()).not.toBe(bark.customProgramCacheKey());
  });

  it('removes whole crowns only in close views', () => {
    const cam = new THREE.Vector3(0, 4, 10);
    updateFade(cam, new THREE.Vector3(0, 0, 0), true);
    expect(fadeUniforms.uFadeCrown.value).toBe(1);
    updateFade(new THREE.Vector3(0, 30, 30), new THREE.Vector3(0, 0, 0), true);
    expect(fadeUniforms.uFadeCrown.value).toBe(0);
    updateFade(cam, new THREE.Vector3(0, 0, 0), false);
    expect(fadeUniforms.uFadeCrown.value).toBe(0);
  });
});
