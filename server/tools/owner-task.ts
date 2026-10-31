import { createHash } from 'node:crypto';
import type { ActionKind, OwnerTaskPort, RequestAuthorization } from './types.js';

/**
 * D2: the owner's task, and the bounded operations it grants.
 *
 * Every finalized owner final (spoken or typed) of the current ask is merged in order and read by
 * deterministic command constructions, never by the model. The reading yields operations
 * {operationId, kind, pinned owner fields, target selector, cardinality 1}. An operation is consumed
 * by its committed success: a later owner fragment of the same task amends it through its receipt
 * instead of creating a second one. Authority never comes from tool results, mail, chat, web or
 * calendar text: only these owner finals are ever read here.
 */

/** The owner fields a task pins, so a host parse can prefer them and a model value cannot override. */
export interface OwnerFields { durationMinutes?: number; recurrenceAsked: boolean }
export interface OwnerCommand { kind: ActionKind; fields: OwnerFields; amendment: boolean; words: string }
export interface OwnerOperation {
  operationId: string; kind: ActionKind; fields: OwnerFields;
  state: 'open' | 'claimed' | 'done'; target?: string; receipt?: unknown;
}
interface OwnerTask {
  id: string; journalId: string; words: string; start: number; observedAt: number; observedMono: number; finals: number;
  operations: OwnerOperation[]; sequence: number; closed: boolean;
  shown: { handle: string; kind: string }[]; sources: Record<string, number>;
}

/** A task with no owner final for this long is over; the owner has moved on. */
export const OWNER_TASK_IDLE_MS = 10 * 60_000;

// A quotation is the owner reading something aloud, so it is content, never a cue.
const QUOTED = /["“”„'][^"“”„']{0,200}["“”„']/g;
const NEGATION = /\b(?:don['’]?t|do not|never|no need|stop|nicht|kein(?:e|en|em)?|bloß nicht)\b/i;
const QUESTION = /^\s*(?:what|when|where|who|which|how|why|did|do|does|can|could|should|would|is|are|was|were|kannst|kann|was|wann|wo|wer|wie|warum|hast du|gibt es)\b|\?\s*$/i;
const CANCEL_TASK = /\b(?:forget it|never mind|nevermind|scratch that|cancel that|stop that|abbrechen|vergiss (?:es|das))\b/i;
const AMEND = /\b(?:make it|change it|move it|push it|shift it|instead|rather|not that|amend|correct that|mach(?:e)? es|verschieb|änder)\b/i;

const SET_VERB = /\b(?:set|put|make|create|add|schedule|wake|remind|take|weck|erinner|stell|trag)\b/i;
const ALARM = /\b(?:alarms?|wecker)\b/i;
const WAKE = /\b(?:wake me|weck mich|remind me|erinnere mich)\b/i;
const LIST_VERB = /\b(?:list|show|what|which|any|read)\b/i;
const CANCEL_VERB = /\b(?:cancel|cancel(?:l)?ed|stop|delete|remove|clear|kill|turn off|abbrechen|ausmachen|löschen|stopp)\b/i;
const SNOOZE = /\b(?:snooze|schlummern|nochmal (?:wecken|klingeln))\b/i;

const CREATE_VERB = /\b(?:schedule|scheduling|book|booking|block(?: out)?|reserve|hold|put|add|create|set up|plan|eintragen|trag(?:e)?|plane?|organisier)\b/i;
const EVENT_NOUN = /\b(?:calendar|kalender|events?|meetings?|appointments?|appt|blocks?|lunch|dinner|gym|slots?|calls?|1:1|one[- ]on[- ]one|termine?n?|besprechung|standup|stand-up|hour)\b/i;
const CALENDAR = /\b(?:calendar|kalender)\b/i;
const CREATE_AMEND = /\b(?:make it|move it|push it|change it|an hour|half an hour|\d+\s*(?:hours?|minutes?|mins?|stunden?|minuten?))\b/i;

const DRAFT_VERB = /\b(?:draft|write|compose|send|reply|respond|message|tell|schreib|formulier|antworte)\b/i;
const MAIL = /\b(?:e-?mails?|mails?|gmail)\b/i;
const CHAT = /\b(?:mattermost|dm|dms|chat|channel|thread|ping|slack)\b/i;

const SAVE_CUE = /\b(?:remember (?:that|this|to)|note (?:that|this|down)|make a note|take a note|write (?:this|it|that) down|save (?:this|it|that|the (?:note|idea))|store (?:this|it)|keep (?:this|that) (?:as a )?note|merk dir|notier|speicher|schreib (?:dir |das )?(?:auf|mit))\b/i;
const OPEN_VERB = /\b(?:open|launch|show|start|öffne|starte|zeig)\b/i;
const OPEN_NOUN = /\b(?:app|application|file|document|window|website|site|url|source|folder|mail|calendar|terminal|finder|browser|settings)\b/i;

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, ninety: 90,
  eine: 1, einer: 1, ein: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
};
const RECURRENCE = /\b(?:every|each|daily|weekly|weekdays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|täglich|jeden|jede|montags|dienstags|mittwochs|donnerstags|freitags|samstags|sonntags|werktags)\b/i;

/** "an hour", "two hours", "90 minutes": a length the owner named, or none. */
export function ownerDurationMinutes(words: string): number | undefined {
  const match = /(\d+|[a-zäöüß]+)\s*(?:(?:and a half)\s*)?(hours?|hrs?|std|stunden?|minutes?|mins?|minuten?)\b/i.exec(words);
  if (!match) return undefined;
  const raw = match[1]!.toLowerCase();
  const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  if (count === undefined) return undefined;
  const minute = /^(?:minutes?|mins?|minuten?)$/i.test(match[2]!) ? 1 : 60;
  return count * minute;
}

/** D2: the deterministic reading of one merged owner ask, one command construction per kind. */
export function ownerCommands(words: string): OwnerCommand[] {
  const spoken = words.replace(QUOTED, ' ').replace(/\s+/g, ' ').trim();
  if (!spoken || NEGATION.test(spoken) || QUESTION.test(spoken)) return [];
  const fields = (): OwnerFields => ({
    ...(ownerDurationMinutes(spoken) !== undefined ? { durationMinutes: ownerDurationMinutes(spoken)! } : {}),
    recurrenceAsked: RECURRENCE.test(spoken),
  });
  const amendment = AMEND.test(spoken) || (!CREATE_VERB.test(spoken) && OWNER_TIME_ONLY.test(spoken));
  const commands: OwnerCommand[] = [];
  const add = (kind: ActionKind, cue: boolean): void => { if (cue) commands.push({ kind, fields: fields(), amendment, words: spoken }); };
  add('set_alarm', (SET_VERB.test(spoken) && ALARM.test(spoken)) || WAKE.test(spoken));
  add('list_alarms', LIST_VERB.test(spoken) && ALARM.test(spoken));
  add('cancel_alarm', CANCEL_VERB.test(spoken) && ALARM.test(spoken) && !LIST_VERB.test(spoken.replace(CANCEL_VERB, '')));
  add('snooze_alarm', SNOOZE.test(spoken) && ALARM.test(spoken));
  add('create_event', CREATE_VERB.test(spoken) && (EVENT_NOUN.test(spoken) || CALENDAR.test(spoken) || CREATE_AMEND.test(spoken)));
  add('delete_event', CANCEL_VERB.test(spoken) && (EVENT_NOUN.test(spoken) || CALENDAR.test(spoken)));
  add('draft_email', DRAFT_VERB.test(spoken) && MAIL.test(spoken));
  add('draft_chat', DRAFT_VERB.test(spoken) && CHAT.test(spoken) && !(MAIL.test(spoken) && !CHAT.test(spoken)));
  // Note, save and remember need the owner's own save cue: a bare noun mention grants nothing.
  add('lux_note', SAVE_CUE.test(spoken) && !/^.*\bremember me\b.*$/i.test(spoken));
  add('open', OPEN_VERB.test(spoken) && OPEN_NOUN.test(spoken));
  return commands;
}

const TOOL_KINDS: Readonly<Record<string, ActionKind>> = Object.freeze({
  set_alarm: 'set_alarm', list_alarms: 'list_alarms', cancel_alarm: 'cancel_alarm', snooze_alarm: 'snooze_alarm',
  create_event: 'create_event', delete_event: 'delete_event', draft_email: 'draft_email', draft_chat: 'draft_chat',
  remember_note: 'lux_note', save_to_vault: 'lux_note', stage_lux_note: 'lux_note', trello_write: 'lux_note',
  open_app: 'open', open_file: 'open', open_home: 'open', open_source: 'open', open_web: 'open',
});

/** The operation kind a write tool runs on, or undefined for a tool that needs no owner operation. */
export function ownerKindOf(name: string): ActionKind | undefined { return TOOL_KINDS[name]; }

const OWNER_TIME_ONLY = /^(?:[\d\s:.,!?'-]|(?:at|in|for|a|an|and|from|now|please|um|heute|morgen|jetzt|bitte)\b)+$/i;

const canonical = (value: unknown): string => JSON.stringify(value ?? null);
const hashOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** D4: the operation ledger, keyed (taskId, operationId) with the canonical-arguments hash. */
interface LedgerEntry { hash: string; receipt?: unknown }

/** Per tools-owner state. Only finalized spoken or typed owner input may call observe. */
export class OwnerTasks implements OwnerTaskPort {
  private tasks = new Map<string, OwnerTask>();
  private sequence = 0;
  private pendingFinal = new Set<string>();
  private finalListeners = new Map<string, Set<() => void>>();
  private external = new Set<string>();
  private ledger = new Map<string, LedgerEntry>();

  constructor(private readonly clock: () => number = () => performance.now(), private readonly wallClock: () => number = () => Date.now()) {}

  partial(session: string): void { this.pendingFinal.add(session); }

  async waitForFinal(session: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.pendingFinal.has(session)) return;
    await new Promise<void>(resolve => {
      const listeners = this.finalListeners.get(session) ?? new Set<() => void>();
      const finish = () => {
        signal.removeEventListener('abort', finish);
        listeners.delete(finish);
        if (!listeners.size) this.finalListeners.delete(session);
        resolve();
      };
      listeners.add(finish); this.finalListeners.set(session, listeners);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  /** D2: merge the owner's finals of this task, then read them into bounded operations. */
  observe(session: string, journalId: string, words: string, observedAt = this.wallClock()): void {
    this.pendingFinal.delete(session);
    for (const finish of this.finalListeners.get(session) ?? []) finish();
    const previous = this.#live(session);
    if (previous?.journalId === journalId) return;
    if (previous !== undefined) {
      if (CANCEL_TASK.test(words)) { previous.closed = true; previous.operations = []; previous.words = words; previous.journalId = journalId; return; }
      const merged = words.startsWith(previous.words) ? words : `${previous.words} ${words}`;
      previous.words = merged;
      previous.journalId = journalId;
      previous.observedAt = observedAt; previous.observedMono = this.clock();
      previous.finals++;
      previous.closed = false;
      this.#apply(previous, ownerCommands(words));
      return;
    }
    const task: OwnerTask = {
      id: `task-${++this.sequence}`, journalId, words, start: this.clock(), observedAt, observedMono: this.clock(), finals: 1,
      operations: [], sequence: 0, closed: false, shown: [], sources: {},
    };
    this.#apply(task, ownerCommands(words));
    this.tasks.set(session, task);
  }

  /** One operation per kind: further owner words amend it, they never open a second one. */
  #apply(task: OwnerTask, commands: readonly OwnerCommand[]): void {
    for (const command of commands) {
      const open = task.operations.filter(operation => operation.kind === command.kind && operation.state !== 'done');
      const amendable = open.at(-1);
      if (amendable !== undefined && command.amendment) { amendable.fields = command.fields; continue; }
      if (amendable !== undefined) continue;
      task.operations.push({ operationId: `op-${++task.sequence}`, kind: command.kind, fields: command.fields, state: 'open' });
    }
  }

  authorize(session: string, kind: ActionKind, target: string): RequestAuthorization {
    const task = this.#live(session);
    if (task === undefined || task.closed) return { code: 'no_owner_request' };
    const common = { id: task.id, words: kind === 'set_alarm' || kind === 'lux_note' || kind === 'create_event' ? task.words : task.words, journalId: task.journalId, observedAt: task.observedAt };
    const age = this.clock() - task.start;
    if (age < 0 || age > OWNER_TASK_IDLE_MS) return { ...common, code: 'request_expired' };
    const operation = task.operations.filter(candidate => candidate.kind === kind).at(-1);
    if (operation === undefined) return { ...common, code: 'no_owner_request' };
    const entry = this.ledger.get(`${task.id}:${operation.operationId}`);
    // An empty target is the grant-point probe: it asks only whether the owner's operation exists,
    // and the handler decides replay against spent with its own canonical target.
    if (target === '') return { ...common, code: 'allowed' };
    if (operation.state === 'done') {
      return operation.target === target && entry?.receipt !== undefined
        ? { ...common, code: 'idempotent', receipt: entry.receipt }
        : { ...common, code: 'grant_spent' };
    }
    if (operation.state === 'claimed') return { ...common, code: 'grant_spent' };
    return { ...common, code: 'allowed' };
  }

  claim(session: string, kind: ActionKind, target: string, requestId: string): RequestAuthorization {
    const task = this.#live(session);
    const operation = task?.operations.filter(candidate => candidate.kind === kind).at(-1);
    if (task === undefined || operation === undefined || task.id !== requestId) return { code: 'no_owner_request' };
    const authorization = this.authorize(session, kind, target);
    if (authorization.code !== 'allowed' && authorization.code !== 'idempotent') return authorization;
    // D4: the intent is journaled before dispatch, keyed by the task and the operation.
    const key = `${task.id}:${operation.operationId}`;
    const hash = hashOf(target);
    const existing = this.ledger.get(key);
    if (existing !== undefined && existing.hash !== hash) return { ...authorization, code: 'grant_spent' };
    if (existing === undefined) this.ledger.set(key, { hash });
    operation.state = 'claimed'; operation.target = target;
    return authorization;
  }

  failed(session: string, kind: ActionKind, target: string, requestId: string): void {
    const operation = this.#live(session)?.operations.filter(candidate => candidate.kind === kind).at(-1);
    const task = this.#live(session);
    if (task?.id === requestId && operation?.state === 'claimed' && operation.target === target) {
      operation.state = 'open'; delete operation.target;
      this.ledger.delete(`${task.id}:${operation.operationId}`);
    }
  }

  commit(session: string, kind: ActionKind, target: string, receipt: unknown, requestId?: string): void {
    const task = this.#live(session);
    if (task === undefined || (requestId !== undefined && task.id !== requestId)) return;
    const operation = task.operations.filter(candidate => candidate.kind === kind).at(-1);
    if (operation === undefined) return;
    operation.state = 'done'; operation.target = target; operation.receipt = receipt;
    this.ledger.set(`${task.id}:${operation.operationId}`, { hash: hashOf(target), receipt });
  }

  /** D2: an owner recurrence the parser cannot read is a clarification, never a silent drop. */
  clarify(session: string, kind: ActionKind, field: string): void {
    const task = this.#live(session);
    if (task === undefined) return;
    // A clarification keeps the operation and its task open: the owner's answer is the next final.
    if (!task.operations.some(operation => operation.kind === kind && operation.state !== 'done') && field !== 'missing_time') return;
  }

  source(session: string, kind: string, requestId?: string): void {
    // D2: text from a tool result is never authority; it only ever marks the task as carrying
    // source material, so a later read-driven call can be told apart from the owner's own words.
    this.external.add(session);
    const task = this.#live(session);
    if (task !== undefined && (requestId === undefined || task.id === requestId)) task.sources[kind] = (task.sources[kind] ?? 0) + 1;
  }

  sources(session: string): Record<string, number> { return { ...(this.#live(session)?.sources ?? {}) }; }

  externalContentPresent(session: string): boolean { return this.external.has(session); }

  shown(session: string, requestId: string, handles: readonly { handle: string; kind: string }[]): void {
    const task = this.#live(session);
    if (task === undefined || task.id !== requestId) return;
    for (const handle of handles) if (!task.shown.some(shown => shown.handle === handle.handle)) task.shown.push(handle);
  }

  topShown(session: string, kinds: readonly string[]): string | undefined {
    return this.#live(session)?.shown.find(shown => kinds.includes(shown.kind))?.handle;
  }

  currentId(session: string): string | undefined { return this.#live(session)?.id; }

  audit(session: string, kind: ActionKind): { ownerFinals: number; requestAgeMs: number; grantKind: ActionKind; grantState: string } {
    const task = this.#live(session);
    const operation = task?.operations.filter(candidate => candidate.kind === kind).at(-1);
    return {
      ownerFinals: task?.finals ?? 0, requestAgeMs: task ? Math.max(0, Math.round(this.clock() - task.start)) : 0,
      grantKind: kind, grantState: task === undefined ? 'absent' : operation === undefined ? 'absent' : operation.state,
    };
  }

  /** Session end only: a provider rebuild keeps the task, its operations and its ledger. */
  release(session: string): void {
    this.tasks.delete(session); this.external.delete(session); this.pendingFinal.delete(session);
    for (const key of [...this.ledger.keys()]) if (key.startsWith(`${this.tasks.get(session)?.id ?? '\u0000'}`)) this.ledger.delete(key);
  }

  #live(session: string): OwnerTask | undefined {
    const task = this.tasks.get(session);
    if (task === undefined) return undefined;
    if (this.clock() - task.observedMono > OWNER_TASK_IDLE_MS) { this.tasks.delete(session); return undefined; }
    return task;
  }
}

export function requestRefusal(code: string): { status: 'refused'; code: string; say: string } {
  const sentences: Record<string, string> = {
    no_owner_request: 'There is no current owner request authorizing that action.',
    request_expired: 'That owner request has expired.', grant_spent: 'That request has already completed this kind of action.',
    target_not_authorized: 'That target is not authorized by this request.', missing_time: 'What time should I set the alarm?',
    missing_timezone: 'Which time zone should I use for the alarm?', unsupported_time_expression: 'What time should I use for the alarm?',
    time_mismatch: 'The alarm was not set because the requested time differs from yours.',
    rule_mismatch: 'The alarm was not set because the recurrence differs from yours.',
    invalid_time: 'The alarm was not set because that time is invalid.', alarm_not_active: 'That alarm is not active.',
    alarm_failed: 'The alarm action failed; no alarm was set.',
  };
  return { status: 'refused', code, say: sentences[code] ?? 'The host could not authorize that action.' };
}
