// Store<T> (a tiny observable value) and the CloudStatus shown by the cloud badge.
// Precedence: needs-signin > conflict > error > syncing > pending > synced (platform §10.1).
import type { CloudStatus, Store } from '../core/cloud-types';
import type { SlotKey } from '../core/contracts';

export interface WritableStore<T> extends Store<T> {
  set(v: T): void;
}

export function createStore<T>(initial: T, equals: (a: T, b: T) => boolean = (a, b) => a === b): WritableStore<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(v: T) {
      if (equals(value, v)) return;
      value = v;
      for (const fn of [...subs]) {
        try {
          fn(v);
        } catch (e) {
          console.error('[net] store subscriber failed', e);
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export const sameJson = <T>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface StatusInputs {
  enabled: boolean;
  auth: 'disabled' | 'guest' | 'signing-in' | 'signed-in' | 'needs-signin';
  conflictKeys: SlotKey[];
  error: string | null;
  syncing: boolean;
  pending: number;
  offline: boolean;
  nextTryAt?: number;
  lastSyncAt: number;
}

export function deriveStatus(s: StatusInputs): CloudStatus {
  if (!s.enabled || s.auth === 'disabled') return { kind: 'disabled' };
  if (s.auth === 'guest' || s.auth === 'signing-in') return { kind: 'guest' };
  if (s.auth === 'needs-signin') return { kind: 'needs-signin' };
  if (s.conflictKeys.length > 0) return { kind: 'conflict', keys: [...s.conflictKeys] };
  if (s.error) return { kind: 'error', message: s.error };
  if (s.syncing) return { kind: 'syncing' };
  if (s.pending > 0) {
    return s.nextTryAt !== undefined
      ? { kind: 'pending', count: s.pending, offline: s.offline, nextTryAt: s.nextTryAt }
      : { kind: 'pending', count: s.pending, offline: s.offline };
  }
  return { kind: 'synced', at: s.lastSyncAt };
}
