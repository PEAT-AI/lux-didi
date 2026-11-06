// M2 (issue 907): a live session stores the instant and zone it was composed at, written in the owner's
// zone, and every later prompt reads that record. The file keeps the contract's name; ruling M2-R2 withdrew
// the staleness rule from this wagon, so nothing here discards a prepared session and neither case below
// would fail on a stale clock.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile, type LiveContext } from '../live/index.js';
import type { LiveVoicePort } from '../adapters/live-voice/index.js';
import { Store } from '../runtime/store.js';
import type { HostTaskFactory } from '../tasks/host.js';

/** 06:45:58 in Jakarta, the call that started this issue: nowhere near a day boundary. */
const MORNING = Date.parse('2026-11-05T23:45:58Z');
const MODEL = 'models/live-clock-test';

/** No provider is ever opened by these cases: every one of them settles before audio. */
const voice = { capabilities: {}, open(): never { throw new Error('the clock suite never opens a provider'); } } as unknown as LiveVoicePort;
const tasks = (() => { throw new Error('the clock suite never starts a task'); }) as unknown as HostTaskFactory;

function owner(t: TestContext, zone: { timeZone: string; timeZoneSource?: 'pin' | 'host' | 'settings' } = { timeZone: 'Asia/Jakarta' }): { owner: ReturnType<typeof createLiveSessionOwner>; store: Store; clock: { now: number }; ctx: LiveContext } {
  const dir = mkdtempSync(join(tmpdir(), 'live-clock-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const profile = validateLiveProfile({ provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    // The unused-session expiry is out of the way, so only the clock rule decides these cases.
    limits: { unusedMs: 3_600_000 } });
  const clock = { now: MORNING };
  const live = createLiveSessionOwner({ createTaskRuntime: tasks, store, voice, profile,
    now: () => clock.now, ...zone, schedule: () => ({ unref: () => {}, cancel: () => {} }) });
  t.after(() => { void live.shutdown('app_quit'); rmSync(dir, { recursive: true, force: true }); });
  return { owner: live, store, clock, ctx: { clientId: 'client', auditId: 'audit', authorityEpoch: store.authorityEpoch } };
}

test('the session row carries the observed instant in the owner zone and the zone itself', (t) => {
  const h = owner(t);
  h.clock.now = MORNING;
  h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-record' }, h.ctx);
  const stored = h.store.transaction(tx => tx.get('SELECT observed_at, time_zone FROM live_sessions LIMIT 1')!);
  assert.equal(String(stored['time_zone']), 'Asia/Jakarta');
  assert.equal(String(stored['observed_at']), '2026-11-06T06:45:58+07:00', 'the instant is written in the owner zone, offset included');
});

test('M2: the owner settings zone is the session zone, and the record carries it with that offset', (t) => {
  const h = owner(t, { timeZone: 'Europe/Berlin', timeZoneSource: 'settings' });
  h.clock.now = MORNING;
  h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-settings' }, h.ctx);
  const stored = h.store.transaction(tx => tx.get('SELECT observed_at, time_zone FROM live_sessions LIMIT 1')!);
  assert.equal(String(stored['time_zone']), 'Europe/Berlin', 'the override wins over the host zone');
  assert.equal(String(stored['observed_at']), '2026-11-06T00:45:58+01:00', 'the instant is the owner zone instant');
});
