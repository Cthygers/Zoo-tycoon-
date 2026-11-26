// Bed textures (S-10): bird-song phrases with `rough` run through a gain whose level a
// noise signal modulates (the syrinx flutter); without it the whistle is a plain tone.
// A recording context stands in for Web Audio: nodes keep their connections.
import { describe, expect, it } from 'vitest';
import { Kit } from '../src/audio/kit';
import { Rng } from '../src/core/rng';

class Param {
  value = 0;
  readonly inputs: Node[] = [];
  setValueAtTime(): this {
    return this;
  }
  linearRampToValueAtTime(): this {
    return this;
  }
  exponentialRampToValueAtTime(): this {
    return this;
  }
  setValueCurveAtTime(): this {
    return this;
  }
}
class Node {
  readonly outs: (Node | Param)[] = [];
  connect<T extends Node | Param>(d: T): T {
    this.outs.push(d);
    if (d instanceof Param) d.inputs.push(this);
    return d;
  }
}
class Gain extends Node {
  readonly gain = new Param();
}
class Source extends Node {
  readonly frequency = new Param();
  readonly detune = new Param();
  readonly offset = new Param();
  type = '';
  start(): void {}
  stop(): void {}
}
class Filter extends Node {
  type = '';
  readonly frequency = new Param();
  readonly Q = new Param();
  readonly gain = new Param();
}

function phraseGraph(rough?: readonly [number, number]) {
  const sources: Source[] = [];
  const ctx = {
    sampleRate: 22050,
    createGain: () => new Gain(),
    createBiquadFilter: () => new Filter(),
    createOscillator: () => {
      const s = new Source();
      sources.push(s);
      return s;
    },
    createConstantSource: () => new Source(),
  };
  const out = new Gain();
  const kit = new Kit(ctx as unknown as BaseAudioContext, out as unknown as AudioNode, null, new Rng(3), 4);
  kit.phrase([{ t: 0.1, d: 0.2, f0: 3000, f1: 3400, a: 1 }], { harm: 0.2, rough });
  // gains on the way from the tone to the dry bus
  const onPath: Gain[] = [];
  const seen = new Set<Node>();
  const walk = (n: Node): boolean => {
    if (n === out) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    let reaches = false;
    for (const d of n.outs) if (d instanceof Node && walk(d)) reaches = true;
    if (reaches && n instanceof Gain) onPath.push(n);
    return reaches;
  };
  expect(walk(sources[0])).toBe(true);
  return onPath.filter((g) => g.gain.inputs.length > 0);
}

describe('bird-song phrases', () => {
  it('a rough phrase has its level modulated on the way out (syrinx flutter); a plain one does not', () => {
    expect(phraseGraph()).toHaveLength(0);
    expect(phraseGraph([120, 0.5])).toHaveLength(1);
  });
});
