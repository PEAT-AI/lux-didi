import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openFixture, result } from './chat-process.js';
import { ChatService, ChatError, chatMigrations, type ChatConfig, type RunSnapshot } from '../chat/index.js';
import { Store } from '../runtime/store.js';
import { PROMPT_VERSION, compilePrompt } from '../prompt/index.js';
import type { ModelPort, ModelRequest, ModelControl, ModelResult } from '../adapters/model/types.js';
import type { SchemaMigration } from '../contracts/storage.js';

class CountingModel implements ModelPort {
  calls: ModelRequest[] = []; controls: ModelControl[] = [];
  pending: ((value: ModelResult) => void)[] = [];
  delayed = false; status: ModelResult['status'] = 'complete'; text = 'Answer';
  generate(request: ModelRequest, control: ModelControl): Promise<ModelResult> {
    this.calls.push(request); this.controls.push(control);
    if (this.delayed) return new Promise(resolve => this.pending.push(resolve));
    return Promise.resolve(result(request, this.status, this.text));
  }
  finish(index = 0) { this.pending[index]?.(result(this.calls[index]!, this.status, this.text)); }
}
function fixture(overrides: Partial<ChatConfig> = {}, migrations: readonly SchemaMigration[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-test-')); const model = new CountingModel();
  const f = openFixture(dir, model, overrides, migrations); const session = f.createSession();
  return { ...f, model, dir, session,
    accept(text = 'Hello', key = 'key') { return f.chat.accept({ sessionId: session.id, text, idempotencyKey: key }, f.context); },
    entries() { return f.store.transaction(tx => f.domain.execute(tx, 'getSession', { id: session.id }, f.context)).entries; },
    close() { f.store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function terminal(f: ReturnType<typeof fixture>, run: RunSnapshot) {
  const stream = f.chat.subscribe(run.runId, f.context);
  for await (const e of stream) if (e.type === 'snapshot' && e.run.state === 'terminal') return e.run;
  throw Error('no durable terminal event');
}
async function started(f: ReturnType<typeof fixture>) {
  // Deterministic scheduling boundary, no timer/polling or synthetic load.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.model.calls.length, 1);
}
function error(code: string) { return (e: unknown) => e instanceof ChatError && e.code === code && !e.localCapture; }

test('accept/replay/fingerprint collision and active-session serialization are durable', async () => {
  const f = fixture(); f.model.delayed = true;
  try {
    const run = f.accept(); assert.equal(f.accept().runId, run.runId);
    assert.throws(() => f.accept('Changed'), error('idempotency_conflict'));
    assert.throws(() => f.accept('Other', 'other'), error('active_run'));
    assert.equal(f.entries().length, 1); await started(f);
    assert.equal(f.accept().runId, run.runId); assert.equal(f.model.calls.length, 1);
    f.model.finish(); assert.equal((await terminal(f, run)).outcome, 'complete');
    assert.deepEqual(f.entries().map(e => e.role), ['user', 'assistant']);
    assert.equal(f.accept().runId, run.runId); assert.equal(f.model.calls.length, 1);
  } finally { f.close(); }
});

test('accept rolls back user entry if chat insert fails; Store transactions are synchronous', () => {
  const f = fixture({}, [{ owner: 'fault', version: 1, statements: ["CREATE TRIGGER reject_run BEFORE INSERT ON chat_runs BEGIN SELECT RAISE(ABORT,'run write rejected'); END"] }]);
  try {
    assert.throws(() => f.accept(), /run write rejected/); assert.equal(f.entries().length, 0);
    assert.equal(f.model.calls.length, 0);
    assert.throws(() => f.store.transaction((async () => {}) as never), /synchronous/);
  } finally { f.close(); }
});

test('boundary rejects unavailable routes before capture and validates ownership/epoch', () => {
  const f = fixture({ route: { provider: 'synthetic', model: 'absent', available: false, allows: () => true } });
  try {
    assert.throws(() => f.accept(), error('unavailable')); assert.equal(f.entries().length, 0); assert.equal(f.model.calls.length, 0);
    assert.throws(() => f.chat.accept({ sessionId: f.session.id, text: 'x', idempotencyKey: 'k' }, { ...f.context, assistantId: 'foreign' }), error('unauthorized'));
    assert.throws(() => f.chat.accept({ sessionId: f.session.id, text: 'x', idempotencyKey: 'k' }, { ...f.context, authorityEpoch: 'stale' }), error('epoch_mismatch'));
  } finally { f.close(); }
});

test('unknown classification and foreign owner fail unavailable, never guessed ordinary', () => {
  for (const classify of [() => null, () => ({ ownerId: 'foreign', dataClass: 'ordinary' as const })]) {
    const f = fixture({ classify });
    try { assert.throws(() => f.accept(), error('unavailable')); assert.equal(f.entries().length, 0); assert.equal(f.model.calls.length, 0); }
    finally { f.close(); }
  }
});

test('route rejects classified history/evidence before model dispatch while reporting captured user', async () => {
  const f = fixture({ route: { provider: 'synthetic', model: 'ordinary-only', available: true, allows: classes => !classes.includes('sensitive') } });
  try {
    const c = { ...f.config, classify: () => ({ ownerId: f.store.assistantId, dataClass: 'sensitive' as const }) };
    const chat = new ChatService(c); chat.recover(f.context);
    const run = chat.accept({ sessionId: f.session.id, text: 'Classified', idempotencyKey: 's' }, f.context);
    for await (const e of chat.subscribe(run.runId, f.context)) if (e.type === 'snapshot' && e.run.state === 'terminal') { assert.equal(e.run.outcome, 'unavailable'); break; }
    assert.equal(f.model.calls.length, 0); assert.equal(f.entries().length, 1);
  } finally { f.close(); }
});

test('cancel wins: abort signal and late completion cannot append an answer; disconnect does not cancel', async () => {
  const f = fixture(); f.model.delayed = true;
  try {
    const run = f.accept(); const iterator = f.chat.subscribe(run.runId, f.context)[Symbol.asyncIterator]();
    await iterator.next(); await iterator.return?.(); await started(f);
    assert.equal(f.model.controls[0]!.signal.aborted, false);
    assert.equal(f.chat.cancel(run.runId, f.context).outcome, 'cancelled');
    assert.equal(f.model.controls[0]!.signal.aborted, true);
    f.model.finish(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.chat.get(run.runId, f.context).outcome, 'cancelled'); assert.equal(f.entries().length, 1);
    assert.throws(() => f.chat.cancel(run.runId, { ...f.context, clientId: 'other' }), error('unauthorized'));
  } finally { f.close(); }
});

test('complete wins: cancel after final commit returns completion unchanged', async () => {
  const f = fixture();
  try { const run = f.accept(); const done = await terminal(f, run); assert.equal(done.outcome, 'complete'); assert.equal(f.chat.cancel(run.runId, f.context).finalEntryId, done.finalEntryId); }
  finally { f.close(); }
});

test('terminal answer/status commit is atomic and persistence failure never claims saved completion', async () => {
  const f = fixture({}, [{ owner: 'fault', version: 1, statements: ["CREATE TRIGGER reject_complete BEFORE UPDATE ON chat_runs WHEN NEW.outcome='complete' BEGIN SELECT RAISE(ABORT,'terminal rejected'); END"] }]); f.model.delayed = true;
  try {
    const run = f.accept(); await started(f);
    f.model.finish(); const done = await terminal(f, run);
    assert.equal(done.outcome, 'persistence_failed'); assert.equal(done.finalEntryId, null); assert.equal(f.entries().length, 1);
  } finally { f.close(); }
});

for (const status of ['denied', 'blocked', 'error', 'empty', 'truncated', 'cancelled', 'deadline'] as const) {
  test(`model ${status} is distinct and provisional text is not completed history`, async () => {
    const f = fixture(); f.model.status = status; f.model.text = status === 'empty' ? '' : 'Partial';
    try { const done = await terminal(f, f.accept()); assert.equal(done.outcome, status); assert.equal(done.finalEntryId, null); assert.equal(done.partialText, f.model.text); assert.equal(f.entries().length, 1); }
    finally { f.close(); }
  });
}

test('empty complete is not an archival answer; deadline enforced even when model ignores control', async () => {
  const f = fixture({ deadlineMs: 20 }); f.model.delayed = true;
  try { const run = f.accept(); const done = await terminal(f, run); assert.equal(done.outcome, 'deadline'); assert.equal(f.model.controls[0]!.signal.aborted, true); f.model.finish(); }
  finally { f.close(); }
  const empty = fixture(); empty.model.text = '';
  try { assert.equal((await terminal(empty, empty.accept())).outcome, 'empty'); assert.equal(empty.entries().length, 1); } finally { empty.close(); }
});

test('sequenced provisional events, reconnect snapshot, bounded overflow explicitly requires resync', async () => {
  const f = fixture({ subscriberCapacity: 2 }); f.model.delayed = true;
  try {
    const run = f.accept(); await started(f);
    const slow = f.chat.subscribe(run.runId, f.context)[Symbol.asyncIterator]();
    const control = f.model.controls[0]!;
    for (const text of ['one', 'two', 'three']) control.onEvent?.({ type: 'text', text, provisional: true });
    const overflow = await slow.next(); assert.equal(overflow.value.type, 'resync_required');
    const reconnected = f.chat.subscribe(run.runId, f.context)[Symbol.asyncIterator]();
    const snapshot = (await reconnected.next()).value; assert.equal(snapshot.type, 'snapshot');
    assert.equal(snapshot.run.partialText, 'onetwothree'); assert.equal(snapshot.run.finalEntryId, null);
    control.onEvent?.({ type: 'text', text: 'four', provisional: true });
    const delta = (await reconnected.next()).value; assert.equal(delta.type, 'text'); assert.equal(delta.provisional, true); assert.ok(delta.sequence > snapshot.sequence);
    f.model.finish(); const final = (await reconnected.next()).value; assert.equal(final.run.outcome, 'complete');
    assert.equal(f.entries()[1]!.text, 'Answer'); assert.ok(final.sequence > delta.sequence);
    await reconnected.return?.();
  } finally { f.close(); }
});

test('long archive selects contiguous whole-turn suffix using actual compiler accounting and preserves all records', async () => {
  const f = fixture({ context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 1200 }, sources: [] } });
  try {
    for (let i = 0; i < 180; i++) f.store.transaction(tx => f.domain.execute(tx, 'appendEntry', { sessionId: f.session.id, text: `old-${i} ${'x'.repeat(70)}`, role: 'user', timeZone: 'UTC' }, f.context));
    const run = f.accept('Current'); await terminal(f, run);
    const request = f.model.calls[0]!; const contents = request.contents;
    assert.equal(JSON.parse(contents.at(-1)!.parts[0]!.text!).text, 'Current'); assert.ok(contents.length < 181);
    const trace = f.store.transaction(tx => tx.get('SELECT trace FROM chat_runs WHERE run_id=?', [run.runId]));
    const parsed = JSON.parse(String(trace!.trace)); assert.equal(parsed.omittedHistoryCount, 181 - contents.length);
    const texts = contents.slice(0, -1).map(c => JSON.parse(c.parts[0]!.text!).text);
    assert.deepEqual(texts, f.entries().slice(180 - texts.length, 180).map(e => e.text));
    assert.equal(f.entries().length, 182); assert.deepEqual(request.declarations, []);
    assert.equal(request.promptVersion, PROMPT_VERSION); assert.ok(request.system.includes('de-DE'));
    assert.equal(JSON.stringify(request).includes(f.store.assistantId), false);
    const expected = compilePrompt(parsed.compileInput); assert.equal(expected.manifest.systemHash, parsed.manifest.systemHash);
    assert.deepEqual(expected.contents, request.contents); assert.equal(JSON.stringify(trace).includes('must-not-persist'), false);
  } finally { f.close(); }
});

test('oversized current turn terminalizes typed before dispatch, with truthful local capture', async () => {
  const f = fixture({ context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 200 }, sources: [] } });
  try { const run = f.accept('x'.repeat(1000)); const done = await terminal(f, run); assert.equal(done.outcome, 'input_too_large'); assert.equal(f.model.calls.length, 0); assert.equal(f.entries().length, 1); }
  finally { f.close(); }
});

test('actual domain recall and Today evidence retain source identities; no runnable tools', async () => {
  const f = fixture({ context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 }, sources: [{ id: 'recall', state: 'available' }, { id: 'today', state: 'available' }], recall: { q: 'needle', limit: 10 }, today: { date: '1970-01-01', timeZone: 'UTC' } } });
  try {
    f.store.transaction(tx => {
      f.domain.execute(tx, 'appendEntry', { sessionId: f.session.id, text: 'needle evidence', role: 'user', timeZone: 'UTC', sourceRef: { id: 'source-a', label: 'Synthetic', sourceTimestamp: null, availability: 'present' } }, f.context);
      f.domain.execute(tx, 'createCommitment', { title: 'Synthetic task', dueAt: '1970-01-01T12:00:00Z', timeZone: 'UTC' }, f.context);
    });
    const done = await terminal(f, f.accept('Current')); assert.equal(done.outcome, 'complete');
    const request = f.model.calls[0]!; assert.ok(request.context.items.some(i => i.text.includes('source-a')));
    assert.ok(request.context.items.some(i => i.text.includes('Synthetic task'))); assert.deepEqual(request.declarations, []);
    assert.ok(request.context.selectedIds.some(id => id.startsWith('recall:'))); assert.ok(request.context.selectedIds.some(id => id.startsWith('today:')));
  } finally { f.close(); }
});

test('noncomplete provider text never enters the next ordinary history', async () => {
  const f = fixture(); f.model.status = 'truncated'; f.model.text = 'NONFINAL';
  try { await terminal(f, f.accept('First')); f.model.status = 'complete'; f.model.text = 'Final'; await terminal(f, f.accept('Second', 'second'));
    assert.equal(JSON.stringify(f.model.calls[1]!.contents).includes('NONFINAL'), false); }
  finally { f.close(); }
});

for (const mode of ['accepted', 'intent', 'called']) {
  test(`real SIGKILL ${mode}: startup sweep no replay, explicit retry/new identity, prior entries preserved`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-kill-')); const model = new CountingModel();
    let f = openFixture(dir, model); const session = f.createSession(); const completeSession = f.createSession();
    const completed = f.chat.accept({ sessionId: completeSession.id, text: 'Preserved complete turn', idempotencyKey: 'preserve' }, f.context);
    for await (const e of f.chat.subscribe(completed.runId, f.context)) if (e.type === 'snapshot' && e.run.state === 'terminal') { assert.equal(e.run.outcome, 'complete'); break; }
    const terminalRow = f.store.transaction(tx => tx.get('SELECT * FROM chat_runs WHERE run_id=?', [completed.runId]));
    model.calls = []; model.controls = []; f.store.close();
    const child = fork(new URL('./chat-process.js', import.meta.url), ['child', dir, mode, session.id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let runId = ''; let killed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`child checkpoint ${mode} missing`)), 5000);
        child.on('error', reject); child.on('message', (message: unknown) => {
          const event = message as { phase: string; runId?: string }; if (event.runId) runId = event.runId;
          if (event.phase === mode) { clearTimeout(timer); resolve(); }
        });
      });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); killed = true; await exited;
      assert.ok(runId); const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').length : 0;
      assert.equal(calls, mode === 'called' ? 1 : 0);
      // Rotate actual synthetic Store authority before constructing startup
      // CHAT: recovery sees genuine prior-epoch orphans, not edited run states.
      const rotated = new Store(dir, [...f.domain.migrations, ...chatMigrations]);
      rotated.transaction(tx => tx.run("UPDATE runtime_meta SET value=? WHERE key='authorityEpoch'", ['next-synthetic-epoch'])); rotated.close();
      f = openFixture(dir, model); const recovered = f.chat.get(runId, f.context);
      assert.notEqual(recovered.authorityEpoch, f.context.authorityEpoch);
      assert.deepEqual(f.store.transaction(tx => tx.get('SELECT * FROM chat_runs WHERE run_id=?', [completed.runId])), terminalRow);
      assert.equal(f.chat.get(completed.runId, f.context).outcome, 'complete');
      assert.equal(f.store.transaction(tx => tx.get('SELECT terminal_epoch FROM chat_runs WHERE run_id=?', [runId]))!.terminal_epoch, f.context.authorityEpoch);
      assert.equal(recovered.outcome, mode === 'accepted' ? 'not_dispatched' : 'outcome_unknown'); assert.equal(model.calls.length, 0);
      const replay = f.chat.accept({ sessionId: session.id, text: 'Synthetic child turn', idempotencyKey: 'child' }, f.context); assert.equal(replay.runId, runId); assert.equal(model.calls.length, 0);
      const next = f.chat.accept({ sessionId: session.id, text: 'New explicit attempt', idempotencyKey: 'new', retryOf: runId }, f.context); assert.notEqual(next.runId, runId);
      for await (const e of f.chat.subscribe(next.runId, f.context)) if (e.type === 'snapshot' && e.run.state === 'terminal') { assert.equal(e.run.outcome, 'complete'); break; }
      assert.equal(model.calls.length, 1); f.chat.recover(f.context); assert.equal(f.chat.get(next.runId, f.context).outcome, 'complete');
      const entries = f.store.transaction(tx => f.domain.execute(tx, 'getSession', { id: session.id }, f.context)).entries; assert.equal(entries.length, 3);
    } finally { if (!killed && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } f.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('public snapshots/subscriber events never contain provider parts or private compiler manifests', async () => {
  const f = fixture(); f.model.delayed = true;
  try {
    const run = f.accept(); const stream = f.chat.subscribe(run.runId, f.context);
    const events: unknown[] = [];
    const collect = (async () => { for await (const event of stream) { events.push(event); if (event.type === 'snapshot' && event.run.state === 'terminal') return; } })();
    await started(f); f.model.controls[0]!.onEvent?.({ type: 'text', text: 'Safe provisional', provisional: true });
    f.model.finish(); await collect;
    const publicValue = JSON.stringify({ run, events, lookup: f.chat.get(run.runId, f.context) });
    for (const forbidden of ['must-not-persist', 'thoughtSignature', 'providerContent', 'compileInput', 'manifest', 'trace', f.store.assistantId]) assert.equal(publicValue.includes(forbidden), false, forbidden);
    const row = f.store.transaction(tx => tx.get('SELECT * FROM chat_runs WHERE run_id=?', [run.runId]));
    assert.ok(String(row!.trace).includes('manifest')); assert.equal(JSON.stringify(row).includes('must-not-persist'), false);
  } finally { f.close(); }
});

test('startup recovery is required; stale run epoch cannot be cancelled or silently overwritten', () => {
  const f = fixture({ schedule: () => {} });
  try {
    const cold = new ChatService(f.config);
    assert.throws(() => cold.accept({ sessionId: f.session.id, text: 'x', idempotencyKey: 'cold' }, f.context), error('recovery_required'));
    const run = f.accept();
    f.store.transaction(tx => tx.run('UPDATE chat_runs SET authority_epoch=? WHERE run_id=?', ['prior-epoch', run.runId]));
    assert.throws(() => f.chat.cancel(run.runId, f.context), error('epoch_mismatch'));
    assert.equal(f.chat.get(run.runId, f.context).state, 'accepted');
    assert.equal(f.entries().length, 1); assert.equal(f.model.calls.length, 0);
  } finally { f.close(); }
});

test('history suffix never splits a completed user/assistant turn', async () => {
  const f = fixture({ context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 1000 }, sources: [] } });
  try {
    for (let i = 0; i < 8; i++) await terminal(f, f.accept(`User-${i} ${'x'.repeat(70)}`, `k${i}`));
    const request = f.model.calls.at(-1)!;
    assert.equal(request.contents[0]!.role, 'user'); assert.equal(request.contents.at(-1)!.role, 'user');
    assert.ok(request.contents.length < 15); assert.equal(request.contents.length % 2, 1);
    for (let i = 0; i < request.contents.length - 1; i += 2) assert.deepEqual(request.contents.slice(i, i + 2).map(c => c.role), ['user', 'model']);
    assert.equal(f.entries().length, 16);
  } finally { f.close(); }
});

test('unknown recalled evidence classification is unavailable even when history is ordinary', async () => {
  const f = fixture({ context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 }, sources: [{ id: 'recall', state: 'available' }], recall: { q: 'needle', limit: 10 } } });
  try {
    const chat = new ChatService({ ...f.config, classify: subject => subject.kind === 'recall' ? null : ({ ownerId: f.store.assistantId, dataClass: 'ordinary' }) }); chat.recover(f.context);
    const run = chat.accept({ sessionId: f.session.id, text: 'needle', idempotencyKey: 'no-evidence-class' }, f.context);
    for await (const event of chat.subscribe(run.runId, f.context)) if (event.type === 'snapshot' && event.run.state === 'terminal') { assert.equal(event.run.outcome, 'unavailable'); break; }
    assert.equal(f.model.calls.length, 0); assert.equal(f.entries().length, 1);
  } finally { f.close(); }
});

test('all terminal writes unavailable: no completion event/assistant entry, explicit subscriber resync', async () => {
  const f = fixture({}, [{ owner: 'fault', version: 1, statements: ["CREATE TRIGGER reject_terminal BEFORE UPDATE ON chat_runs WHEN NEW.state='terminal' BEGIN SELECT RAISE(ABORT,'storage unavailable'); END"] }]); f.model.delayed = true;
  try {
    const run = f.accept(); await started(f); const stream = f.chat.subscribe(run.runId, f.context)[Symbol.asyncIterator]();
    await stream.next(); f.model.finish();
    const event = (await stream.next()).value; assert.equal(event.type, 'resync_required'); assert.equal(event.reason, 'storage_unavailable');
    assert.equal(f.chat.get(run.runId, f.context).state, 'dispatch_intent'); assert.equal(f.entries().length, 1);
  } finally { f.close(); }
});

test('partial retention is explicitly bounded but final durable lookup returns the entire archival answer', async () => {
  const f = fixture({ maxPartialChars: 4 }); f.model.delayed = true; f.model.text = 'Complete archival answer';
  try {
    const run = f.accept(); await started(f);
    f.model.controls[0]!.onEvent?.({ type: 'text', text: 'Provisional overflow', provisional: true });
    const partial = f.chat.get(run.runId, f.context); assert.equal(partial.partialText, 'Prov'); assert.equal(partial.partialTruncated, true); assert.equal(partial.finalText, null);
    f.model.finish(); const final = await terminal(f, run); assert.equal(final.finalText, f.model.text);
    assert.equal(f.chat.get(run.runId, f.context).finalText, f.entries()[1]!.text);
  } finally { f.close(); }
});

test('capability snapshot never advertises an unconfigured source as available', async () => {
  const f = fixture({ context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 }, sources: [{ id: 'today', state: 'available' }] } });
  try { const done = await terminal(f, f.accept()); assert.equal(done.outcome, 'unavailable'); assert.equal(f.model.calls.length, 0); }
  finally { f.close(); }
});
