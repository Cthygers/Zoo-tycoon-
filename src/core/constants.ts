// Global world constants shared by every module.
//
// Coordinate conventions (IMPORTANT — every module relies on these):
//  - The playable map is MAP_W x MAP_H tiles. Tile (tx, tz) covers world X in
//    [tx*TILE, (tx+1)*TILE) and world Z in [tz*TILE, (tz+1)*TILE).
//  - World origin (0,0,0) is the corner of tile (0,0). +Y is up.
//  - Tile centre: x = (tx + 0.5) * TILE, z = (tz + 0.5) * TILE.
//  - Heading angle θ (radians): forward direction = (sin θ, 0, cos θ).
//    A model built facing local +Z gets the right orientation with
//    object.rotation.y = θ.
//  - The zoo entrance is on the south edge (max Z) at ENTRANCE_TILE.

export const TILE = 2; // metres per tile
export const MAP_W = 72; // tiles
export const MAP_H = 72; // tiles
export const WORLD_W = MAP_W * TILE; // metres
export const WORLD_H = MAP_H * TILE; // metres

/** Decorative, non-playable terrain ring drawn around the map (metres). */
export const OUTER_RING = 120;

/** Y of the water surface in ponds / pools. */
export const WATER_LEVEL = -0.32;
/** Depth of ground under a fully shallow-water tile corner. */
export const SHALLOW_DEPTH = 0.9;
/** Depth of ground under a fully deep-water tile corner. */
export const DEEP_DEPTH = 2.0;
/** Y of the walking surface of boardwalk decks built over water. */
export const DECK_Y = WATER_LEVEL + 0.25;
/**
 * Per-metre absorption of light in pond water (linear RGB: red goes first, then
 * green → teal shallows), shared by the lake bed and submerged creatures so
 * both sink into the same water colour.
 */
export const WATER_ABSORPTION: readonly [number, number, number] = [0.5, 0.19, 0.14];
/**
 * Mean linear albedo of the wet lake bed (the lakeBed ground layer in
 * render/textures.ts darkened by the ground shader's underwater wetness):
 * submerged creatures fade into it with the murk of their water column.
 */
export const LAKE_BED_WET_ALBEDO: readonly [number, number, number] = [0.044, 0.044, 0.021];
/**
 * three.js layer of meshes that only cast shadows (prop shadow batches): the
 * sun's shadow camera renders it, the main camera never even binds them.
 */
export const SHADOW_ONLY_LAYER = 1;

/** Entrance gate tile (centre of the south edge). Path starts here. */
export const ENTRANCE_TILE = { x: Math.floor(MAP_W / 2), z: MAP_H - 1 };
/** Tile rect of the paved plaza at the gate: its paths can't be bulldozed (guests must always get in). */
export const ENTRANCE_PLAZA = { x0: ENTRANCE_TILE.x - 2, z0: ENTRANCE_TILE.z - 2, x1: ENTRANCE_TILE.x + 2, z1: ENTRANCE_TILE.z };

/** Game clock: game-minutes that pass per simulated second at 1x speed. */
export const GAME_MINUTES_PER_SECOND = 3; // a full day ≈ 8 real minutes at 1x (opening hours ≈ 4 min)
export const MINUTES_PER_DAY = 24 * 60;
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 20;
export const START_MINUTE = 7 * 60 + 30; // game starts at 07:30 on day 1

export const START_MONEY = 60000;
export const DEFAULT_ADMISSION = 15;

export const SAVE_KEY = 'wildhaven-save-v1';
/** localStorage key for the chosen graphics quality tier. */
export const QUALITY_KEY = 'wildhaven-quality';
/** localStorage key for the sound on/off setting ('1' | '0'). */
export const SOUND_KEY = 'wildhaven-sound';
