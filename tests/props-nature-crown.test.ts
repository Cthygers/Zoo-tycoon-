// Near-camera foliage fade (props/lod/fade.ts): tree crowns on the camera's
// view line go as a whole, card by card, never as half-transparent sheets.
// Every geometry drawn with the shared tree foliage material carries the
// crown attributes (BatchedMesh wants one attribute layout per batch).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { QualitySettings } from '../src/core/contracts';
import { PROP_SPECS } from '../src/props/registry';
import '../src/props/nature';
import { applyFade, fadeModeOf, updateFade, fadeUniforms, TREE_GONE, TREE_KEEP_R, TREE_SHADOW_R } from '../src/props/lod/fade';
import { windDepthMaterial } from '../src/props/wind';
import { addCrownFade, barkRanks, connectedPieces } from '../src/props/nature/geo';

const QUALITY: QualitySettings = { level: 'low', pixelRatio: 1, antialias: false, shadows: true, shadowMapSize: 1024, grassDensity: 0.25, postFX: false, detailDistance: 26, creatureDetail: 0 };

function compile(m: THREE.Material): { vertexShader: string; fragmentShader: string } {
  const src = THREE.ShaderLib.standard;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: {}, defines: {} };
  m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}

function compileDepth(m: THREE.Material): { vertexShader: string; fragmentShader: string } {
  const src = THREE.ShaderLib.depth;
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

  it('is on the bark that goes with a crown, ranked so limbs go before what they grow from', () => {
    for (const id of ['tree_acacia', 'tree_baobab', 'tree_oak', 'tree_pine', 'tree_birch', 'tree_palm', 'bamboo', 'bush_savanna']) {
      const spec = PROP_SPECS[id];
      for (const obj of [spec.build(0, QUALITY), spec.buildLod!(0, QUALITY)]) {
        const bark = meshes(obj).filter((m) => fadeModeOf(m.material as THREE.Material) === 'crownSolid');
        expect(bark.length, id).toBe(1);
        const g = bark[0].geometry;
        const c = g.getAttribute('aCrown') as THREE.BufferAttribute;
        expect(c?.count, id).toBe(g.getAttribute('position').count);
        expect(g.getAttribute('aCrownR')?.count, id).toBe(g.getAttribute('position').count);
        const pos = g.getAttribute('position');
        const piece = connectedPieces(g);
        // one rank per piece; the piece rooted nearest the trunk base ranks highest
        let root = 0;
        for (let i = 0; i < pos.count; i++) {
          expect(c.getW(i), id).toBe(c.getW(piece[i]));
          if (Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)) < Math.hypot(pos.getX(root), pos.getY(root), pos.getZ(root))) root = i;
        }
        for (let i = 0; i < pos.count; i++) expect(c.getW(i), id).toBeLessThanOrEqual(c.getW(root));
        // branching trees: the limbs are separate tubes and drop out one by one
        if (id !== 'tree_palm') expect(new Set(Array.from({ length: c.count }, (_, i) => c.getW(i))).size, id).toBeGreaterThan(1);
      }
    }
  }, 60000);

  it('ranks bark pieces by how far from the trunk base they start', () => {
    // a trunk from the base, a limb from 2 m up, a twig from 3 m up (separate tubes)
    const pos: number[] = [];
    const idx: number[] = [];
    for (const [y0, x1] of [[0, 0], [2, 1.5], [3, 2.5]]) {
      const b = pos.length / 3;
      pos.push(0.1, y0, 0, -0.1, y0, 0, x1, y0 + 1, 0);
      idx.push(b, b + 1, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const rank = barkRanks(g, connectedPieces(g));
    expect([rank.get(0), rank.get(3), rank.get(6)]).toEqual([247, 85, 0]);
  });

  it('gives a fallen log the oak bark material with neutral crown data, so they share a batch', () => {
    const logBark = meshes(PROP_SPECS.log_fallen.build(0, QUALITY)).filter((m) => m.name === 'bark');
    const oakBark = meshes(PROP_SPECS.tree_oak.build(0, QUALITY)).filter((m) => fadeModeOf(m.material as THREE.Material) === 'crownSolid');
    expect(logBark.length).toBe(1);
    expect(logBark[0].material).toBe(oakBark[0].material);
    const g = logBark[0].geometry;
    const layout = (geo: THREE.BufferGeometry) => Object.keys(geo.attributes).sort().map((k) => `${k}:${geo.getAttribute(k).itemSize}:${(geo.getAttribute(k) as THREE.BufferAttribute).array.constructor.name}`).join();
    expect(layout(g)).toBe(layout(oakBark[0].geometry));
    // no crown (radii 0: never cut as a tree) and one mid rank (switches at a fade of 0.5)
    const c = g.getAttribute('aCrown') as THREE.BufferAttribute;
    const r = g.getAttribute('aCrownR') as THREE.BufferAttribute;
    for (let i = 0; i < c.count; i += 7) {
      expect([r.getX(i), r.getY(i), c.getW(i)]).toEqual([0, 0, 128]);
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
    expect(crown.vertexShader).not.toContain('#define PROP_FADE_SOLID');

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
    expect(tb).toContain('#define PROP_FADE_CROWN');
    expect(tb).toContain('#define PROP_FADE_BARK');
    expect(crown.vertexShader).not.toContain('#define PROP_FADE_BARK');
    expect(tb).not.toContain('#define PROP_FADE_SOLID');
    expect(treeBark.customProgramCacheKey()).not.toBe(bark.customProgramCacheKey());
    // leaves and bark of a tree: one decision per instance (no per-vertex hole, lens or limb cut)
    for (const sh of [crown.vertexShader, tb]) {
      expect(sh).toContain('float tree = max( instF, propTreeF( M, uFadeCam + dir * max( tEnd, 0.0 ), grow ) * uFadeCrown * between );');
      // the crown thins by at most half over a wide band, then the tree goes whole
      expect(sh).toContain(`float fade = tree < ${TREE_GONE.toFixed(2)} ? 0.5 * smoothstep( 0.15, ${TREE_GONE.toFixed(2)}, tree ) : 1.0;`);
      // bark stays whole until the tree goes (no bare trunk or skeleton)
      expect(sh).toContain(`fade = step( ${TREE_GONE.toFixed(2)}, tree );`);
      expect(sh.indexOf('float propTreeF( mat4 M')).toBeGreaterThan(sh.indexOf('attribute vec2 aCrownR;'));
    }
  });

  it('keeps the tree the camera looks at and only removes trees clearly between camera and subject', () => {
    const leaf = new THREE.MeshStandardMaterial();
    leaf.userData.foliage = true;
    leaf.userData.crownFade = true;
    applyFade(leaf, 'crown');
    const sh = compile(leaf).vertexShader;
    // trunk within TREE_KEEP_R (3 m, 1 m band) of the focus: the subject's own tree, kept
    expect(sh).toContain(`smoothstep( ${TREE_KEEP_R.toFixed(1)}, ${(TREE_KEEP_R + 1).toFixed(1)}, length( o.xz - uFadeFocus.xz ) )`);
    // crown centre within TREE_KEEP_R of the line's end (at or beyond the subject): kept
    expect(sh).toContain(`( 1.0 - smoothstep( -0.04, 0.04, tc - 1.0 + ${TREE_KEEP_R.toFixed(1)} / len ) )`);
    expect(TREE_KEEP_R).toBeGreaterThanOrEqual(2);
    // a tree 6 m in front of the subject (through-tree views) is no longer the subject's own
    expect(TREE_KEEP_R + 1).toBeLessThan(6);
  });

  it("drops a removed tree's shadow near the camera only, and no other prop's", () => {
    const leaf = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    leaf.userData.foliage = true;
    leaf.userData.crownFade = true;
    leaf.userData.sway = 0.011;
    const depth = windDepthMaterial(leaf)!;
    const dsh = compileDepth(depth);
    expect(dsh.vertexShader).toContain('#define PROP_FADE_SHADOW');
    expect(dsh.vertexShader).toContain('#define PROP_FADE_CROWN');
    expect(dsh.vertexShader).toContain(`fade *= 1.0 - smoothstep( ${TREE_SHADOW_R.toFixed(1)}, ${(TREE_SHADOW_R + 4).toFixed(1)}, length( uFadeCam.xz - o.xz ) );`);
    // the wind sway is kept, and the fade runs on the swayed vertex
    expect(dsh.vertexShader.indexOf('windOffset( wO')).toBeLessThan(dsh.vertexShader.indexOf('vPropFade = propFadeAt('));
    expect(dsh.fragmentShader).toContain('if ( vPropFade > vPropRank ) discard;');
    expect(depth.customProgramCacheKey()).toBe('props-wind-depth|treeshadow-crown');
    // the visible pass never carries the shadow gate
    applyFade(leaf, 'crown');
    expect(compile(leaf).vertexShader).not.toContain('#define PROP_FADE_SHADOW');

    // other swaying props (bushes, reeds) keep plain swaying shadows
    const bush = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    bush.userData.foliage = true;
    bush.userData.sway = 0.065;
    const bd = windDepthMaterial(bush)!;
    expect(compileDepth(bd).vertexShader).not.toContain('propFadeAt');
    expect(bd.customProgramCacheKey()).toBe('props-wind-depth');
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
