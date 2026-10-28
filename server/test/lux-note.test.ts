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
import { attachHostLogSink } from '../tools/host-events.js';
import { liveMigrations } from '../live/schema.js';
import { Store } from '../runtime/store.js';
import { runToolCalls } from '../tools/declarations.js';
import { createToolsOwner, toolsMigrations } from '../tools/index.js';
import type { RunAcceptance, StageNotePort } from '../tools/types.js';
import {
  AUTHORIZATION_MISSING_GUIDANCE, NoteRequestGate, NOTE_PROVENANCE, noteReadbackText, readbackMatches,
  beginStage, composedAsk, confirmAsk, CONFIRM_MAX_TOKENS, CONFIRM_WINDOW_MS, currentOwnerTurn, freezeNote, NOTE_MAX_CHARS, OWNER_WINDOW_CHARS,
  noteOwnerFragment, noteOwnerUtterance, noteReadback, noteSegmentSignal, noteSettle, stageComposedNote, STAGE_NOTE_IDENTITY,
  validateStageNote, type PlaybackSignal, type ReadbackBinding,
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
  // R7-W1: the frame a split stretch opens with is not the ask; the clause after it is.
  for (const text of ['you have my full permission to save it in Lux Knowledge', 'can you, can you store it in Lux Knowledge']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
  // W1-R2: a save verb and a lux destination anywhere in the stretch are the ask, whatever leads it.
  for (const text of ['naya what can you tell me about rize store it in lux knowledge',
    'you have my full permission to save it in Lux Knowledge and also a card in Trello both of these things']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
  // No save verb, or no lux destination, is still no authorization.
  for (const text of ['both of these things', 'both of these in Lux Knowledge', 'you have my full permission to save it and also a card in Trello']) {
    assert.deepEqual(composedAsk(text), { decision: 'none' }, text);
  }
  // W7-R1 F5: a word that merely ends in "no" is not a negation, so the ask stands.
  for (const text of ['Bruno save it to Lux', 'the Reno property save it to Lux', 'we discussed the piano and you should save it to Lux']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
  // W1-R3: a negation refuses only when it governs the save verb; an ordinary self-correction does not.
  for (const text of ['no that is not right it is the second one save it to Lux knowledge',
    'no I mean the other file save it to Lux knowledge']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
  // W1-R4 F10: every save verb is judged, so an ask after a report of not saving still grants.
  for (const text of ['I did not save it, but save it to Lux', 'I never saved it, save it to Lux knowledge']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
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
    ['cannot save it to Lux', 'negated'],
    ["can't save it to Lux", 'negated'],
    ['not save it to Lux', 'negated'],
    ['Bruno cannot save it to Lux', 'negated'],
    ['do not save it to Lux', 'negated'],
    ["don't put it in Lux", 'negated'],
    ['never save this to Lux', 'negated'],
    // W1-R4 F9: a negation governs across a short auxiliary chain, and a contraction is one token.
    ["I don't want to save it to Lux", 'negated'],
    ["I didn't want to save it to Lux", 'negated'],
    ["I won't need to save it to Lux", 'negated'],
    ['I do not intend to save it to Lux', 'negated'],
    ["I can't just save it to Lux", 'negated'],
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

// R7-W1: a VAD split ask is one ask, so the whole finalized stretch of this turn authorizes it.
test('the exact four-fragment incident ask composes into one authorization', () => {
  const rows = [turnRow(21, 'you have my full permission to save it', 1_200), turnRow(22, 'in Lux Knowledge', 1_300),
    turnRow(23, 'and also a card in Trello', 1_400), turnRow(24, 'both of these things', 1_500)];
  const read = currentOwnerTurn(rows, 1_000, true, 1_600);
  assert.equal(read.state, 'owner_turn');
  if (read.state !== 'owner_turn') return;
  assert.equal(read.text, 'you have my full permission to save it in Lux Knowledge and also a card in Trello both of these things');
  assert.deepEqual([...read.evidence].sort(), ['journal:21', 'journal:22', 'journal:23', 'journal:24']);
});

test('the composed stretch keeps the open guard bounds and never crosses its own window', () => {
  const seven = [11, 12, 13, 14, 15, 16, 17].map((id, index) => turnRow(id, `fragment ${id}`, 1_100 + index * 10));
  const bounded = currentOwnerTurn(seven, 1_000, true, 1_500);
  assert.equal(bounded.state === 'owner_turn' ? bounded.text : '', 'fragment 12 fragment 13 fragment 14 fragment 15 fragment 16 fragment 17');
  const long = currentOwnerTurn([turnRow(11, 'a'.repeat(400), 1_200), turnRow(12, 'b'.repeat(400), 1_300)], 1_000, true, 1_400);
  assert.equal(long.state === 'owner_turn' ? long.text.length : 0, OWNER_WINDOW_CHARS);
  // A split from before this turn started, or from before the confirm window, is never composed.
  const before = currentOwnerTurn([turnRow(11, 'save it to lux', 900), turnRow(12, 'both of these', 1_400)], 1_000, true, 1_500);
  assert.equal(before.state === 'owner_turn' ? before.text : '', 'both of these');
  const stale = currentOwnerTurn([turnRow(11, 'save it to lux', 1_400 - CONFIRM_WINDOW_MS - 1), turnRow(12, 'both of these', 1_400)],
    undefined, true, 1_400);
  assert.equal(stale.state === 'owner_turn' ? stale.text : '', 'both of these');
  // The model's own output ends the stretch: the owner's words before it never authorize.
  const afterModel = currentOwnerTurn([turnRow(11, 'save it to lux', 1_300), turnRow(13, 'both of these', 1_400)],
    1_000, true, 1_500, 12);
  assert.equal(afterModel.state === 'owner_turn' ? afterModel.text : '', 'both of these');
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
/** One journal row of the fixture session: kind, text, and when it finalized relative to the harness clock. */
type JournalSeed = readonly ['inputTranscription' | 'outputTranscription', string, number];
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

/** The default session: the owner asked, then asked to store this answer, both in the same stretch. */
const DEFAULT_SEEDS: readonly JournalSeed[] = [
  ['inputTranscription', 'Naya, what can you tell me about Rize', 0],
  ['inputTranscription', 'store it in Lux Knowledge', 0]];

function stageHarness(t: TestContext, seeds: readonly JournalSeed[] = DEFAULT_SEEDS): StageHarness {
  const now = 1_700_000_000_000;
  const run = 'live-stage-run';
  const dir = mkdtempSync(join(tmpdir(), 'lux-note-stage-'));
  const store = new Store(dir, [...liveMigrations, ...toolsMigrations]);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.transaction(tx => {
    tx.run(`INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
        client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events,
        journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'active',1,1,?,0,0,'attached',NULL,NULL,?,?)`,
      [run, store.assistantId, store.authorityEpoch, 'key-stage', 'fp-stage', 'client', 'audit', 'profile', 'prompt', 2, now, now]);
    for (const [kind, text, offset] of seeds) {
      tx.run('INSERT INTO live_journal (live_session_id, kind, text, finished, final_origin, finalized_at, payload_bytes, arrived_at) VALUES (?,?,?,?,?,?,?,?)',
        [run, kind, text, 1, 'app_model_start', now + offset, text.length, now + offset]);
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

test('the split-fragment save ask stages instead of refusing on its newest fragment alone', async t => {
  const h = stageHarness(t, [['inputTranscription', 'you have my full permission to save it', 0],
    ['inputTranscription', 'in Lux Knowledge', 4_000], ['inputTranscription', 'and also a card in Trello', 6_000],
    ['inputTranscription', 'both of these things', 9_000]]);
  const outcome = await h.stage(STAGE_ARGS);
  assert.equal(outcome?.status, 'completed');
  const stages = h.store.transaction(tx => tx.all('SELECT state FROM lux_note_stages'));
  assert.deepEqual(stages.map(row => row['state']), ['staged']);
});

test('a self-correction before the ask does not stop it staging, and a negation of the verb does', async t => {
  const corrected = stageHarness(t, [['inputTranscription', 'no that is not right it is the second one', 0],
    ['inputTranscription', 'save it to Lux knowledge', 3_000]]);
  const staged = await corrected.stage(STAGE_ARGS);
  assert.equal(staged?.status, 'completed');
  const rows = corrected.store.transaction(tx => tx.all('SELECT state FROM lux_note_stages'));
  assert.deepEqual(rows.map(row => row['state']), ['staged']);
  const refused = stageHarness(t, [['inputTranscription', 'no that is not right it is the second one', 0],
    ['inputTranscription', 'do not save it to Lux knowledge', 3_000]]);
  const outcome = await refused.stage(STAGE_ARGS);
  assert.equal(outcome?.status, 'completed');
  const response = refused.store.transaction(tx => JSON.parse(String(tx.get('SELECT result_json FROM tool_calls')!['result_json'])) as Record<string, unknown>)['response'];
  assert.equal((response as Record<string, unknown>)['code'], 'authorization_refused');
  assert.equal(refused.store.transaction(tx => tx.all('SELECT stage_id FROM lux_note_stages')).length, 0);
});

test('a stretch with no save ask refuses with plain guidance, never an authorization error', async t => {
  const h = stageHarness(t, [['inputTranscription', 'what time is it', 0]]);
  const outcome = await h.stage(STAGE_ARGS);
  assert.equal(outcome?.status, 'completed');
  const response = h.store.transaction(tx => JSON.parse(String(tx.get('SELECT result_json FROM tool_calls')!['result_json'])) as Record<string, unknown>)['response'];
  assert.deepEqual(response, { staged: false, code: 'authorization_missing', guidance: AUTHORIZATION_MISSING_GUIDANCE });
  assert.doesNotMatch(AUTHORIZATION_MISSING_GUIDANCE, /authorization error|lux error/iu);
  assert.equal(h.store.transaction(tx => tx.all('SELECT stage_id FROM lux_note_stages')).length, 0);
});

test('an ask from before this stretch, or from before the model answered, never authorizes the save', async t => {
  const older = stageHarness(t, [['inputTranscription', 'save it to Lux', -600_000], ['inputTranscription', 'both of these', 0]]);
  const refused = await older.stage(STAGE_ARGS);
  assert.equal(refused?.status, 'completed');
  const response = older.store.transaction(tx => JSON.parse(String(tx.get('SELECT result_json FROM tool_calls')!['result_json'])) as Record<string, unknown>)['response'];
  assert.equal((response as Record<string, unknown>)['code'], 'authorization_missing');
  const answered = stageHarness(t, [['inputTranscription', 'save it to Lux', 0],
    ['outputTranscription', 'The lab asks for a property target and proposes candidate mixes.', 2_000],
    ['inputTranscription', 'both of these', 4_000]]);
  const afterModel = await answered.stage(STAGE_ARGS);
  assert.equal(afterModel?.status, 'completed');
  const after = answered.store.transaction(tx => JSON.parse(String(tx.get('SELECT result_json FROM tool_calls')!['result_json'])) as Record<string, unknown>)['response'];
  assert.equal((after as Record<string, unknown>)['code'], 'authorization_missing');
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
  // The sink sees the raw event; safeEvent's own closed shape is asserted in host-log.test.ts, which
  // owns the whitelist. Here the assertion is that one line reached the sink at all.
  const detach = attachHostLogSink({ event: raw => { lines.push(raw as Record<string, unknown>); } });
  t.after(detach);
  const throwing = h.definitions(() => ({ staged: false, code: 'not_enabled' })).map(tool => tool.name === STAGE_NOTE_IDENTITY.name
    ? { ...tool, async execute(): Promise<ToolOutcome> { throw new TypeError('synthetic handler failure'); } }
    : tool);
  // The batch books the call itself, so the handler throws after a real dispatch.
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

// C-LUXSAVE11, synthetic owner conversation only. These assertions precede the fix.
test('C-LUXSAVE11: delayed deictic save requests authorize the conversation, qualified requests do not', () => {
  for (const text of ['save all of this', 'store all of this in great detail', 'remember that', 'note this']) {
    assert.deepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
  for (const text of ['do not save all of this', 'maybe store all of this', 'if I say save all of this']) {
    assert.notDeepEqual(composedAsk(text), { decision: 'grant' }, text);
  }
});

test('C-LUXSAVE11 W12-R2: a 4,000-character body fits independently of the title; longer bodies refuse', () => {
  assert.equal(freezeNote({ title: 'Synthetic synthesis', body: 'x'.repeat(4_000) }).state, 'frozen');
  assert.equal(freezeNote({ title: 'Synthetic synthesis', body: 'x'.repeat(4_001) }).state, 'refused');
});

test('C-LUXSAVE11: paragraph boundaries survive staging so no paragraph can be hidden from readback', () => {
  const body = 'The synthetic plan is ready. Details follow.\n\nThe second paragraph changes the budget.\n\n- The first bullet has a constraint.\n- The second bullet adds a deadline.';
  const outcome = beginStage({ stageId: 'paragraphs', sessionId: 'synthetic', ownerText: 'save this to lux',
    title: 'Synthetic plan', body, evidence: EVIDENCE, heldEvidence: HELD, enabled: true, now: 1 });
  assert.equal(outcome.state, 'staged');
  if (outcome.state === 'staged') {
    assert.equal(outcome.note.body, body);
    assert.equal(JSON.parse(outcome.note.payload).content, body);
  }
  assert.equal(beginStage({ stageId: 'empty', sessionId: 'synthetic', ownerText: 'save this to lux',
    title: 'Synthetic plan', body: '', evidence: EVIDENCE, heldEvidence: HELD, enabled: true, now: 1 }).state, 'refused');
});

test('C-LUXSAVE11: confirmation is a closed phrase, not an arbitrary affirmative word bag', () => {
  for (const text of ['yes', 'yes save it', 'save it', 'go ahead', 'do it', 'save this note']) {
    assert.equal(confirmAsk(text), 'affirm', text);
  }
  for (const text of ['right', 'perfect', 'go', 'do', 'yes but not yet', 'yes save it no', 'yes save it after lunch']) {
    assert.equal(confirmAsk(text), 'cancel', text);
  }
});


test('C-LUXSAVE11: host request tokens merge provider splits and are single use', () => {
  const gate = new NoteRequestGate();
  gate.observeOwner(10, 11, 'save all');
  gate.observeOwner(10, 12, 'of this in great detail');
  assert.deepEqual(gate.claim(), { ownerText: 'save all of this in great detail', ownerJournalIds: [11, 12], watermark: 12 });
  assert.equal(gate.claim(), undefined);
  gate.observeOwner(10, 13, 'save that too');
  assert.equal(gate.claim(), undefined, 'a consumed block cannot mint another token');
  gate.observeOwner(20, 21, 'save this');
  assert.equal(gate.claim()?.watermark, 21, 'a new save block can mint a token');
});

test('C-LUXSAVE11: intervening external reads, non-save blocks and disconnect revoke authority', () => {
  for (const revoke of [(gate: NoteRequestGate) => gate.externalRead(),
    (gate: NoteRequestGate) => gate.observeOwner(20, 21, 'what time is it'),
    (gate: NoteRequestGate) => gate.disconnect()]) {
    const gate = new NoteRequestGate();
    gate.observeOwner(1, 2, 'save this');
    revoke(gate);
    assert.equal(gate.claim(), undefined);
    gate.observeOwner(30, 31, 'store all of this');
    assert.equal(gate.claim()?.watermark, 31);
  }
});

test('C-LUXSAVE11 W12-R2: external results taint owner-only citations and every paragraph is read', () => {
  const gate = new NoteRequestGate();
  gate.externalResult();
  gate.observeOwner(1, 2, 'save all of this');
  const result = beginStage({ stageId: 'tainted', sessionId: 'synthetic', ownerText: gate.claim()!.ownerText,
    title: 'Synthetic plan', body: 'First paragraph. More details.\n\nHidden budget change. Another sentence.\n\n- First bullet. Detail.\n- Second bullet. Detail.',
    evidence: ['journal:11'], heldEvidence: HELD, enabled: true, now: 1, externalContextPresent: gate.externalContextPresent });
  assert.equal(result.state, 'staged');
  if (result.state !== 'staged') return;
  assert.equal(result.note.externalContextPresent, true);
  assert.ok(result.note.body.endsWith(NOTE_PROVENANCE));
  const readback = noteReadbackText(result.note);
  for (const line of ['Synthetic plan', NOTE_PROVENANCE, 'First paragraph.', 'Hidden budget change.', 'First bullet.', 'Second bullet.']) assert.ok(readback.includes(line), line);
  assert.ok(!readback.includes('More details.'));
  assert.equal(readbackMatches(readback, readback), true);
  assert.equal(readbackMatches(readback, 'Would you like me to save something else?'), false);
  assert.ok(noteReadbackText({ ...result.note, fullReadback: true }).includes('More details.'));
  const clean = beginStage({ stageId: 'clean', sessionId: 'synthetic', ownerText: 'save this', title: 'Plan', body: 'Synthetic only.', evidence: [], heldEvidence: HELD, enabled: true, now: 1 });
  assert.equal(clean.state, 'staged');
  if (clean.state === 'staged') assert.equal(clean.note.body.includes(NOTE_PROVENANCE), false);
});

test('C-LUXSAVE11: split confirmation merges, trailing negation and early onset never commit', () => {
  const first = noteOwnerUtterance(armed(), { text: 'yes', now: 3_000, onsetAt: 2_500 });
  const pending = noteOwnerFragment(first, 3_100);
  assert.equal(noteSettle(pending, 9_000).state, 'settling', 'partial speech suspends commit');
  const second = noteOwnerUtterance(pending, { text: 'save it', now: 3_200, onsetAt: 3_100 });
  assert.equal(noteSettle(second, 5_000).state, 'committed');
  const negated = noteOwnerUtterance(second, { text: 'no', now: 3_400, onsetAt: 3_300 });
  assert.equal(noteSettle(negated, 5_000).state, 'cancelled');
  assert.equal(noteOwnerUtterance(armed(), { text: 'yes', now: 3_000, onsetAt: 1_000 }).state, 'cancelled');
});
