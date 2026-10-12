import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import { collect, control, fixture, options, pcm, request } from './live-voice-fixture.js';

// Synthetic provider-only secret; assertions never print it in captured production output.
const HANDLE = 'synthetic-resumption-secret';

test('resumption setup requests updates and forwards a usable handle without finishing on goAway', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  const captured = collect(session);
  await f.frame(1);
  assert.deepEqual((f.frames[0] as { setup: { sessionResumption?: unknown } }).setup.sessionResumption, {});
  f.send({ setupComplete: {} }); await session.ready;
  f.send({ sessionResumptionUpdate: { resumable: true, newHandle: HANDLE }, goAway: { timeLeft: '1s' } });
  // Waiting for an emitted frame rather than a real timer keeps this test deterministic.
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  session.sendAudio({ pcm, dataClass: 'ordinary' });
  f.terminate();
  const outcome = await session.done; await captured.done;
  assert.ok(captured.events.some(e => e.type === ('resumptionHandle' as string) && 'handle' in e && e.handle === HANDLE));
  assert.ok(captured.events.some(e => e.type === 'goAway' && 'timeLeftMs' in e && e.timeLeftMs === 1000));
  assert.equal('recoverable' in outcome && outcome.recoverable, true);
  assert.equal(f.frames.length, 1, 'goAway stops outbound admission');
});

test('resumption transport policy failures are final while a network cut is recoverable', async t => {
  for (const code of [1008, 1011]) {
    const f = await fixture(t);
    const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
    collect(session);
    await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
    f.remoteClose('', code);
    const outcome = await session.done;
    assert.equal('recoverable' in outcome && outcome.recoverable, code === 1011);
  }
});
