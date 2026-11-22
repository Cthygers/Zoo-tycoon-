// The render context: WebGL2 renderer, camera, sky / time of day, sun & moon
// light with focus-following texel-snapped shadows, PMREM environment, ground
// (terrain + outer landscape), water, boardwalk decks, grass and post FX.

import * as THREE from 'three';
import { MAP_H, MAP_W, WORLD_H, WORLD_W } from '../core/constants';
import type { IRenderContext, QualityLevel, QualitySettings } from '../core/contracts';
import type { EventBus, TileRect } from '../core/events';
import type { World } from '../core/world';
import { AtmosphereModel } from './atmosphere';
import { BoardwalkDecks } from './boardwalk';
import { computeCelestial } from './celestial';
import { GrassField } from './grass';
import { createGroundMaterial, type GroundUniforms } from './groundMaterial';
import { OuterLand } from './outer';
import { pickGround } from './pick';
import { PostFX } from './post';
import { qualitySettings } from './quality';
import { SkyDome } from './sky';
import { TerrainMesh, TileIndexTexture } from './terrain';
import { GroundTextures } from './textures';
import { WaterSurface } from './water';

/** Top-of-atmosphere sun irradiance in renderer light units. */
const SUN_E = 3.4;
/**
 * Direct sun light relative to the sky model. The single-scattering sky is
 * somewhat too dark compared with the sun (≈1:14 vs ≈1:6 measured on clear
 * days), which makes shadows black; scaling the direct term restores a
 * realistic shadow ratio while the exposure adapts to the result.
 */
const SUN_LIGHT = 0.55;
/** Moon light relative to the sun (strongly exaggerated for playability). */
const MOON_E = 0.24;
const DEG = Math.PI / 180;
const FOG_DENSITY = 0.0005;
const GROUND_ALBEDO = new THREE.Color(0.1, 0.12, 0.065);
const BANK_ALBEDO = new THREE.Color(0.05, 0.07, 0.035);

function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function grassCapacity(q: QualitySettings): number {
  return Math.round(4400 * q.grassDensity) + 64;
}

export class RenderContext implements IRenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  quality: QualitySettings;
  readonly sunDirection = new THREE.Vector3(0, 1, 0);

  private _night = 0;
  get nightFactor(): number {
    return this._night;
  }

  private container: HTMLElement;
  private world: World;
  private events: EventBus;
  private unsub: (() => void)[] = [];

  private atmosphere: AtmosphereModel;
  private textures: GroundTextures;
  private sky: SkyDome;
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envSunElev = -999;
  private envAge = 1e9;
  private envDirty = true;
  private lutSunElev = -999;
  private clockMinute = 12 * 60;
  private clockDay = 1;

  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private fog: THREE.FogExp2;

  private tileTex: TileIndexTexture;
  private groundMat: THREE.MeshStandardMaterial;
  private groundU: GroundUniforms;
  private terrain: TerrainMesh;
  private outer: OuterLand;
  private water: WaterSurface;
  private decks: BoardwalkDecks;
  private grass: GrassField;
  private post: PostFX | null = null;

  private moonDir = new THREE.Vector3(0, -1, 0);
  private sunCol = new THREE.Color();
  private moonCol = new THREE.Color();
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();
  private mountainAmb = new THREE.Color();
  private tmpV = new THREE.Vector3();
  private lightDir = new THREE.Vector3(0, 1, 0);
  private shUp = new THREE.Vector3();
  private shCenter = new THREE.Vector3();

  private focus = new THREE.Vector3(WORLD_W / 2, 0, WORLD_H * 0.75);
  private viewRadius = 40;
  private time = 0;
  private exposure = 1;
  private targetExposure = 1;
  private cloudOffset = new THREE.Vector2();
  private width = 1;
  private height = 1;
  private contextLost = false;
  private lastDt = 1 / 60;

  // deferred world updates (processed once per frame)
  private pendingTerrain: TileRect | null = null;
  private pendingTiles: TileRect | null = null;
  private waterDirty = false;
  private decksDirty = false;
  private outerDirty = false;

  private onLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
  };
  private onRestored = () => {
    this.contextLost = false;
    this.textures.generate();
    this.envRT?.dispose();
    this.envRT = null;
    this.envDirty = true;
    this.lutSunElev = -999;
    this.atmosphere.rayTex.needsUpdate = true;
    this.atmosphere.mieTex.needsUpdate = true;
    this.tileTex.texture.needsUpdate = true;
  };

  constructor(container: HTMLElement, world: World, events: EventBus, level: QualityLevel) {
    this.container = container;
    this.world = world;
    this.events = events;
    this.quality = qualitySettings(level);

    const q = this.quality;
    this.renderer = new THREE.WebGLRenderer({
      antialias: q.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.info.autoReset = false;
    r.shadowMap.enabled = q.shadows;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    r.domElement.style.display = 'block';
    r.domElement.style.width = '100%';
    r.domElement.style.height = '100%';
    r.domElement.addEventListener('webglcontextlost', this.onLost, false);
    r.domElement.addEventListener('webglcontextrestored', this.onRestored, false);
    container.appendChild(r.domElement);

    this.width = Math.max(1, container.clientWidth || window.innerWidth);
    this.height = Math.max(1, container.clientHeight || window.innerHeight);
    r.setSize(this.width, this.height, false);

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.3, 4500);
    this.camera.position.set(WORLD_W / 2, 35, WORLD_H + 10);
    this.camera.lookAt(this.focus);

    // ---- procedural textures
    const aniso = Math.min(r.capabilities.getMaxAnisotropy(), level === 'low' ? 2 : level === 'medium' ? 4 : 8);
    this.textures = new GroundTextures(r, level === 'low' ? 256 : 512, aniso);
    this.textures.generate();

    // ---- sky
    this.atmosphere = new AtmosphereModel(1.35);
    this.sky = new SkyDome(this.atmosphere.rayTex, this.atmosphere.mieTex, this.textures.noise);
    this.scene.add(this.sky.mesh);
    this.envScene.add(this.sky.envMesh);
    this.pmrem = new THREE.PMREMGenerator(r);

    // ---- lights
    this.sun = new THREE.DirectionalLight(0xffffff, SUN_E);
    this.sun.name = 'sun';
    this.sun.castShadow = q.shadows;
    this.configureShadow();
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd0ff, 0x4a4632, 0.2);
    this.scene.add(this.hemi);
    this.fog = new THREE.FogExp2(0xbfd0e0, FOG_DENSITY);
    this.scene.fog = this.fog;

    // ---- ground
    this.tileTex = new TileIndexTexture(world);
    const gm = createGroundMaterial(this.textures, this.tileTex.texture, {
      antiTile: level === 'high',
      cloudShadows: level !== 'low',
      caustics: level !== 'low',
    });
    this.groundMat = gm.material;
    this.groundU = gm.uniforms;
    this.terrain = new TerrainMesh(world, this.groundMat);
    this.scene.add(this.terrain.mesh);
    this.outer = new OuterLand(world, this.groundMat, this.textures.noise, {
      treeCount: level === 'low' ? 500 : level === 'medium' ? 900 : 1600,
    });
    this.scene.add(this.outer.group);

    this.water = new WaterSurface(world, this.textures.waves, this.textures.noise, (x, z) => this.outer.heights.height(x, z));
    this.scene.add(this.water.mesh);
    this.decks = new BoardwalkDecks(world);
    this.scene.add(this.decks.mesh);

    this.grass = new GrassField(world, this.textures.noise, grassCapacity(q));
    this.grass.configure(q.grassDensity, q.detailDistance);
    this.scene.add(this.grass.mesh);

    if (q.postFX) this.post = new PostFX(r, this.scene, this.camera, this.width, this.height, level, q.antialias, this.aoExcluded);

    // ---- world events
    const grow = (a: TileRect | null, b: TileRect): TileRect =>
      a
        ? { x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) }
        : { ...b };
    this.unsub.push(
      events.on('terrainChanged', (rect) => {
        this.pendingTerrain = grow(this.pendingTerrain, rect);
        this.pendingTiles = grow(this.pendingTiles, rect);
        this.waterDirty = true;
        this.decksDirty = true;
        this.grass.markDirty();
        if (rect.x0 <= 1 || rect.z0 <= 1 || rect.x1 >= MAP_W - 2 || rect.z1 >= MAP_H - 2) this.outerDirty = true;
      }),
      events.on('pathChanged', (rect) => {
        this.pendingTiles = grow(this.pendingTiles, rect);
        this.decksDirty = true;
        this.grass.markDirty();
      }),
      events.on('objectAdded', () => this.objectsChanged()),
      events.on('objectRemoved', () => this.objectsChanged()),
      events.on('worldReset', () => {
        const all = { x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 };
        this.pendingTerrain = all;
        this.pendingTiles = all;
        this.waterDirty = true;
        this.decksDirty = true;
        this.outerDirty = true;
        this.grass.markDirty();
      }),
    );

    this.setTimeOfDay(12 * 60, 1);
    this.setFocus(this.focus.x, this.focus.z, this.viewRadius);
  }

  /** Objects that must not take part in the GTAO normal/depth pass. */
  private aoExcluded = (): THREE.Object3D[] => [this.grass.mesh, this.sky.mesh, this.water.mesh, ...this.outer.aoExcluded()];

  private objectsChanged() {
    this.pendingTiles = { x0: 0, z0: 0, x1: MAP_W - 1, z1: MAP_H - 1 };
    this.grass.markDirty();
  }

  private configureShadow() {
    const s = this.sun.shadow;
    s.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
    s.bias = -0.0004;
    s.normalBias = 0.03;
    s.radius = this.quality.level === 'low' ? 1.5 : 2.5;
    const cam = s.camera;
    cam.near = 1;
    cam.far = 500;
    s.map?.dispose();
    s.map = null;
  }

  // ------------------------------------------------------------ time of day
  setTimeOfDay(minuteOfDay: number, day: number): void {
    this.clockMinute = minuteOfDay;
    this.clockDay = day;
    this.applyLighting();
  }

  private applyLighting(): void {
    const cel = computeCelestial(this.clockMinute, this.clockDay, this.sunDirection, this.moonDir);
    const sunElev = cel.sunElev;
    const atm = this.atmosphere;

    const lutDelta = Math.abs(sunElev - this.lutSunElev);
    if (lutDelta > 4 * DEG) {
      // big jump (start-up, load, time skip): update synchronously
      atm.compute(sunElev);
      this.lutSunElev = sunElev;
    } else if (lutDelta > 0.35 * DEG && !atm.busy) {
      atm.request(sunElev); // amortised over the next frames in update()
      this.lutSunElev = sunElev;
    }

    // night factor: 0 above +2°, 1 below −11° (end of nautical twilight-ish)
    const se = sunElev / DEG;
    const t = Math.min(Math.max((2 - se) / 13, 0), 1);
    this._night = t * t * (3 - 2 * t);
    const night = this._night;

    // sun colour at the ground and at cloud altitude
    atm.transmittance(sunElev, atm.observerKm, this.sunCol);
    const moonUp = Math.min(Math.max((cel.moonElev / DEG + 2) / 10, 0), 1);
    atm.transmittance(Math.max(cel.moonElev, -0.2), atm.observerKm, this.moonCol);
    // moon fill fades in as soon as the sun is down so twilight never goes black
    const sunDown = Math.min(Math.max((1 - se) / 4, 0), 1);
    const moonBright = MOON_E * moonUp * (0.35 + 0.65 * cel.moonIllum) * sunDown * sunDown * (3 - 2 * sunDown);
    this.moonCol.multiplyScalar(moonBright).multiply(this.tmpC.setRGB(0.6, 0.74, 1.0));

    const sunLum = luminance(this.sunCol) * SUN_E * SUN_LIGHT * Math.max(this.sunDirection.y, 0);
    const moonLum = luminance(this.moonCol) * SUN_E * SUN_LIGHT * Math.max(this.moonDir.y, 0);
    const useMoon = moonLum > sunLum;
    if (useMoon) {
      this.lightDir.copy(this.moonDir);
      this.sun.color.copy(this.moonCol);
      this.sun.shadow.intensity = 0.75;
    } else {
      this.lightDir.copy(this.sunDirection);
      this.sun.color.copy(this.sunCol);
      this.sun.shadow.intensity = 1;
    }
    this.sun.intensity = SUN_E * SUN_LIGHT;
    if (this.lightDir.y < 0.02) {
      // never light from below the horizon
      this.lightDir.y = 0.02;
      this.lightDir.normalize();
    }

    // sky irradiance and colours
    const skyIrr = this.tmpC.copy(atm.skyIrradiance).multiplyScalar(SUN_E);
    const nightSky = this.tmpC2.setRGB(0.0016, 0.0028, 0.0065).multiplyScalar(0.6 + 1.8 * moonUp * cel.moonIllum).multiplyScalar(night);
    const u = this.sky.uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    u.uMoonDir.value.copy(this.moonDir);
    u.uSunE.value = SUN_E;
    u.uSunDisc.value.copy(this.sunCol).multiplyScalar(SUN_E * 18);
    u.uMoonColor.value.setRGB(0.95, 0.95, 0.92).multiplyScalar((0.2 + 0.8 * cel.moonIllum) * (0.25 + 0.75 * night) * 0.9);
    u.uNight.value = night;
    u.uNightSky.value.copy(nightSky);
    u.uHorizonGlow.value.setRGB(0.006, 0.0042, 0.0026).multiplyScalar(night);
    // clouds lit by the sun colour at ~2 km (stays warm after ground sunset)
    const cloudSun = atm.transmittance(sunElev, 3.5, u.uCloudSun.value).multiplyScalar(SUN_E * 0.32);
    cloudSun.add(this.tmpC2.copy(this.moonCol).multiplyScalar(SUN_E * 0.5));
    u.uCloudAmb.value.copy(skyIrr).multiplyScalar(1 / Math.PI).add(this.tmpC2.copy(nightSky).multiplyScalar(1.4));
    // ground radiance below the horizon (env map bounce)
    const groundIrr = this.tmpC2.copy(this.sunCol).multiplyScalar(SUN_E * SUN_LIGHT * Math.max(this.sunDirection.y, 0)).add(skyIrr);
    u.uGround.value.copy(groundIrr).multiply(GROUND_ALBEDO).multiplyScalar(1 / Math.PI);
    u.uGround.value.add(this.tmpC2.copy(nightSky).multiplyScalar(0.4));

    // fog = horizon radiance (day) + night sky horizon
    this.fog.color.copy(atm.horizon).multiplyScalar(SUN_E);
    this.fog.color.add(this.tmpC2.copy(nightSky).multiplyScalar(1.6)).add(this.tmpC2.copy(u.uHorizonGlow.value).multiplyScalar(0.25));
    this.renderer.setClearColor(this.fog.color);

    // hemisphere fill: low, mostly to lift deep shadows and for env-less materials
    this.hemi.color.copy(skyIrr).multiplyScalar(0.25 / Math.PI).add(this.tmpC2.copy(nightSky).multiplyScalar(2.5));
    this.hemi.groundColor.copy(u.uGround.value).multiplyScalar(0.6);
    this.hemi.intensity = 1;

    // water: reflected banks ≈ dark foliage lit by sky + sun, blended with haze
    this.water.uniforms.uBank.value
      .copy(this.tmpC2.copy(this.sunCol).multiplyScalar(SUN_E * Math.max(this.sunDirection.y, 0) * 0.5))
      .add(skyIrr)
      .multiply(BANK_ALBEDO)
      .multiplyScalar(1 / Math.PI)
      .lerp(this.fog.color, 0.25);

    // ground contact shadows of the outer forest
    this.outer.updateTreeShadows(this.sunDirection, (1 - night) * Math.min(1, Math.max(0, se / 6)));

    // mountains
    this.mountainAmb.copy(skyIrr).multiplyScalar(1 / Math.PI);
    this.outer.setMountainLight(this.fog.color, this.tmpC2.copy(this.sunCol).multiplyScalar(SUN_E), this.mountainAmb, this.sunDirection);

    // ground / grass shader inputs
    this.groundU.uSunDirW.value.copy(this.lightDir);
    this.groundU.uCloudShadow.value = 0.45 * (1 - night) * Math.min(1, Math.max(0, se / 8));
    this.grass.uniforms.uSunDirW.value.copy(this.lightDir);
    this.grass.uniforms.uSunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);

    // exposure target from scene illuminance (log-ish adaptation)
    const E = sunLum + moonLum + luminance(skyIrr) + 1e-4;
    // partial adaptation: noon ≈ 1.2, golden hour ≈ 2–3, moonlit night ≈ 5–6
    let ex = 1.9 * Math.pow(Math.max(E, 0.6) / 1.6, -0.47);
    if (E < 0.6) ex *= Math.pow(E / 0.6, -0.8);
    this.targetExposure = Math.min(Math.max(ex, 0.7), 10);

    if (Math.abs(sunElev - this.envSunElev) > 2.5 * DEG) this.envDirty = true;
    this.post?.setNight(night);
  }

  // ------------------------------------------------------------ focus / shadows
  setFocus(x: number, z: number, viewRadius: number): void {
    this.focus.set(x, this.world.heightAt(x, z), z);
    this.viewRadius = Math.max(5, viewRadius);
  }

  private updateShadowFrustum() {
    if (!this.quality.shadows) return;
    const half = Math.min(Math.max(this.viewRadius * 1.15 + 6, 14), 130);
    const cam = this.sun.shadow.camera;
    if (cam.right !== half) {
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
      this.sun.shadow.normalBias = 0.02 + (half * 2) / this.quality.shadowMapSize * 1.2;
    }
    // texel snapping in light space
    const dir = this.lightDir;
    const right = this.tmpV.set(0, 1, 0).cross(dir);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = this.shUp.crossVectors(dir, right).normalize();
    const texel = (half * 2) / this.quality.shadowMapSize;
    const fx = this.focus.dot(right),
      fy = this.focus.dot(up);
    const sx = Math.round(fx / texel) * texel - fx;
    const sy = Math.round(fy / texel) * texel - fy;
    const center = this.shCenter.copy(this.focus).addScaledVector(right, sx).addScaledVector(up, sy);
    // keep the depth position snapped too, so the projection is stable
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(dir, 250);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  // ------------------------------------------------------------ per frame
  update(dt: number): void {
    this.lastDt = dt;
    this.time += dt;
    const t = this.time;
    this.flushWorldChanges();
    // amortised sky LUT update (~6 rows per frame); refresh lighting when done
    if (this.atmosphere.busy && this.atmosphere.step(6)) this.applyLighting();

    // exposure adaptation (~1.5 s time constant)
    const k = 1 - Math.exp(-dt / 1.5);
    this.exposure += (this.targetExposure - this.exposure) * k;
    this.renderer.toneMappingExposure = this.exposure;

    // clouds drift
    this.cloudOffset.set(t * 0.0045, t * 0.0021);
    this.sky.uniforms.uCloudOffset.value.copy(this.cloudOffset);
    this.sky.uniforms.uTime.value = t;
    this.groundU.uCloudOffset.value.copy(this.cloudOffset);
    this.groundU.uTime.value = t;
    this.water.update(t);

    // grass follows a point between the focus and the camera's ground position
    const cam = this.camera.position;
    const gx = this.focus.x + (cam.x - this.focus.x) * 0.35;
    const gz = this.focus.z + (cam.z - this.focus.z) * 0.35;
    const camDist = cam.distanceTo(this.focus);
    const D = this.quality.detailDistance;
    const g = 1 - Math.min(Math.max((camDist - D * 1.3) / (D * 0.9), 0), 1);
    this.grass.setCenter(gx, gz, g);
    this.grass.mesh.visible = g > 0.01 && this.quality.grassDensity > 0.01;
    this.grass.update(t, 150);

    this.envAge += dt;
  }

  private flushWorldChanges() {
    if (this.pendingTiles) {
      this.tileTex.update(this.pendingTiles);
      this.pendingTiles = null;
    }
    if (this.pendingTerrain) {
      this.terrain.rebuild(this.pendingTerrain);
      this.pendingTerrain = null;
    }
    if (this.waterDirty) {
      this.water.rebuild();
      this.waterDirty = false;
    }
    if (this.decksDirty) {
      this.decks.rebuild();
      this.decksDirty = false;
    }
    if (this.outerDirty) {
      this.outer.refreshBorder();
      this.outerDirty = false;
    }
  }

  private updateEnvironment() {
    // throttle: only when the sun moved noticeably (or every ~40 s for cloud drift)
    if (!this.envDirty && this.envAge < 40) return;
    if (this.envRT && this.envAge < 0.5) return;
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 10, { size: 256 });
    const old = this.envRT;
    this.envRT = rt;
    this.scene.environment = rt.texture;
    old?.dispose();
    this.envSunElev = Math.asin(this.sunDirection.y);
    this.envDirty = false;
    this.envAge = 0;
  }

  render(): void {
    if (this.contextLost) return;
    this.renderer.info.reset();
    this.updateEnvironment();
    this.updateShadowFrustum();
    if (this.post) this.post.render(this.lastDt);
    else this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(this.width, this.height, this.renderer.getPixelRatio());
  }

  pickGround(ndcX: number, ndcY: number): THREE.Vector3 | null {
    return pickGround(this.world, this.camera, ndcX, ndcY);
  }

  setQuality(level: QualityLevel): void {
    const prev = this.quality;
    const q = qualitySettings(level);
    // the default framebuffer's MSAA is fixed at context creation
    q.antialias = prev.antialias;
    this.quality = q;
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    r.setSize(this.width, this.height, false);
    if (prev.shadows !== q.shadows) {
      r.shadowMap.enabled = q.shadows;
      this.sun.castShadow = q.shadows;
    }
    if (prev.shadowMapSize !== q.shadowMapSize || prev.shadows !== q.shadows) this.configureShadow();
    this.sun.shadow.camera.right = -1; // force frustum refresh
    if (grassCapacity(prev) !== grassCapacity(q)) {
      this.scene.remove(this.grass.mesh);
      this.grass.dispose();
      this.grass = new GrassField(this.world, this.textures.noise, grassCapacity(q));
      this.scene.add(this.grass.mesh);
    }
    this.grass.configure(q.grassDensity, q.detailDistance);
    this.grass.uniforms.uSunDirW.value.copy(this.lightDir);
    this.grass.uniforms.uSunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    this.post?.dispose();
    this.post = q.postFX ? new PostFX(r, this.scene, this.camera, this.width, this.height, level, prev.antialias, this.aoExcluded) : null;
    this.post?.setNight(this._night);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    const r = this.renderer;
    r.domElement.removeEventListener('webglcontextlost', this.onLost);
    r.domElement.removeEventListener('webglcontextrestored', this.onRestored);
    this.post?.dispose();
    this.grass.dispose();
    this.decks.dispose();
    this.water.dispose();
    this.outer.dispose();
    this.terrain.dispose();
    this.groundMat.dispose();
    this.tileTex.dispose();
    this.sky.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.atmosphere.dispose();
    this.textures.dispose();
    this.sun.shadow.map?.dispose();
    this.scene.clear();
    r.dispose();
    r.domElement.remove();
  }

  /** Debug / harness helpers (not part of the contract). */
  debugInfo(): { calls: number; triangles: number; grassTufts: number; exposure: number } {
    const i = this.renderer.info.render;
    return { calls: i.calls, triangles: i.triangles, grassTufts: this.grass.count, exposure: this.exposure };
  }

  /** Snap exposure to its target (for screenshots / time jumps). */
  settle(): void {
    this.exposure = this.targetExposure;
    this.renderer.toneMappingExposure = this.exposure;
  }
}

