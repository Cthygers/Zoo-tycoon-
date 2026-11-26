// Sync prompts and the account extension's texts (spec §3.8, §3.9, §3.11): the conflict card
// choice (Newest = more unique play), the lease-lost notice / choice split at 120 s, takeover and
// notice wording, the HUD badge states, the Settings status line, the sign-out and delete-account
// texts, the backups list, and the small format helpers.
import { describe, expect, it } from 'vitest';
import type { SaveMeta } from '../shared/api-types';
import type { CachedProfile, CloudStatus, LeaseLostInfo, SaveCard } from '../src/core/cloud-types';
import { backupLines, giveTargets, reasonText } from '../src/ui/account/backups';
import { badgeModel, statusText } from '../src/ui/account/badge';
import { animalsText, fmtAgo, fmtDuration, fmtMoneyShort, fmtStars, metaLine, starCount } from '../src/ui/account/format';
import {
  cardLines,
  cardTitle,
  CONFLICT_TEXT,
  conflictTitle,
  leaseCardTitles,
  leaseLostMode,
  movedText,
  movedTitle,
  newestSide,
  noticeText,
  playedMoreText,
  takeoverText,
} from '../src/ui/account/prompts';
import { deleteAccountText, deleteResultText, REAUTH_MISMATCH, unsyncedPlayers, unsyncedText } from '../src/ui/account/settings';

const NOW = new Date(2026, 10, 26, 15, 0, 0).getTime();
const META: SaveMeta = { day: 12, minute: 860, money: 48_210, rating: 61, animals: 18, species: 5, visitors: 900, playSeconds: 4200 };

function card(o: Partial<SaveCard> = {}): SaveCard {
  return { deviceName: 'Pixel 7', thisDevice: false, meta: META, savedAt: NOW - 5 * 60_000, uniquePlaySeconds: 600, newest: false, playingNow: false, ...o };
}

describe('conflict cards (spec §3.11)', () => {
  it('Newest goes to the card with more unique play, on either side', () => {
    expect(newestSide({ here: card({ thisDevice: true, uniquePlaySeconds: 4200 }), other: card({ uniquePlaySeconds: 600 }) })).toBe('here');
    expect(newestSide({ here: card({ thisDevice: true, uniquePlaySeconds: 300 }), other: card({ uniquePlaySeconds: 900 }) })).toBe('other');
    // the engine's own flag never beats more play
    expect(newestSide({ here: card({ uniquePlaySeconds: 200, newest: true }), other: card({ uniquePlaySeconds: 900, newest: false }) })).toBe('other');
    // a tie: the engine's flag, then this phone
    expect(newestSide({ here: card({ uniquePlaySeconds: 500 }), other: card({ uniquePlaySeconds: 500, newest: true }) })).toBe('other');
    expect(newestSide({ here: card({ uniquePlaySeconds: 500 }), other: card({ uniquePlaySeconds: 500 }) })).toBe('here');
  });

  it('"played … more" sits on the newest card; under a minute says nothing', () => {
    expect(playedMoreText({ here: card({ uniquePlaySeconds: 600 }), other: card({ uniquePlaySeconds: 600 + 70 * 60 }) })).toEqual({ side: 'other', text: 'played 1 h 10 min more' });
    expect(playedMoreText({ here: card({ uniquePlaySeconds: 1500 }), other: card({ uniquePlaySeconds: 300 }) })).toEqual({ side: 'here', text: 'played 20 min more' });
    expect(playedMoreText({ here: card({ uniquePlaySeconds: 330 }), other: card({ uniquePlaySeconds: 300 }) })).toBeNull();
  });

  it('cards are titled by device and show day, time, money, stars, animals and when they were saved', () => {
    expect(cardTitle(card({ thisDevice: true, deviceName: 'Pixel 7' }))).toBe('This phone');
    expect(cardTitle(card({ deviceName: 'Tablet' }))).toBe('Tablet');
    expect(cardTitle(card({ deviceName: '  ' }))).toBe('Another device');
    expect(cardLines(card(), NOW)).toEqual(['Day 12 · 14:20', '$48,210   ★★★   18 animals', 'saved 5 min ago']);
    expect(cardLines(card({ playingNow: true }), NOW)[2]).toBe('playing now');
    expect(conflictTitle('Mia')).toBe('You have two different zoos for Mia');
    expect(CONFLICT_TEXT).toBe('Which one do you want to keep playing? The other one is kept as a backup.');
  });
});

describe('lease lost (spec §3.8, S1)', () => {
  const since = new Date(2026, 10, 26, 14, 5).getTime();
  const info = (delta: number): LeaseLostInfo => ({
    profileName: 'Mia',
    here: card({ thisDevice: true, uniquePlaySeconds: delta }),
    other: card({ deviceName: 'Tablet', uniquePlaySeconds: 60, playingNow: true }),
    localDeltaSeconds: delta,
    since,
  });

  it('a notice up to 120 s of play on this phone, the two-card choice above it', () => {
    expect(leaseLostMode(info(0))).toBe('notice');
    expect(leaseLostMode(info(120))).toBe('notice');
    expect(leaseLostMode(info(121))).toBe('choice');
    expect(leaseLostMode(info(3600))).toBe('choice');
  });

  it('notice and card wording', () => {
    expect(movedTitle('Mia', 'Tablet')).toBe("Mia's zoo is open on Tablet now.");
    expect(movedText(since)).toBe('What you did here since 14:05 is kept as a backup.');
    expect(movedText(undefined)).toBe('What you did here is kept as a backup.');
    expect(leaseCardTitles(info(3600))).toEqual({ here: 'This phone: 1 h of play since 14:05', other: 'Tablet, playing now' });
    // with 1 h here vs a fresh takeover there, this phone is the newest card
    expect(newestSide(info(3600))).toBe('here');
  });
});

describe('takeover and notices', () => {
  it('takeover question names the device and how long ago it was seen', () => {
    expect(takeoverText({ profileName: 'Mia', holderDevice: 'Tablet', lastSeenAt: NOW - 60_000 }, NOW)).toEqual({
      title: 'Mia is playing on Tablet',
      text: 'Mia is playing on Tablet right now (1 min ago). If you play here, the Tablet will stop.',
    });
  });

  it('every notice kind has kid words', () => {
    expect(noticeText('moved', { profileName: 'Mia', deviceName: 'Tablet', since: new Date(2026, 10, 26, 9, 30).getTime() })).toEqual({
      title: "Mia's zoo is open on Tablet now.",
      text: 'What you did here since 09:30 is kept as a backup.',
    });
    expect(noticeText('profileGone', { profileName: 'Mia' }).title).toBe('Mia was removed on another device.');
    expect(noticeText('newerVersion', { profileName: 'Mia' }).title).toBe("Update Wildhaven to open Mia's zoo.");
    expect(noticeText('tooLarge', { profileName: 'Mia' })).toEqual({ title: 'This zoo is too big to save online.', text: 'It is still saved on this phone.' });
    expect(noticeText('matchLost', { profileName: 'Mia' })).toEqual({ title: 'This match was lost.', text: 'Your zoo is kept as practice.' });
  });
});

describe('HUD cloud badge', () => {
  const st = (s: CloudStatus) => badgeModel(s, { guest: false, versus: false, now: NOW });

  it('hidden for the guest, in disabled builds, signed out and during a versus match', () => {
    expect(badgeModel({ kind: 'synced', at: NOW }, { guest: true, versus: false }).hidden).toBe(true);
    expect(badgeModel({ kind: 'synced', at: NOW }, { guest: false, versus: true }).hidden).toBe(true);
    expect(st({ kind: 'disabled' }).hidden).toBe(true);
    expect(st({ kind: 'guest' }).hidden).toBe(true);
  });

  it('a tick that fades, a spinner, a crossed cloud, "!" for a conflict', () => {
    expect(st({ kind: 'synced', at: NOW - 120_000 })).toMatchObject({ hidden: false, cls: 'synced', icon: 'cloudCheck', fades: true, label: 'All saved online ✓ (2 min ago)' });
    expect(st({ kind: 'syncing' })).toMatchObject({ spin: true, icon: null });
    expect(st({ kind: 'pending', count: 1, offline: true })).toMatchObject({ cls: 'offline', icon: 'cloudOff', label: 'Waiting for internet, saved on this phone' });
    expect(st({ kind: 'pending', count: 1, offline: false })).toMatchObject({ cls: 'pending', icon: 'cloud' });
    expect(st({ kind: 'needs-signin' })).toMatchObject({ cls: 'signin', icon: 'cloudOff', label: 'Sign in again to keep your zoos safe online' });
    expect(st({ kind: 'conflict', keys: [] })).toMatchObject({ cls: 'conflict', bang: true });
    expect(st({ kind: 'error', message: 'Oops' })).toMatchObject({ cls: 'error', label: 'Oops' });
  });

  it('status lines for Settings', () => {
    expect(statusText({ kind: 'guest' }, NOW).text).toBe('Not signed in. Zoos are saved on this phone.');
    expect(statusText({ kind: 'synced', at: NOW }, NOW)).toEqual({ text: 'All saved online ✓ (just now)', tone: 'good' });
    expect(statusText({ kind: 'conflict', keys: [] }, NOW).tone).toBe('warn');
  });
});

function prof(name: string, state: CachedProfile['local']['state'], meta: SaveMeta | null, hasMain = !!meta): CachedProfile {
  return { id: `id-${name}`, name, avatar: { animal: 'lion', color: 0 }, prefs: {}, createdAt: 0, updatedAt: 0, main: null, local: { hasMain, meta, state } };
}

describe('sign-out and delete-account texts', () => {
  it('names the players whose zoo is not online yet', () => {
    const list = [prof('Mia', 'pending', { ...META, day: 14 }), prof('Ben', 'synced', META), prof('Leo', 'offline', { ...META, day: 3 }), prof('Ana', 'local', null, false)];
    const who = unsyncedPlayers(list);
    expect(who).toEqual(['Mia: Day 14', 'Leo: Day 3']);
    expect(unsyncedText(['Mia: Day 14'])).toBe(
      "Some progress isn't saved online yet (Mia: Day 14). It stays on this phone and uploads next time you sign in with this account.",
    );
    expect(unsyncedText([])).toBe("Some progress isn't saved online yet. It stays on this phone and uploads next time you sign in with this account.");
  });

  it('delete account lists what goes and maps every answer', () => {
    expect(deleteAccountText('parent@example.com', ['Mia', 'Ben'])).toContain('the players Mia, Ben, their online zoos and their Versus results');
    expect(deleteResultText('mismatch')).toBe(REAUTH_MISMATCH);
    expect(REAUTH_MISMATCH).toBe("That's a different Google account. Use the one you signed in with.");
    expect(deleteResultText('cancelled')).toBeNull();
    expect(deleteResultText('offline')).toBe('Connect to the internet to do this.');
    expect(deleteResultText('ok')).toBeTruthy();
    expect(deleteResultText('error')).toBe('Something went wrong. Try again.');
  });
});

describe('backups', () => {
  it('says why a backup exists and what is in it', () => {
    expect(reasonText('lease_lost', 'Tablet')).toBe('Kept when Tablet took over');
    expect(reasonText('chose_other', 'Tablet')).toBe('Kept when you picked the other zoo');
    expect(reasonText('auto_pull', '')).toBe('Kept when a newer zoo came from another device');
    const l = backupLines({ id: 'b1', reason: 'chose_other', fromDevice: 'Pixel 7', meta: META, savedAt: NOW, createdAt: NOW - 3 * 3600_000, uploaded: true }, NOW);
    expect(l).toEqual({ title: 'Day 12 · $48k', sub: '★★★ · 18 animals · played 1 h 10 min', why: 'Kept when you picked the other zoo · 3 h ago' });
  });

  it('"Give this zoo to…" only offers players with no zoo', () => {
    const list = [prof('Mia', 'synced', META), prof('Ben', 'local', null, false), { ...prof('Leo', 'local', null, false), main: { epoch: 'e', rev: 1, meta: META, savedAt: 0, deviceName: 'Tablet', lease: null } }];
    const cloud = { profiles: { list: () => list }, local: { has: (k: string) => k === 'id-Mia/main' } } as unknown as Parameters<typeof giveTargets>[0];
    expect(giveTargets(cloud, 'id-Mia').map((p) => [p.name, p.empty])).toEqual([['Ben', true], ['Leo', false]]);
  });
});

describe('format helpers', () => {
  it('durations, ages, stars, money', () => {
    expect(fmtDuration(0)).toBe('0 min');
    expect(fmtDuration(20)).toBe('1 min');
    expect(fmtDuration(25 * 60)).toBe('25 min');
    expect(fmtDuration(3600)).toBe('1 h');
    expect(fmtDuration(4200)).toBe('1 h 10 min');
    expect(fmtAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(fmtAgo(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(fmtAgo(NOW - 2 * 3600_000, NOW)).toBe('2 h ago');
    expect(fmtAgo(NOW - 26 * 3600_000, NOW)).toBe('yesterday');
    expect(fmtAgo(NOW - 3 * 86400_000, NOW)).toBe('3 days ago');
    expect([0, 1, 30, 61, 100].map(starCount)).toEqual([0, 1, 2, 3, 5]);
    expect(fmtStars(61)).toBe('★★★');
    expect(metaLine(null)).toBe('No zoo yet');
    expect(metaLine({ ...META, day: 15 })).toBe('Day 15 · ★★★');
    expect(fmtMoneyShort(48_210)).toBe('$48k');
    expect(fmtMoneyShort(950)).toBe('$950');
    expect(fmtMoneyShort(1_250_000)).toBe('$1.25M');
    expect(animalsText(1)).toBe('1 animal');
    expect(animalsText(0)).toBe('No animals yet');
  });
});
