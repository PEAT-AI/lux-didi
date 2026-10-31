import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { audioPlan, readUtteranceFile, runAudioProbe, PROBE_RATE, synthUtterance } from './audio.js';
import { loadRecording } from './replay.js';
import { recordingsDir } from './locate.js';

test('the synthetic utterance is the size and rate the adapter expects', () => {
  const pcm = synthUtterance();
  assert.equal(pcm.byteLength, 24_000);
  assert.equal(PROBE_RATE, 24_000);
  assert.match(audioPlan({ bytes: pcm.byteLength, source: 'test' }), /no audio device/);
});

test('the audio path uploads the utterance and drops what comes back', async () => {
  const pcm = synthUtterance();
  const outcome = await runAudioProbe({ pcm, recording: loadRecording(join(recordingsDir(), 'audio-probe.json')), timeoutMs: 8_000 });
  assert.equal(outcome.connections, 1);
  assert.equal(outcome.uploadedBytes, pcm.byteLength);
  assert.ok(outcome.chunks > 1, 'the utterance is uploaded in chunks');
  assert.ok(outcome.outputAudioFrames > 0, 'the provider audio reached the adapter');
  assert.deepEqual(outcome.transcripts, ['Audio probe answered.']);
});

test('a say capture is read as bare PCM16', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-audio-probe-'));
  try {
    const pcm = synthUtterance(2_400);
    const wav = new Uint8Array(44 + pcm.byteLength);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set(pcm, 44);
    const path = join(dir, 'probe.wav');
    writeFileSync(path, wav);
    assert.equal(readUtteranceFile(path).byteLength, pcm.byteLength);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
