import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_INPUT_RATE, LIVE_PROVIDER_RATE, Pcm16Upsampler } from '../adapters/live-voice/index.js';

const pcm16 = (samples: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
};
const read = (bytes: Uint8Array): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
};
const sine = (samples: number, hertz: number, rate = LIVE_INPUT_RATE): number[] =>
  Array.from({ length: samples }, (_, index) => Math.round(Math.sin((2 * Math.PI * hertz * index) / rate) * 12_000));
const run = (input: readonly number[], chunk: number): number[] => {
  const upsampler = new Pcm16Upsampler();
  const out: number[] = [];
  for (let start = 0; start < input.length; start += chunk) out.push(...read(upsampler.process(pcm16(input.slice(start, start + chunk)))));
  return out;
};

test('the rates are the native capture rate and the single GPT-Live rate', () => {
  assert.equal(LIVE_INPUT_RATE, 16_000);
  assert.equal(LIVE_PROVIDER_RATE, 24_000);
});

test('one 480-sample capture frame becomes 720 samples from the second frame on', () => {
  const upsampler = new Pcm16Upsampler();
  const frames = Array.from({ length: 10 }, () => read(upsampler.process(pcm16(sine(480, 440)))).length);
  assert.deepEqual(frames, [719, 720, 720, 720, 720, 720, 720, 720, 720, 720]);
  assert.equal(frames.reduce((sum, count) => sum + count, 0), 1_440 * 5 - 1, '1.5x overall, minus the one-sample lookahead');
});

test('an empty chunk emits nothing and keeps the phase', () => {
  const upsampler = new Pcm16Upsampler();
  assert.equal(upsampler.process(new Uint8Array(0)).byteLength, 0);
  // Five positions fit inside four samples (0, 2/3, 4/3, 2, 8/3): the last one still has its right neighbour.
  assert.equal(read(upsampler.process(pcm16([5, 5, 5, 5]))).length, 5);
  assert.equal(upsampler.process(new Uint8Array(0)).byteLength, 0);
});

test('the output keeps the frequency: a 1 kHz tone stays at 1 kHz', () => {
  const out = run(sine(LIVE_INPUT_RATE, 1_000), 480);
  const crossings = out.reduce((count, sample, index) => (index && ((sample < 0) !== (out[index - 1]! < 0)) ? count + 1 : count), 0);
  // One second of audio: 2,000 zero crossings at 1 kHz, whatever the sample rate.
  assert.ok(Math.abs(crossings - 2_000) <= 2, `crossings ${crossings}`);
  assert.equal(out.length, 24_000 - 1);
});

test('amplitude survives: DC passes through and a full-scale square stays bounded', () => {
  const flat = run(new Array(96).fill(1_234), 96);
  assert.ok(flat.every(sample => sample === 1_234));
  const square = run(Array.from({ length: 480 }, (_, index) => (Math.floor(index / 8) % 2 ? 30_000 : -30_000)), 480);
  assert.ok(square.every(sample => Math.abs(sample) <= 30_000));
  assert.equal(Math.max(...square), 30_000);
});

test('the result does not depend on the chunk size', () => {
  const input = sine(LIVE_INPUT_RATE, 1_000);
  const whole = run(input, input.length);
  const chunked = run(input, 480);
  const odd = run(input, 333);
  assert.deepEqual(chunked, whole);
  assert.deepEqual(odd, whole);
});
