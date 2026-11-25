// Near-camera foliage fade (props/lod/fade.ts): tree crowns on the camera's
// view line go as a whole, card by card, never as half-transparent sheets.
// Every geometry drawn with the shared tree foliage material carries the
// crown attributes (BatchedMesh wants one attribute layout per batch).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { QualitySettings } from '../src/core/contracts';
import { PROP_SPECS } from '../src/props/registry';
import '../src/props/nature';
import { applyFade, applyOccluderCut, BIG_TRUNK_R, casterDepthMaterial, fadeModeOf, updateFade, fadeUniforms, FOLLOW_CARD_R, FOLLOW_CARD_R_MAX, FOLLOW_CUT_D, OCCLUDER_BELOW, OCCLUDER_D, OCCLUDER_FADE_S, OCCLUDER_OFF_D, OCCLUDER_R, OCCLUDER_SHARE, OCCLUDER_SIDE, setFollowCut, setOcclTop, TREE_GONE, TREE_KEEP_R, TREE_SHADOW_R } from '../src/props/lod/fade';
import { windDepthMaterial } from '../src/props/wind';
import { addCrownFade, barkRanks, connectedPieces, trunkRadius } from '../src/props/nature/geo';
import { buildAcacia, buildBamboo, buildBaobab } from '../src/props/nature/trees';

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
    // horizontal radius = the larger of x / z, vertical separately; no bark here: no trunk
    expect([r.getX(0), r.getY(0), r.getZ(0)]).toEqual([400, 150, 0]);
    for (let i = 1; i < 4; i++) expect(c.getW(i)).toBe(c.getW(0));
    for (let i = 5; i < 8; i++) expect(c.getW(i)).toBe(c.getW(4));
    expect(c.getW(0)).not.toBe(c.getW(4));
    expect(plain.geometry.getAttribute('aCrown')).toBeUndefined();
    // every vertex of a leaf card carries the card's centre (cm): the follow cut drops whole cards
    const card = g.getAttribute('aCard') as THREE.BufferAttribute;
    expect(card.array).toBeInstanceOf(Int16Array);
    for (let i = 0; i < 4; i++) expect([card.getX(i), card.getY(i), card.getZ(i)]).toEqual([50, 50, 0]);
    for (let i = 4; i < 8; i++) expect([card.getX(i), card.getY(i), card.getZ(i)]).toEqual([550, 50, 0]);
  });

  it('gives leaves card centres but not bark', () => {
    const spec = PROP_SPECS.tree_acacia;
    for (const obj of [spec.build(0, QUALITY), spec.buildLod!(0, QUALITY)]) {
      for (const m of meshes(obj)) {
        const mode = fadeModeOf(m.material as THREE.Material);
        if (mode === 'crown') expect(m.geometry.getAttribute('aCard')?.count).toBe(m.geometry.getAttribute('position').count);
        if (mode === 'crownSolid') expect(m.geometry.getAttribute('aCard')).toBeUndefined();
      }
    }
  }, 30000);

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
      // while following, at every zoom, crowns grow by the follow cut's small margin only (no thinned neighbours)
      expect(sh).toContain('float hit = propTreeF( M, uFadeCam + dir * max( tEnd, 0.0 ), mix( grow, 0.50, uFadeFollow ) ) * between;');
      expect(sh).toContain('float fade = propTreeFade( max( instF, hit * uFadeCrown ) );');
      // the crown thins by at most half over a wide band, then the tree goes whole
      expect(sh).toContain(`return tree < ${TREE_GONE.toFixed(2)} ? 0.5 * smoothstep( 0.15, ${TREE_GONE.toFixed(2)}, tree ) : 1.0;`);
      // bark stays whole until the tree goes (no bare trunk or skeleton)
      expect(sh).toContain(`return step( ${TREE_GONE.toFixed(2)}, tree );`);
      expect(sh.indexOf('float propTreeF( mat4 M')).toBeGreaterThan(sh.indexOf('attribute vec3 aCrownR;'));
    }
    expect(tb).toContain('#define PROP_FADE_BARK');
    expect(crown.vertexShader.indexOf('#define PROP_FADE_BARK')).toBe(-1);
  });

  it('keeps the tree the camera looks at and only removes trees clearly between camera and subject', () => {
    const leaf = new THREE.MeshStandardMaterial();
    leaf.userData.foliage = true;
    leaf.userData.crownFade = true;
    applyFade(leaf, 'crown');
    const sh = compile(leaf).vertexShader;
    // trunk within TREE_KEEP_R (3 m; 1 m band, 2 m while following) of the focus: the subject's own tree, kept
    expect(sh).toContain(`smoothstep( ${TREE_KEEP_R.toFixed(1)}, ${(TREE_KEEP_R + 1).toFixed(1)} + uFadeFollow, length( o.xz - uFadeFocus.xz ) )`);
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

  it('cuts crowns on the camera → subject line while following, up to FOLLOW_CUT_D, unless the line only grazes their top', () => {
    const leaf = new THREE.MeshStandardMaterial();
    leaf.userData.foliage = true;
    leaf.userData.crownFade = true;
    applyFade(leaf, 'crown');
    const sh = compile(leaf).vertexShader;
    // trees run the fade while following even where the free-camera hole is gone (beyond ~42 m)
    expect(sh).toContain('#define PROP_FADE_ON ( uFadeParams.w > 0.0 || uFadeFollow > 0.0 )');
    // the follow term: the same per-tree hit (keep rules included) anywhere on the line, except where
    // the line passes half a metre or more over the crown's top (the grown crown's margin alone)
    expect(sh).toContain('float lineY = uFadeCam.y + dir.y * clamp( tc, 0.0, 1.0 ) * len;');
    expect(sh).toContain('float crownTop = cw.y + aCrownR.y * 0.01 * length( M[ 1 ].xyz );');
    expect(sh).toContain('float under = 1.0 - smoothstep( crownTop + 0.30, crownTop + 0.70, lineY );');
    expect(sh).toContain('fade = max( fade, propTreeFade( hit * uFadeFollow * under ) );');
    expect(sh).not.toMatch(/smoothstep\( 0\.35, 0\.45/);
    // other foliage and solid parts keep the free-camera gate
    const fern = new THREE.MeshStandardMaterial();
    fern.userData.foliage = true;
    applyFade(fern, 'foliage');
    expect(compile(fern).vertexShader).toContain('#define PROP_FADE_ON uFadeParams.w > 0.0');

    // a followed tree's shadow goes with it at any distance (after the near-camera shadow limit)
    const depth = windDepthMaterial(Object.assign(new THREE.MeshStandardMaterial({ alphaTest: 0.5 }), { userData: { foliage: true, crownFade: true, sway: 0.011 } }))!;
    const dv = compileDepth(depth).vertexShader;
    expect(dv.indexOf('fade *= 1.0 - smoothstep( 12.0')).toBeLessThan(dv.indexOf('fade = max( fade, propTreeFade( hit * uFadeFollow'));

    const subject = new THREE.Vector3(0, 0, 0);
    const camAt = (d: number) => new THREE.Vector3(0, d * 0.5, d * 0.866);
    try {
      // free camera: no follow cut at any distance
      for (const d of [8, 30, 44]) {
        updateFade(camAt(d), subject, true);
        expect(fadeUniforms.uFadeFollow.value).toBe(0);
        expect(fadeUniforms.uFadeOccl.value).toBe(0);
      }
      setFollowCut(subject);
      updateFade(camAt(34), subject, true);
      expect(fadeUniforms.uFadeFollow.value).toBe(1);
      expect(fadeUniforms.uFadeCrown.value).toBe(0);
      updateFade(camAt(FOLLOW_CUT_D - 1), subject, true);
      expect(fadeUniforms.uFadeFollow.value).toBe(1);
      // past the free-camera range the line still tracks the camera
      expect(fadeUniforms.uFadeParams.value.w).toBe(0);
      expect(fadeUniforms.uFadeCam.value.distanceTo(camAt(FOLLOW_CUT_D - 1))).toBeLessThan(1e-6);
      updateFade(camAt(FOLLOW_CUT_D + 4), subject, true);
      expect(fadeUniforms.uFadeFollow.value).toBe(0);
      // the fade tier switch turns it off too
      updateFade(camAt(30), subject, false);
      expect(fadeUniforms.uFadeFollow.value).toBe(0);
    } finally {
      setFollowCut(null);
    }
  });

  it('hands the follow cuts back over FOLLOW_RELEASE_S when following ends (no pop)', () => {
    const cam = new THREE.Vector3(0, 6, 8);
    const subject = new THREE.Vector3(0, 0, 0);
    try {
      setFollowCut(subject, 0.016);
      updateFade(cam, subject, true);
      expect(fadeUniforms.uFadeFollow.value).toBe(1);
      setFollowCut(null, 0.3);
      updateFade(cam, subject, true);
      expect(fadeUniforms.uFadeFollow.value).toBeCloseTo(0.5, 5);
      expect(fadeUniforms.uFadeOccl.value).toBeCloseTo(0.5, 5);
      setFollowCut(null, 0.3);
      updateFade(cam, subject, true);
      expect(fadeUniforms.uFadeFollow.value).toBe(0);
      expect(fadeUniforms.uFadeOccl.value).toBe(0);
    } finally {
      setFollowCut(null);
    }
  });

  it('aims the cuts at the followed subject, not at the ground point at the screen centre', () => {
    const cam = new THREE.Vector3(0, 6, 8);
    const subject = new THREE.Vector3(0, 0, 0);
    const beyond = new THREE.Vector3(0, 0, -12); // a subject framed low: the screen centre hits the ground behind it
    try {
      setFollowCut(subject);
      updateFade(cam, beyond, true);
      expect(fadeUniforms.uFadeFocus.value.toArray()).toEqual([0, 1.1, 0]);
      // the camera is 10 m from the subject: close enough for the occluder cut
      expect(fadeUniforms.uFadeOccl.value).toBe(1);
      setFollowCut(null);
      updateFade(cam, beyond, true);
      expect(fadeUniforms.uFadeFocus.value.toArray()).toEqual([0, 1.1, -12]);
    } finally {
      setFollowCut(null);
    }
  });

  it("while following, drops the leaf cards on the camera → subject line, whole, even from the subject's own tree", () => {
    const leaf = new THREE.MeshStandardMaterial();
    leaf.userData.foliage = true;
    leaf.userData.crownFade = true;
    applyFade(leaf, 'crown');
    const sh = compile(leaf).vertexShader;
    expect(sh).toContain('#define PROP_FADE_CARDS');
    expect(sh).toContain('attribute vec3 aCard;');
    // the card's centre against the segment, anywhere past the lens, in front of the subject
    expect(sh).toContain('vec3 c = ( M * vec4( aCard * 0.01, 1.0 ) ).xyz - uFadeCam;');
    expect(sh).toContain('float r = length( c - dir * clamp( t, 0.0, len ) );');
    expect(sh).toContain('* smoothstep( 1.50, 2.50, t )');
    expect(sh).not.toContain('t / len )');
    // after the keep rule: the kept tree loses its cards on the line too
    expect(sh.indexOf('fade = max( fade, propCardCut( M, dir, len ) );')).toBeGreaterThan(sh.indexOf('float between ='));
    // bark and the tree's shadow do not (the trunk and its shade stay)
    const bark = new THREE.MeshStandardMaterial();
    bark.userData.fadeNear = true;
    bark.userData.crownFade = true;
    applyFade(bark, 'crownSolid');
    expect(compile(bark).vertexShader).not.toContain('#define PROP_FADE_CARDS');
    const depth = windDepthMaterial(Object.assign(new THREE.MeshStandardMaterial({ alphaTest: 0.5 }), { userData: { foliage: true, crownFade: true, sway: 0.011 } }))!;
    const dv = compileDepth(depth).vertexShader;
    expect(dv).not.toContain('#define PROP_FADE_CARDS');
    // a trunk on the line in front of the subject at the closest zooms takes its tree (visible pass only)
    const trunkCut = 'fade = max( fade, propTreeFade( propOccluderAt( o, propOcclTop( o, M ), 0.5, true ) ) );';
    expect(sh).toContain(trunkCut);
    expect(sh.lastIndexOf('#ifndef PROP_FADE_SHADOW', sh.indexOf(trunkCut))).toBeGreaterThan(sh.indexOf('fade = max( fade, propTreeFade( hit * uFadeFollow'));

    // the card radius grows with the distance
    const subject = new THREE.Vector3(0, 0, 0);
    try {
      setFollowCut(subject);
      updateFade(new THREE.Vector3(0, 8, 14), subject, true);
      expect(fadeUniforms.uFadeCard.value).toBe(FOLLOW_CARD_R);
      updateFade(new THREE.Vector3(0, 25, 43), subject, true);
      expect(fadeUniforms.uFadeCard.value).toBe(FOLLOW_CARD_R_MAX);
    } finally {
      setFollowCut(null);
    }
  });

  it('reaches a 44 m follow zoom (the subject framed low: ≈ 1.2 × the zoom to its feet)', () => {
    const subject = new THREE.Vector3(0, 0, 0);
    try {
      setFollowCut(subject);
      updateFade(new THREE.Vector3(0, 44 * 1.2 * 0.42, 44 * 1.2 * 0.906), subject, true);
      expect(fadeUniforms.uFadeFollow.value).toBe(1);
    } finally {
      setFollowCut(null);
    }
  });

  it('dissolves a ground-plant clump on the follow line through its own threshold', () => {
    const fern = new THREE.MeshStandardMaterial();
    fern.userData.foliage = true;
    applyFade(fern, 'foliage');
    const sh = compile(fern);
    expect(sh.vertexShader).toContain('vPropOccl = propOccluderAt( o, propOcclTop( o, M ), 0.5, true );');
    expect(sh.fragmentShader).toContain('if ( vPropFade > vPropRank || vPropOccl > 0.3 + 0.4 * fract(');
    // the fragment declares what it reads (the defines only reach the vertex shader)
    expect(sh.fragmentShader).toContain('varying float vPropOccl;');
    // solid plants keep the plain discard
    const cactus = new THREE.MeshStandardMaterial();
    cactus.userData.fadeNear = true;
    applyFade(cactus, 'solid');
    expect(compile(cactus).fragmentShader).toContain('if ( vPropFade > vPropRank ) discard;');
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

describe('follow-mode occluder cut (fences, small structures)', () => {
  it('dissolves whole pieces near the camera on the camera → subject line, only while following close', () => {
    const m = new THREE.MeshStandardMaterial();
    const key = m.customProgramCacheKey();
    applyOccluderCut(m);
    applyOccluderCut(m);
    const sh = compile(m);
    expect(sh.vertexShader.match(/#define PROP_FADE_OCCLUDER/g)?.length).toBe(1);
    // runs only while the occluder cut is on (never in free-camera play)
    expect(sh.vertexShader).toContain('#define PROP_FADE_ON uFadeOccl > 0.0');
    // one value per instance, from its origin: within OCCLUDER_R of the camera, OCCLUDER_SIDE of the line, in front of the subject
    expect(sh.vertexShader).toContain(`float nearR = max( ${OCCLUDER_R.toFixed(2)}, ${OCCLUDER_SHARE.toFixed(2)} * len ) + PROP_OCCL_REACH;`);
    expect(sh.vertexShader).toContain('float near = anywhere ? 1.0 : 1.0 - smoothstep( nearR - 0.25, nearR, length( co ) );');
    expect(sh.vertexShader).toContain('#define PROP_OCCL_REACH 0.00');
    expect(sh.vertexShader).toContain(`float sideR = ${OCCLUDER_SIDE.toFixed(2)} + PROP_OCCL_REACH;`);
    expect(sh.vertexShader).toContain('( 1.0 - smoothstep( sideR - 0.15, sideR, side ) )');
    // at least a metre in front of the subject
    expect(sh.vertexShader).toContain('( 1.0 - smoothstep( len - front - 0.3, len - front, t ) )');
    expect(sh.vertexShader).toContain('return propOccluderAt( o, top, 1.0, false );');
    // only a piece reaching up to the line's height over it (less OCCLUDER_BELOW); without height data, any piece
    expect(sh.vertexShader).toContain('float lineY = mix( uFadeCam.y, uFadeFocus.y, clamp( t / len, 0.0, 1.0 ) );');
    expect(sh.vertexShader).toContain(`float tall = smoothstep( lineY - ${(OCCLUDER_BELOW + 0.2).toFixed(2)}, lineY - ${OCCLUDER_BELOW.toFixed(2)}, top );`);
    expect(sh.vertexShader).toContain('return o.y + 1e4;');
    expect(sh.vertexShader).not.toContain('#define PROP_OCCL_TOP');
    // a screen-space threshold, not the rank: the whole piece dissolves evenly
    expect(sh.fragmentShader).toContain('if ( vPropFade > 0.3 + 0.4 * fract( 52.9829189');
    expect(sh.fragmentShader).not.toContain('vPropFade > vPropRank');
    expect(m.customProgramCacheKey()).toBe(`${key}|propoccl0`);

    // bulky pieces (boulders) reach farther from the line
    const rock = new THREE.MeshStandardMaterial();
    rock.userData.occluderReach = 0.6;
    applyOccluderCut(rock);
    expect(compile(rock).vertexShader).toContain('#define PROP_OCCL_REACH 0.60');
    // fence posts go only with every panel they join (the fence patch supplies propPostMask)
    const post = new THREE.MeshStandardMaterial();
    post.userData.occluderPosts = true;
    applyOccluderCut(post);
    const pv = compile(post).vertexShader;
    expect(pv).toContain('#define PROP_OCCL_POSTS');
    expect(pv).toContain('float propPostMask();');
    expect(pv).toContain('cut = min( cut, propOccluderAt( o + vec3( e.x, 0.0, e.y ) * 1.00, top, 1.0, false ) );');
    expect(post.customProgramCacheKey()).not.toBe(m.customProgramCacheKey());

    // vegetation keeps its own fade
    const leaf = new THREE.MeshStandardMaterial();
    leaf.userData.foliage = true;
    applyFade(leaf, 'foliage');
    applyOccluderCut(leaf);
    expect(compile(leaf).vertexShader).not.toContain('#define PROP_FADE_OCCLUDER');

    const subject = new THREE.Vector3(0, 0, 0);
    const camAt = (d: number) => new THREE.Vector3(0, d * 0.42, d * 0.906);
    try {
      setFollowCut(subject);
      updateFade(camAt(5.25), subject, true);
      expect(fadeUniforms.uFadeOccl.value).toBe(1);
      updateFade(camAt(OCCLUDER_D + 3.5), subject, true);
      expect(fadeUniforms.uFadeOccl.value).toBe(0);
      setFollowCut(null);
      updateFade(camAt(5.25), subject, true);
      expect(fadeUniforms.uFadeOccl.value).toBe(0);
    } finally {
      setFollowCut(null);
    }
  });
});

describe('big trunks on the follow line', () => {
  it("carry the trunk's radius: only baobabs count as big, not clumps of canes", () => {
    const radius = (g: THREE.Object3D) => {
      let r = -1;
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && (m.material as THREE.Material).userData.crownFade === true) r = (m.geometry.getAttribute('aCrownR') as THREE.BufferAttribute).getZ(0) / 100;
      });
      return r;
    };
    expect(radius(buildBaobab(0))).toBeGreaterThan(BIG_TRUNK_R);
    expect(radius(buildAcacia(0))).toBeLessThan(BIG_TRUNK_R);
    expect(radius(buildBamboo(0))).toBeLessThan(BIG_TRUNK_R);
    // leaves and bark of a tree agree
    const g = buildBaobab(1);
    const all = new Set<number>();
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).userData.crownFade === true) all.add((m.geometry.getAttribute('aCrownR') as THREE.BufferAttribute).getZ(0));
    });
    expect(all.size).toBe(1);
    expect(trunkRadius(new THREE.CylinderGeometry(1.2, 1.2, 4, 16, 8).translate(0, 2, 0))).toBeCloseTo(1.2, 3);
  });

  it('take their tree (visible pass only, at every follow zoom) when the trunk covers the subject', () => {
    const leaf = new THREE.MeshStandardMaterial();
    leaf.userData.foliage = true;
    leaf.userData.crownFade = true;
    applyFade(leaf, 'crown');
    const sh = compile(leaf).vertexShader;
    const cut = 'fade = max( fade, propTreeFade( propBigTrunk( o, M, cw.y ) * uFadeFollow ) );';
    expect(sh).toContain(cut);
    expect(sh).toContain(`return step( ${BIG_TRUNK_R.toFixed(2)}, tr ) * ( 1.0 - smoothstep( tr + 0.2, tr + 0.5, side ) )`);
    // the line passes the trunk below the crown, not over it
    expect(sh).toContain('* ( 1.0 - smoothstep( crownY - 0.5, crownY, lineY ) );');
    expect(sh.lastIndexOf('#ifndef PROP_FADE_SHADOW', sh.indexOf(cut))).toBeGreaterThan(sh.lastIndexOf('#endif', sh.indexOf(cut)) - 400);
    const depth = windDepthMaterial(Object.assign(new THREE.MeshStandardMaterial({ alphaTest: 0.5 }), { userData: { foliage: true, crownFade: true, sway: 0.011 } }))!;
    const dv = compileDepth(depth).vertexShader;
    // the shadow pass compiles with PROP_FADE_SHADOW, which skips the term: the shade stays
    expect(dv).toContain('#define PROP_FADE_SHADOW');
    expect(dv.indexOf('#ifndef PROP_FADE_SHADOW')).toBeLessThan(dv.indexOf(cut));
  });
});

describe('follow-mode occluder cut: never parked half dissolved, only what hides the subject', () => {
  it('switches on and off with hysteresis and a short time cross-fade, not by zoom', () => {
    const subject = new THREE.Vector3(0, 0, 0);
    const camAt = (d: number) => new THREE.Vector3(0, d * 0.42, d * 0.906);
    const occl = () => fadeUniforms.uFadeOccl.value;
    try {
      setFollowCut(subject);
      updateFade(camAt(OCCLUDER_OFF_D + 1), subject, true, undefined, 0.1);
      expect(occl()).toBe(0);
      // between the two distances coming from far: stays off
      updateFade(camAt((OCCLUDER_D + OCCLUDER_OFF_D) / 2), subject, true, undefined, 1);
      expect(occl()).toBe(0);
      // in: fades in over OCCLUDER_FADE_S of time
      updateFade(camAt(OCCLUDER_D - 0.5), subject, true, undefined, OCCLUDER_FADE_S / 2);
      expect(occl()).toBeCloseTo(0.5, 5);
      // back out between the two distances: stays on (no flicker while zooming around one distance)
      updateFade(camAt((OCCLUDER_D + OCCLUDER_OFF_D) / 2), subject, true, undefined, OCCLUDER_FADE_S);
      expect(occl()).toBe(1);
      updateFade(camAt((OCCLUDER_D + OCCLUDER_OFF_D) / 2), subject, true, undefined, 10);
      expect(occl()).toBe(1);
      // out: fades out over time, whatever the zoom does meanwhile
      updateFade(camAt(OCCLUDER_OFF_D + 0.5), subject, true, undefined, OCCLUDER_FADE_S / 4);
      expect(occl()).toBeCloseTo(0.75, 5);
      updateFade(camAt(OCCLUDER_OFF_D + 0.5), subject, true, undefined, OCCLUDER_FADE_S);
      expect(occl()).toBe(0);
    } finally {
      setFollowCut(null);
      updateFade(camAt(40), subject, true);
    }
  });

  it('reads height data, the anywhere rule and a den shell from the material flags', () => {
    const rock = new THREE.MeshStandardMaterial();
    Object.assign(rock.userData, { occluderReach: 0.6, occluderTop: true, occluderAnywhere: true });
    const key = rock.customProgramCacheKey();
    applyOccluderCut(rock);
    const rv = compile(rock).vertexShader;
    expect(rv).toContain('#define PROP_OCCL_TOP');
    expect(rv).toContain('attribute float aOcclTop;');
    // the piece's top: its geometry's height, scaled with the instance
    expect(rv).toContain('return o.y + aOcclTop * length( M[ 1 ].xyz );');
    // boulders and ice: anywhere on the line, from 0.6 m in front of the subject
    expect(rv).toContain('return propOccluderAt( o, top, 0.6, true );');
    expect(rock.customProgramCacheKey()).toBe(`${key}|propoccl0.6ta`);

    const den = new THREE.MeshStandardMaterial();
    Object.assign(den.userData, { occluderReach: 1.6, occluderShell: true });
    applyOccluderCut(den);
    const dv = compile(den).vertexShader;
    // a den the subject stands in goes whole, whichever side of its origin the subject is
    expect(dv).toContain('onLine = max( onLine, 1.0 - smoothstep( PROP_OCCL_REACH, PROP_OCCL_REACH + 0.4, length( o.xz - uFadeFocus.xz ) ) );');
    expect(dv).not.toContain('#define PROP_OCCL_TOP');
    expect(compile(rock).vertexShader).not.toContain('#define PROP_OCCL_SHELL');

    // ground plants: the clump's reach and height ride on the fade patch
    const grass = new THREE.MeshStandardMaterial();
    Object.assign(grass.userData, { foliage: true, occluderReach: 0.6, occluderTop: true });
    applyFade(grass, 'foliage');
    const gv = compile(grass).vertexShader;
    expect(gv).toContain('#define PROP_OCCL_REACH 0.60');
    expect(gv).toContain('attribute float aOcclTop;');
    expect(grass.customProgramCacheKey()).toMatch(/\|propfade-foliage\|0\.6t$/);
  });

  it('gives a geometry its height for the cut (default: its highest point)', () => {
    const g = new THREE.BoxGeometry(1, 2, 1).translate(0, 1, 0);
    setOcclTop(g);
    const a = g.getAttribute('aOcclTop');
    expect(a.count).toBe(g.getAttribute('position').count);
    expect(a.getX(0)).toBeCloseTo(2, 5);
    expect(a.getX(a.count - 1)).toBeCloseTo(2, 5);
    setOcclTop(g, 0.4);
    expect(g.getAttribute('aOcclTop').getX(3)).toBeCloseTo(0.4, 5);
  });
});

describe('shared shadow casters (still bark)', () => {
  it('drop a removed tree\'s trunk and limb shadows, never a piece without crown data', () => {
    const d = casterDepthMaterial();
    expect(casterDepthMaterial()).toBe(d);
    const sh = compileDepth(d);
    for (const def of ['PROP_FADE_CROWN', 'PROP_FADE_SHADOW', 'PROP_FADE_BARK', 'PROP_FADE_TREES_ONLY']) expect(sh.vertexShader).toContain(`#define ${def}`);
    expect(sh.vertexShader).toContain('if ( aCrownR.y < 1.0 ) return 0.0;');
    expect(sh.fragmentShader).toContain('if ( vPropFade > vPropRank ) discard;');
    expect(d.customProgramCacheKey()).toBe('props-caster-depth|treeshadow');
  });
});
