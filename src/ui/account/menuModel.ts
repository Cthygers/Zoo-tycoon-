// Pure view models of the title menu (spec §7.1, §6.8) and the "Who's playing?" picker (§3.3).
// The DOM code in screens.ts / picker.ts only draws what these return, so every case is tested
// without a browser (tests/account-menu.test.ts).
import type { Avatar, SaveMeta } from '../../../shared/api-types';
import type { AuthState, CachedProfile, SlotUiState } from '../../core/cloud-types';
import type { MenuResult, PlayerRef, SlotName } from '../../core/contracts';
import { GUEST, vsSlot } from '../../core/storage-keys';
import { metaLine } from './format';

/** How the cloud looks to the menu. */
export type CloudMode = 'disabled' | 'guest' | 'signed-in' | 'needs-signin';

export function cloudModeOf(s: AuthState): CloudMode {
  switch (s.kind) {
    case 'disabled':
      return 'disabled';
    case 'signed-in':
      return 'signed-in';
    case 'needs-signin':
      return 'needs-signin';
    default:
      return 'guest'; // guest and signing-in
  }
}

export interface MenuInput {
  cloud: CloudMode;
  /** The player the menu plays as ('guest' or a profile id). */
  player: PlayerRef;
  name: string | null;
  avatar: Avatar | null;
  /** The player's main zoo exists (on this phone or in the cloud). */
  hasZoo: boolean;
  /** The slot this player last played (readActiveSlot). */
  activeSlot: SlotName;
  /** The practice zoo exists. */
  hasPractice: boolean;
  /** An unfinished versus match the player last played. */
  activeMatch: { matchId: string } | null;
  /** Red dot on Versus: your turn, or a new result. */
  versusDot?: boolean;
}

export interface ConfirmText {
  title: string;
  text: string;
  ok: string;
}

export type MenuAction = { kind: 'result'; result: MenuResult; confirm?: ConfirmText } | { kind: 'versus' };

export type MenuButtonId = 'continue' | 'continueTutorial' | 'backToMatch' | 'new' | 'backToMain' | 'myZoo' | 'versus' | 'learn';

export interface MenuButton {
  id: MenuButtonId;
  label: string;
  style: 'primary' | 'ghost';
  action: MenuAction;
  dot?: boolean;
}

export type ChipModel =
  | { kind: 'signin'; label: 'Sign in' }
  | { kind: 'guest'; label: 'Guest' }
  | { kind: 'player'; name: string; avatar: Avatar | null; needsSignin: boolean };

export interface MenuModel {
  /** Top-right player chip (cloud builds only). */
  chip: ChipModel | null;
  /** Row 1, 52 px. */
  primary: MenuButton;
  /** Row 2, 44 px, side by side (empty when there is nothing else to offer). */
  row2: MenuButton[];
  /** Row 3 left: the "Learn to play" text link (every build). */
  learn: MenuButton;
  /** The account's session died: show "Sign in again" in the foot. */
  signinAgain: boolean;
}

export const NEW_ZOO_TITLE = 'Start a new zoo?';
export const NEW_ZOO_TEXT = 'Your saved zoo will be replaced the next time the game saves.';
export const NEW_ZOO_TEXT_CLOUD = 'Your saved zoo will be replaced on all your devices the next time the game saves.';

/** The New Zoo confirm text over an existing zoo ("…on all your devices…" for a signed-in player). */
export function newZooConfirm(cloud: CloudMode, player: PlayerRef): ConfirmText {
  const synced = player !== GUEST && (cloud === 'signed-in' || cloud === 'needs-signin');
  return { title: NEW_ZOO_TITLE, text: synced ? NEW_ZOO_TEXT_CLOUD : NEW_ZOO_TEXT, ok: 'New zoo' };
}

export function menuModel(i: MenuInput): MenuModel {
  const ref = i.player;
  const isProfile = ref !== GUEST && i.cloud !== 'disabled';
  const versusOk = isProfile && i.cloud === 'signed-in';
  const result = (r: Omit<MenuResult, 'player'>): MenuResult => ({ ...r, player: ref }) as MenuResult;

  const chip: ChipModel | null =
    i.cloud === 'disabled'
      ? null
      : isProfile
        ? { kind: 'player', name: i.name ?? 'Player', avatar: i.avatar, needsSignin: i.cloud === 'needs-signin' }
        : i.cloud === 'guest'
          ? { kind: 'signin', label: 'Sign in' }
          : { kind: 'guest', label: 'Guest' };

  const versus: MenuButton = { id: 'versus', label: 'Versus', style: 'ghost', action: { kind: 'versus' }, ...(i.versusDot ? { dot: true } : {}) };
  const newZoo = (confirm: boolean, extra: Partial<MenuResult> = {}): MenuButton => ({
    id: 'new',
    label: 'New Zoo',
    style: 'ghost',
    action: { kind: 'result', result: result({ kind: 'new', slot: 'main', ...extra }), ...(confirm ? { confirm: newZooConfirm(i.cloud, ref) } : {}) },
  });

  let primary: MenuButton;
  let row2: MenuButton[];
  if (i.activeMatch && isProfile) {
    const id = i.activeMatch.matchId;
    primary = { id: 'backToMatch', label: 'Back to your match', style: 'primary', action: { kind: 'result', result: result({ kind: 'versus', slot: vsSlot(id), matchId: id }) } };
    row2 = [
      i.hasZoo
        ? { id: 'myZoo', label: 'My zoo', style: 'ghost', action: { kind: 'result', result: result({ kind: 'continue', slot: 'main' }) } }
        : newZoo(false),
    ];
  } else if (i.activeSlot === 'practice' && i.hasPractice) {
    primary = { id: 'continueTutorial', label: 'Continue tutorial', style: 'primary', action: { kind: 'result', result: result({ kind: 'continue', slot: 'practice' }) } };
    row2 = [
      i.hasZoo
        ? { id: 'backToMain', label: 'Back to my zoo', style: 'ghost', action: { kind: 'result', result: result({ kind: 'continue', slot: 'main', discard: 'practice' }) } }
        : newZoo(false, { discard: 'practice' }),
    ];
  } else if (i.hasZoo) {
    const label = isProfile && i.name ? `Continue as ${i.name}` : 'Continue';
    primary = { id: 'continue', label, style: 'primary', action: { kind: 'result', result: result({ kind: 'continue', slot: 'main' }) } };
    row2 = [newZoo(true)];
  } else {
    primary = { ...newZoo(false), style: 'primary' };
    row2 = [];
  }
  if (versusOk) row2.push(versus);

  const learn: MenuButton = {
    id: 'learn',
    label: 'Learn to play',
    style: 'ghost',
    action: {
      kind: 'result',
      result: i.hasZoo ? result({ kind: 'tutorial', slot: 'practice' }) : result({ kind: 'new', slot: 'main', startTutorial: true }),
    },
  };

  return { chip, primary, row2, learn, signinAgain: isProfile && i.cloud === 'needs-signin' };
}

// ------------------------------------------------------------------ who's playing

export interface PickerTile {
  ref: PlayerRef;
  name: string;
  avatar: Avatar | null;
  /** "Day 15 · ★★★" / "No zoo yet". */
  line: string;
  /** Small cloud state (profiles only). */
  state: SlotUiState | null;
  /** "!" for a conflict, "⛔" for "update needed". */
  mark: '!' | '⛔' | null;
  /** The last player on this device (highlighted). */
  last: boolean;
}

/** The newer of the zoo on this phone and the cloud summary (the cloud one when this phone has none). */
export function profileMeta(p: CachedProfile): SaveMeta | null {
  return p.local.meta ?? p.main?.meta ?? null;
}

/** One tile per player, then the Guest tile (the "+ Add player" tile is drawn by the picker). */
export function pickerTiles(list: readonly CachedProfile[], last: PlayerRef, guestMeta: SaveMeta | null): PickerTile[] {
  const tiles: PickerTile[] = list.map((p) => ({
    ref: p.id,
    name: p.name,
    avatar: p.avatar,
    line: metaLine(profileMeta(p)),
    state: p.local.state,
    mark: p.local.state === 'conflict' ? '!' : p.local.state === 'blocked' ? '⛔' : null,
    last: p.id === last,
  }));
  tiles.push({ ref: GUEST, name: 'Guest', avatar: null, line: guestMeta ? metaLine(guestMeta) : 'Play on this phone', state: null, mark: null, last: last === GUEST && list.length > 0 });
  return tiles;
}

/** The player the menu starts with: the preselected one, else the last one, else (one player) that player. */
export function startPlayer(o: { mode: CloudMode; profiles: readonly { id: string }[]; preselect?: PlayerRef | null; last: PlayerRef }): PlayerRef {
  if (o.mode === 'disabled' || o.mode === 'guest') return GUEST;
  const valid = (r: PlayerRef | null | undefined): r is PlayerRef => !!r && (r === GUEST || o.profiles.some((p) => p.id === r));
  if (valid(o.preselect)) return o.preselect;
  if (o.last !== GUEST && valid(o.last)) return o.last;
  if (o.profiles.length === 1) return o.profiles[0].id;
  return GUEST;
}

/**
 * Open "Who's playing?" before the menu: on a cold start with 2+ players (spec §3.3), or when
 * "Switch player" asked for it. A preselected player (back from a match) skips it.
 */
export function openPickerFirst(o: { mode: CloudMode; profiles: number; preselect?: PlayerRef | null; forced: boolean }): boolean {
  if (o.mode !== 'signed-in' && o.mode !== 'needs-signin') return false;
  if (o.forced) return true;
  if (o.preselect) return false;
  return o.profiles >= 2;
}

/** A signed-in account with no players yet runs the first-player setup before anything else. */
export function needsFirstPlayer(mode: CloudMode, profiles: number): boolean {
  return mode === 'signed-in' && profiles === 0;
}

const MATCH_OVER = new Set(['finished', 'cancelled', 'expired']);

/**
 * "Back to your match": the stored versus record (wh2:vs:<pid>/<matchId>, spec §5.6) of the
 * player's active vs slot says the match is still on for this seat. No record → no button (the
 * Versus hub still lists the match).
 */
export function activeMatchFrom(raw: string | null, matchId: string | null): { matchId: string } | null {
  if (!matchId || !raw) return null;
  try {
    const r = JSON.parse(raw) as {
      ended?: unknown;
      lost?: unknown;
      match?: { id?: unknown; status?: unknown; mySeat?: unknown; players?: { seat?: unknown; state?: unknown; doneAt?: unknown }[] };
    };
    if (!r || typeof r !== 'object' || !r.match || r.match.id !== matchId) return null;
    if (r.ended || r.lost === true) return null;
    if (typeof r.match.status === 'string' && MATCH_OVER.has(r.match.status)) return null;
    const me = Array.isArray(r.match.players) ? r.match.players.find((p) => p && p.seat === r.match!.mySeat) : undefined;
    if (me && (me.state === 'done' || (me.doneAt !== null && me.doneAt !== undefined))) return null;
    return { matchId };
  } catch {
    return null;
  }
}
