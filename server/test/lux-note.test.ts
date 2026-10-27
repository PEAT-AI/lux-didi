import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { McpRegistry } from '../adapters/mcp/registry.js';
import type { McpPort } from '../adapters/mcp/port.js';
import type { JsonObject, ToolCallIntent, ToolDefinition, ToolOutcome } from '../adapters/model/types.js';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { safeEvent } from '../host/log.js';
import { liveMigrations, stageComposedNote } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { runToolCalls } from '../tools/declarations.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import type { RunAcceptance, StageNotePort } from '../tools/types.js';
import {
  beginStage, composedAsk, confirmAsk, CONFIRM_MAX_TOKENS, CONFIRM_WINDOW_MS, currentOwnerTurn, freezeNote, NOTE_MAX_CHARS,
  noteOwnerFragment, noteOwnerUtterance, noteReadback, noteSegmentSignal, noteSettle, STAGE_NOTE_IDENTITY, validateStageNote,
  type PlaybackSignal, type ReadbackBinding,
} from '../tools/lux-note.js';

const HELD = new Set(['journal:11', 'journal:12']);
const EVIDENCE = ['journal:11', 'journal:12'];

function staged(over: { ownerText?: string; title?: string; body?: string; enabled?: boolean; now?: number } = {}) {
  const outcome = beginStage({
    stageId: 'stage-1', sessionId: 'session-1', now: over.now ?? 1_000,
    ownerText: over.ownerText ?? 'save that to lux', title: over.title ?? 'Trip plan', body: over.body ?? 'Fly to Lisbon on the third.',
    evidence: EVIDENCE, heldEvidence: HELD, enabled: over.enabled ?? true,
  });
  assert.equal(outcome.state, 'staged', `staged: ${JSON.stringify(outcome)}`);
  return outcome.state === 'staged' ? outcome.note : (undefined as never);
}

/** Stage, let the read-back drain, and come back with an armed note. */
function armed(now = 2_000) {
  const note = noteReadback(staged(), now, 'drained');
  assert.equal(note.state, 'armed');
  return note;
}

test('an imperative with an explicit lux destination is the only form that authorizes a composed note', () => {
  for (const text of ['save that to lux', 'remember in lux knowledge that Lisbon is booked', 'put this in my vault', 'add that to the knowledge base']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
  // C-LUX-SAVE: the owner asks for a note about the conversation itself, which names its source instead of a store.
  for (const text of ['save a note about what we just discussed', 'remember a note from our conversation', 'save a note of this call']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
  for (const text of ['do not save a note about what we just discussed', 'he said save a note about our conversation']) {
    assert.notDeepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
});

test('negated, reported, quoted, conditional and ambiguous save asks are refused with a clarification', () => {
  const refusals: [string, string][] = [
    ['do not save that to lux', 'negated'],
    ["don't remember it in lux", 'negated'],
    ['never put that in my vault', 'negated'],
    ['he said save that to lux', 'reported'],
    ['the email says remember this in lux knowledge', 'reported'],
    ['save "that to lux"', 'quoted'],
    ['if you want, save that to lux', 'conditional'],
    ['maybe save that to lux', 'ambiguous'],
    ['save that to lux or to memory', 'ambiguous'],
    ['how do I save something to lux', 'reported'],
  ];
  for (const [text, reason] of refusals) {
    assert.deepEqual(composedAsk(text), { decision: 'clarify', reason }, text);
  }
  assert.deepEqual(composedAsk('what is on my calendar'), { decision: 'none' });
});

test('an append or edit ask is answered as unsupported, never turned into a create', () => {
  for (const text of ['add that to the Simone note in lux', 'update the Lisbon note in lux', 'delete the Lisbon note from my vault', 'link that to the Lisbon note in lux']) {
    assert.deepEqual(composedAsk(text), { decision: 'append' }, text);
  }
});

test('the confirm word is an exact affirmative allowlist under normalisation, at most six tokens, with disqualifiers', () => {
  for (const text of ['yes', 'Yes.', 'yeah do it', 'correct', 'that is right', 'ok save it', 'yes, save it']) {
    assert.equal(confirmAsk(text), 'affirm', text);
  }
  for (const text of ['no', 'not yet', 'yes but change the date', 'yes wait make it fifty', 'cancel', 'no do not', 'yes cancel that', 'yes and please also add a hotel line', 'hold on']) {
    assert.equal(confirmAsk(text), 'cancel', text);
  }
  assert.equal(CONFIRM_MAX_TOKENS, 6);
});

test('the frozen payload never truncates, and an oversized title plus body is refused whole', () => {
  const over = freezeNote({ title: 'Trip', body: 'x'.repeat(NOTE_MAX_CHARS + 1) });
  assert.deepEqual(over, { state: 'refused', code: 'payload_too_long' });
  const empty = freezeNote({ title: 'Trip', body: '' });
  assert.deepEqual(empty, { state: 'refused', code: 'payload_empty' });
  const frozen = freezeNote({ title: 'Trip', body: 'Fly on the third.' });
  assert.equal(frozen.state, 'frozen');
  if (frozen.state !== 'frozen') return;
  assert.deepEqual(JSON.parse(frozen.payload), { content: 'Fly on the third.', insight_title: 'Trip', insight_type: 'UNCATEGORIZED', project: 'didi-voice' });
});

test('a stage needs the switch, the owner grammar and evidence the host holds', () => {
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'save that to lux', title: 'T', body: 'B', evidence: EVIDENCE, heldEvidence: HELD, enabled: false }),
    { state: 'refused', code: 'not_enabled' });
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'do not save that to lux', title: 'T', body: 'B', evidence: EVIDENCE, heldEvidence: HELD, enabled: true }),
    { state: 'refused', code: 'authorization_refused' });
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'what is on my calendar', title: 'T', body: 'B', evidence: EVIDENCE, heldEvidence: HELD, enabled: true }),
    { state: 'refused', code: 'authorization_missing' });
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'save that to lux', title: 'T', body: 'B', evidence: ['journal:99'], heldEvidence: HELD, enabled: true }),
    { state: 'refused', code: 'evidence_unknown' });
  assert.deepEqual(beginStage({ stageId: 's', sessionId: 'x', now: 1, ownerText: 'save that to lux', title: 'T', body: 'B', evidence: [], heldEvidence: HELD, enabled: true }),
    { state: 'refused', code: 'evidence_missing' });
});

test('unknown tool arguments are rejected, never coerced', () => {
  assert.equal(validateStageNote({ title: 'T', body: 'B', evidenceRefs: ['journal:1'] }), true);
  assert.equal(validateStageNote({ title: 'T', body: 'B', evidenceRefs: ['journal:1'], commit: true }), false);
  assert.equal(validateStageNote({ title: 'T', body: 'B' }), false);
  assert.equal(validateStageNote({ title: 'T', body: 7, evidenceRefs: [] }), false);
  assert.equal(validateStageNote(null), false);
});

test('the lifecycle is stage, drained, affirmative, settle, commit, and nothing commits before the read-back drained', () => {
  const note = staged();
  assert.equal(noteOwnerUtterance(note, { text: 'yes', now: 1_500 }).state, 'staged');
  const armedNote = armed();
  const settling = noteOwnerUtterance(armedNote, { text: 'yes', now: 3_000 });
  assert.equal(settling.state, 'settling');
  const committed = noteSettle(settling, 4_500);
  assert.equal(committed.state, 'committed');
  assert.equal(noteSettle(committed, 4_000).state, 'committed');
});

test('a VAD split affirmative that keeps talking never commits', () => {
  const settling = noteOwnerUtterance(armed(), { text: 'yes', now: 3_000 });
  assert.equal(settling.state, 'settling');
  const cancelled = noteOwnerFragment(settling, 3_400);
  assert.deepEqual({ state: cancelled.state, code: cancelled.code }, { state: 'cancelled', code: 'late_fragment' });
  assert.equal(noteSettle(cancelled, 5_000).state, 'cancelled');
});

test('an interrupted read-back invalidates the stage, and nothing else can revive it', () => {
  const note = noteReadback(staged(), 2_000, 'interrupted');
  assert.deepEqual({ state: note.state, code: note.code }, { state: 'invalidated', code: 'readback_interrupted' });
  assert.equal(noteOwnerUtterance(note, { text: 'yes', now: 3_000 }).state, 'invalidated');
  assert.equal(noteReadback(note, 4_000, 'drained').state, 'invalidated');
});

test('a confirmation after the thirty second window cancels, and a mismatch cancels with its reason', () => {
  const late = noteOwnerUtterance(armed(), { text: 'yes', now: 2_000 + CONFIRM_WINDOW_MS + 1 });
  assert.deepEqual({ state: late.state, code: late.code }, { state: 'cancelled', code: 'confirm_expired' });
  const mismatch = noteOwnerUtterance(armed(), { text: 'no', now: 3_000 });
  assert.deepEqual({ state: mismatch.state, code: mismatch.code }, { state: 'cancelled', code: 'not_affirmative' });
  assert.equal(noteOwnerUtterance(armed(), { text: 'what time is it', now: 3_000 }).state, 'cancelled');
});

test('a stage that never hears a read-back will not take a confirmation forever', () => {
  const expired = noteOwnerUtterance(staged(), { text: 'yes', now: 1_000 + CONFIRM_WINDOW_MS + 1 });
  assert.deepEqual({ state: expired.state, code: expired.code }, { state: 'cancelled', code: 'not_armed' });
});

// B1 (W6-R2): the dispatcher's authorization read. A stage that arrives before this turn's
// transcript is finalized never grants, and never borrows an older owner turn.
const turnRow = (journalId: number, text: string, finalizedAt: number, finalOrigin = 'provider') => ({ journalId, text, finalizedAt, finalOrigin });

test('a stage before this turn\'s transcript is finalized refuses and borrows no older turn', () => {
  assert.deepEqual(currentOwnerTurn([], 1_000, false), { state: 'refused', code: 'transcript_pending' });
  // The previous turn is final, but this turn is still open: its words are not authorization.
  const borrowed = currentOwnerTurn([turnRow(11, 'save that to lux', 900)], 1_000, false);
  assert.deepEqual(borrowed, { state: 'refused', code: 'transcript_pending' });
  // Even a final-flagged handle that finalized before this turn started is the older turn.
  const stale = currentOwnerTurn([turnRow(11, 'save that to lux', 900)], 1_000, true);
  assert.deepEqual(stale, { state: 'refused', code: 'transcript_pending' });
});

test('a turn flag that outlived its turn never authorizes from an old transcript', () => {
  // A rebuild can leave inputFinal true; the transcript behind it is minutes old, so it is not this turn.
  assert.deepEqual(currentOwnerTurn([turnRow(11, 'save that to lux', 900)], undefined, true, 900 + CONFIRM_WINDOW_MS + 1),
    { state: 'refused', code: 'transcript_pending' });
  assert.equal(currentOwnerTurn([turnRow(12, 'save that to lux', 1_200)], undefined, true, 1_300).state, 'owner_turn');
});

test('a typed turn never authorizes, and the current finalized mic turn does', () => {
  assert.deepEqual(currentOwnerTurn([turnRow(12, 'save that to lux', 1_200, 'typed')], 1_000, true), { state: 'refused', code: 'transcript_typed' });
  const read = currentOwnerTurn([turnRow(12, 'save that to lux', 1_200)], 1_000, true);
  assert.equal(read.state, 'owner_turn');
  if (read.state !== 'owner_turn') return;
  assert.equal(read.text, 'save that to lux');
  assert.deepEqual([...read.evidence].sort(), ['journal:12']);
});

// B2 (W6-R2): arming follows the read-back segment, never just any drained receipt.
const signal = (receipt: PlaybackSignal['receipt'], key: string, wallMs: number) => ({ receipt, key, wallMs });
const bound = (stageId: string, key: string): ReadbackBinding => ({ stageId, key });

test('a segment that began before the stage never arms it, and the read-back segment does', () => {
  const note = staged();
  const before = noteSegmentSignal(note, undefined, signal('drained', 'instance:1', 900));
  assert.equal(before.note.state, 'staged', 'a drained segment from before the stage is not the read-back');
  const opened = noteSegmentSignal(note, undefined, signal('started', 'instance:2', 1_400));
  assert.deepEqual(opened.binding, bound(note.stageId, 'instance:2'));
  assert.equal(opened.note.state, 'staged');
  const stray = noteSegmentSignal(opened.note, opened.binding, signal('drained', 'instance:3', 1_600));
  assert.equal(stray.note.state, 'staged', 'another segment draining does not arm');
  const armedNote = noteSegmentSignal(opened.note, opened.binding, signal('drained', 'instance:2', 1_900));
  assert.equal(armedNote.note.state, 'armed');
});

test('the read-back segment interrupted invalidates, and a later drained cannot revive it', () => {
  const opened = noteSegmentSignal(staged(), undefined, signal('started', 'instance:2', 1_400));
  const cut = noteSegmentSignal(opened.note, opened.binding, signal('interrupted', 'instance:2', 1_700));
  assert.deepEqual({ state: cut.note.state, code: cut.note.code }, { state: 'invalidated', code: 'readback_interrupted' });
  const later = noteSegmentSignal(cut.note, cut.binding, signal('drained', 'instance:2', 2_000));
  assert.equal(later.note.state, 'invalidated');
});

// C1 (W6-R2 review): a second note in the same call is the contract's own case (a correction
// restages). The read-back binding belongs to one stage, so a stale key never blocks the next note.
test('a restaged note in the same call arms on its own read-back segment, not the previous stage\'s', () => {
  const first = staged();
  const firstOpened = noteSegmentSignal(first, undefined, signal('started', 'instance:2', 1_400));
  assert.deepEqual(firstOpened.binding, bound(first.stageId, 'instance:2'));
  const firstArmed = noteSegmentSignal(firstOpened.note, firstOpened.binding, signal('drained', 'instance:2', 1_900));
  assert.equal(firstArmed.note.state, 'armed');

  // The owner corrects the note, so the host restages it with a new stage id in the same session.
  const second = beginStage({ stageId: 'stage-2', sessionId: 'session-1', now: 2_500,
    ownerText: 'save that to lux', title: 'Trip plan', body: 'Fly to Lisbon on the fourth.',
    evidence: EVIDENCE, heldEvidence: HELD, enabled: true });
  assert.equal(second.state, 'staged');
  if (second.state !== 'staged') return;
  const stale = noteSegmentSignal(second.note, firstArmed.binding, signal('drained', 'instance:2', 2_600));
  assert.equal(stale.note.state, 'staged', 'the previous stage\'s key never arms the new stage');

  const secondOpened = noteSegmentSignal(second.note, stale.binding, signal('started', 'instance:4', 2_700));
  assert.deepEqual(secondOpened.binding, bound('stage-2', 'instance:4'), 'the new stage adopts its own segment');
  const secondArmed = noteSegmentSignal(secondOpened.note, secondOpened.binding, signal('drained', 'instance:4', 3_100));
  assert.equal(secondArmed.note.state, 'armed');
});

// --- The stage tool itself, over a real store and the real state schema (C-LUX-SAVE-LANDS W5) ---
//
// `liveDefinitions(... composedNotes: true)` is the shipped wiring: the composed tool exists only while
// the switch is on, its execute books the intent, and the host's own composed stage freezes the payload.
// Neither could ever complete before this change: the intent check compared the booked call against a
// four-field object, so every dispatch threw and rolled back with no note row and no log line.

const VAULT_ACCOUNT = 'gateway:live-voice';
const VAULT_RESOURCE = 'owner-vault';

/** A realistic composed note body: synthetic prose, the length of the answer the owner asked to save. */
const COMPOSED_BODY = ('Rize is a materials research company: its platform automates the formulation and testing of '
  + 'new polymer blends, so a lab asks for a property target and the system proposes candidate mixes. ').repeat(9).slice(0, 1100);

interface StageHarness {
  store: Store;
  owner: ReturnType<typeof createToolsOwner>;
  run: string;
  now: number;
  stage(args: Record<string, unknown>): Promise<ToolOutcome | undefined>;
  stageWith(port: StageNotePort, args: Record<string, unknown>): Promise<ToolOutcome | undefined>;
  definitions(port: StageNotePort): readonly ToolDefinition[];
}

function stageHarness(t: TestContext): StageHarness {
  const now = 1_700_000_000_000;
  const run = 'live-stage-run';
  const dir = mkdtempSync(join(tmpdir(), 'lux-note-stage-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events,
        journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'active',1,1,?,0,0,'attached',NULL,NULL,?,?)`,
      [run, store.assistantId, store.authorityEpoch, 'key-stage', 'fp-stage', 'client', 'audit', 'profile', 'prompt', 2, now, now]);
    for (const text of ['Naya, what can you tell me about Rize', 'store it in Lux Knowledge']) {
      tx.run('INSERT INTO live_journal (live_session_id, kind, text, finished, final_origin, finalized_at, payload_bytes, arrived_at) VALUES (?,?,?,?,?,?,?,?)',
        [run, 'inputTranscription', text, 1, 'app_model_start', now, text.length, now]);
    }
  });
  const acceptance: RunAcceptance = { ownerId: store.assistantId, actorId: 'tester', runId: run,
    authorityEpoch: store.authorityEpoch, revision: 1,
    route: { identity: 'route-stage', provider: 'gemini', modelId: 'models/lux-note-stage', allowedClasses: ['ordinary'] },
    allowedClasses: ['ordinary'], connectionIds: [] };
  let acceptedRunHash = '';
  const owner = createToolsOwner({ store, ownerId: store.assistantId, registry: new McpRegistry(),
    port: { readSlice: () => ({ state: 'unavailable' }) } as unknown as McpPort,
    lookupAuthority: async () => ({ ...acceptance, acceptedRunHash }), grantMode: 'owner-trusted-reads' });
  store.transaction(tx => { acceptedRunHash = owner.snapshotRun(tx, acceptance).sha256; });
  const realStage: StageNotePort = (tx, sessionId, args) =>
    stageComposedNote(tx, sessionId, args, { inputAt: now, inputFinal: true }, now, true);
  const definitions = (port: StageNotePort) => owner.liveDefinitions(run, () => ({ remembered: false }), undefined, port, true);
  const receive = async (port: StageNotePort, args: Record<string, unknown>, executionId: string): Promise<ToolOutcome | undefined> => {
    const call: ToolCallIntent = { runId: run, actorId: 'tester', authorityEpoch: store.authorityEpoch, revision: 1, executionId,
      toolName: STAGE_NOTE_IDENTITY.name, argumentsHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      callId: `call-${executionId}`, accountId: VAULT_ACCOUNT, resourceId: VAULT_RESOURCE };
    assert.equal(owner.journal.intent(call, args), 'fresh');
    const tool = definitions(port).find(definition => definition.name === STAGE_NOTE_IDENTITY.name);
    assert.ok(tool, 'the composed stage tool is declared while the switch is on');
    return tool.execute(args, { runId: run, actorId: 'tester', authorityEpoch: store.authorityEpoch, revision: 1,
      executionId, accountId: VAULT_ACCOUNT, resourceId: VAULT_RESOURCE, signal: new AbortController().signal });
  };
  return { store, owner, run, now, definitions,
    stage: args => receive(realStage, args, 'run:1:0'),
    stageWith: (port, args) => receive(port, args, 'run:1:1') };
}

const STAGE_ARGS = { title: 'Rize materials research', body: COMPOSED_BODY, evidenceRefs: ['journal:1', 'journal:2'] };

test('the composed stage completes a real store write and leaves exactly one note row', async t => {
  const h = stageHarness(t);
  const outcome = await h.stage(STAGE_ARGS);
  assert.equal(outcome?.status, 'completed');
  const calls = h.store.transaction(tx => tx.all('SELECT state FROM tool_calls'));
  assert.deepEqual(calls.map(row => row['state']), ['completed']);
  const stages = h.store.transaction(tx => tx.all('SELECT state,body,title FROM lux_note_stages'));
  assert.equal(stages.length, 1);
  assert.equal(stages[0]!['state'], 'staged');
  assert.equal(stages[0]!['body'], COMPOSED_BODY.replace(/\s+/g, ' ').trim());
});

test('a throwing composed stage is a bounded stage_failed result the model can speak, never unknown', async t => {
  const h = stageHarness(t);
  const outcome = await h.stageWith(() => { throw new Error('synthetic stage failure'); }, STAGE_ARGS);
  assert.equal(outcome?.status, 'completed');
  const response = h.store.transaction(tx => JSON.parse(String(tx.get('SELECT result_json FROM tool_calls')!['result_json'])) as Record<string, unknown>)['response'];
  assert.deepEqual(response, { staged: false, code: 'stage_failed', guidance: 'The note was not staged. Tell the owner it was not saved and ask them to say it again in one sentence.' });
  assert.equal(h.store.transaction(tx => tx.all('SELECT stage_id FROM lux_note_stages')).length, 0);
});

test('a handler that throws outside its own catch writes one closed tool_handler_error line', async t => {
  const h = stageHarness(t);
  const lines: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { const safe = safeEvent(raw); if (safe) lines.push(safe); } });
  t.after(detach);
  const throwing = h.definitions(() => ({ staged: false, code: 'not_enabled' })).map(tool => tool.name === STAGE_NOTE_IDENTITY.name
    ? { ...tool, async execute(): Promise<ToolOutcome> { throw new TypeError('synthetic handler failure'); } }
    : tool);
  const call: ToolCallIntent = { runId: h.run, actorId: 'tester', authorityEpoch: h.store.authorityEpoch, revision: 1, executionId: 'run:2:0',
    toolName: STAGE_NOTE_IDENTITY.name, argumentsHash: createHash('sha256').update(JSON.stringify(STAGE_ARGS)).digest('hex'),
    callId: 'call-handler', accountId: VAULT_ACCOUNT, resourceId: VAULT_RESOURCE };
  assert.equal(h.owner.journal.intent(call, STAGE_ARGS), 'fresh');
  const batch = await runToolCalls(h.owner, [{ id: 'call-handler', name: STAGE_NOTE_IDENTITY.name, args: STAGE_ARGS as unknown as JsonObject }], {
    registry: throwing, host: { runId: h.run, actorId: 'tester', authorityEpoch: h.store.authorityEpoch, revision: 1,
      grants: [{ tool: STAGE_NOTE_IDENTITY.name, effect: 'write', accountId: VAULT_ACCOUNT, resourceId: VAULT_RESOURCE }] },
    authority: { isCurrent: async () => true }, control: { signal: new AbortController().signal, deadlineMs: Date.now() + 5_000 },
    step: 1, contentIndex: 0, seenIds: new Set(), baseClasses: ['ordinary'], authorize: true });
  assert.equal(batch.tools[0]?.status, 'unknown');
  const logged = lines.filter(line => line['event'] === 'tool_handler_error');
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], { event: 'tool_handler_error', tool: 'stage_lux_note', class: 'TypeError', reason: 'handler_outcome' });
});
