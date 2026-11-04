import { stripNonLexicalTags } from '../live/index.js';
import './host-compose-wire.test.js';
import './continuity-replay.test.js';
import './task-context.test.js';
import './host-log.test.js';
import './connector-publication.test.js';
import './live-declarations.test.js';
import './task-unbounded-projection.test.js';
import './task-draft-chat.test.js';
import './task-live-correction.test.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { Authority } from '../tasks/authority.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { TaskCall } from '../tasks/call.js';
import type { Infer, Inference } from '../tasks/worker.js';
function fixture(t: TestContext, infer: Infer, provider: 'openai' | 'gemini' = 'openai', after?: (ms: number, callback: () => void) => () => void) {
  const directory = mkdtempSync(join(tmpdir(), 'task-call-synthetic-')), store = new Store(directory);
  const sent: { id: string | null; text: string }[] = [], responses: unknown[] = []; let reconnects = 0;
  const call = new TaskCall({ provider, ...(after ? { after } : {}),
    createRuntime: delivery => new TaskRuntime({ store, delivery, infer, contentAllowed: () => true,
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal(() => true) }), execute: async () => { throw new Error('unexpected fixture tool'); } }),
    append: (_generation, id, text) => { sent.push({ id, text }); return `c${sent.length}`; },
    respond: (_generation, values) => { responses.push(values); return 'sent'; },
    state: () => {},
  });
  call.socket(1); t.after(() => { call.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { call, store, sent, responses, reconnects: () => reconnects };
}
function deferred() { let resolve!: (value: Inference) => void; const promise = new Promise<Inference>(done => { resolve = done; }); return { promise, resolve }; }
test('delegation before final input and duplicates do not start a worker', async t => {
  let inference = 0; const f = fixture(t, async () => { inference++; return { text: 'Synthetic answer.', calls: [] }; });
  f.call.delegation('d1'); f.call.delegation('d1'); assert.equal(inference, 0);
  await f.call.input('Synthetic request', 1); assert.equal(inference, 1);
  assert.deepEqual(f.sent, [{ id: 'd1', text: 'Synthetic answer.' }]);
});
test('a socket rebuild does not abort a running task', async t => {
  const pending = deferred(); let signal: AbortSignal | undefined;
  const f = fixture(t, async (_request, abort) => { signal = abort; return pending.promise; });
  const running = f.call.input('Synthetic request', 1);
  f.call.socket(2); f.call.delegation('new-socket');
  assert.equal(signal?.aborted, false); pending.resolve({ text: 'Completed after rebuild.', calls: [] }); await running;
  assert.deepEqual(f.sent, [{ id: 'new-socket', text: 'Completed after rebuild.' }]);
});
test('a correction suppresses the stale worker answer', async t => {
  const first = deferred(); let inference = 0;
  const f = fixture(t, async () => ++inference === 1 ? first.promise : { text: 'Corrected answer.', calls: [] });
  f.call.delegation('d1'); const stale = f.call.input('First request', 1);
  await f.call.input('Correction', 2); first.resolve({ text: 'Stale answer.', calls: [] }); await stale;
  assert.deepEqual(f.sent, [{ id: 'd1', text: 'Corrected answer.' }]);
});
test('no delegation still executes finalized input and appends on the open line', async t => {
  const f = fixture(t, async () => ({ text: 'Synthetic answer.', calls: [] }));
  await f.call.input('Synthetic request', 1); assert.equal(f.reconnects(), 0);
  assert.equal(f.call.reconnectAnswer()?.text, 'Synthetic answer.');
});
test('Gemini delegate attaches to the finalized task and carries its spoken answer', async t => {
  let inference = 0; const f = fixture(t, async () => { inference++; return { text: 'Synthetic spoken answer.', calls: [] }; }, 'gemini');
  f.call.functions([{ id: 'fn1', name: 'delegate', args: { request: 'Model words are not the owner request' } }]);
  assert.equal(inference, 0); await f.call.input('Actual finalized owner words', 1);
  assert.deepEqual(f.responses, [[{ id: 'fn1', name: 'delegate', response: { status: 'complete', text: 'Synthetic spoken answer.' } }]]);
  assert.equal(f.sent.length, 0); assert.equal(f.reconnects(), 0);
});


test('R24 EF5: a final inference answer is redacted in Store, delivery and recovery seed', async t => {
  const secret = 'sk-syntheticFinalAnswerSecretOnly1234567890';
  const f = fixture(t, async () => ({ text: `Ordinary verified answer ${secret}`, calls: [] }));
  f.call.delegation('synthetic-final-secret');
  await f.call.input('Give an ordinary synthetic answer', 1);
  const rows = f.store.transaction(tx => tx.all('SELECT final_answer FROM tasks'));
  assert.equal(rows.length, 1); assert.match(String(rows[0]!.final_answer), /Ordinary verified answer/);
  assert(!JSON.stringify(rows).includes(secret), 'retained final answer contains no secret');
  assert.equal(f.sent.length, 1); assert.match(f.sent[0]!.text, /Ordinary verified answer/);
  assert(!JSON.stringify(f.sent).includes(secret)); assert.match(f.sent[0]!.text, /\[redacted\]/);
  const seed = f.call.reconnectAnswer(); assert(seed);
  assert.match(seed.text, /Ordinary verified answer/); assert(!JSON.stringify(seed).includes(secret));
  assert.match(seed.text, /\[redacted\]/);
});


test('R25 EF8: performance cues are stripped but cue-prefixed Markdown citations stay byte-identical', () => {
  for (const citation of ['[Music study](https://example.test/paper)', '[Noise report](https://example.test/noise)', '[Silence](https://example.test/silence)', '[Music Überblick 🌱](https://example.test/unicode)']) {
    assert.equal(stripNonLexicalTags(`[laughter] ${citation} [breath]`), ` ${citation} `);
  }
  assert.equal(stripNonLexicalTags('ordinary [chuckle] words [inhale'), 'ordinary  words ');
});


test('R28 cue cleanup preserves nested, reference and escaped literal labels while removing real cues', () => {
  const literals = [
    '[Music [study]](https://example.test/paper)',
    '[Music study][paper]',
    '[Music study][]',
    '[[Noise report]](https://example.test/noise)',
    String.raw`\[Music study]`,
    String.raw`[Music \[study\]](https://example.test/paper)`,
    String.raw`[Music study\] notes](https://example.test/paper)`,
    String.raw`\[Noise report][paper]`,
  ];
  for (const literal of literals) {
    assert.equal(stripNonLexicalTags(`[laughter] ${literal} [breath]`), ` ${literal} `);
  }
  assert.equal(stripNonLexicalTags(String.raw`\\[inhale]`), String.raw`\\`);
  assert.equal(stripNonLexicalTags('[music playing] words [inhale'), ' words ');
});

function quietClock() {
  let now = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    after: (ms: number, callback: () => void) => { const timer = { at: now + ms, callback }; timers.add(timer); return () => { timers.delete(timer); }; },
    advance: (ms: number) => { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.callback(); } },
  };
}
for (const gap of [600, 1_000, 1_600, 8_000]) test(`C-DELIVERY: fragment gap ${gap} ms merges or revises at host quiet`, async t => {
  const clock = quietClock(); const inputs: string[] = [];
  const f = fixture(t, async request => { inputs.push(JSON.stringify(request)); return { text: 'Synthetic answer.', calls: [] }; }, 'openai', clock.after);
  f.call.ownerWords(); f.call.finalized('Synthetic first fragment', 1);
  clock.advance(gap); await Promise.resolve();
  assert.equal(inputs.length, gap < 1_200 ? 0 : 1);
  f.call.ownerWords(); f.call.finalized('Synthetic second fragment', 2);
  clock.advance(1_199); assert.equal(inputs.length, gap < 1_200 ? 0 : 1);
  clock.advance(1); await Promise.resolve();
  assert.equal(inputs.length, gap < 1_200 ? 1 : 2);
  assert.match(inputs.at(-1)!, /Synthetic second fragment/);
  if (gap < 1_200) assert.match(inputs[0]!, /Synthetic first fragment/);
});
test('C-DELIVERY: distinct completed asks each start work after quiet', async t => {
  const clock = quietClock(); let runs = 0;
  const f = fixture(t, async () => { runs++; return { text: 'Synthetic answer.', calls: [] }; }, 'openai', clock.after);
  for (let turn = 1; turn <= 2; turn++) {
    f.call.ownerWords(); f.call.finalized(`Synthetic separate ask ${turn}`, turn); clock.advance(1_200);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(runs, turn);
  }
});
for (const spoken of [false, true]) test(`C-DELIVERY: no-tool result after prior voice speech=${spoken}`, async t => {
  const pending = deferred(); const f = fixture(t, async () => pending.promise);
  const result = f.call.input('Synthetic general question', 1);
  if (spoken) f.call.spoke();
  pending.resolve({ text: 'Synthetic own answer.', calls: [] }); await result;
  assert.equal(f.sent.length, spoken ? 0 : 1);
});
for (const bound of [false, true]) test(`C-DELIVERY: no-action terminal fact with open delegation=${bound}`, async t => {
  const pending = deferred(); const f = fixture(t, async () => pending.promise);
  const result = f.call.input('Synthetic general question', 1);
  if (bound) f.call.delegation('open');
  pending.resolve({ text: '', calls: [] }); await result;
  assert.equal(f.sent.length, bound ? 1 : 0);
  if (bound) assert.match(f.sent[0]!.text, /No lookup is needed/);
});
