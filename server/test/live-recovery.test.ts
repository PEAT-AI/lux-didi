import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import type { LiveVoiceControl, LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort, LiveVoiceRequest, LiveVoiceSession } from '../adapters/live-voice/index.js';

const NOW = 1_700_000_000_000;
const MODEL = 'models/live-recovery-test';
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** A clock the test moves itself: no test sleeps and no timer fires on its own. */
class DeadlineClock {
  now = NOW;
  readonly pending = new Set<{ due: number; callback: () => void }>();
  schedule = (callback: () => void, delayMs: number) => {
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

/** One provider session the test drives: it never becomes ready and dies on its own, or it goes live. */
interface DrivenSession {
  live(): void;
  die(): void;
}

/** A port whose every open can be made to die before its ready event, which is the failure at issue (#525). */
function drivenPort() {
  const sessions: DrivenSession[] = [];
  const openedAt: number[] = [];
  let events: ((event: LiveVoiceEvent) => void) = () => {};
  let sequence = 0;
  const port = {
    capabilities: Object.freeze({ provider: 'gemini', supportsResumption: false, supportsGoAway: false, supportsInterruption: false,
      supportsServerVadConfig: false, inputRates: Object.freeze([8000]), outputRates: Object.freeze([24000]),
      outputModalities: Object.freeze(['audio', 'text'] as const), thinking: 'provider_default', supportsToolScheduling: false,
      toleratesEmptyReadyLifecycle: false }),
    open(_request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
      let resolveReady: () => void = () => {};
      let rejectReady: (error: unknown) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      let resolveDone: (outcome: LiveVoiceOutcome) => void = () => {};
      const done = new Promise<LiveVoiceOutcome>(resolve => { resolveDone = resolve; });
      const pending: LiveVoiceEvent[] = [];
      let waiter: (() => void) | undefined;
      let ended = false;
      const wake = () => { const waiting = waiter; waiter = undefined; waiting?.(); };
      const end = (): void => { ended = true; wake(); };
      events = event => { pending.push(event); wake(); };
      const iterator: AsyncIterable<LiveVoiceEvent> = {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (ended) return;
            if (!pending.length) { await new Promise<void>(resolve => { waiter = resolve; }); continue; }
            yield pending.shift()!;
          }
        },
      };
      const session: LiveVoiceSession = {
        ready, done, events: iterator,
        sendAudio(): void {}, sendText(): void {}, sendToolResponse(): void {}, endAudioStream(): void {},
        close(): void { if (ended) return; end(); resolveDone({ status: 'cancelled', code: 'cancelled' }); },
      };
      control.signal.addEventListener('abort', () => { if (ended) return; end(); resolveDone({ status: 'cancelled', code: 'cancelled' }); }, { once: true });
      sessions.push({
        live: () => { events({ sequence: ++sequence, type: 'ready' } as LiveVoiceEvent); resolveReady(); },
        die: () => { rejectReady(new Error('provider setup refused')); resolveDone({ status: 'failed', code: 'transport_error', recoverable: true }); end(); },
      });
      openedAt.push(sessions.length);
      return session;
    },
  } as unknown as LiveVoicePort;
  return { port, sessions, openedAt };
}

interface Harness {
  owner: LiveSessionOwner; store: Store; port: ReturnType<typeof drivenPort>; clock: DeadlineClock; ctx: LiveContext;
  receipts: Record<string, unknown>[];
  advance(ms: number): Promise<void>;
}

function harness(t: TestContext): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-recovery-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const clock = new DeadlineClock();
  const port = drivenPort();
  const receipts: Record<string, unknown>[] = [];
  const sink = attachHostLogSink({ event: raw => { receipts.push(raw as Record<string, unknown>); } });
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const owner = createLiveSessionOwner({ store, voice: port.port, profile, now: () => clock.now, timeZone: 'Asia/Kolkata', schedule: clock.schedule });
  t.after(() => { sink(); rmSync(dir, { recursive: true, force: true }); });
  return { owner, store, port, clock, ctx, receipts, advance: async ms => { clock.now += ms; clock.runDue(); await flush(); } };
}

/** The provider session at \`index\`, waiting out its backoff when the host has not opened it yet. */
async function sessionAt(h: Harness, index: number): Promise<DrivenSession | undefined> {
  for (let i = 0; i < 60; i++) { if (h.port.sessions.length > index) return h.port.sessions[index]; await flush(); }
  for (let round = 0; round < 4; round += 1) {
    await h.advance(10_000);
    if (h.port.sessions.length > index) return h.port.sessions[index];
  }
  return undefined;
}

/** The receipt the client reads when the call is over, plus the terminal frame the orb leaves live on. */
async function ended(t: TestContext, attachment: { done: Promise<{ terminal: unknown }>; output: AsyncIterable<{ kind: string; marker?: { kind: string } }> }): Promise<{ terminal: unknown; terminalFrame: boolean }> {
  let terminalFrame = false;
  const reader = (async () => {
    for await (const chunk of attachment.output) {
      if (chunk.kind === 'marker' && chunk.marker?.kind === 'terminal') { terminalFrame = true; return; }
    }
  })();
  const snapshot = await attachment.done;
  await Promise.race([reader, new Promise<void>(resolve => setTimeout(resolve, 1_000))]);
  t.diagnostic('terminal frame delivered');
  return { terminal: snapshot.terminal, terminalFrame };
}

test('#525: a provider session that dies right after open costs three attempts after their backoff, then settles', async t => {
  const h = harness(t);
  const created = h.owner.create({ idempotencyKey: 'death-loop', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  await attachment.ready;
  const first = (await sessionAt(h, 0))!;
  first.live();
  await flush();
  // The session goes live, then dies, and every recovery socket dies before its ready event.
  const died: number[] = [h.clock.now];
  first.die();
  await flush();
  for (let index = 1; index <= 4; index += 1) {
    const next = await sessionAt(h, index);
    if (!next) break;
    died.push(h.clock.now);
    next.die();
    await flush();
  }
  const end = await ended(t, attachment as never);
  // At most RECOVERY_MAX_CONSECUTIVE recoveries: the opening session plus three attempts, never a fourth.
  assert.equal(h.port.sessions.length, 4, 'one session and three recovery attempts, then the call ends');
  assert.equal(died.length, 4, 'every attempt was driven and none was left hanging');
  // A dead socket never re-enters the loop without its own backoff: 0, 2 s, 5 s between attempts.
  for (let i = 2; i < died.length; i += 1) {
    assert.ok(died[i]! - died[i - 1]! >= 2_000, `attempt ${i} waited its backoff, got ${died[i]! - died[i - 1]!} ms`);
  }
  const recovery = h.receipts.filter(entry => entry['event'] === 'live_recovery');
  assert.deepEqual(recovery.map(entry => entry['code']), ['open_failed', 'open_failed', 'open_failed'], 'each dead socket is a failed attempt, never an opening');
  assert.deepEqual(recovery.map(entry => entry['attempt']), [1, 2, 3], 'and the count is consecutive');
  assert.ok(recovery.every(entry => typeof entry['liveSessionId'] === 'string' && entry['generation'] !== undefined), 'every line names the session and generation (#451)');
  assert.lengthOf(h.receipts.filter(entry => entry['event'] === 'live_recovery' && entry['code'] === 'opened'), 0, 'a socket that never said ready is never logged as opened');
  assert.deepEqual(end.terminal, { state: 'failed', code: 'resume_failed' }, 'the call settles with a visible reason');
  assert.equal(end.terminalFrame, true, 'and the terminal frame reaches the client, so the orb leaves live');
});

test('#527: the three-strike ceiling still fires after a long healthy stretch', async t => {
  const h = harness(t);
  const created = h.owner.create({ idempotencyKey: 'healthy-then-dead', inputClass: 'ordinary' }, h.ctx);
  const attachment = h.owner.attach({ liveSessionId: created.liveSessionId }, h.ctx);
  await attachment.ready;
  const first = (await sessionAt(h, 0))!;
  first.live();
  await flush();
  // 90 s of health, moved without firing the session window: the drop itself is what the host reacts to.
  h.clock.now += 90_000;
  first.die();
  await flush();
  for (let index = 1; index <= 4; index += 1) {
    const next = await sessionAt(h, index);
    if (!next) break;
    next.die();
    await flush();
  }
  const end = await ended(t, attachment as never);
  assert.equal(h.port.sessions.length, 4, 'the ceiling counts the dead sessions, it does not reset per attempt');
  assert.deepEqual(end.terminal, { state: 'failed', code: 'resume_failed' }, 'a healthy episode does not buy an endless retry loop');
});
