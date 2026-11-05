import { ProviderError } from '../tasks/model.js';
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
import { TaskRuntime, type TaskRuntimeOptions } from '../tasks/runtime.js';
import { TaskCall } from '../tasks/call.js';
import type { Infer, Inference } from '../tasks/worker.js';
function fixture(t: TestContext, infer: Infer, provider: 'openai' | 'gemini' = 'openai', after?: (ms: number, callback: () => void) => () => void, execute?: TaskRuntimeOptions['execute']) {
  const directory = mkdtempSync(join(tmpdir(), 'task-call-synthetic-')), store = new Store(directory);
  const sent: { id: string | null; text: string }[] = [], responses: unknown[] = [];
  const call = new TaskCall({ provider, ...(after ? { after } : {}),
    createRuntime: delivery => new TaskRuntime({ store, delivery, infer, 
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal() }), execute: execute ?? (async () => { throw new Error('unexpected fixture tool'); }) }),
    append: (_generation, id, text) => { sent.push({ id, text }); return `c${sent.length}`; },
    respond: (_generation, values) => { responses.push(values); return 'sent'; },
    state: () => {},
  });
  call.socket(1); t.after(() => { call.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { call, store, sent, responses };
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
  await f.call.input('Synthetic request', 1);
  assert.equal(f.call.pendingAnswer()?.text, 'Synthetic answer.');
});
test('Gemini delegate attaches to the finalized task and carries its spoken answer', async t => {
  let inference = 0; const f = fixture(t, async () => { inference++; return { text: 'Synthetic spoken answer.', calls: [] }; }, 'gemini');
  f.call.functions([{ id: 'fn1', name: 'delegate', args: { request: 'Model words are not the owner request' } }]);
  assert.equal(inference, 0); await f.call.input('Actual finalized owner words', 1);
  assert.deepEqual(f.responses, [[{ id: 'fn1', name: 'delegate', response: { status: 'complete', text: 'Synthetic spoken answer.' } }]]);
  assert.equal(f.sent.length, 0);
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
  const seed = f.call.pendingAnswer(); assert(seed);
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
  pending.resolve({ text: '', calls: [], no_action: true }); await result;
  assert.equal(f.sent.length, bound ? 1 : 0);
  if (bound) assert.match(f.sent[0]!.text, /No lookup is needed/);
});

test('C-DELIVERY: tool evidence is delivered even if the voice already answered without a delegation', async t => {
  const first = deferred(); let inferences = 0;
  const f = fixture(t, async () => ++inferences === 1 ? first.promise : { text: 'Synthetic evidence answer.', calls: [] }, 'openai', undefined,
    async () => ({ status: 'ok', text: 'Synthetic evidence.', references: [], next_cursor: null, coverage: 'Whole synthetic source.', repair: null }));
  const running = f.call.input('Read the synthetic source.', 1); f.call.spoke();
  first.resolve({ text: '', calls: [{ id: 'read', name: 'search_knowledge', args: { query: 'Synthetic' } }] });
  const result = await running; assert.equal(result.findings.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.text, 'Synthetic evidence answer.');
});
test('C-DELIVERY: a correction during a running read revises only after transcript quiet', async t => {
  const clock = quietClock(); let release!: () => void; let reads = 0; let inferences = 0;
  const read = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, async () => ++inferences === 1
    ? { text: '', calls: [{ id: 'read', name: 'search_knowledge', args: { query: 'Synthetic' } }] }
    : { text: 'Synthetic corrected result.', calls: [] }, 'openai', clock.after,
    async () => { reads++; await read; return { status: 'ok', text: 'Synthetic read result.', references: [], next_cursor: null, coverage: 'Whole synthetic source.', repair: null }; });
  t.after(release);
  f.call.ownerWords(); f.call.finalized('Read the synthetic source.', 1); clock.advance(1_200);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(reads, 1); const first = f.call.runtime.controller.current!.identity;
  f.call.ownerWords(); f.call.finalized('Synthetic correction.', 2); clock.advance(1_199);
  assert.equal(f.call.runtime.controller.isCurrent(first), true);
  clock.advance(1); for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(f.call.runtime.controller.isCurrent(first), false); release();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(reads, 1); assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.text, 'Synthetic corrected result.');
});

for (const failedRead of [false, true]) test(`review F1: prior voice speech cannot suppress an attempted read, failed=${failedRead}`, async t => {
  const first = deferred(); let inferences = 0; let reads = 0;
  const f = fixture(t, async () => {
    if (++inferences === 1) return first.promise;
    if (failedRead) throw new Error('Synthetic final inference unavailable.');
    return { text: 'Synthetic successful read answer.', calls: [] };
  }, 'openai', undefined, async () => {
    reads++; if (failedRead) throw new Error('Synthetic read unavailable.');
    return { status: 'ok', text: 'Synthetic evidence.', references: [], next_cursor: null, coverage: 'Whole synthetic source.', repair: null };
  });
  const running = f.call.input('Read the synthetic source.', 1); f.call.spoke();
  first.resolve({ text: '', calls: [{ id: 'read', name: 'search_knowledge', args: { query: 'Synthetic' } }] });
  const result = await running; assert.equal(reads, 1);
  assert.equal(result.status, failedRead ? 'incomplete' : 'complete');
  assert.equal(result.findings.length, failedRead ? 0 : 1);
  if (failedRead) { assert.equal(result.text, ''); assert.equal(f.sent.length, 0); }
  else { assert.ok(result.text.trim()); assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.text, result.text); }
});

for (const text of ['', 'Synthetic late answer.']) test(`C-SILENCE: late delegation retains terminal ${JSON.stringify(text)}`, async t => {
  const f = fixture(t, async () => ({ text, calls: [], ...(!text ? { no_action: true } : {}) }));
  f.call.spoke(); await f.call.input('Synthetic late ask', 1);
  assert.equal(f.sent.length, 0);
  f.call.delegation('late'); assert.equal(f.sent.length, 1);
  f.call.delivery.accepted('c1'); f.call.delegation('again'); assert.equal(f.sent.length, 1);
});
for (const text of ['', ' ', '\n']) test(`C-SILENCE: blank terminal with delegation ${JSON.stringify(text)}`, async t => {
  const pending = deferred(), f = fixture(t, async () => pending.promise);
  const running = f.call.input('Synthetic blank ask', 1); f.call.delegation('open');
  pending.resolve({ text, calls: [] }); await running;
  assert.equal(f.sent.length, 1); assert.match(f.sent[0]!.text, /No lookup is needed/);
});
test('C-SILENCE: no action survives unready replacement and late delegation', async t => {
  const pending = deferred(), f = fixture(t, async () => pending.promise);
  const running = f.call.input('Synthetic rebuild ask', 1);
  f.call.socket(2, false); pending.resolve({ text: '', calls: [], no_action: true }); await running;
  f.call.delegation('late'); assert.equal(f.sent.length, 0);
  f.call.delivery.ready(); assert.equal(f.sent.length, 1);
});
test('C-SILENCE: twice rejected remainder stays owed until socket ready', async t => {
  const f = fixture(t, async () => ({ text: 'Synthetic retained answer.', calls: [] }));
  await f.call.input('Synthetic ask', 1);
  f.call.delivery.rejected('c1'); f.call.delivery.rejected('c2'); assert.equal(f.sent.length, 2);
  assert.ok(f.call.delivery.waitingAnswer());
  f.call.socket(2); assert.equal(f.sent.length, 3);
  f.call.delivery.accepted('c3'); f.call.delivery.ready(); assert.equal(f.sent.length, 3);
});
for (const rejected of [false, true]) test(`C-SILENCE: newer revision retires terminal debt rejected=${rejected}`, async t => {
  let runs = 0;
  const f = fixture(t, async () => ++runs === 1 ? { text: rejected ? 'Synthetic old.' : '', calls: [], ...(!rejected ? { no_action: true } : {}) } : { text: '', calls: [], no_action: true });
  await f.call.input('Synthetic old ask', 1);
  if (rejected) { f.call.delivery.rejected('c1'); f.call.delivery.rejected('c2'); }
  await f.call.input('Synthetic new ask', 2); const count = f.sent.length;
  f.call.delegation('new'); assert.equal(f.sent.length, count + 1);
  assert.match(f.sent.at(-1)!.text, /No lookup is needed/);
});
for (const text of ['', ' ', '\n']) test(`C-SILENCE: blank composition keeps findings and coverage ${JSON.stringify(text)}`, async t => {
  let runs = 0;
  const f = fixture(t, async () => ++runs === 1 ? { text: '', calls: [{ id: 'read', name: 'search_knowledge', args: { query: 'Synthetic' } }] } : { text, calls: [] }, 'openai', undefined,
    async () => ({ status: 'ok', text: 'Synthetic findings.', references: [], next_cursor: null, coverage: 'Synthetic coverage.', repair: null }));
  await f.call.input('Synthetic findings ask', 1);
  assert.match(f.sent[0]!.text, /Synthetic findings/);
  assert.match(f.sent[0]!.text, /coverage/i);
});
test('C-SILENCE: recovery rejection waits for another event, not activity', async t => {
  const f = fixture(t, async () => ({ text: 'Synthetic retained.', calls: [] }));
  await f.call.input('Synthetic retry ask', 1);
  f.call.delivery.rejected('c1'); f.call.delivery.rejected('c2');
  f.call.socket(2); f.call.delivery.rejected('c3'); assert.equal(f.sent.length, 3);
  f.call.delivery.activity({ outputQuiet: true, ownerSpeaking: false }); assert.equal(f.sent.length, 3);
  f.call.delegation('retry'); assert.equal(f.sent.length, 4);
});

test('SILENCE-R1: failed composition speaks plain findings with one incomplete clause', async t => {
  let runs = 0;
  const f = fixture(t, async () => {
    if (++runs === 1) return { text: '', calls: ['first', 'second'].map(id => ({ id, name: 'search_knowledge', args: { query: `Synthetic ${id}` } })) };
    throw new Error('Synthetic composition failure');
  }, 'openai', undefined, async (_name, args) => ({ status: 'ok', text: `${(args as { query: string }).query} finding.`, references: [], next_cursor: null, coverage: 'Synthetic coverage.', repair: null }));
  const answer = await f.call.input('Synthetic two sources', 1);
  assert.equal(answer.status, 'incomplete');
  assert.equal(answer.text, "Synthetic first finding. Synthetic coverage. Synthetic second finding. Synthetic coverage.");
  assert.doesNotMatch(answer.text, /\d+[.)]|\n/);
});

test('failed inference passes an empty fact immediately without requiring delegation', async t => {
  const f = fixture(t, async () => { throw new ProviderError('provider_rejected', 'uniqueItems is not permitted', 400); });
  let delivered: { answer: import('../tasks/worker.js').WorkerResult; requiresDelegation: boolean | undefined } | undefined;
  f.call.delivery.deliver = (_identity, answer, requiresDelegation) => { delivered = { answer, requiresDelegation }; };
  f.call.spoke();
  const result = await f.call.input('synthetic helper request', 1);
  assert.equal(result.status, 'incomplete'); assert.equal(result.text, '');
  assert.equal(delivered?.requiresDelegation, false);
  assert.equal(delivered?.answer.failure?.reason_code, 'provider_rejected');
  assert.equal(delivered?.answer.text, '');
});
