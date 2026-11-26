// Device soak test recorder (spec §5.8, `?soak=<minutes>`): frame times and heap, logged once a
// minute as `[soak] {"min":3,"fps":29.6,"p50":18.2,"p95":31.0,"heapMB":142,"longTasks":2}` so a
// phone run can be read with `adb logcat -s Capacitor/Console`. main.ts calls update(raw) every frame.

export interface SoakLine {
  min: number;
  fps: number;
  p50: number;
  p95: number;
  heapMB: number | null;
  longTasks: number;
}

export interface SoakRecorder {
  update(rawDt: number): void;
}

export interface SoakOptions {
  /** Seconds per report (60). */
  every?: number;
  log?: (line: string) => void;
  /** Used JS heap in bytes (performance.memory where the browser has it). */
  heap?: () => number | null;
  /** Start counting long tasks; returns a function reading and resetting the count. */
  longTasks?: () => () => number;
}

/** Percentile of `xs` (sorted copy), `q` in 0..1, nearest-rank. */
export function percentile(xs: readonly number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

/** One report line from a minute of frame times (ms). */
export function soakLine(min: number, frameMs: readonly number[], seconds: number, heapBytes: number | null, longTasks: number): SoakLine {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    min,
    fps: r1(seconds > 0 ? frameMs.length / seconds : 0),
    p50: r1(percentile(frameMs, 0.5)),
    p95: r1(percentile(frameMs, 0.95)),
    heapMB: heapBytes === null ? null : Math.round(heapBytes / 1048576),
    longTasks,
  };
}

function browserHeap(): number | null {
  const mem = (globalThis.performance as unknown as { memory?: { usedJSHeapSize?: number } } | undefined)?.memory;
  return typeof mem?.usedJSHeapSize === 'number' ? mem.usedJSHeapSize : null;
}

function browserLongTasks(): () => number {
  let n = 0;
  try {
    const PO = (globalThis as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (PO && PO.supportedEntryTypes?.includes('longtask')) {
      new PO((list) => {
        n += list.getEntries().length;
      }).observe({ type: 'longtask', buffered: false });
    }
  } catch {
    /* no long-task timing here */
  }
  return () => {
    const c = n;
    n = 0;
    return c;
  };
}

export function createSoakRecorder(opts: SoakOptions = {}): SoakRecorder {
  const every = opts.every ?? 60;
  const log = opts.log ?? ((line: string) => console.log(line));
  const heap = opts.heap ?? browserHeap;
  const readLong = (opts.longTasks ?? browserLongTasks)();
  let frames: number[] = [];
  let acc = 0;
  let min = 0;
  return {
    update(rawDt: number) {
      if (!(rawDt > 0) || !Number.isFinite(rawDt)) return;
      frames.push(rawDt * 1000);
      acc += rawDt;
      if (acc < every) return;
      min++;
      log(`[soak] ${JSON.stringify(soakLine(min, frames, acc, heap(), readLong()))}`);
      frames = [];
      acc = 0;
    },
  };
}
