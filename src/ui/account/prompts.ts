// SyncPrompts (spec §3.11): the dialogs the sync engine asks through. Conflict and lease-lost
// choices show two cards titled by device; the card with more unique play gets the "Newest"
// ribbon and the filled "Keep this one" button. The wording and the card choice are pure
// functions (tests/account-prompts.test.ts); createSyncPrompts only draws them.
import type { Avatar } from '../../../shared/api-types';
import { UNIQUE_PLAY_THRESHOLD_S } from '../../../shared/limits';
import type { CloudHandle, ConflictInfo, LeaseLostInfo, NoticeKind, SaveCard, SyncPrompts, TakeoverInfo } from '../../core/cloud-types';
import { button, el } from '../dom';
import { avatarEl, confirmBox, notice, openModal, showToast } from './dialog';
import { animalsText, fmtAgo, fmtClock, fmtDuration, fmtStars, fmtWallTime } from './format';
import { fmtMoney } from '../../core/format';

export type Side = 'here' | 'other';

/** The side with more unique play (the Newest ribbon and the primary button); a tie keeps the engine's flag, then this phone. */
export function newestSide(info: { here: SaveCard; other: SaveCard }): Side {
  const h = info.here.uniquePlaySeconds;
  const o = info.other.uniquePlaySeconds;
  if (h > o) return 'here';
  if (o > h) return 'other';
  if (info.other.newest && !info.here.newest) return 'other';
  return 'here';
}

/** "played 1 h 10 min more" on the newest card (nothing when the difference is under a minute). */
export function playedMoreText(info: { here: SaveCard; other: SaveCard }): { side: Side; text: string } | null {
  const side = newestSide(info);
  const diff = Math.abs(info.here.uniquePlaySeconds - info.other.uniquePlaySeconds);
  if (diff < 60) return null;
  return { side, text: `played ${fmtDuration(diff)} more` };
}

/** Card title: "This phone" for this device, else the other device's name ("Tablet"). */
export function cardTitle(card: SaveCard): string {
  if (card.thisDevice) return 'This phone';
  return card.deviceName.trim() || 'Another device';
}

/** The lines of one card, top to bottom (without the title and the played-more line). */
export function cardLines(card: SaveCard, now: number): string[] {
  const m = card.meta;
  return [
    `Day ${m.day} · ${fmtClock(m.minute)}`,
    [fmtMoney(m.money), fmtStars(m.rating), animalsText(m.animals)].filter(Boolean).join('   '),
    card.playingNow ? 'playing now' : `saved ${fmtAgo(card.savedAt, now)}`,
  ];
}

export const CONFLICT_TEXT = 'Which one do you want to keep playing? The other one is kept as a backup.';

export function conflictTitle(name: string): string {
  return `You have two different zoos for ${name}`;
}

/** Lease lost: a notice when this phone has ≤ 120 s of unique play, else the two-card choice (S1). */
export function leaseLostMode(info: Pick<LeaseLostInfo, 'localDeltaSeconds'>): 'notice' | 'choice' {
  return info.localDeltaSeconds > UNIQUE_PLAY_THRESHOLD_S ? 'choice' : 'notice';
}

/** "Mia's zoo is open on Tablet now." */
export function movedTitle(name: string, device: string | undefined): string {
  return `${name}'s zoo is open on ${device || 'another device'} now.`;
}

/** "What you did here since 14:05 is kept as a backup." */
export function movedText(since: number | undefined): string {
  const t = since ? fmtWallTime(since) : '';
  return t ? `What you did here since ${t} is kept as a backup.` : 'What you did here is kept as a backup.';
}

/** The lease-lost card headings: "This phone: 1 h of play since 14:05" / "Tablet, playing now". */
export function leaseCardTitles(info: LeaseLostInfo): { here: string; other: string } {
  const t = fmtWallTime(info.since);
  return {
    here: `This phone: ${fmtDuration(info.localDeltaSeconds)} of play${t ? ` since ${t}` : ''}`,
    other: `${cardTitle(info.other)}, playing now`,
  };
}

/** Takeover question (409 in_use). */
export function takeoverText(info: TakeoverInfo, now: number): { title: string; text: string } {
  const dev = info.holderDevice || 'another device';
  const ago = fmtAgo(info.lastSeenAt, now);
  return {
    title: `${info.profileName} is playing on ${dev}`,
    text: `${info.profileName} is playing on ${dev} right now (${ago}). If you play here, the ${dev} will stop.`,
  };
}

/** Title and text of each notice. */
export function noticeText(kind: NoticeKind, info: { profileName: string; deviceName?: string; since?: number }): { title: string; text?: string } {
  const name = info.profileName || 'This player';
  switch (kind) {
    case 'moved':
      return { title: movedTitle(name, info.deviceName), text: movedText(info.since) };
    case 'profileGone':
      return { title: `${name} was removed on another device.`, text: 'A grown-up can bring the player back in Manage players.' };
    case 'newerVersion':
      return { title: `Update Wildhaven to open ${name}'s zoo.`, text: 'This zoo was saved by a newer version of the game.' };
    case 'tooLarge':
      return { title: 'This zoo is too big to save online.', text: 'It is still saved on this phone.' };
    case 'matchLost':
      return { title: 'This match was lost.', text: 'Your zoo is kept as practice.' };
    default:
      return { title: name };
  }
}

/** The two cards with their buttons; resolves with the side whose button was tapped. */
function chooseCards(
  root: HTMLElement,
  o: { title: string; text: string; info: { here: SaveCard; other: SaveCard }; titles: { here: string; other: string }; avatar: Avatar | null; more?: boolean },
): Promise<Side> {
  const now = Date.now();
  const newest = newestSide(o.info);
  const more = o.more === false ? null : playedMoreText(o.info);
  let pick: (s: Side) => void = () => {};
  const card = (side: Side): HTMLElement => {
    const c = side === 'here' ? o.info.here : o.info.other;
    const isNew = side === newest;
    const lines = cardLines(c, now);
    return el('div', { class: `wh-ac-card${isNew ? ' newest' : ''}`, attrs: { 'data-side': side } }, [
      isNew ? el('div', { class: 'wh-ac-ribbon', text: 'Newest' }) : null,
      el('div', 'wh-ac-card-h', [o.avatar ? avatarEl(o.avatar, 32) : null, el('span', { text: o.titles[side] })]),
      el('div', { class: 'wh-ac-card-l', text: lines[0] }),
      el('div', { class: 'wh-ac-card-l', text: lines[1] }),
      more && more.side === side ? el('div', { class: 'wh-ac-card-l more', text: more.text }) : null,
      c.playingNow && /playing now$/.test(o.titles[side]) ? null : el('div', { class: 'wh-ac-card-l faint', text: lines[2] }),
      button(isNew ? 'wh-btn-primary' : 'wh-btn-ghost', null, 'Keep this one', () => pick(side), `Keep ${o.titles[side]}`),
    ]);
  };
  const body = el('div', 'wh-ac-cards', [card('here'), card('other')]);
  const m = openModal<Side>(root, { title: o.title, text: o.text, body, buttons: [], wide: true, cls: 'wh-ac-choice' });
  pick = (s) => m.close(s);
  (body.querySelector('.wh-btn-primary') as HTMLElement | null)?.focus({ preventScroll: true });
  return m.done;
}

/**
 * The sync prompts drawn in `root`'s account layer. `cloud` (optional) lets the cards show the
 * player's avatar.
 */
export function createSyncPrompts(root: HTMLElement, cloud?: Pick<CloudHandle, 'profiles'> | null): SyncPrompts {
  const avatarOf = (name: string): Avatar | null => {
    try {
      return cloud?.profiles.list().find((p) => p.name === name)?.avatar ?? null;
    } catch {
      return null;
    }
  };
  return {
    confirmTakeover(info) {
      const t = takeoverText(info, Date.now());
      return confirmBox(root, { title: t.title, text: t.text, ok: 'Play here', cancel: 'Back' });
    },
    chooseConflict(info: ConflictInfo) {
      return chooseCards(root, {
        title: conflictTitle(info.profileName),
        text: CONFLICT_TEXT,
        info,
        titles: { here: cardTitle(info.here), other: cardTitle(info.other) },
        avatar: avatarOf(info.profileName),
      });
    },
    async chooseLeaseLost(info: LeaseLostInfo) {
      if (leaseLostMode(info) === 'notice') {
        await notice(root, movedTitle(info.profileName, cardTitle(info.other)), movedText(info.since));
        return 'other';
      }
      return chooseCards(root, {
        title: movedTitle(info.profileName, cardTitle(info.other)),
        text: CONFLICT_TEXT,
        info,
        titles: leaseCardTitles(info),
        avatar: avatarOf(info.profileName),
        more: false,
      });
    },
    notice(kind, info) {
      const t = noticeText(kind, info);
      return notice(root, t.title, t.text);
    },
    toast(text) {
      showToast(root, text);
    },
  };
}
