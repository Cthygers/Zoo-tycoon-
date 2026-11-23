// The render context: WebGL2 renderer, camera, sky / time of day, sun & moon
// light with camera-fitted texel-snapped shadows, PMREM environment, ground
// (terrain + outer landscape + impostor forest), water, boardwalk decks,
// grass and (high tier) post FX.

import * as THREE from 'three';
import { MAP_H, MAP_W, WORLD_H, WORLD_W } from '../core/constants';
import type { IRenderContext, QualityLevel, QualitySettings } from '../core/contracts';
import type { EventBus, TileRect } from '../core/events';
import type { World } from '../core/world';
import { AtmosphereModel } from './atmosphere';
import { BoardwalkDecks } from './boardwalk';
import { computeCelestial, type Celestial } from './celestial';
import { MESOPIC_EXPOSURE, installShaderPatches } from './grade';
import { GrassField, type TuftShape } from './grass';
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
 * Direct sun light relative to the sky model at high sun. The single-
 * scattering sky is somewhat too dark compared with the sun (≈1:14 vs ≈1:6
 * measured on clear days), which makes shadows black; scaling the direct term
 * restores a realistic shadow ratio. At low sun the direct share grows again
 * (warm, contrasty golden hour light grazing the grass).
 */
const SUN_LIGHT_HIGH = 0.55;
const SUN_LIGHT_LOW = 0.85;
/** Moonlight luminance on the ground for a full moon high in the sky. */
const MOON_LUM = 0.08;
const DEG = Math.PI / 180;
const FOG_DENSITY = 0.00085;
const GROUND_ALBEDO = new THREE.Color(0.1, 0.12, 0.065);
const BANK_ALBEDO = new THREE.Color(0.05, 0.07, 0.035);
const MOON_TINT = new THREE.Color(0.52, 0.68, 1.0);
/** Blue-hour sky colour (luminance 1), see the sky shader's uTwilight. */
const TWILIGHT_BLUE = new THREE.Color(0.646, 0.999, 2.056);

/** Pull a colour toward TWILIGHT_BLUE at equal luminance. */
function twilightTint(c: THREE.Color, k: number): THREE.Color {
  if (k <= 0) return c;
  const l = luminance(c);
  return c.setRGB(c.r + (l * TWILIGHT_BLUE.r - c.r) * k, c.g + (l * TWILIGHT_BLUE.g - c.g) * k, c.b + (l * TWILIGHT_BLUE.b - c.b) * k);
}

/**
 * Ground illuminance from sun + sky (luminance units) the scene should have at
 * a given sun elevation (deg). Above ~25° the physical model is used as is;
 * lower, the light is lifted (partial adaptation baked into the light so the
 * exposure stays photopic through golden hour and sunset).
 */
const E_TABLE: [number, number][] = [
  [-16, 0.002],
  [-12, 0.014],
  [-8, 0.055],
  [-4, 0.15],
  [0, 0.32],
  [5, 0.6],
  [10, 0.85],
  [15, 1.0],
];
/** Displayed brightness (E × exposure) per sun elevation: noon → night. */
// (ACES has a deep toe: dim scenes need a higher B to stay readable)
const B_TABLE: [number, number][] = [
  [-12, 0.85],
  [-8, 0.93],
  [-4, 1.05],
  [0, 1.3],
  [5, 1.8],
  [10, 2.25],
  [20, 2.75],
  [40, 2.85],
];

function tableLog(t: [number, number][], x: number): number {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) {
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      const k = (x - x0) / (x1 - x0);
      return Math.exp(Math.log(y0) * (1 - k) + Math.log(y1) * k);
    }
  }
  return t[t.length - 1][1];
}

function smooth01(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

function rrt(v: number): number {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

/**
 * CPU twin of the CustomToneMapping grade (grade.ts) + ACES: maps a linear HDR
 * colour to the linear display value the shaders would output. Used for the
 * fog / clear colour, which three mixes in after tone mapping.
 */
export function gradeToneMap(c: THREE.Color, exposure: number, out: THREE.Color): THREE.Color {
  let r = c.r,
    g = c.g,
    b = c.b;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const disp = lum * exposure;
  const meso = smooth01(MESOPIC_EXPOSURE[0], MESOPIC_EXPOSURE[1], exposure) * (1 - smooth01(0.06, 0.5, disp)) * 0.82;
  const rod = 0.03 * r + 0.55 * g + 0.62 * b;
  r += (rod * 0.6 - r) * meso;
  g += (rod * 0.8 - g) * meso;
  b += (rod * 1.28 - b) * meso;
  const k = disp / (disp + 0.3);
  r = Math.max(lum + (r - lum) * 1.06, 0) * (0.965 + 0.07 * k);
  g = Math.max(lum + (g - lum) * 1.06, 0) * (0.99 + 0.01 * k);
  b = Math.max(lum + (b - lum) * 1.06, 0) * (1.045 - 0.085 * k);
  const s = exposure / 0.6;
  r *= s;
  g *= s;
  b *= s;
  const x = rrt(0.59719 * r + 0.35458 * g + 0.04823 * b);
  const y = rrt(0.076 * r + 0.90834 * g + 0.01566 * b);
  const z = rrt(0.0284 * r + 0.13383 * g + 0.83777 * b);
  return out.setRGB(
    clamp01(1.60475 * x - 0.53108 * y - 0.07367 * z),
    clamp01(-0.10208 * x + 1.10813 * y - 0.00605 * z),
    clamp01(-0.00327 * x - 0.07276 * y + 1.07602 * z),
  );
}

/** Per-tier environment detail (the contract's QualitySettings stay generic). */
interface EnvTier {
  trees: number;
  nearSprites: number;
  farSprites: number;
  grassCapacity: number;
  tuft: TuftShape;
  /** Shadows reach this far beyond the camera focus (m)… */
  shadowReach: number;
  /** …within a light-space box of at most this half size around the focus (m). */
  shadowMaxHalf: number;
}
const ENV_TIERS: Record<QualityLevel, EnvTier> = {
  low: { trees: 420, nearSprites: 7, farSprites: 4, grassCapacity: 1000, tuft: { blades: 6, segs: 2 }, shadowReach: 26, shadowMaxHalf: 60 },
  medium: { trees: 820, nearSprites: 11, farSprites: 5, grassCapacity: 1900, tuft: { blades: 7, segs: 2 }, shadowReach: 42, shadowMaxHalf: 85 },
  high: { trees: 1400, nearSprites: 14, farSprites: 7, grassCapacity: 3400, tuft: { blades: 8, segs: 3 }, shadowReach: 70, shadowMaxHalf: 120 },
};

/** Camera frustum rays (NDC x, y pairs) used to fit the shadow box. */
const NDC_RAYS = [-1, -1, 1, -1, 1, 1, -1, 1, 0, 1];
/** Quantise a shadow-box half size up to ≈9 % steps (stable texel size). */
function quantiseHalf(v: number): number {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(v, 8)) * 8) / 8);
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
  /** Fog / horizon radiance in HDR (before tone mapping). */
  private fogHDR = new THREE.Color();

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
  private cel: Celestial = { sunElev: 0, moonElev: 0, moonIllum: 0 };
  private sunCol = new THREE.Color();
  private moonCol = new THREE.Color();
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();
  private skyIrr = new THREE.Color();
  private mountainAmb = new THREE.Color();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private lightDir = new THREE.Vector3(0, 1, 0);
  private shUp = new THREE.Vector3();
  private shCenter = new THREE.Vector3();
  private shRight = new THREE.Vector3();

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
  private shadowHalf = new THREE.Vector2(-1, -1);

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
    installShaderPatches();
    this.container = container;
    this.world = world;
    this.events = events;
    this.quality = qualitySettings(level);
    const env = ENV_TIERS[level];

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
    // ACES filmic with the colour grade folded in (grade.ts)
    r.toneMapping = THREE.CustomToneMapping;
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
    this.outer = new OuterLand(world, this.groundMat, {
      treeCount: env.trees,
      nearSprites: env.nearSprites,
      farSprites: env.farSprites,
      foliage: this.textures.foliage,
      msaa: q.antialias,
    });
    this.scene.add(this.outer.group);

    this.water = new WaterSurface(world, this.textures.waves, this.textures.noise, (x, z) => this.outer.heights.height(x, z));
    this.scene.add(this.water.mesh);
    this.decks = new BoardwalkDecks(world);
    this.scene.add(this.decks.mesh);

    this.grass = new GrassField(world, this.textures.noise, env.grassCapacity, env.tuft);
    this.grass.configure(q.grassDensity, q.detailDistance);
    this.scene.add(this.grass.mesh);

    if (q.postFX) this.post = new PostFX(r, this.scene, this.camera, this.width, this.height, q.antialias);

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
    this.shadowHalf.set(-1, -1);
  }

  // ------------------------------------------------------------ time of day
  setTimeOfDay(minuteOfDay: number, day: number): void {
    this.clockMinute = minuteOfDay;
    this.clockDay = day;
    this.applyLighting();
  }

  private applyLighting(): void {
    const cel = computeCelestial(this.clockMinute, this.clockDay, this.sunDirection, this.moonDir, this.cel);
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

    // ---- natural light: sun (direct) + sky, lifted at low sun (see E_TABLE)
    atm.transmittance(sunElev, atm.observerKm, this.sunCol);
    // the model reddens the mid-morning / late-afternoon sun a little too much;
    // keep the deep orange for the last few degrees only
    const desat = (0.12 + 0.18 * smooth01(4, 12, se)) * (1 - smooth01(25, 45, se));
    if (desat > 0) {
      const l = luminance(this.sunCol);
      this.sunCol.lerp(this.tmpC.setRGB(l, l, l), desat);
    }
    const sunLight = SUN_LIGHT_HIGH + (SUN_LIGHT_LOW - SUN_LIGHT_HIGH) * (1 - smooth01(4, 32, se));
    const sunY = Math.max(this.sunDirection.y, 0);
    const natural = luminance(this.sunCol) * SUN_E * sunLight * sunY + luminance(atm.skyIrradiance) * SUN_E;
    let lift = 1;
    if (se < 25) {
      const want = tableLog(E_TABLE, se);
      const k = smooth01(15, 25, se); // blend back to the physical value above 15°
      lift = Math.min(Math.max(want / Math.max(natural, 1e-7), 1), 3000);
      lift = Math.exp(Math.log(lift) * (1 - k));
    }
    const skyE = SUN_E * lift;

    // ---- moon: fades in as the sky darkens, blue-tinted (night grade desaturates further)
    const moonUp = smooth01(-2, 8, cel.moonElev / DEG);
    const sunDown = smooth01(-3, -10, se);
    atm.transmittance(Math.max(cel.moonElev, -0.2), atm.observerKm, this.moonCol);
    const tl = luminance(this.moonCol);
    const moonLumTarget = MOON_LUM * moonUp * (0.3 + 0.7 * cel.moonIllum) * sunDown;
    // colour × intensity such that luminance × sin(elev) ≈ target at the zenith-ish moon
    this.moonCol
      .multiply(MOON_TINT)
      .multiplyScalar(tl > 1e-5 ? moonLumTarget / Math.max(luminance(this.tmpC.copy(this.moonCol)), 1e-5) : 0);

    const sunLum = luminance(this.sunCol) * skyE * sunLight * sunY;
    const moonLum = luminance(this.moonCol) * Math.max(this.moonDir.y, 0);
    const useMoon = moonLum > sunLum;
    if (useMoon) {
      this.lightDir.copy(this.moonDir);
      this.sun.color.copy(this.moonCol);
      this.sun.intensity = 1;
      this.sun.shadow.intensity = 0.7;
    } else {
      this.lightDir.copy(this.sunDirection);
      this.sun.color.copy(this.sunCol);
      this.sun.intensity = skyE * sunLight;
      this.sun.shadow.intensity = 1;
    }
    if (this.lightDir.y < 0.02) {
      // never light from below the horizon
      this.lightDir.y = 0.02;
      this.lightDir.normalize();
    }

    // ---- sky irradiance and colours (blue hour: see twilightTint)
    const twilight = 0.85 * smooth01(1.5, -4, se);
    const skyIrr = twilightTint(this.skyIrr.copy(atm.skyIrradiance).multiplyScalar(skyE), twilight);
    const nightSky = this.tmpC2.setRGB(0.0009, 0.0017, 0.0042).multiplyScalar(0.5 + 1.6 * moonUp * cel.moonIllum).multiplyScalar(night);
    skyIrr.add(this.tmpC.copy(nightSky).multiplyScalar(2.2));
    const u = this.sky.uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    u.uMoonDir.value.copy(this.moonDir);
    u.uSunE.value = skyE;
    u.uSunDisc.value.copy(this.sunCol).multiplyScalar(skyE * 18);
    u.uMoonColor.value.setRGB(0.95, 0.95, 0.92).multiplyScalar((0.2 + 0.8 * cel.moonIllum) * (0.25 + 0.75 * night) * 0.28);
    u.uNight.value = night;
    u.uTwilight.value = twilight;
    u.uNightSky.value.copy(nightSky);
    u.uHorizonGlow.value.setRGB(0.0035, 0.0028, 0.0022).multiplyScalar(night);
    // clouds lit by the sun colour at ~2 km (stays warm after ground sunset)
    const cloudSun = atm.transmittance(sunElev, 3.5, u.uCloudSun.value).multiplyScalar(skyE * 0.32);
    cloudSun.add(this.tmpC.copy(this.moonCol).multiplyScalar(0.9));
    u.uCloudAmb.value.copy(skyIrr).multiplyScalar(1 / Math.PI).add(this.tmpC.copy(nightSky).multiplyScalar(1.4));
    // ground radiance below the horizon (env map bounce)
    const groundIrr = this.tmpC.copy(this.sun.color).multiplyScalar(this.sun.intensity * Math.max(this.lightDir.y, 0)).add(skyIrr);
    u.uGround.value.copy(groundIrr).multiply(GROUND_ALBEDO).multiplyScalar(1 / Math.PI);

    // ---- fog = horizon radiance (HDR; converted to display values per frame)
    twilightTint(this.fogHDR.copy(atm.horizon).multiplyScalar(skyE), twilight * 0.8);
    this.fogHDR.add(this.tmpC.copy(nightSky).multiplyScalar(1.5)).add(this.tmpC2.copy(u.uHorizonGlow.value).multiplyScalar(0.3));

    // hemisphere fill: low, mostly to lift deep shadows and for env-less materials
    this.hemi.color.copy(skyIrr).multiplyScalar(0.25 / Math.PI);
    this.hemi.groundColor.copy(u.uGround.value).multiplyScalar(0.6);
    this.hemi.intensity = 1;

    // water: reflected banks ≈ dark foliage lit by sky + sun, blended with haze
    this.water.uniforms.uBank.value
      .copy(this.tmpC.copy(this.sun.color).multiplyScalar(this.sun.intensity * Math.max(this.lightDir.y, 0) * 0.5))
      .add(skyIrr)
      .multiply(BANK_ALBEDO)
      .multiplyScalar(1 / Math.PI)
      .lerp(this.fogHDR, 0.25);

    // ground contact shadows of the outer forest
    this.outer.updateTreeShadows(this.sunDirection, (1 - night) * Math.min(1, Math.max(0, se / 6)));

    // mountains (own haze in HDR)
    this.mountainAmb.copy(skyIrr).multiplyScalar(1 / Math.PI);
    this.outer.setMountainLight(this.fogHDR, this.tmpC.copy(this.sun.color).multiplyScalar(this.sun.intensity / Math.max(sunLight, 0.1)), this.mountainAmb, this.lightDir);

    // distant forest
    const fu = this.outer.forest.uniforms;
    fu.uSunDir.value.copy(this.lightDir);
    fu.uSunE.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    fu.uSkyE.value.copy(skyIrr);
    fu.uGroundE.value.copy(groundIrr).multiply(GROUND_ALBEDO).multiplyScalar(0.9);

    // ground / grass shader inputs
    this.groundU.uSunDirW.value.copy(this.lightDir);
    this.groundU.uSunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    this.groundU.uCloudShadow.value = 0.45 * (1 - night) * Math.min(1, Math.max(0, se / 8));
    this.grass.uniforms.uSunDirW.value.copy(this.lightDir);
    this.grass.uniforms.uSunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);

    // ---- exposure: displayed brightness per sun elevation (B_TABLE) / scene light
    const E = Math.max(sunLum, moonLum) + luminance(skyIrr) + 1e-5;
    const B = tableLog(B_TABLE, se);
    this.targetExposure = Math.min(Math.max(B / E, 0.7), 20);

    // PMREM refresh (≈50 draws + blur passes): only every ~4° of sun motion
    if (Math.abs(sunElev - this.envSunElev) > 4 * DEG) this.envDirty = true;
    this.post?.setNight(night);
  }

  // ------------------------------------------------------------ focus / shadows
  setFocus(x: number, z: number, viewRadius: number): void {
    this.focus.set(x, this.world.heightAt(x, z), z);
    this.viewRadius = Math.max(5, viewRadius);
  }

  /**
   * Fit the orthographic shadow frustum to the ground the camera actually sees
   * within the tier's shadow distance (camera frustum ∩ ground, plus a few
   * metres of receiver height), in light space; sizes are quantised and the
   * centre texel-snapped so shadows do not swim. Casters outside the fitted box
   * are culled from the shadow pass; shadows fade out at its edge (grade.ts).
   */
  private updateShadowFrustum() {
    if (!this.quality.shadows) return;
    const env = ENV_TIERS[this.quality.level];
    const cam = this.camera;
    cam.updateMatrixWorld();
    const cp = cam.position;
    const gy = this.focus.y;
    const reach = cp.distanceTo(this.focus) + env.shadowReach;
    const camH = Math.max(cp.y - gy, 0.5);
    const horiz = Math.sqrt(Math.max(reach * reach - camH * camH, 25));

    const dir = this.lightDir;
    const right = this.shRight.set(0, 1, 0).cross(dir);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = this.shUp.crossVectors(dir, right).normalize();

    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    const p = this.tmpV;
    const d = this.tmpV2;
    for (let r = 0; r < NDC_RAYS.length; r += 2) {
      d.set(NDC_RAYS[r], NDC_RAYS[r + 1], 0.5).unproject(cam).sub(cp).normalize();
      let hit = false;
      if (d.y < -1e-4) {
        const t = (gy - cp.y) / d.y;
        p.copy(cp).addScaledVector(d, t);
        hit = Math.hypot(p.x - cp.x, p.z - cp.z) <= horiz;
      }
      if (!hit) {
        const hl = Math.hypot(d.x, d.z) || 1;
        p.set(cp.x + (d.x / hl) * horiz, gy, cp.z + (d.z / hl) * horiz);
      }
      for (let k = 0; k < 2; k++) {
        const y = gy + (k ? 5 : -0.5);
        const lx = p.x * right.x + y * right.y + p.z * right.z;
        const ly = p.x * up.x + y * up.y + p.z * up.z;
        if (lx < minX) minX = lx;
        if (lx > maxX) maxX = lx;
        if (ly < minY) minY = ly;
        if (ly > maxY) maxY = ly;
      }
    }
    // never more than the tier's box around the focus (zoomed-out views lose
    // their farthest shadows rather than all shadow resolution)
    const f = this.focus;
    const fx = f.x * right.x + f.y * right.y + f.z * right.z;
    const fy = f.x * up.x + f.y * up.y + f.z * up.z;
    const M = env.shadowMaxHalf;
    minX = Math.max(minX, fx - M);
    maxX = Math.min(maxX, fx + M);
    minY = Math.max(minY, fy - M);
    maxY = Math.min(maxY, fy + M);
    // quantise the extents so small camera moves keep the texel size
    const hw = quantiseHalf((maxX - minX) / 2 + 2),
      hh = quantiseHalf((maxY - minY) / 2 + 2);
    const sc = this.sun.shadow.camera;
    const size = this.quality.shadowMapSize;
    if (hw !== this.shadowHalf.x || hh !== this.shadowHalf.y) {
      this.shadowHalf.set(hw, hh);
      sc.left = -hw;
      sc.right = hw;
      sc.top = hh;
      sc.bottom = -hh;
      sc.updateProjectionMatrix();
      this.sun.shadow.normalBias = 0.02 + ((Math.max(hw, hh) * 2) / size) * 1.2;
    }
    const tx = (hw * 2) / size,
      ty = (hh * 2) / size;
    const cx = Math.round((minX + maxX) / 2 / tx) * tx;
    const cy = Math.round((minY + maxY) / 2 / ty) * ty;
    // centre: (cx, cy) in light space, depth of the focus along the light
    const depth = this.focus.dot(dir);
    const center = this.shCenter.copy(right).multiplyScalar(cx).addScaledVector(up, cy).addScaledVector(dir, depth);
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

    // exposure adaptation (~1.5 s time constant, in log space)
    const k = 1 - Math.exp(-dt / 1.5);
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(this.targetExposure) - Math.log(this.exposure)) * k);
    this.applyExposure();

    // clouds drift
    this.cloudOffset.set(t * 0.0045, t * 0.0021);
    this.sky.uniforms.uCloudOffset.value.copy(this.cloudOffset);
    this.sky.uniforms.uTime.value = t;
    this.groundU.uCloudOffset.value.copy(this.cloudOffset);
    this.groundU.uTime.value = t;
    this.outer.forest.uniforms.uTime.value = t;
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

  /** Exposure → renderer, and the display-referred fog / clear colour. */
  private applyExposure(): void {
    this.renderer.toneMappingExposure = this.exposure;
    if (this.post) this.fog.color.copy(this.fogHDR);
    else gradeToneMap(this.fogHDR, this.exposure, this.fog.color);
    this.renderer.setClearColor(this.fog.color);
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
    // throttled while time flows; a jump (load, skip, settle) refreshes at once
    const jump = Math.abs(Math.asin(this.sunDirection.y) - this.envSunElev) > 10 * DEG;
    if (this.envRT && this.envAge < 2 && !jump) return;
    // the sky is smooth: 128² faces are plenty for rough ground / foliage on low
    const size = this.quality.level === 'low' ? 128 : 256;
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 10, { size });
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
    this.shadowHalf.set(-1, -1); // force frustum refresh
    const envPrev = ENV_TIERS[prev.level],
      env = ENV_TIERS[level];
    if (envPrev.grassCapacity !== env.grassCapacity || envPrev.tuft.blades !== env.tuft.blades || envPrev.tuft.segs !== env.tuft.segs) {
      this.scene.remove(this.grass.mesh);
      this.grass.dispose();
      this.grass = new GrassField(this.world, this.textures.noise, env.grassCapacity, env.tuft);
      this.scene.add(this.grass.mesh);
    }
    this.grass.configure(q.grassDensity, q.detailDistance);
    if (envPrev.trees !== env.trees || envPrev.nearSprites !== env.nearSprites || envPrev.farSprites !== env.farSprites) {
      this.outer.setForest({
        treeCount: env.trees,
        nearSprites: env.nearSprites,
        farSprites: env.farSprites,
        foliage: this.textures.foliage,
        msaa: prev.antialias,
      });
      this.applyLighting(); // re-places the forest's ground shadows
    }
    this.grass.uniforms.uSunDirW.value.copy(this.lightDir);
    this.grass.uniforms.uSunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    this.post?.dispose();
    this.post = q.postFX ? new PostFX(r, this.scene, this.camera, this.width, this.height, prev.antialias) : null;
    this.post?.setNight(this._night);
    this.applyExposure();
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
  debugInfo(): {
    calls: number;
    triangles: number;
    grassTufts: number;
    exposure: number;
    terrainTris: number;
    forestTris: number;
    shadowBox: [number, number];
  } {
    const i = this.renderer.info.render;
    return {
      calls: i.calls,
      triangles: i.triangles,
      grassTufts: this.grass.count,
      exposure: this.exposure,
      terrainTris: this.terrain.triangles,
      forestTris: this.outer.forest.triangles,
      shadowBox: [this.shadowHalf.x * 2, this.shadowHalf.y * 2],
    };
  }

  /** Snap exposure to its target (for screenshots / time jumps). */
  settle(): void {
    this.applyLighting();
    this.exposure = this.targetExposure;
    this.applyExposure();
    this.envDirty = true;
    this.envAge = 1e9;
  }
}
