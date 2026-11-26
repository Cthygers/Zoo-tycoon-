// The one registry of local storage key names (feature round 14, spec §3.4 / §8.4).
// Every localStorage / sessionStorage key the game reads or writes for saves, players,
// sync and versus comes from here, so no two modules spell a key differently.
import type { PlayerRef, SlotKey, SlotName } from './contracts';
import { SAVE_KEY } from './constants';

export const GUEST: PlayerRef = 'guest';
export const BOOT_INTENT_KEY = 'wildhaven-boot';          // sessionStorage
export const KEYS = {
  guestMain: SAVE_KEY,                                     // 'wildhaven-save-v1'
  guestMainMoved: 'wildhaven-save-v1-moved',
  guestPractice: 'wildhaven-practice-v1',
  guestActive: 'wildhaven-active-slot',
  guestTutorial: 'wildhaven-tutorial',
  legacyTour: 'wildhaven-tour',                            // read-only
  device: 'wh2:device',
  auth: 'wh2:auth',
  last: 'wh2:last',
  index: 'wh2:index',
  slotPrefix: 'wh2:slot:',
  slot: (pid: string, slot: SlotName) => `wh2:slot:${pid}/${slot}`,
  bak: (pid: string) => `wh2:bak:${pid}/main`,
  remote: (pid: string) => `wh2:remote:${pid}/main`,
  bad: (pid: string, slot: SlotName, ts: number) => `wh2:bad:${pid}/${slot}:${ts}`,
  outbox: (accountId: string, matchId: string) => `wh2:outbox:${accountId}:${matchId}`,
  outboxDead: (accountId: string, matchId: string) => `wh2:outbox-dead:${accountId}:${matchId}`,
  vs: (pid: string, matchId: string) => `wh2:vs:${pid}/${matchId}`,
  vsIndex: (pid: string) => `wh2:vsidx:${pid}`,
  active: (pid: string) => `wh2:p:${pid}:active`,
  tutorial: (pid: string) => `wh2:p:${pid}:tutorial`,
} as const;

const VS_PREFIX = 'vs-';

/** True for 'main', 'practice' and 'vs-<id>' (non-empty id without '/'). */
function isSlotName(s: string): s is SlotName {
  if (s === 'main' || s === 'practice') return true;
  return s.length > VS_PREFIX.length && s.startsWith(VS_PREFIX) && !s.includes('/');
}

export function slotKey(player: PlayerRef, slot: SlotName): SlotKey { return `${player}/${slot}` as SlotKey; }

/**
 * 'guest/main' → { player: 'guest', slot: 'main' }; '<pid>/vs-<matchId>' → { player: pid, slot: 'vs-<matchId>' }.
 * Splits at the first '/' (player refs and server ids never contain one). Throws an Error on a
 * malformed key (no player, or a slot that is not main / practice / vs-<id>): a SlotKey read
 * back from storage should be parsed inside a try.
 */
export function parseSlotKey(key: SlotKey): { player: PlayerRef; slot: SlotName } {
  const k = String(key);
  const i = k.indexOf('/');
  const player = i > 0 ? k.slice(0, i) : '';
  const slot = i > 0 ? k.slice(i + 1) : '';
  if (!player || !isSlotName(slot)) throw new Error(`Bad slot key: ${JSON.stringify(k)}`);
  return { player, slot };
}

export function isLocalOnly(slot: SlotName): boolean { return slot !== 'main'; }
export function vsSlot(matchId: string): SlotName { return `vs-${matchId}`; }

/** 'vs-<id>' → id; null for 'main', 'practice' and anything else. */
export function matchIdOf(slot: SlotName): string | null {
  const s = String(slot);
  return s.length > VS_PREFIX.length && s.startsWith(VS_PREFIX) ? s.slice(VS_PREFIX.length) : null;
}
