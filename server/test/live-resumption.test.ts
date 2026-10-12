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

test('a resumed connection uses the remaining idle budget once, then the full activity interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory, limits: { idleMs: 40 } })).open(request(), { ...control(), idleResetMs: 100 });
  const output = session.events[Symbol.asyncIterator]();
  let ended = false; void session.done.then(() => { ended = true; });
  await f.frame(1); f.send({ setupComplete: {} }); await session.ready;
  assert.equal((await output.next()).value.type, 'ready');
  t.mock.timers.tick(30);
  f.send({ serverContent: { inputTranscription: { text: 'new activity' } } });
  assert.equal((await output.next()).value.type, 'inputTranscription');
  t.mock.timers.tick(40);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ended, false, 'activity refreshes the configured interval, not the reduced rebuild budget');
  t.mock.timers.tick(60);
  assert.equal((await session.done).code, 'idle_timeout');
});
