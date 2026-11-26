// Yellow "do it here" markers on the ground (tutorial.md §6.6): a box, footprint spots, path
// tiles, fence-gap edges and a ring under an animal. Draped over the terrain like the build
// tools' own previews (DrapedMesh), in yellow so they never read as the tools' green / red.

import * as THREE from 'three';
import { TILE } from '../../core/constants';
import type { World } from '../../core/world';
import { DrapedMesh, surfaceY, type RGBA } from '../preview';
import type { WorldHint } from './facts';

const UNDER: RGBA = [0.12, 0.11, 0.03, 0.55];
const LINE: RGBA = [1.0, 0.886, 0.478, 0.95];
const FILL: RGBA = [1.0, 0.886, 0.478, 0.13];
const REDRAW_EVERY = 0.1;

export class GroundMarkers {
  readonly group = new THREE.Group();
  private mesh: DrapedMesh;
  private ring: THREE.Mesh;
  private hint: WorldHint | null = null;
  private key = '';
  private t = 0;
  private acc = REDRAW_EVERY;
  private still: boolean;

  constructor(
    private world: World,
    scene: THREE.Scene,
    reducedMotion = false,
  ) {
    this.still = reducedMotion;
    // drawn over trees and buildings (no depth test, late in the order): a child must always see where
    this.mesh = new DrapedMesh(world, 40, 512);
    this.mesh.mesh.name = 'tutorial-ground';
    (this.mesh.mesh.material as THREE.MeshBasicMaterial).depthTest = false;
    const g = new THREE.RingGeometry(0.9, 1.25, 48);
    g.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false, toneMapped: false, fog: false, side: THREE.DoubleSide }));
    this.ring.renderOrder = 40;
    this.ring.visible = false;
    this.ring.name = 'tutorial-ring';
    this.group.name = 'tutorial-markers';
    this.group.add(this.mesh.mesh, this.ring);
    scene.add(this.group);
  }

  set(h: WorldHint | null): void {
    const key = h ? JSON.stringify(h.kind === 'animal' ? { k: 'animal', id: h.id } : h) : '';
    this.hint = h;
    if (key !== this.key) {
      this.key = key;
      this.acc = REDRAW_EVERY;
    }
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  update(dt: number): void {
    this.t += dt;
    this.acc += dt;
    const h = this.hint;
    if (h?.kind === 'animal' || h?.kind === 'point') {
      this.mesh.clear();
      const r = h.kind === 'point' ? h.r / 1.25 : 1;
      this.ring.position.set(h.x, surfaceY(this.world, h.x, h.z) + 0.05, h.z);
      const s = r * (this.still ? 1 : 1 + 0.1 * Math.sin(this.t * Math.PI * 2 * 1.2));
      this.ring.scale.set(s, 1, s);
      this.ring.visible = true;
      return;
    }
    this.ring.visible = false;
    if (this.acc < REDRAW_EVERY) return;
    this.acc = 0;
    const pulse = this.still ? 1 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(this.t * Math.PI * 2 * 1.2));
    const line: RGBA = [LINE[0], LINE[1], LINE[2], LINE[3] * pulse];
    const fill: RGBA = [FILL[0], FILL[1], FILL[2], FILL[3] * pulse];
    const m = this.mesh;
    m.begin();
    if (h) {
      switch (h.kind) {
        case 'box':
          this.box(h.rect.x0, h.rect.z0, h.rect.x1, h.rect.z1, line, fill);
          break;
        case 'spot':
          this.box(h.spot.tx, h.spot.tz, h.spot.tx + h.spot.w - 1, h.spot.tz + h.spot.d - 1, line, fill);
          break;
        case 'tiles':
          for (const t of h.tiles) this.box(t.x, t.z, t.x, t.z, line, fill);
          break;
        case 'edges':
          for (const e of h.edges) {
            const x0 = e.x * TILE,
              z0 = e.z * TILE;
            const x1 = e.dir === 'h' ? x0 + TILE : x0;
            const z1 = e.dir === 'v' ? z0 + TILE : z0;
            m.line(x0, z0, x1, z1, 0.7, UNDER);
            m.line(x0, z0, x1, z1, 0.42, line);
          }
          break;
      }
    }
    m.end();
  }

  private box(x0: number, z0: number, x1: number, z1: number, line: RGBA, fill: RGBA): void {
    const m = this.mesh;
    m.rect(x0 * TILE, z0 * TILE, (x1 + 1) * TILE, (z1 + 1) * TILE, fill, Math.max(2, Math.min(8, (x1 - x0 + 1) * 2)));
    m.outline(x0, z0, x1, z1, 0.45, UNDER);
    m.outline(x0, z0, x1, z1, 0.25, line);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.mesh.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
  }
}
