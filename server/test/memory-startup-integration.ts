import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { startHost, hostMigrations } from '../host/runtime.js';
import { Store } from '../runtime/store.js';
import { createLiveSessionOwner, validateLiveProfile } from '../live/index.js';
import { CalendarDigestCache } from '../live/warm-context.js';
import { composeLiveInstruction, NAYA_LIVE_BASE } from '../prompt/live-persona.js';
import { recordHistorySession } from '../domain/history-lifecycle.js';
import { insertSummary } from '../domain/summaries.js';
import { fakeLiveVoicePort } from './fixtures/fake-live-voice.js';

const NOW = 1_792_400_000_000;
const profile = () => validateLiveProfile({ provider: 'openai', liveModelId: 'gpt-live-1', voice: 'marin', keyReference: 'openai-primary',
  route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] },
  prompt: { text: composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en-IN' }).text, dataClass: 'ordinary' } });
async function runtime(configured = true) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-startup-integration-')); let now = NOW, providerCalls = 0;
  const host = await startHost({ dataDir: dir, webRoot: resolve(import.meta.dirname, '../../../web/dist'), port: 0,
    now: () => now,
    ...(configured ? { liveTesting: { profile: profile(), credentials: { resolve: async () => { providerCalls++; throw Error('unexpected provider'); } } } } : {}) });
  const post = (path: string, key = 'synthetic-start', signal?: AbortSignal) => fetch(host.service.origin + path, { method: 'POST',
    headers: { Authorization: `Bearer ${readFileSync(join(dir, 'admin-credential'), 'utf8').trim()}`, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Didi-Authority-Epoch': host.descriptor.authorityEpoch },
    body: JSON.stringify(path.endsWith('/live-sessions') ? { inputClass: 'ordinary' } : {}), ...(signal ? { signal } : {}) });
  return { host, post, advance: (ms: number) => { now += ms; }, providerCalls: () => providerCalls,
    async cleanup() { await host.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function snapshot(store: Store, id: string): { system: string } {
  return store.transaction(tx => JSON.parse(String(tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE live_session_id=?', [id])!['accepted_prompt_snapshot'])));
}

test('memory startup integration: real runtime wake and HTTP CREATE use fresh calendar with zero new reader calls', async () => {
  const f = await runtime(); let reads = 0;
  const cache = new CalendarDigestCache(async () => { reads++; return { state: 'present', text: '09:00 synthetic review', items: 1, fetchedAt: NOW }; }, { now: () => NOW, timeZone: 'UTC' });
  try {
    await cache.refresh(); f.host.tools.calendarDigest!.forStart = () => cache.forStart();
    f.host.tools.calendarDigest!.refresh = () => { void cache.refresh(); };
    assert.equal((await f.host.prewarm()).assembled, true);
    assert.equal((await (await f.post('/api/v1/live/prewarm')).json()).data.assembled, true);
    const started = performance.now(), response = await f.post('/api/v1/live-sessions'); assert.equal(response.status, 200);
    const { data } = await response.json(); assert.ok(snapshot(f.host.store, data.liveSessionId).system.includes('Today: 09:00 synthetic review'));
    assert.equal(reads, 1); assert.ok(performance.now() - started < 1000); assert.equal(f.providerCalls(), 0);
  } finally { cache.stop(); await f.cleanup(); }
});

test('memory startup integration: stale HTTP wait stays bounded and unconfigured runtime stays truthful', async () => {
  const f = await runtime(); let reads = 0, now = NOW;
  let settle: ((value: { state: 'present'; text: string; items: number; fetchedAt: number }) => void) | undefined;
  const cache = new CalendarDigestCache(async () => { reads++; if (reads === 1) return { state: 'present', text: '09:00 expired synthetic item', items: 1, fetchedAt: NOW };
    return await new Promise(resolveRead => { settle = resolveRead; }); }, { now: () => now, timeZone: 'UTC' });
  try {
    await cache.refresh(); now += 31 * 60_000; f.advance(31 * 60_000); f.host.tools.calendarDigest!.forStart = () => cache.forStart();
    const started = performance.now(), response = await f.post('/api/v1/live-sessions'), elapsed = performance.now() - started;
    assert.equal(response.status, 200); const { data } = await response.json(); assert.ok(!snapshot(f.host.store, data.liveSessionId).system.includes('expired synthetic item'));
    assert.ok(elapsed < 1000, `create never waits on the calendar read, measured ${elapsed}`); assert.equal(reads, 2); assert.equal(f.providerCalls(), 0);
    settle?.({ state: 'present', text: '09:00 current synthetic item', items: 1, fetchedAt: now }); await cache.refresh();
    const later = await f.post('/api/v1/live-sessions', 'after-refresh'); assert.ok(snapshot(f.host.store, (await later.json()).data.liveSessionId).system.includes('current synthetic item'));
  } finally { cache.stop(); await f.cleanup(); }
  const absent = await runtime(false);
  try {
    const expected = { ageBeforeMs: null, ageAfterMs: null, assembled: false, reason: 'unconfigured' };
    assert.deepEqual(await absent.host.prewarm(), expected); assert.deepEqual((await (await absent.post('/api/v1/live/prewarm')).json()).data, expected);
    assert.equal((await absent.post('/api/v1/live-sessions')).status, 503);
  } finally { await absent.cleanup(); }
});

test('memory startup integration: current CREATE summaries and notes never mutate frozen ATTACH text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-snapshot-integration-')), store = new Store(dir, hostMigrations);
  const fake = fakeLiveVoicePort({ provider: 'openai', inputRates: [16000] }); let now = NOW, reads = 0, note = 'Synthetic old note';
  const owner = createLiveSessionOwner({ store, voice: fake.port, profile: profile(), now: () => now, timeZone: 'UTC',
    memorySource: () => { reads++; return [{ id: 'note', text: note, dataClass: 'ordinary' }]; } });
  const context = { clientId: 'synthetic', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  try {
    store.transaction(tx => recordHistorySession(tx, 'ended-a', store.assistantId, ['ordinary'], [], now));
    const a = store.transaction(tx => insertSummary(tx, { liveSessionId: 'ended-a', dataClass: 'ordinary', sourceRevision: 1, status: 'complete', summary: 'Synthetic prior summary A.', endedAt: now - 1000, now }));
    const first = owner.create({ idempotencyKey: 'first', inputClass: 'ordinary' }, context), frozen = snapshot(store, first.liveSessionId);
    store.transaction(tx => recordHistorySession(tx, 'ended-b', store.assistantId, ['ordinary'], [], now));
    const b = store.transaction(tx => insertSummary(tx, { liveSessionId: 'ended-b', dataClass: 'ordinary', sourceRevision: 1, status: 'complete', summary: 'Synthetic newest summary B.', endedAt: now, now })); note = 'Synthetic new note';
    for (const minutes of [0, 9, 11, 30]) {
      now = NOW + minutes * 60_000; await owner.prewarm(); const current = owner.create({ idempotencyKey: `summary-${minutes}`, inputClass: 'ordinary' }, context);
      assert.ok(snapshot(store, current.liveSessionId).system.includes('Synthetic newest summary B.')); assert.ok(snapshot(store, current.liveSessionId).system.includes('Synthetic new note'));
      const provenance = store.transaction(tx => JSON.parse(String(tx.get('SELECT memory_provenance FROM live_sessions WHERE live_session_id=?', [current.liveSessionId])!['memory_provenance'])));
      assert.deepEqual(provenance.injectedSummaryIds, [b.id, a.id]);
    }
    now = NOW; const before = reads, attached = owner.attach({ liveSessionId: first.liveSessionId }, context); await attached.ready;
    assert.equal(reads, before); assert.equal(fake.requests[0]!.system.text, frozen.system);
    assert.equal(first.promptIdentity, createHash('sha256').update(JSON.stringify({ text: frozen.system, dataClass: 'ordinary' })).digest('hex'));
    assert.ok(!fake.requests[0]!.system.text.includes('Synthetic newest summary B.')); await attached.close();
  } finally { await owner.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('memory startup integration: cancelled HTTP CREATE never accepts after calendar wait', async () => {
  const f = await runtime();
  let release: (() => void) | undefined;
  let waiting: (() => void) | undefined;
  const entered = new Promise<void>(resolveWait => { waiting = resolveWait; });
  f.host.tools.calendarDigest!.forStart = async () => {
    waiting?.(); await new Promise<void>(resolveWait => { release = resolveWait; });
    return { state: 'empty', text: undefined, items: 0, fetchedAt: NOW };
  };
  try {
    const controller = new AbortController();
    const response = f.post('/api/v1/live-sessions', 'cancelled-start', controller.signal);
    const rejected = assert.rejects(response, error => error instanceof Error && error.name === 'AbortError');
    await entered; controller.abort(); await rejected;
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 20)); release?.();
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 20));
    assert.equal(f.host.store.transaction(tx => Number(tx.get('SELECT COUNT(*) AS n FROM live_sessions')!['n'])), 0);
    assert.equal(f.providerCalls(), 0);
  } finally { release?.(); await f.cleanup(); }
});
