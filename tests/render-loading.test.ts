// Loading screen render steps (src/loader.ts): the empty frame that captures
// the sky environment in a task of its own.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { renderEmptyFrame } from '../src/loader';
import type { IRenderContext } from '../src/core/contracts';

describe('renderEmptyFrame', () => {
  it('renders once with every drawn object hidden and restores visibility', () => {
    const scene = new THREE.Scene();
    const mesh = () => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const a = mesh();
    const off = mesh();
    off.visible = false;
    const group = new THREE.Group();
    const b = mesh();
    group.add(b);
    scene.add(a, off, group);
    const seen: boolean[][] = [];
    const ctx = { scene, render: () => seen.push([a.visible, b.visible, off.visible, group.visible]) } as unknown as IRenderContext;
    renderEmptyFrame(ctx);
    expect(seen).toEqual([[false, false, false, true]]);
    expect([a.visible, b.visible, off.visible, group.visible]).toEqual([true, true, false, true]);
  });

  it('restores visibility when the render throws', () => {
    const scene = new THREE.Scene();
    const a = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    scene.add(a);
    const ctx = {
      scene,
      render: () => {
        throw new Error('context lost');
      },
    } as unknown as IRenderContext;
    expect(() => renderEmptyFrame(ctx)).toThrow('context lost');
    expect(a.visible).toBe(true);
  });
});
