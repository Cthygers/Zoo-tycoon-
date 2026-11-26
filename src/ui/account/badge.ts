// The HUD cloud badge (platform §10.4 item 7): a cloud glyph left of the menu button. A tick
// when everything is online (fades after 3 s), a spinner while syncing, a crossed cloud offline
// or signed out, "!" for a conflict. Hidden for the guest, in cloud-disabled builds and during a
// versus match. badgeModel is pure (tests/account-prompts.test.ts).
import type { CloudStatus } from '../../core/cloud-types';
import type { IconName } from '../icons';
import { fmtAgo } from './format';

export interface BadgeModel {
  hidden: boolean;
  /** CSS state class. */
  cls: 'synced' | 'syncing' | 'pending' | 'offline' | 'signin' | 'conflict' | 'error' | 'none';
  icon: IconName | null;
  spin: boolean;
  bang: boolean;
  /** Fade after a few seconds (all saved). */
  fades: boolean;
  /** One line for a tap and for screen readers. */
  label: string;
}

/** The Settings status line and the badge's tap text for a cloud status. */
export function statusText(s: CloudStatus, now: number): { text: string; tone: 'good' | 'warn' | 'plain' } {
  switch (s.kind) {
    case 'disabled':
      return { text: 'Online saves are off in this version.', tone: 'plain' };
    case 'guest':
      return { text: 'Not signed in. Zoos are saved on this phone.', tone: 'plain' };
    case 'needs-signin':
      return { text: 'Sign in again to keep your zoos safe online', tone: 'warn' };
    case 'synced':
      return { text: `All saved online ✓ (${fmtAgo(s.at, now)})`, tone: 'good' };
    case 'syncing':
      return { text: 'Saving online…', tone: 'plain' };
    case 'pending':
      return s.offline
        ? { text: 'Waiting for internet, saved on this phone', tone: 'warn' }
        : { text: 'Saved on this phone. Saving online soon.', tone: 'plain' };
    case 'conflict':
      return { text: 'Two different zoos. Tap to pick one.', tone: 'warn' };
    case 'error':
      return { text: s.message || 'Online saving has a problem. Your zoo is safe on this phone.', tone: 'warn' };
    default:
      return { text: '', tone: 'plain' };
  }
}

export function badgeModel(s: CloudStatus, o: { guest: boolean; versus: boolean; now?: number }): BadgeModel {
  const label = statusText(s, o.now ?? Date.now()).text;
  const base: BadgeModel = { hidden: false, cls: 'none', icon: 'cloud', spin: false, bang: false, fades: false, label };
  if (o.guest || o.versus || s.kind === 'disabled' || s.kind === 'guest') return { ...base, hidden: true };
  switch (s.kind) {
    case 'synced':
      return { ...base, cls: 'synced', icon: 'cloudCheck', fades: true };
    case 'syncing':
      return { ...base, cls: 'syncing', icon: null, spin: true };
    case 'pending':
      return s.offline ? { ...base, cls: 'offline', icon: 'cloudOff' } : { ...base, cls: 'pending', icon: 'cloud' };
    case 'needs-signin':
      return { ...base, cls: 'signin', icon: 'cloudOff' };
    case 'conflict':
      return { ...base, cls: 'conflict', icon: 'cloudAlert', bang: true };
    case 'error':
      return { ...base, cls: 'error', icon: 'cloudAlert' };
    default:
      return base;
  }
}
