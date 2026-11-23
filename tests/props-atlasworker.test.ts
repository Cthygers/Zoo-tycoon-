// paintAtlasesOffThread must never hang the loading screen: a worker that
// fails, sends garbage or stops answering is given up, and the atlases it did
// not paint are left to the main thread (atlasSteps).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { kind: string; mips: { data: Uint8Array; width: number; height: number }[] } | { kind: string; error: string };

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: Reply }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: string[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(kind: string): void {
    this.posted.push(kind);
  }
  terminate(): void {
    this.terminated = true;
  }
  answer(kind: string): void {
    this.onmessage?.({ data: { kind, mips: [{ data: new Uint8Array(4), width: 1, height: 1 }] } });
  }
  answerAll(): void {
    for (const k of this.posted) this.answer(k);
  }
}

/** A fresh atlases module (its worker state is module-level). */
async function load() {
  vi.resetModules();
  return import('../src/props/nature/atlases');
}

/** Whether a promise has settled after the pending microtasks ran. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe('foliage atlas worker', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shares one worker between callers and reports progress to each', async () => {
    const { paintAtlasesOffThread } = await load();
    const a: number[] = [];
    const b: number[] = [];
    const p1 = paintAtlasesOffThread((f) => a.push(f));
    const p2 = paintAtlasesOffThread((f) => b.push(f));
    expect(FakeWorker.all).toHaveLength(1);
    const w = FakeWorker.all[0];
    expect(w.posted.length).toBe(11);
    w.answerAll();
    expect(await settled(Promise.all([p1, p2]).then(() => {}))).toBe(true);
    expect(a.at(-1)).toBe(1);
    expect(b.at(-1)).toBe(1);
    expect(w.terminated).toBe(true);
    // every atlas is painted: nothing left for a new worker
    await paintAtlasesOffThread();
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('gives up a worker that never answers, and paints on the main thread from then on', async () => {
    const { paintAtlasesOffThread } = await load();
    const p = paintAtlasesOffThread();
    const w = FakeWorker.all[0];
    await vi.advanceTimersByTimeAsync(5000);
    expect(await settled(p)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await settled(p)).toBe(true);
    expect(w.terminated).toBe(true);
    await paintAtlasesOffThread();
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('keeps waiting for a slow worker that keeps answering', async () => {
    const { paintAtlasesOffThread } = await load();
    const p = paintAtlasesOffThread();
    const w = FakeWorker.all[0];
    for (const k of w.posted) {
      expect(await settled(p)).toBe(false);
      await vi.advanceTimersByTimeAsync(6000);
      w.answer(k);
    }
    expect(await settled(p)).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('gives up on a worker error or an unreadable message', async () => {
    for (const fail of ['error', 'messageerror'] as const) {
      const { paintAtlasesOffThread } = await load();
      const p = paintAtlasesOffThread();
      const w = FakeWorker.all.at(-1)!;
      w.answer(w.posted[0]);
      if (fail === 'error') w.onerror?.({ message: 'boom', preventDefault() {} });
      else w.onmessageerror?.();
      expect(await settled(p)).toBe(true);
      expect(w.terminated).toBe(true);
    }
  });

  it('leaves an atlas the worker could not paint to the main thread', async () => {
    const { paintAtlasesOffThread } = await load();
    const p = paintAtlasesOffThread();
    const w = FakeWorker.all[0];
    const [bad, ...rest] = w.posted;
    w.onmessage?.({ data: { kind: bad, error: 'Error: no memory' } });
    for (const k of rest) w.answer(k);
    expect(await settled(p)).toBe(true);
    // not given up: the next call asks a new worker for just the missing atlas
    void paintAtlasesOffThread();
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[1].posted).toEqual([bad]);
  });

  it('resolves at once without worker support', async () => {
    vi.unstubAllGlobals();
    const { paintAtlasesOffThread } = await load();
    expect(await settled(paintAtlasesOffThread())).toBe(true);
  });
});
