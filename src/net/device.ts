// Device identity (spec §3.2, review P5). wh2:device = { id: uuid4, hw: sha256hex(Device.getId().identifier) | null,
// createdAt }. The id is a random install id sent at sign-in (never the hardware id). When the stored
// hw differs from this phone's (an Android Auto Backup restore onto another phone), a new id is made
// and the session in wh2:auth is dropped: the restored slots keep their base, CAS protects the cloud.
import type { DeviceProvider } from '../core/cloud-types';
import { KEYS } from '../core/storage-keys';
import { sha256HexOfString, uuid } from './codec';

export interface DeviceRecord { id: string; hw: string | null; createdAt: number }

/** Device info through a dynamic import of @capacitor/device (never loaded on the web or in tests). */
export function createDeviceProvider(): DeviceProvider {
  return {
    async info() {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return { name: 'Browser', platform: 'web', hwId: null };
        const { Device } = await import('@capacitor/device');
        const [info, id] = await Promise.all([Device.getInfo().catch(() => null), Device.getId().catch(() => null)]);
        const model = (info?.model ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
        return { name: (model || 'Android phone').slice(0, 40), platform: 'android', hwId: id?.identifier || null };
      } catch {
        return { name: 'Browser', platform: 'web', hwId: null };
      }
    },
  };
}

export function readDeviceRecord(s: Pick<Storage, 'getItem'>): DeviceRecord | null {
  try {
    const raw = s.getItem(KEYS.device);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<DeviceRecord>;
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(r.id)) return null;
    return { id: r.id, hw: typeof r.hw === 'string' ? r.hw : null, createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0 };
  } catch {
    return null;
  }
}

/**
 * The P5 binding, run by cloud.init(): create wh2:device on first run; on a hardware mismatch make a new
 * id and drop wh2:auth. Returns the record and whether the session was dropped.
 */
export async function bindDevice(s: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, hwId: string | null, now: number): Promise<{ device: DeviceRecord; reset: boolean }> {
  const hw = hwId ? await sha256HexOfString(hwId) : null;
  const stored = readDeviceRecord(s);
  let device: DeviceRecord;
  let reset = false;
  if (!stored) {
    device = { id: uuid(), hw, createdAt: now };
  } else if (stored.hw && hw && stored.hw !== hw) {
    // a copy restored onto another phone: new install id, no session (sign in again)
    device = { id: uuid(), hw, createdAt: now };
    reset = true;
    try {
      s.removeItem(KEYS.auth);
    } catch {
      /* ignore */
    }
  } else {
    device = { ...stored, hw: stored.hw ?? hw };
  }
  if (!stored || reset || stored.hw !== device.hw) {
    try {
      s.setItem(KEYS.device, JSON.stringify(device));
    } catch {
      /* storage full: the id stays in memory for this session */
    }
  }
  return { device, reset };
}
