// shared/limits.ts — numeric limits and the avatar list, shared by the game and the server.
// Constants only. No DOM, no Node APIs, no dependencies.
export const MAX_PROFILES_DEFAULT = 8;
export const AVATAR_ANIMALS = ['lion', 'giraffe', 'elephant', 'zebra', 'penguin', 'hippo', 'tiger', 'bear', 'gorilla', 'flamingo'] as const;
export const AVATAR_COLORS = 8;
export const NAME_MAX_GRAPHEMES = 16;
export const PREFS_MAX_BYTES = 4096;
export const META_MAX_BYTES = 2048;
export const SAVE_MAX_GZ_BYTES = 1_048_576;
export const SAVE_WARN_GZ_BYTES = 524_288;
export const SAVE_MAX_RAW_BYTES = 4_194_304;
export const FINAL_SAVE_MAX_GZ_BYTES = 262_144;
export const SNAPSHOTS_PER_CALL = 48;
export const UNIQUE_PLAY_THRESHOLD_S = 120;     // S1/S2: "2 minutes of unique play"
export const SOFT_DELETE_DAYS = 30;
export const LEASE_SECONDS_DEFAULT = 150;
