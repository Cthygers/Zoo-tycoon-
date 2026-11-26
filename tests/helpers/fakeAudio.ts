// Minimal Web Audio stand-in for engine tests (node has no AudioContext).
// Nodes record their connections; AudioParams record every automation call
// and can evaluate their value at any time; sources record start / stop and
// fire onended when stopped. Use with
//   new ZooAudio(sim, events, { context: fake as unknown as BaseAudioContext })
// and a vi.mock of renderRecipe that returns fakeAsset() buffers.

export type ParamEvent =
  | { type: 'set'; t: number; v: number }
  | { type: 'linear'; t: number; v: number }
  | { type: 'exp'; t: number; v: number }
  | { type: 'target'; t: number; v: number; tc: number };

/** Every automation call in order, including the cancels (for click lints). */
export type ParamCall = ParamEvent | { type: 'cancel'; t: number } | { type: 'hold'; t: number; v: number };

export class FakeParam {
  readonly calls: ParamCall[] = [];
  private events: ParamEvent[] = [];
  private base: number;

  constructor(
    private readonly ctx: FakeAudioContext,
    v: number,
  ) {
    this.base = v;
  }

  get value(): number {
    return this.valueAt(this.ctx.currentTime);
  }

  set value(v: number) {
    this.base = v;
    if (this.events.length) this.add({ type: 'set', t: this.ctx.currentTime, v });
  }

  /** Automation events still scheduled. */
  get scheduled(): readonly ParamEvent[] {
    return this.events;
  }

  setValueAtTime(v: number, t: number): this {
    return this.add({ type: 'set', t, v });
  }
  linearRampToValueAtTime(v: number, t: number): this {
    return this.add({ type: 'linear', t, v });
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    return this.add({ type: 'exp', t, v });
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    return this.add({ type: 'target', t, v, tc });
  }
  setValueCurveAtTime(curve: ArrayLike<number>, t: number, dur: number): this {
    return this.add({ type: 'set', t: t + dur, v: curve[curve.length - 1] ?? 0 });
  }
  cancelScheduledValues(t: number): this {
    this.calls.push({ type: 'cancel', t });
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  cancelAndHoldAtTime(t: number): this {
    const v = this.valueAt(t);
    this.calls.push({ type: 'hold', t, v });
    this.events = this.events.filter((e) => e.t < t);
    this.events.push({ type: 'set', t, v });
    return this;
  }

  /** Value at time t (setValue, linear / exponential ramps and setTarget). */
  valueAt(t: number): number {
    let v = this.base;
    let tPrev = 0;
    let target: { v: number; tc: number; t0: number; v0: number } | null = null;
    const at = (tt: number) => (target ? target.v + (target.v0 - target.v) * Math.exp(-(tt - target.t0) / target.tc) : v);
    for (const e of this.events) {
      if (e.t > t) {
        if (e.type === 'linear' || e.type === 'exp') {
          const v0 = at(tPrev);
          const k = (t - tPrev) / Math.max(1e-9, e.t - tPrev);
          if (e.type === 'linear') return v0 + (e.v - v0) * k;
          return v0 > 0 && e.v > 0 ? v0 * Math.pow(e.v / v0, k) : v0;
        }
        break;
      }
      v = at(e.t);
      target = null;
      if (e.type === 'target') target = { v: e.v, tc: e.tc, t0: e.t, v0: v };
      else v = e.v;
      tPrev = e.t;
    }
    return at(t);
  }

  private add(e: ParamEvent): this {
    this.calls.push(e);
    // keep the timeline sorted; equal times stay in insertion order
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].t > e.t) i--;
    this.events.splice(i, 0, e);
    return this;
  }
}

export class FakeNode {
  readonly outputs: unknown[] = [];
  constructor(readonly context: FakeAudioContext) {}
  connect<T>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }
  disconnect(): void {
    this.outputs.length = 0;
  }
}

export class FakeGain extends FakeNode {
  readonly gain: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx);
    this.gain = new FakeParam(ctx, 1);
  }
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
  readonly gain: FakeParam;
  readonly detune: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx);
    this.frequency = new FakeParam(ctx, 350);
    this.Q = new FakeParam(ctx, 1);
    this.gain = new FakeParam(ctx, 0);
    this.detune = new FakeParam(ctx, 0);
  }
}

export class FakePanner extends FakeNode {
  readonly pan: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx);
    this.pan = new FakeParam(ctx, 0);
  }
}

export class FakeBuffer {
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c: number): Float32Array {
    return this.data[c];
  }
  copyToChannel(src: Float32Array, c: number): void {
    this.data[c].set(src.subarray(0, this.length));
  }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate: FakeParam;
  onended: (() => void) | null = null;
  startAt: number | null = null;
  startOffset = 0;
  stopAt: number | null = null;
  constructor(ctx: FakeAudioContext) {
    super(ctx);
    this.playbackRate = new FakeParam(ctx, 1);
  }
  start(when = 0, offset = 0): void {
    if (this.startAt !== null) throw new Error('start() twice');
    this.startAt = when;
    this.startOffset = offset;
  }
  stop(when = 0): void {
    if (this.startAt === null) throw new Error('stop() before start()');
    if (this.stopAt !== null) return;
    this.stopAt = when;
    this.onended?.();
  }
}

export class FakeConstantSource extends FakeNode {
  readonly offset: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx);
    this.offset = new FakeParam(ctx, 1);
  }
  start(): void {}
  stop(): void {}
}

export class FakeConvolver extends FakeNode {
  buffer: FakeBuffer | null = null;
  normalize = true;
}

export class FakeDelay extends FakeNode {
  readonly delayTime: FakeParam;
  constructor(ctx: FakeAudioContext, readonly maxDelayTime = 1) {
    super(ctx);
    this.delayTime = new FakeParam(ctx, 0);
  }
}

export class FakeCompressor extends FakeNode {
  readonly threshold: FakeParam;
  readonly knee: FakeParam;
  readonly ratio: FakeParam;
  readonly attack: FakeParam;
  readonly release: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx);
    this.threshold = new FakeParam(ctx, -24);
    this.knee = new FakeParam(ctx, 30);
    this.ratio = new FakeParam(ctx, 12);
    this.attack = new FakeParam(ctx, 0.003);
    this.release = new FakeParam(ctx, 0.25);
  }
}

export class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
}

export class FakeAudioContext {
  currentTime = 0;
  readonly destination: FakeNode;
  /** Every node created, in order. */
  readonly gains: FakeGain[] = [];
  readonly filters: FakeBiquad[] = [];
  readonly panners: FakePanner[] = [];
  readonly sources: FakeSource[] = [];
  readonly compressors: FakeCompressor[] = [];

  constructor(readonly sampleRate = 48000) {
    this.destination = new FakeNode(this);
  }

  createGain(): FakeGain {
    const g = new FakeGain(this);
    this.gains.push(g);
    return g;
  }
  createBiquadFilter(): FakeBiquad {
    const f = new FakeBiquad(this);
    this.filters.push(f);
    return f;
  }
  createStereoPanner(): FakePanner {
    const p = new FakePanner(this);
    this.panners.push(p);
    return p;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource(this);
    this.sources.push(s);
    return s;
  }
  createConvolver(): FakeConvolver {
    return new FakeConvolver(this);
  }
  createDelay(maxDelayTime = 1): FakeDelay {
    return new FakeDelay(this, maxDelayTime);
  }
  createDynamicsCompressor(): FakeCompressor {
    const c = new FakeCompressor(this);
    this.compressors.push(c);
    return c;
  }
  createWaveShaper(): FakeShaper {
    return new FakeShaper(this);
  }
  createConstantSource(): FakeConstantSource {
    return new FakeConstantSource(this);
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }

  /** Every AudioParam of every gain node (for click lints). */
  gainParams(): FakeParam[] {
    return this.gains.map((g) => g.gain);
  }
}

/** A rendered-sound stand-in: silent buffer of `dur` seconds at `sr`. */
export function fakeAsset(dur: number, sr = 22050, loop = false) {
  const buffer = new FakeBuffer(1, Math.max(1, Math.round(dur * sr)), sr);
  return { buffer: buffer as unknown as AudioBuffer, loopEnd: loop ? dur : 0, duration: dur, peak: 0.5, rms: 0.1, norm: 1, ms: 1, mainMs: 0.5, sliceMs: 0.2 };
}

/**
 * Click lint: the steepest linear gain ramp (|Δ| per ms) scheduled on any
 * param that started from a hold / set at the ramp's start time.
 */
export function steepestRamp(params: readonly FakeParam[]): number {
  let worst = 0;
  for (const p of params) {
    let lastT = 0;
    let lastV = 0;
    for (const c of p.calls) {
      if (c.type === 'hold' || c.type === 'set') {
        lastT = c.t;
        lastV = c.v;
      } else if (c.type === 'linear') {
        const dt = (c.t - lastT) * 1000;
        if (dt > 0) worst = Math.max(worst, Math.abs(c.v - lastV) / dt);
        lastT = c.t;
        lastV = c.v;
      }
    }
  }
  return worst;
}
