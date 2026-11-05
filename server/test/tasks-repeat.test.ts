import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { Authority } from '../tasks/authority.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { TaskCall } from '../tasks/call.js';
import { failed } from '../tasks/results.js';
import type { Infer, Inference } from '../tasks/worker.js';
import type { ToolResult } from '../tasks/results.js';

/** C-REPEAT: what she already said, and what is really running, reach the helper as plain data. */
interface Captured { input: Record<string, unknown>; instructions: string }

function fixture(t: TestContext, infer: Infer, execute?: () => Promise<ToolResult>) {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-repeat-synthetic-')), store = new Store(directory);
  const sent: { id: string | null; text: string }[] = [];
  const call = new TaskCall({ provider: 'openai',
    createRuntime: delivery => new TaskRuntime({ store, delivery, infer, timeZone: 'UTC',
      authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal() }),
      execute: execute ?? (async () => { throw new Error('unexpected fixture tool'); }) }),
    append: (_generation, id, text) => { sent.push({ id, text }); return `c${sent.length}`; },
    respond: () => 'sent', state: () => {} });
  call.socket(1);
  t.after(() => { call.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { call, store, sent };
}

function capture(answer: (request: { input: string }) => Inference | Promise<Inference>, captured: Captured[]): Infer {
  return async request => {
    captured.push({ input: JSON.parse(request.input) as Record<string, unknown>, instructions: request.instructions });
    return answer(request);
  };
}

/** The overlap fact arrives with his words; C-REPEAT adds the flag to the port. */
function hisWordsOverHerSpeech(call: TaskCall, overlapped: boolean): void {
  (call.ownerWords as unknown as (overlapped?: boolean) => void)(overlapped);
}

function deferred() { let resolve!: (value: Inference) => void; const promise = new Promise<Inference>(done => { resolve = done; }); return { promise, resolve }; }

function said(captured: Captured[], index: number): { text: string; accepted: number; total: number; truncated: boolean } {
  return captured[index]!.input['already_said'] as { text: string; accepted: number; total: number; truncated: boolean };
}

function verified(captured: Captured[], index: number): Record<string, unknown> {
  return JSON.parse(captured[index]!.input['verified_status'] as string) as Record<string, unknown>;
}

test('the helper is told what she already said, and how far its chunks got', async t => {
  const captured: Captured[] = [];
  // Eight short sentences exceed the 450 character chunk, so the spoken answer needs exactly two of them.
  const answer = `${'The synthetic sampling plan is ready and two replicates per plot is enough. '.repeat(8)}`.trim();
  const f = fixture(t, capture(() => ({ text: answer, calls: [] }), captured));
  await f.call.input('First synthetic ask', 1);
  assert.equal(f.sent.length, 1, 'only the first chunk is offered before it is accepted');
  f.call.delivery.accepted('c1');
  assert.equal(f.sent.length, 2, 'the second chunk is offered once the first is accepted');
  await f.call.input('Second synthetic ask', 1);
  assert.deepEqual(said(captured, 1), { text: answer, accepted: 1, total: 2, truncated: false },
    'a cut answer is distinguishable from a finished one by accepted chunks of total');
});

test('a finished delivery is told as fully accepted', async t => {
  const captured: Captured[] = [];
  const f = fixture(t, capture(() => ({ text: 'The only synthetic sentence.', calls: [] }), captured));
  await f.call.input('First synthetic ask', 1);
  f.call.delivery.accepted('c1');
  await f.call.input('Second synthetic ask', 1);
  assert.deepEqual(said(captured, 1), { text: 'The only synthetic sentence.', accepted: 1, total: 1, truncated: false });
});

test('said stays across a revision and across a provider socket rebuild', async t => {
  const captured: Captured[] = [];
  const pending = deferred();
  let turn = 0;
  const f = fixture(t, capture(() => {
    turn++;
    return turn === 1 ? { text: 'The synthetic answer she already gave.', calls: [] } : pending.promise;
  }, captured));
  await f.call.input('First synthetic ask', 1);
  f.call.delivery.accepted('c1');
  f.call.socket(2);
  const running = f.call.input('Second synthetic ask', 1);
  hisWordsOverHerSpeech(f.call, false); f.call.finalized('Third synthetic words', 2, 1_200);
  pending.resolve({ text: 'The synthetic answer to the later ask.', calls: [] });
  await running;
  assert.equal(said(captured, 1).text, 'The synthetic answer she already gave.', 'a socket rebuild keeps what she said');
  assert.equal(said(captured, 2).text, 'The synthetic answer she already gave.', 'a revision keeps what she said');
});

test('the host fact about overlap reaches the helper as data only', async t => {
  const captured: Captured[] = [];
  const f = fixture(t, capture(() => ({ text: 'The synthetic answer.', calls: [] }), captured));
  hisWordsOverHerSpeech(f.call, true); f.call.finalized('Synthetic words over her speech', 1, 1_200);
  await Promise.resolve();
  hisWordsOverHerSpeech(f.call, false); f.call.finalized('Synthetic words after her speech', 2, 1_200);
  await Promise.resolve();
  assert.equal(captured[0]!.input['owner_words_overlapped_her_speech'], true);
  assert.equal(captured[1]!.input['owner_words_overlapped_her_speech'], false, 'the fact does not stick to the next ask');
});

test('verified status reports facts, never that work is running', async t => {
  const captured: Captured[] = [];
  const f = fixture(t, capture(() => ({ text: 'The synthetic answer.', calls: [] }), captured));
  await f.call.input('First synthetic ask', 1);
  await f.call.input('Second synthetic ask', 1);
  const status = verified(captured, 1);
  assert.equal('status' in status, false, 'no invented running status');
  assert.equal(status['other_work_running'], false, 'a sole run reports no other work');
  assert.deepEqual(status['last_task'], { status: 'complete', failed_tools: [] });
  assert.equal(status['rebuilt'], false);
  assert.equal(status['rebuild_cause'], null);
  assert.ok('staged_deletion' in status, 'staged deletion and rebuild fields stay');
});

test('verified status names the last task failures with their closed codes', async t => {
  const captured: Captured[] = [];
  let calls = 0;
  const f = fixture(t, capture(request => {
    if (request.input.includes('First synthetic ask') && calls++ === 0) return { text: '', calls: [{ id: 'read', name: 'chat_attention', args: { days: 7, limit: 5 } }] };
    return { text: 'The synthetic answer after a failed read.', calls: [] };
  }, captured), async () => failed('Synthetic connector unavailable.', 'unavailable'));
  await f.call.input('First synthetic ask', 1);
  await f.call.input('Why did that synthetic read fail', 1);
  assert.deepEqual(verified(captured, 2)['last_task'], { status: 'complete', failed_tools: [{ tool: 'chat_attention', code: 'unavailable' }] });
});

test('the helper carries people and owner-authorized lore', async t => {
  const { installPeople, parsePeople } = await import('../people/index.js');
  const { workerInstructions, WORKER_INSTRUCTIONS } = await import('../tasks/instructions.js');
  t.after(() => installPeople(null));
  installPeople(parsePeople({ version: 1, people: [{ id: 'person-a', name: 'Ada Moss', aliases: ['Ada'], role: 'Engineer', circle: 'plantix', tier: 1, email: ['person-a@example.invalid'], mattermost: 'ada.moss' }] }));
  const instructions = workerInstructions({ schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: '1',
    displayName: 'Synthetic Owner', style: { text: 'SYNTHETIC PRESENTATION STYLE', dataClass: 'ordinary' }, lore: { text: 'SYNTHETIC OWNER LORE', dataClass: 'ordinary' } });
  assert.ok(instructions.startsWith(WORKER_INSTRUCTIONS));
  assert.match(instructions, /# People/);
  assert.match(instructions, /Ada Moss/);
  assert.match(instructions, /SYNTHETIC OWNER LORE/, 'the owner authorizes lore at the helper boundary');
});

test('the follow-up rules are judgments the helper applies, never lines to say', async () => {
  const { WORKER_INSTRUCTIONS } = await import('../tasks/instructions.js');
  for (const rule of [
    'A follow-up that asks something new is read together with the task before it',
    'Words that add no new ask, agreement and an unfinished sentence among them, return no_action',
    'What is listed as already said is his: never write it again',
    'A cut answer may continue from where it stopped',
    'widen the sources, open what was only a pointer, and say what changed',
    'when the status says nothing is running, say that nothing is running and give the real outcome',
  ]) assert.ok(WORKER_INSTRUCTIONS.includes(rule), rule);
  assert.doesNotMatch(WORKER_INSTRUCTIONS, /A short follow-up refers to the task before it/);
  assert.doesNotMatch(WORKER_INSTRUCTIONS, /"/, 'no quoted line for her to say');
});
