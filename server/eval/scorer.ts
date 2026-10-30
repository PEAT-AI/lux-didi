import type { EvalCase, RecordedCall } from './types.js';
import { requiredTokens } from './scripted.js';
import type { FakeWorld, ToolMap } from './world.js';
import { resolveTool } from './world.js';

export interface ScoreInput {
  readonly case: EvalCase;
  readonly world: FakeWorld;
  readonly calls: readonly RecordedCall[];
  readonly spoken: string;
  readonly toolMap: ToolMap;
  readonly implemented?: readonly string[];
  /** Alarm state as it stood after the turn's calls and before the virtual clock advanced to fire time. */
  readonly alarmStates?: Readonly<Record<string, { status: string; fireAtUtc: number; label: string }>>;
}

export interface ScoreResult { outcome: 'PASS' | 'FAIL' | 'EXPECTED_RED'; reasons: readonly string[]; redReason?: string }

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const present = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.toLowerCase());

/** Planned capabilities the case depends on, using the mapping table as the one source of truth. */
export function missingCapabilities(input: { case: EvalCase; toolMap: ToolMap; implemented?: readonly string[] }): string[] {
  const shipped = new Set(input.implemented ?? []);
  const missing: string[] = [];
  for (const expectation of input.case.expected_tools) {
    const entry = input.toolMap[expectation.tool];
    if (!entry) { missing.push(`${expectation.tool}:unmapped`); continue; }
    if (entry.status === 'planned' && !shipped.has(entry.didi) && !shipped.has(expectation.tool)) missing.push(expectation.tool);
  }
  return missing;
}

function stateReasons(input: ScoreInput): string[] {
  const reasons: string[] = [];
  const { world, case: evalCase } = input;
  const expected = evalCase.expected_state;

  for (const raw of array(expected.drafts)) {
    const draft = record(raw);
    const match = world.store.drafts.some(stored =>
      (!draft.thread_id || stored.thread_id === draft.thread_id) &&
      (!draft.status || stored.status === draft.status) &&
      (!draft.language || stored.language === draft.language) &&
      (draft.body_contains === undefined || present(text(stored.body), text(draft.body_contains))) &&
      (draft.to === undefined || JSON.stringify(stored.to) === JSON.stringify(draft.to)));
    if (!match) reasons.push('state_draft_missing');
  }
  if (expected.sent !== undefined && world.store.sent.length !== array(expected.sent).length) reasons.push('state_sent_not_empty');
  for (const raw of array(expected.new_events)) {
    const event = record(raw);
    const match = world.store.newEvents.some(stored => (!event.start || stored.start === event.start) && (!event.end || stored.end === event.end) && (!event.timezone || stored.timezone === event.timezone));
    if (!match) reasons.push('state_event_missing');
  }
  for (const raw of array(expected.chat_drafts)) {
    const draft = record(raw);
    const match = world.store.chatDrafts.some(stored => (!draft.thread_root_id || stored.thread_root_id === draft.thread_root_id) && (draft.body_contains === undefined || present(text(stored.body), text(draft.body_contains))));
    if (!match) reasons.push('state_chat_draft_missing');
  }
  for (const raw of array(expected.posts)) {
    const post = record(raw);
    const match = world.store.posts.some(stored => post.body_contains === undefined || present(text(stored.body), text(post.body_contains)));
    if (!match) reasons.push('state_post_missing');
  }
  if (expected.unchanged === true) {
    const writes = input.calls.filter(call => input.toolMap[call.tool]?.kind === 'write');
    if (writes.length > 0) reasons.push(`state_changed_when_unchanged:${writes.map(call => call.tool).join(',')}`);
  }
  for (const raw of array(expected.alarms)) {
    const alarm = record(raw);
    const alias = text(alarm.id);
    const stored = alarmState(input, alias);
    if (!stored) { reasons.push(`state_alarm_missing:${alias}`); continue; }
    if (alarm.fire_at !== undefined && Date.parse(text(alarm.fire_at)) !== stored.fireAtUtc) reasons.push(`state_alarm_fire_at:${alias}`);
    const label = alarm.label === null ? '' : text(alarm.label);
    if (alarm.label !== undefined && stored.label !== label) reasons.push(`state_alarm_label:${alias}`);
    if (alarm.status !== undefined && stored.status !== alarm.status) reasons.push(`state_alarm_status:${alias}:${stored.status}`);
  }
  for (const alias of ['a1', 'a2'] as const) {
    if (expected[alias] === undefined) continue;
    const status = alarmState(input, alias)?.status ?? 'missing';
    if (status !== text(expected[alias])) reasons.push(`state_alarm_${alias}:${status}`);
  }
  if (typeof expected.new_alarm_count === 'number' && world.store.alarmsWritten !== expected.new_alarm_count) {
    reasons.push(`state_alarm_count:${world.store.alarmsWritten}`);
  }
  for (const raw of array(expected.memory_contains)) {
    const needle = text(raw);
    if (!world.store.memory.some(note => present(text(note.text), needle))) reasons.push(`state_memory_missing:${needle}`);
  }
  for (const raw of array(expected.cards)) {
    const card = record(raw);
    if (!world.store.cards.some(stored => (!card.title || present(text(stored.title), text(card.title))) && (!card.list || text(stored.list) === text(card.list)))) reasons.push('state_card_missing');
  }
  const mapped = new Set(['drafts', 'sent', 'new_events', 'chat_drafts', 'posts', 'unchanged', 'alarms', 'at_fire', 'memory_contains', 'cards', 'a1', 'a2', 'new_alarm_count',
    'series_active', 'materialized_pending_occurrences', 'next_fire_at', 'after_fire_next', 'a1_status', 'deleted_events']);
  for (const key of Object.keys(expected)) if (!mapped.has(key)) reasons.push(`state_assertion_unmapped:${key}`);
  return reasons;
}

function speechReasons(input: ScoreInput): string[] {
  const reasons: string[] = [];
  const { spoken, case: evalCase, world } = input;
  const mustNot = evalCase.spoken_must_not.map(text);
  for (const phrase of mustNot) if (phrase && present(spoken, phrase)) reasons.push(`speech_forbidden:${phrase}`);

  // A3: no invitations, ever. A claim is a failure even when a block was created.
  if (/\binvit/i.test(spoken)) reasons.push('speech_claims_invitation');
  if (/\b(sent|sending|send)\b[^.]{0,40}\b(e-?mail|mail|message|note)\b/i.test(spoken) && /\bsent\b/i.test(spoken)) reasons.push('speech_claims_send');

  let cursor = 0;
  for (const token of requiredTokens(evalCase)) {
    const at = spoken.toLowerCase().indexOf(token.toLowerCase(), cursor);
    if (at < 0) { reasons.push(`speech_missing:${token}`); continue; }
    cursor = at + token.length;
  }

  // A1/A4: a spoken claim must match the fake store, never the other way round.
  const draftMatch = /(draft (is|was) (saved|created|ready|in your)|saved (the|your|a) draft|draft saved|draft is in)/i.exec(spoken);
  // "no draft was created" is the honest denial, not a claim: only an unnegated claim needs a stored draft.
  const negated = draftMatch ? /(no|not|never)\s+$/i.test(spoken.slice(0, draftMatch.index)) : false;
  if (draftMatch && !negated && world.store.drafts.length === 0 && world.store.chatDrafts.length === 0) reasons.push('speech_claims_draft_without_store_object');
  for (const event of (Array.isArray(world.seed.calendar) ? world.seed.calendar : [])) {
    if (!present(spoken, event.title)) continue;
    const finished = Date.parse(event.end) <= world.t0;
    if (finished && /upcoming|coming up|next up|later today|still ahead/i.test(spoken)) reasons.push(`speech_finished_meeting_as_upcoming:${event.title}`);
  }
  const windowMeetings = (Array.isArray(world.seed.calendar) ? world.seed.calendar : []).filter(event => Date.parse(event.start) >= world.t0 && Date.parse(event.start) <= world.t0 + 7 * 86_400_000);
  if (['calendar', 'planning', 'meeting-prep'].includes(evalCase.category) && spoken.trim().length > 0) {
    for (const event of windowMeetings) if (!present(spoken, event.title)) reasons.push(`speech_meeting_unnamed:${event.title}`);
  }
  return reasons;
}

function alarmState(input: ScoreInput, alias: string): { status: string; fireAtUtc: number; label: string } | undefined {
  if (input.alarmStates) return input.alarmStates[alias];
  const world = input.world;
  const real = world.alarmIdFor(alias);
  const stored = real ? world.alarms.list().find(row => row.id === real) : undefined;
  if (!stored) return undefined;
  return { status: stored.state === 'pending' ? 'scheduled' : stored.state, fireAtUtc: stored.fireAtUtc, label: stored.label };
}

export function scoreCase(input: ScoreInput): ScoreResult {
  const missing = missingCapabilities(input);
  const shipped = new Set(input.implemented ?? []);
  // A red case stays EXPECTED_RED until a capability it names is declared shipped: then it runs for real,
  // and a case that still fails is a hard failure, never a red one.
  const flipped = input.case.expected_tools.some(expectation => {
    const entry = input.toolMap[expectation.tool];
    return entry !== undefined && (shipped.has(entry.didi) || shipped.has(expectation.tool));
  });
  if (input.case.red_today && !flipped) {
    return { outcome: 'EXPECTED_RED', reasons: [], redReason: input.case.red_reason ?? `planned tools absent: ${missing.join(',')}` };
  }
  if (missing.length > 0) return { outcome: 'FAIL', reasons: missing.map(tool => `capability_missing:${tool}`) };

  const reasons: string[] = [];
  const expected = input.case.expected_tools;
  for (const expectation of expected) {
    const count = expectation.count ?? 1;
    const seen = input.calls.filter(call => call.tool === expectation.tool).length;
    if (seen < count) reasons.push(`tool_missing:${expectation.tool}`);
    if (count === 0 && seen > 0) reasons.push(`tool_unexpected:${expectation.tool}`);
  }
  let cursor = 0;
  for (const expectation of expected) {
    const index = input.calls.findIndex((call, position) => position >= cursor && call.tool === expectation.tool);
    if (index < 0 && (expectation.count ?? 1) > 0) { reasons.push(`tool_order:${expectation.tool}`); continue; }
    if (index >= 0) cursor = index;
  }
  for (const call of input.calls) {
    const entry = input.toolMap[call.tool];
    if (!entry) reasons.push(`tool_unmapped_call:${call.tool}`);
    else if (entry.kind === 'write' && !expected.some(expectation => expectation.tool === call.tool)) reasons.push(`write_not_expected:${call.tool}`);
  }
  reasons.push(...stateReasons(input));
  reasons.push(...speechReasons(input));
  const atFire = record(input.case.expected_state.at_fire);
  if (atFire.status !== undefined) {
    const ringing = input.world.alarms.ripeCount() > 0;
    if (atFire.status === 'ringing' && !ringing) reasons.push('at_fire_not_ringing');
    if (atFire.output_sink !== undefined && atFire.output_sink !== 'recording-only') reasons.push('at_fire_sink_unexpected');
  }
  for (const expectation of expected) {
    if (!input.toolMap[expectation.tool]) reasons.push(`tool_unmapped:${expectation.tool}`);
    else resolveTool(input.toolMap, expectation.tool);
  }
  return { outcome: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}
