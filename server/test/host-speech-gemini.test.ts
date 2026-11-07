import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { chatMigrations } from '../chat/index.js';
import { toolsMigrations } from '../tools/schema.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile } from '../live/index.js';
import { syntheticTaskFactory } from './synthetic-task.js';
import { fakeLiveVoicePort, type FakeLiveVoice } from './fixtures/fake-live-voice.js';
import { GeminiLiveVoiceAdapter } from '../adapters/live-voice/index.js';
import type { LiveVoicePort, LiveVoiceSession } from '../adapters/live-voice/index.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { FakeClock } from './openai-live-voice-fixture.js';
import { control, fixture, options, request } from './live-voice-fixture.js';

/**
 * A Gemini-shaped port: it carries a session commentary method that acknowledges nothing, exactly as the
 * Gemini adapter does, and the host-text turn is the only path it accepts. The alarm opening must still
 * reach the voice, once, and be announced at her first audio after it.
 */
function commentarylessPort(fake: FakeLiveVoice, texts: string[], commentaryCalls: string[]): LiveVoicePort {
  return {
    capabilities: fake.port.capabilities,
    open: (liveRequest: Parameters<LiveVoicePort['open']>[0], liveControl: Parameters<LiveVoicePort['open']>[1]) => {
      const opened = fake.port.open(liveRequest, liveControl);
      return {
        ...opened,
        sendSessionCommentary: (input: { text: string }) => { commentaryCalls.push(input.text); return undefined; },
        sendText: (input: { text: string }) => { texts.push(input.text); },
      } as unknown as LiveVoiceSession;
    },
  } as LiveVoicePort;
}

async function openAlarmHost(t: TestContext) {
  const clock = new FakeClock();
  const dir = mkdtempSync(join(tmpdir(), 'didi-host-speech-gemini-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
  const fake = fakeLiveVoicePort();
  const texts: string[] = [];
  const commentaryCalls: string[] = [];
  const records: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { records.push(raw as Record<string, unknown>); } });
  const profile = validateLiveProfile({ provider: 'gemini', liveModelId: 'models/explicit-live-test', voice: 'ExplicitVoice',
    keyReference: 'test-reference', route: { enabled: true, provider: 'gemini', modelId: 'models/explicit-live-test', dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' } });
  const owner = createLiveSessionOwner({ store, voice: commentarylessPort(fake, texts, commentaryCalls), profile, timeZone: 'UTC',
    createTaskRuntime: syntheticTaskFactory(store), now: () => clock.now(),
    schedule: (fire, ms) => { const timer = clock.setTimer(ms, fire); return { unref() {}, cancel: () => clock.clearTimer(timer) }; } });
  const now = clock.now();
  store.transaction(tx => tx.run("INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id,ring_started_at_utc,ring_deadline_utc) VALUES(?,?,'UTC','','ringing','synthetic',?,?)", ['synthetic-alarm', now, now, now + 60000]));
  const context = { clientId: 'synthetic', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const created = owner.create({ idempotencyKey: 'synthetic-alarm-call', inputClass: 'ordinary',
    alarm: { ownerDisplayName: 'Synthetic owner', scheduledTime: '08:00', alarmId: 'synthetic-alarm', ringDeadlineUtc: now + 60000 } }, context);
  const attachment = owner.attach({ liveSessionId: created.liveSessionId }, context);
  const consumed = (async () => { for await (const _chunk of attachment.output) { /* Native playback consumes the host event stream. */ } })();
  t.after(async () => { attachment.close(); await attachment.done; await consumed; detach(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  const events = (name: string) => records.filter(record => record.event === name);
  return { fake, texts, commentaryCalls, events, flush, clock };
}

test('an adapter with no commentary channel announces the alarm opening through the host text it accepts', async t => {
  const { fake, texts, commentaryCalls, events, flush } = await openAlarmHost(t);
  await flush();
  assert.equal(events('alarm_prompt_installed').length, 1);
  assert.equal(events('alarm_ready').length, 1);
  assert.equal(events('alarm_announced').length, 0, 'installing and sending the opening announce nothing yet');
  assert.equal(commentaryCalls.length > 0, true, 'the host prefers the commentary channel it is offered');
  assert.ok(texts.length > 0, 'the note reaches an adapter that has no commentary channel');
  assert.match(texts.join('\n'), /\[alarm mode\]/, 'the opening names the alarm mode the voice must speak');
  for (const text of texts) assert.ok(text.length <= 450, 'each host text stays inside the provider\'s command bound');
  fake.emit({ type: 'audio', pcm: new Uint8Array(4_800).fill(1), rate: 24_000, audible: true, rmsDbfs: -20 });
  await flush();
  assert.equal(events('alarm_announced').length, 1, 'her first audio after the opening announces the alarm');
  assert.equal(events('alarm_announced')[0]!.mode, 'new_session');
  fake.emit({ type: 'audio', pcm: new Uint8Array(4_800).fill(1), rate: 24_000, audible: true, rmsDbfs: -20 });
  await flush();
  assert.equal(events('alarm_announced').length, 1, 'the announcement is recorded exactly once');
});

test('the Gemini adapter acknowledges no commentary append, so its host notes ride the host text path', async t => {
  const f = await fixture(t);
  const session = new GeminiLiveVoiceAdapter(options({ socketFactory: f.socketFactory })).open(request(), control());
  t.after(() => session.close());
  await f.frame(1);
  f.send({ setupComplete: {} });
  await session.ready;
  const before = f.frames.length;
  assert.equal(session.sendSessionCommentary?.({ text: 'Synthetic host instruction' }), undefined);
  assert.equal(f.frames.length, before, 'the Gemini path writes no commentary frame');
});
