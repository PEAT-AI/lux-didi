import { taskLiveFixture as fixture, flushTaskLive as flush } from './task-live-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';














test('VOICE-R12: final correction invalidates a speech-held old answer before releasing delivery', async t => {
  const f = await fixture(t);
  await f.emit({ type: 'inputTranscription', text: 'Synthetic request A', finished: true, finalOrigin: 'provider' });
  await f.emit({ type: 'delegation', delegationId: 'synthetic-delegation' });
  assert.equal(f.inference.length, 1);
  await f.emit({ type: 'audio', pcm: new Uint8Array(480), rate: 24000, audible: true });
  f.inference[0]!({ text: 'Synthetic answer A.', calls: [] }); await flush(); assert.deepEqual(f.appended, []);
  await f.emit({ type: 'inputTranscription', text: 'Synthetic correction B', finished: false });
  await f.emit({ type: 'turnComplete' });
  await f.emit({ type: 'inputTranscription', text: '', finished: true, finalOrigin: 'provider' });
  assert.equal(f.inference.length, 2); assert.deepEqual(f.appended, [], 'answer A must never be appended while B becomes current');
});
test('VOICE-R12 paired valid: a current speech-held answer is released and heard after speech ends', async t => {
  const f = await fixture(t);
  await f.emit({ type: 'inputTranscription', text: 'Synthetic current request', finished: true, finalOrigin: 'provider' });
  await f.emit({ type: 'delegation', delegationId: 'synthetic-delegation' });
  await f.emit({ type: 'audio', pcm: new Uint8Array(480), rate: 24000, audible: true });
  f.inference[0]!({ text: 'Synthetic current answer.', calls: [] }); await flush(); assert.deepEqual(f.appended, []);
  await f.emit({ type: 'interrupted' });
  await f.emit({ type: 'turnComplete' });
  await f.emit({ type: 'inputTranscription', text: '', finished: true, finalOrigin: 'provider' });
  assert.deepEqual(f.appended, ['Synthetic current answer.']);
  await f.emit({ type: 'commentaryAccepted', commandId: 'synthetic-command-1' });
  await f.emit({ type: 'outputTranscription', text: 'Synthetic current answer.', finished: true });
  assert.ok(f.receipts.some(event => event.event === 'task_delivery' && event.state === 'accepted'));
});

for (const status of ['waiting', 'heard', 'stale'] as const) test(`VOICE-R14: ordinary provider rebuild seeds only a waiting current answer (${status})`, async t => {
  const f = await fixture(t);
  await f.emit({ type: 'inputTranscription', text: 'Synthetic rebuild request', finished: true, finalOrigin: 'provider' });
  await f.emit({ type: 'delegation', delegationId: 'synthetic-delegation' });
  f.inference[0]!({ text: 'Synthetic waiting rebuild answer.', calls: [] }); await flush();
  assert.deepEqual(f.appended, ['Synthetic waiting rebuild answer.']);
  if (status === 'heard') {
    await f.emit({ type: 'commentaryAccepted', commandId: 'synthetic-command-1' });
    await f.emit({ type: 'outputTranscription', text: 'Synthetic waiting rebuild answer.', finished: true });
  }
  if (status === 'stale') await f.emit({ type: 'inputTranscription', text: 'Synthetic replacement request', finished: true, finalOrigin: 'provider' });
  await f.emit({ type: 'goAway', timeLeftMs: 10000 });
  assert.equal(f.requests.length, 2, 'the provider recovery must open a fresh actual session request');
  const request = f.requests[1]!;
  assert.doesNotMatch(request.system.text, /first spoken output must be exactly/);
  assert.ok(request.history?.some(turn => turn.text.includes('Synthetic rebuild request')), 'rebuild keeps owner transcript seed');
  assert.doesNotMatch(request.system.text, /Synthetic waiting rebuild answer/);
  assert.equal(f.appended.length, status === 'waiting' ? 2 : 1);
  if (status === 'waiting') assert.equal(f.appended[1], 'Synthetic waiting rebuild answer.');
});
