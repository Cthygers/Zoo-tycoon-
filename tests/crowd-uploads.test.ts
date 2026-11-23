// Crowd batches upload only what changed since the last frame (texture uploads
// are a large per-frame cost on phones).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DrawIdTexture, FilteredBatch, SkinnedBatch } from '../src/models/crowd/batch';
import { crowdUniforms } from '../src/models/crowd/skinning';

const fakeRenderer = { isWebGPURenderer: false } as unknown as THREE.WebGLRenderer;

function testCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  cam.position.set(0, 1, 0);
  cam.lookAt(0, 1, -10);
  cam.updateMatrixWorld();
  return cam;
}

function boxGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.deleteAttribute('uv');
  g.computeBoundingSphere();
  return g;
}

type Internals = { _matricesTexture: THREE.DataTexture; _indirectTexture: THREE.DataTexture };

describe('crowd texture uploads', () => {
  it('draw-id texture uploads only a list that differs from the last one', () => {
    const t = new DrawIdTexture(2);
    t.needsUpdate = true; // first list always uploads, even all zeros
    expect(t.version).toBe(1);
    t.needsUpdate = true;
    expect(t.version).toBe(1);
    (t.image.data as Uint32Array)[1] = 3;
    t.needsUpdate = true;
    expect(t.version).toBe(2);
  });

  it('main and shadow passes keep their own draw lists; a still batch re-uploads neither', () => {
    const b = new FilteredBatch('t', new THREE.MeshBasicMaterial(), 4, 64, 192);
    const g = b.addKeyedGeometry('box', boxGeo());
    const m = new THREE.Matrix4();
    const ids = [0, 1, 2].map((i) => {
      const id = b.addSlot(g);
      b.setMatrixAt(id, m.makeTranslation(i - 1, 1, -10));
      return id;
    });
    b.setCastShadow(ids[1], false);
    const cam = testCamera();
    const internal = b as unknown as Internals;
    const frame = (): [THREE.DataTexture, THREE.DataTexture] => {
      b.onBeforeShadow(fakeRenderer, new THREE.Scene(), cam, cam, b.geometry, b.material as THREE.Material, new THREE.Group());
      const shadow = internal._indirectTexture;
      b.onAfterShadow();
      b.onBeforeRender(fakeRenderer, new THREE.Scene(), cam, b.geometry, b.material as THREE.Material, new THREE.Group());
      return [shadow, internal._indirectTexture];
    };
    const [shadow, main] = frame();
    expect(shadow).not.toBe(main);
    const v = [shadow.version, main.version, internal._matricesTexture.version];
    // same matrices again (the crowd renderer writes every visible instance each frame)
    for (let i = 0; i < 3; i++) b.setMatrixAt(ids[i], m.makeTranslation(i - 1, 1, -10));
    frame();
    expect([shadow.version, main.version, internal._matricesTexture.version]).toEqual(v);
    // one instance moves: its matrix uploads; it stays in both lists, so they do not
    b.setMatrixAt(ids[0], m.makeTranslation(-1.5, 1, -10));
    frame();
    expect(internal._matricesTexture.version).toBe(v[2] + 1);
    expect([shadow.version, main.version]).toEqual(v.slice(0, 2));
    b.dispose();
  });

  it('skinned batch uploads only the blocks written since the last flush', () => {
    const b = new SkinnedBatch('s', new THREE.MeshBasicMaterial(), new THREE.MeshDepthMaterial(), [crowdUniforms()], {
      bones: 2,
      look: 1,
      instances: 4,
      vertices: 64,
      indices: 192,
    });
    const g = b.addKeyedGeometry('box', boxGeo());
    const ids = [0, 1, 2, 3].map(() => b.addSlot(g));
    const tex = b.texture;
    // a new texture's first upload is whole (no update ranges)
    b.flush();
    expect(tex.updateRanges.length).toBe(0);
    const v0 = tex.version;
    // nothing written (creature not re-posed this frame): no upload
    b.flush();
    expect(tex.version).toBe(v0);
    // one creature re-posed: only its bone rows
    b.data[b.boneOffset(ids[2])] = 1;
    b.flush();
    expect(tex.version).toBe(v0 + 1);
    expect(tex.updateRanges).toEqual([{ start: (ids[2] * b.stride + b.look) * 4, count: b.bones * 3 * 4 }]);
    tex.clearUpdateRanges(); // (the renderer does this after uploading)
    // look texels of one + pose of another: one span covering both
    b.data[b.offset(ids[0])] = 0.25;
    b.data[b.boneOffset(ids[1])] = 1;
    b.flush();
    expect(tex.updateRanges).toEqual([{ start: 0, count: (ids[1] + 1) * b.stride * 4 }]);
    b.dispose();
  });

  it('skinned batch re-sends the whole texture after growing', () => {
    const b = new SkinnedBatch('s', new THREE.MeshBasicMaterial(), new THREE.MeshDepthMaterial(), [crowdUniforms()], {
      bones: 2,
      look: 1,
      instances: 2,
      vertices: 64,
      indices: 192,
    });
    const g = b.addKeyedGeometry('box', boxGeo());
    for (let i = 0; i < 3; i++) b.addSlot(g);
    b.flush();
    b.texture.clearUpdateRanges();
    for (let i = 0; i < 6; i++) b.addSlot(g); // grows: new texture
    b.data[b.boneOffset(0)] = 2;
    b.flush();
    expect(b.texture.updateRanges.length).toBe(0);
    expect(b.texture.version).toBeGreaterThan(0);
    b.dispose();
  });
});
