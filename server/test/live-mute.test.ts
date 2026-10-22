import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, MUTE_WARM_MS, MUTED_OFFER_SILENCE_MS, validateLiveProfile,
  type LiveContext, type LiveAttachment, type LiveOutputChunk, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';
import type { LiveVoicePort, LiveVoiceSession } from '../adapters/live-voice/index.js';
import { pcm } from './live-voice-fixture.js';

const NOW = 1_700_000_000_000;
const MODEL = 'models/live-mute-test';
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** A dead-air clock: nothing sleeps, the test moves time and the owner's timers fire in due order. */
class DeadlineClock {
  now = NOW;
  readonly pending = new Set<{ due: number; callback: () => void }>();
  schedule = (callback: () => void, delayMs: number) => {
    assert.ok(delayMs > 0, 'a zero-delay loop is a bug, not a schedule');
    const entry = { due: this.now + delayMs, callback };
    this.pending.add(entry);
    return { unref: () => {}, cancel: () => { this.pending.delete(entry); } };
  };
  runDue(): void {
    for (;;) {
      const entry = [...this.pending].find(item => item.due <= this.now);
      if (!entry) return;
      this.pending.delete(entry);
      entry.callback();
    }
  }
}

interface Live {
  owner: LiveSessionOwner; fake: FakeLiveVoice; receipts: Record<string, unknown>[]; liveSessionId: string;
  attachment: LiveAttachment; uplinkBytes: () => number; texts: string[]; output: LiveOutputChunk[];
  emit(event: FakeLiveVoiceEvent): Promise<void>; advance(ms: number): Promise<void>;
}

/** The fake's own sendAudio/sendText are no-ops, so the test wraps the session it hands out. */
function recordingPort(fake: FakeLiveVoice, record: { uplinkBytes: number; texts: string[] }): LiveVoicePort {
  return {
    capabilities: fake.port.capabilities,
    open: (liveRequest: Parameters<LiveVoicePort['open']>[0], liveControl: Parameters<LiveVoicePort['open']>[1]) => {
      const opened = fake.port.open(liveRequest, liveControl);
      return {
        ...opened,
        sendAudio: (input: { pcm: Uint8Array; dataClass?: string }) => { record.uplinkBytes += input.pcm.byteLength; },
        sendText: (input: { text: string }) => { record.texts.push(input.text); },
      } as unknown as LiveVoiceSession;
    },
  } as LiveVoicePort;
}

async function openLive(t: TestContext, limits: Record<string, number> = {}): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-mute-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const scheduler = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  const record = { uplinkBytes: 0, texts: [] as string[] };
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50, ...limits },
  });
  const receipts: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => {
    const value = raw as Record<string, unknown>;
    if (value.event === 'live_mute' || value.event === 'live_watchdog') receipts.push(value);
  } });
  t.after(() => { detach(); rmSync(dir, { recursive: true, force: true }); });
  const owner = createLiveSessionOwner({ store, voice: recordingPort(fake, record), profile,
    now: () => scheduler.now, timeZone: 'Asia/Kolkata', schedule: scheduler.schedule });
  const session = owner.create({ idempotencyKey: `mute-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  const output: LiveOutputChunk[] = [];
  void (async () => { for await (const chunk of attachment.output) output.push(chunk); })();
  return {
    owner, fake, receipts, liveSessionId: session.liveSessionId, attachment, output,
    uplinkBytes: () => record.uplinkBytes, texts: record.texts,
    emit: async event => { fake.emit(event); await flush(); },
    advance: async ms => { scheduler.now += ms; scheduler.runDue(); await flush(); },
  };
}

const phases = (live: Live): unknown[] => live.receipts.filter(record => record.event === 'live_watchdog').map(record => record.phase);
const mutes = (live: Live): Record<string, unknown>[] => live.receipts.filter(record => record.event === 'live_mute');
const audibleFrame = { type: 'audio' as const, pcm: new Uint8Array(4_800).fill(1), rate: 24_000, audible: true, rmsDbfs: -20 };
const terminalCode = (live: Live): string | undefined => {
  const terminal = live.owner.get(live.liveSessionId).terminal;
  return terminal !== null && 'code' in terminal ? terminal.code : undefined;
};

test('a mute keeps the provider session open, uploads nothing and suspends the watchdog', async t => {
  const live = await openLive(t);
  await live.emit({ type: 'inputTranscription', text: 'what is on my plate', finished: true });
  assert.deepEqual(phases(live), ['armed'], 'the ended owner turn owes a reply');

  live.attachment.setInputMuted(true);
  await flush();
  assert.equal(live.owner.get(live.liveSessionId).terminal, null, 'the mute closes nothing');
  assert.equal(live.fake.sessionsOpened, 1, 'the provider session is the same one');
  const before = live.uplinkBytes();
  for (let i = 0; i < 10; i += 1) { live.attachment.sendAudio({ pcm }); }
  await flush();
  assert.equal(live.uplinkBytes(), before, 'a muted uplink forwards zero PCM frames');

  for (let spent = 0; spent < 60_000; spent += 1_000) await live.advance(1_000);
  assert.deepEqual(phases(live), ['armed'], 'sixty muted seconds arm nothing new and never nudge');
  assert.equal(live.owner.get(live.liveSessionId).terminal, null, 'a muted session is not a stalled one');
  assert.equal(live.fake.sessionsOpened, 1, 'no recovery ran while muted');

  live.attachment.setInputMuted(false);
  await flush();
  assert.deepEqual(phases(live), ['armed', 'armed'], 'the unmute re-arms the answer that is still owed');
  assert.equal(live.fake.sessionsOpened, 1, 'the unmute resumes the same session');

  const events = mutes(live);
  assert.deepEqual(events.map(event => [event.muted, event.warm]), [[true, true], [false, true]],
    'the receipts name the mute and the unmute on a session that stayed open');
  assert.equal(events[1]?.['msSinceMute'], 60_000, 'the unmute receipt carries how long the mute lasted');
  assert.equal(events[0]?.['generation'], events[1]?.['generation'], 'the same generation across the window');
  assert.equal(events[0]?.['liveSessionId'], live.liveSessionId, 'the receipt names the session');
});

test('a mute past the cost cap settles as muted_expired, benign, never paused forever', async t => {
  const live = await openLive(t);
  live.attachment.setInputMuted(true);
  await flush();
  await live.advance(MUTE_WARM_MS - 1_000);
  assert.equal(live.owner.get(live.liveSessionId).terminal, null, 'the window is 180 s, not less');
  await live.advance(1_000);
  const terminal = live.owner.get(live.liveSessionId).terminal;
  assert.deepEqual(terminal, { state: 'closed', code: 'muted_expired' }, 'the expiry is a benign close');
  const expiry = mutes(live).at(-1);
  assert.deepEqual([expiry?.['muted'], expiry?.['warm'], expiry?.['msSinceMute']], [true, false, MUTE_WARM_MS],
    'the expiry receipt says the session is no longer warm');
  await assert.doesNotReject(live.attachment.done, 'the consumer sees the session end');
});

test('a muted session never idles out, even with an idle limit shorter than the mute window', async t => {
  const live = await openLive(t, { idleMs: 60_000 });
  live.attachment.setInputMuted(true);
  await flush();
  // Provider activity is what restarts the idle clock in the ordinary path; under a mute it must not.
  await live.emit({ type: 'modelTurnStarted' });
  await live.emit({ type: 'audio', pcm: new Uint8Array(4_800).fill(1), rate: 24_000, audible: true, rmsDbfs: -20 });
  await live.emit({ type: 'turnComplete' });
  for (let spent = 0; spent < 90_000; spent += 1_000) await live.advance(1_000);
  assert.equal(live.owner.get(live.liveSessionId).terminal, null,
    'ninety muted seconds are not an idle session, the idle clock is suspended');
  await live.advance(90_000 + 1_000);
  assert.deepEqual(live.owner.get(live.liveSessionId).terminal, { state: 'closed', code: 'muted_expired' },
    'only the mute cost cap ends it');
});

test('a provider drop while muted is muted cold with no recovery attempt', async t => {
  const live = await openLive(t);
  live.attachment.setInputMuted(true);
  await flush();
  await live.emit({ type: 'goAway', timeLeftMs: 0 });
  await flush();
  assert.equal(live.fake.sessionsOpened, 1, 'a drop under a mute reconnects nothing');
  assert.equal(terminalCode(live), 'muted_drop', 'the drop is recorded as the muted cold case');
  const drop = mutes(live).at(-1);
  assert.deepEqual([drop?.['muted'], drop?.['warm']], [true, false], 'the receipt says the session is gone');
});

test('an answer that arrives while muted is held, never played, and offered once after two silent seconds', async t => {
  const live = await openLive(t);
  live.attachment.setInputMuted(true);
  await flush();
  await live.emit(audibleFrame);
  await live.emit({ type: 'turnComplete' });
  assert.equal(live.output.filter(chunk => chunk.kind === 'audio').length, 0,
    'a muted owner hears none of the answer, not late and not quieter');
  assert.deepEqual(live.texts, [], 'and nothing is spoken on her behalf');

  live.attachment.setInputMuted(false);
  await flush();
  await live.advance(MUTED_OFFER_SILENCE_MS - 500);
  assert.deepEqual(live.texts, [], 'the offer waits out the two seconds of owner silence');
  await live.advance(1_000);
  assert.equal(live.texts.length, 1, 'the owner stayed silent, so one short item says an answer arrived');
  assert.match(live.texts[0] ?? '', /muted/, 'the item says the answer arrived while muted');
});

test('an owner who speaks within two seconds of the unmute is never interrupted by an offer', async t => {
  const live = await openLive(t);
  live.attachment.setInputMuted(true);
  await flush();
  await live.emit(audibleFrame);
  await live.emit({ type: 'turnComplete' });
  live.attachment.setInputMuted(false);
  await flush();
  await live.advance(500);
  await live.emit({ type: 'inputTranscription', text: 'hold on, one thing first', finished: true });
  await live.advance(MUTED_OFFER_SILENCE_MS + 1_000);
  assert.deepEqual(live.texts, [], 'the owner spoke first, so no held answer is offered over him');
});

test('a muted attachment accepts the same mute twice and a late frame after the mute changes nothing', async t => {
  const live = await openLive(t);
  live.attachment.setInputMuted(true);
  live.attachment.setInputMuted(true);
  await flush();
  assert.equal(mutes(live).length, 1, 'one receipt per change, never one per call');
  live.attachment.setInputMuted(false);
  await flush();
  assert.deepEqual(mutes(live).map(event => event.muted), [true, false], 'the pair is recorded in order');
});
