// Render pipeline pieces (src/audio/render.ts) that run without an OfflineAudioContext.
import { describe, expect, it } from 'vitest';
import { normalizationScale } from '../src/audio/render';
import { FakeBuffer } from './helpers/fakeAudio';

const filled = (channels: number, n: number, sr: number, v: number) => {
  const b = new FakeBuffer(channels, n, sr);
  for (let c = 0; c < channels; c++) b.getChannelData(c).fill(v);
  return b as unknown as AudioBuffer;
};

describe('reverb IR normalisation (split IRs share the whole IR scale)', () => {
  it('follows the Web Audio spec: 0.00125 / RMS, scaled to 44.1 kHz', () => {
    expect(normalizationScale(filled(1, 1000, 44100, 0.1))).toBeCloseTo(0.0125, 9);
    expect(normalizationScale(filled(1, 1000, 22050, 0.1))).toBeCloseTo(0.025, 9);
    expect(normalizationScale(filled(2, 1000, 44100, 0.2))).toBeCloseTo(0.00625, 9);
    expect(normalizationScale(filled(4, 1000, 44100, 0.1))).toBeCloseTo(0.00625, 9);
  });

  it('never divides by a near-silent IR', () => {
    expect(normalizationScale(filled(1, 100, 44100, 0))).toBeCloseTo(10, 6);
  });
});
