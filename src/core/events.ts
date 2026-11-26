// Typed event bus shared by the simulation, renderer layers and UI.

import type { CommandResult, SelectionRef, Tool } from './types';

export interface TileRect {
  x0: number;
  z0: number;
  x1: number; // inclusive
  z1: number; // inclusive
}

export type NotifyKind = 'info' | 'good' | 'warn' | 'bad';
/** Income category of a money popup (same values as the sim's IncomeKind). */
export type MoneyKind = 'admissions' | 'shopIncome' | 'donations' | 'other';
/** Audio category of a notification (set by the sim; picks the event sound). */
export type NotifySound = 'escape' | 'contain' | 'healed' | 'birth' | 'sick' | 'death' | 'hire' | 'sold' | 'debt' | 'day' | 'gate';

export interface GameEvents {
  /** Terrain types (and therefore heights near water) changed in this tile rect. */
  terrainChanged: TileRect;
  /** Path tiles changed in this tile rect. */
  pathChanged: TileRect;
  /** One or more fence edges changed (rect covers touched tiles). */
  fenceChanged: TileRect;
  objectAdded: { id: number };
  objectRemoved: { id: number };
  habitatsChanged: {};
  animalAdded: { id: number };
  animalRemoved: { id: number };
  guestAdded: { id: number };
  guestRemoved: { id: number };
  staffAdded: { id: number };
  staffRemoved: { id: number };
  litterAdded: { id: number };
  litterRemoved: { id: number };
  moneyChanged: { money: number; delta: number };
  /**
   * Toast message for the player, kept in the message log. `logOnly`: log it without a
   * toast, because something else on screen already shows it (e.g. the goal-complete card).
   */
  notify: {
    text: string;
    kind: NotifyKind;
    focus?: { x: number; z: number };
    logOnly?: boolean;
    /** audio category, set by the sim */
    sound?: NotifySound;
  };
  dayChanged: { day: number };
  objectiveCompleted: { id: string; text: string; reward: number };
  /** Floating "+$12" style feedback at a world position. */
  moneyPopup: { x: number; z: number; amount: number; kind?: MoneyKind };
  /** A bought animal was placed by the player (emitted right after animalAdded). */
  animalPlaced: { id: number; x: number; z: number };
  /** Fired by UI when the active tool changes. */
  toolChanged: { tool: Tool };
  /** Fired by UI when the selection changes (null = cleared). */
  selectionChanged: { selection: SelectionRef | null };
  /** Fired after a build command so UI/audio can react. */
  commandResult: CommandResult & { x?: number; z?: number };
  /** Whole world replaced (load game / new game) — views must rebuild everything. */
  worldReset: {};
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for ${String(type)} failed`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
