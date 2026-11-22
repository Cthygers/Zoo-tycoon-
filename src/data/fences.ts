import { PathType, type FenceDef, type PathDef } from '../core/types';

export const FENCES: FenceDef[] = [
  { id: 1, key: 'wood', name: 'Timber Rail Fence', strength: 1, costPerSegment: 30, visibility: 0.9, height: 1.3, description: 'Post-and-rail fence. Only for gentle grazers.' },
  { id: 2, key: 'chainlink', name: 'Chain-Link Fence', strength: 2, costPerSegment: 55, visibility: 0.75, height: 2.2, description: 'Galvanised mesh on steel posts.' },
  { id: 3, key: 'stone', name: 'Stone Wall', strength: 3, costPerSegment: 90, visibility: 0.25, height: 1.6, description: 'Dry-stone wall — strong but hides the view.' },
  { id: 4, key: 'glass', name: 'Glass Viewing Wall', strength: 3, costPerSegment: 140, visibility: 1.0, height: 2.0, description: 'Toughened glass panels — perfect views for guests.' },
  { id: 5, key: 'steel', name: 'Heavy Steel Barrier', strength: 4, costPerSegment: 120, visibility: 0.6, height: 2.8, description: 'Tall vertical steel bars for the most powerful animals.' },
];

export const FENCES_BY_ID: Record<number, FenceDef> = Object.fromEntries(FENCES.map((f) => [f.id, f]));

export const PATHS: PathDef[] = [
  { type: PathType.Paved, name: 'Stone Pavers', costPerTile: 20, description: 'Clean, hard-wearing paving.' },
  { type: PathType.Gravel, name: 'Gravel Path', costPerTile: 10, description: 'Cheap and natural-looking.' },
  { type: PathType.Boardwalk, name: 'Timber Boardwalk', costPerTile: 30, description: 'Raised deck — can cross water.' },
];

export const PATHS_BY_TYPE: Record<number, PathDef> = Object.fromEntries(PATHS.map((p) => [p.type, p]));
