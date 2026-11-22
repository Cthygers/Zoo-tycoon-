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

/** Entrance gate tile (centre of the south edge). Path starts here. */
export const ENTRANCE_TILE = { x: Math.floor(MAP_W / 2), z: MAP_H - 1 };

/** Game clock: game-minutes that pass per simulated second at 1x speed. */
export const GAME_MINUTES_PER_SECOND = 4; // a full day ≈ 6 real minutes at 1x
export const MINUTES_PER_DAY = 24 * 60;
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 20;
export const START_MINUTE = 7 * 60 + 30; // game starts at 07:30 on day 1

export const START_MONEY = 60000;
export const DEFAULT_ADMISSION = 20;

export const SAVE_KEY = 'wildhaven-save-v1';
