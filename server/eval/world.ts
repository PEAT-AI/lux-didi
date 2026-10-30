import type { AlarmWorld } from './alarms.js';
import type { Contact, DriveFile, EvalCase, Meeting, RecordedCall, SeededState, ToolExpectation } from './types.js';

export interface ToolMapEntry { didi: string; kind: 'read' | 'write'; status: 'implemented' | 'planned'; connector: string; note?: string }
export type ToolMap = Readonly<Record<string, ToolMapEntry>>;

export interface CallResult { ok: boolean; data: Record<string, unknown>; reason?: string }

export interface FakeWorld {
  readonly seed: SeededState;
  readonly calls: RecordedCall[];
  readonly t0: number;
  readonly tz: string;
  readonly offset: string;
  /** Writes the fake store holds after the turn, which is what `expected_state` and the scorer read. */
  readonly store: {
    drafts: Record<string, unknown>[];
    sent: Record<string, unknown>[];
    chatDrafts: Record<string, unknown>[];
    posts: Record<string, unknown>[];
    newEvents: Record<string, unknown>[];
    cards: Record<string, unknown>[];
    memory: Record<string, unknown>[];
    deletedEvents: string[];
    alarmsWritten: number;
  };
  readonly alarms: AlarmWorld;
  call(expectation: { tool: string; args?: Record<string, unknown> }): CallResult;
  available(tool: string): boolean;
  meetingAlias(id: string): string | undefined;
  alarmAlias(id: string): string | undefined;
  alarmIdFor(aliasOrId: string): string | undefined;
}

export interface WorldOptions {
  readonly case: EvalCase;
  readonly clock: { now(): number };
  readonly alarms: AlarmWorld;
  readonly toolMap: ToolMap;
  /** Capabilities the harness is told to treat as shipped, so a red case flips to a hard run. */
  readonly implemented?: readonly string[];
}

const words = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = <T>(value: unknown): readonly T[] => (Array.isArray(value) ? (value as readonly T[]) : []);

/** Abstract tool name to the real (or planned) Didi tool, without trusting the case to name it correctly. */
export function resolveTool(toolMap: ToolMap, tool: string): ToolMapEntry {
  const entry = toolMap[tool];
  if (!entry) throw new Error(`eval_tool_unmapped: ${tool}`);
  return entry;
}

function localIso(t0: string, time: string, offset: string): string {
  const date = t0.slice(0, 10);
  return `${date}T${time.length === 5 ? `${time}:00` : time}${offset}`;
}

export function fakeWorld(options: WorldOptions): FakeWorld {
  const { case: evalCase, clock, alarms, toolMap } = options;
  // fixture_mode is "isolated deep copy; reset before each case": every case gets its own copy.
  const seed: SeededState = structuredClone(evalCase.setup.seeded_state);
  const t0 = Date.parse(evalCase.setup.clock_T0);
  const tz = evalCase.setup.timezone;
  const offset = evalCase.setup.clock_T0.slice(19);
  const calls: RecordedCall[] = [];
  const store = {
    drafts: [] as Record<string, unknown>[], sent: [] as Record<string, unknown>[],
    chatDrafts: [] as Record<string, unknown>[], posts: [] as Record<string, unknown>[],
    newEvents: [] as Record<string, unknown>[], cards: [] as Record<string, unknown>[],
    memory: [] as Record<string, unknown>[], deletedEvents: [] as string[], alarmsWritten: 0,
  };
  const alarmIdByAlias = new Map<string, string>();
  const meetingAliases = new Map<string, string>();
  for (const meeting of list<Meeting>(seed.calendar)) meetingAliases.set(meeting.id, meeting.id);

  for (const seeded of list<{ id: string; time?: string; label?: string }>(seed.alarms)) {
    const time = words(seeded.time) || '07:00';
    // A seeded alarm whose time already passed today belongs to the next day: an alarm is never in the past.
    let fireAt = Date.parse(localIso(evalCase.setup.clock_T0, time, offset));
    if (fireAt <= t0) fireAt += 86_400_000;
    const alarm = alarms.set(fireAt, words(seeded.label), tz);
    alarmIdByAlias.set(seeded.id, alarm.id);
  }

  const implemented = new Set(options.implemented ?? []);
  const available = (tool: string): boolean => {
    const entry = toolMap[tool];
    if (!entry) return false;
    return entry.status === 'implemented' || implemented.has(entry.didi) || implemented.has(tool);
  };

  const record = (tool: string, entry: ToolMapEntry, args: Record<string, unknown>): void => {
    calls.push({ tool, didi: entry.didi, args, at: clock.now(), seq: calls.length });
  };
  const fail = (reason: string): CallResult => ({ ok: false, data: {}, reason });

  const contacts = list<Contact>(seed.contacts);
  const contactById = (id: unknown): Contact | undefined => contacts.find(contact => contact.id === id);
  const mail = list<{ id: string; from: string; subject: string; body: string; unread?: boolean; received?: string }>(seed.mail);
  const chat = list<{ id: string; channel_id?: string; channel_name?: string; author?: string; text: string; needs_attention?: boolean }>(seed.chat);
  const calendar = list<Meeting>(seed.calendar);
  const driveFiles = list<DriveFile>(seed.drive_files);
  const stubs = list<{ id: string; expand_to: string }>(seed.lux_stubs);
  const transcripts = list<{ id: string; title: string; attendee_ids?: readonly string[]; date?: string; body: string }>(seed.transcripts);
  const companies = list<{ domain: string; name: string; fact?: string }>(seed.companies);
  const searchable = (text: string, query: string): boolean => {
    const needle = query.toLowerCase().trim();
    if (!needle) return true;
    return needle.split(/\s+/).some(word => word.length > 2 && text.toLowerCase().includes(word));
  };

  const handlers: Record<string, (args: Record<string, unknown>) => CallResult> = {
    resolve_person(args) {
      const query = words(args.query);
      const hit = contacts.find(contact => contact.name.toLowerCase().includes(query.toLowerCase()) || words(contact.email).includes(query.toLowerCase()));
      return { ok: true, data: { contacts: hit ? [hit] : contacts.filter(contact => searchable(contact.name, query)) } };
    },
    'people.lookup'(args) {
      const byId = contactById(args.person_id);
      if (byId) return { ok: true, data: { person: byId } };
      const resolve = handlers.resolve_person;
      if (!resolve) throw new Error('eval_tool_unfaked: resolve_person');
      return resolve(args);
    },
    research(args) {
      const query = words(args.query);
      const source = words(args.source);
      const person = contactById(args.person_id);
      const items: Record<string, unknown>[] = [];
      if (source !== 'chat') for (const thread of mail) if (searchable(`${thread.subject} ${thread.body} ${thread.from}`, query)) items.push({ source: 'mail', id: thread.id, title: thread.subject, snippet: thread.body, unread: thread.unread === true });
      if (source !== 'mail') for (const post of chat) if (searchable(post.text, query)) items.push({ source: 'chat', id: post.id, title: post.channel_name, snippet: post.text, needs_attention: post.needs_attention === true });
      if (person) for (const file of driveFiles) if ((file.attendee_ids ?? []).includes(person.id)) items.push({ source: 'drive', id: file.id, title: file.title, snippet: words(file.body) });
      return { ok: true, data: { items, unread: mail.filter(thread => thread.unread === true).length } };
    },
    'mail.read_thread'(args) {
      const thread = mail.find(row => row.id === args.thread_id);
      return thread ? { ok: true, data: { thread } } : fail('not_found');
    },
    'mail.create_draft'(args) {
      const draft = { to: list<string>(args.to), thread_id: args.thread_id, language: args.language, body: words(args.body_contains), status: 'unsent' };
      store.drafts.push(draft);
      return { ok: true, data: { draft, sendCapable: false } };
    },
    'calendar.read'(args) {
      const start = args.start ? Date.parse(words(args.start)) : t0;
      const end = args.end ? Date.parse(words(args.end)) : t0 + 7 * 86_400_000;
      const events = calendar.filter(event => Date.parse(event.end) > start && Date.parse(event.start) < end);
      return { ok: true, data: { events } };
    },
    'calendar.create_event'(args) {
      const event = { start: args.start, end: args.end, timezone: args.timezone, attendees: [], sendUpdates: 'none' };
      store.newEvents.push(event);
      return { ok: true, data: { event } };
    },
    'calendar.delete_event'(args) {
      store.deletedEvents.push(words(args.event_id));
      return { ok: true, data: { deleted: words(args.event_id) } };
    },
    'chat.resolve_target'(args) {
      const query = words(args.query);
      const channel = chat.find(post => words(post.channel_name).includes(query.toLowerCase()));
      const person = contactById(args.target_id) ?? contacts.find(contact => contact.name.toLowerCase().includes(query.toLowerCase()));
      return { ok: true, data: { target: args.target_id ?? channel?.channel_id ?? person?.id ?? null, matches: [channel?.channel_id, person?.id].filter(Boolean) } };
    },
    'chat.create_draft'(args) {
      const draft = { target_id: args.target_id, thread_root_id: args.thread_root_id, body: words(args.body_intent), status: 'unsent' };
      store.chatDrafts.push(draft);
      return { ok: true, data: { draft } };
    },
    'drive.find'(args) {
      const attendee = words(args.attendee_id);
      const query = words(args.title_contains) || words(args.query);
      const files = driveFiles.filter(file => (!attendee || (file.attendee_ids ?? []).includes(attendee)) && searchable(`${file.title} ${words(file.body)}`, query));
      return { ok: true, data: { files } };
    },
    'drive.open'(args) {
      const file = driveFiles.find(row => row.id === args.file_id);
      return file ? { ok: true, data: { file } } : fail('not_found');
    },
    'lux.meetings'(args) {
      const attendee = words(args.attendee_id);
      const notes = transcripts.filter(entry => !attendee || (entry.attendee_ids ?? []).includes(attendee));
      return { ok: true, data: { notes, stubs } };
    },
    'lux.expand_stub'(args) {
      const stub = stubs.find(row => row.id === args.meeting_id);
      return stub ? { ok: true, data: { stub } } : fail('not_found');
    },
    'memory.save'(args) {
      const note = { text: words(args.text) };
      store.memory.push(note);
      return { ok: true, data: { saved: note } };
    },
    'memory.search'(args) {
      const query = words(args.query);
      const hits = store.memory.filter(note => searchable(words(note.text), query));
      return { ok: true, data: { notes: hits } };
    },
    'mongoose.company'(args) {
      const domain = words(args.domain);
      const company = companies.find(row => row.domain === domain) ?? companies[0];
      return company ? { ok: true, data: { company } } : fail('not_found');
    },
    'mongoose.data'(args) {
      const query = words(args.query);
      const rows = companies.filter(row => searchable(`${row.name} ${words(row.fact)}`, query));
      return { ok: true, data: { rows } };
    },
    'trello.create_card'(args) {
      const card = { list: args.li ?? args.list, title: args.title, body: args.body };
      store.cards.push(card as Record<string, unknown>);
      return { ok: true, data: { card } };
    },
    set_alarm(args) {
      const fireAt = Date.parse(words(args.fire_at));
      if (!Number.isSafeInteger(fireAt)) return fail('bad_fire_at');
      const label = typeof args.label === 'string' ? args.label : '';
      const alarm = alarms.set(fireAt, label, tz);
      const alias = `a${alarmIdByAlias.size + 1}`;
      alarmIdByAlias.set(alias, alarm.id);
      store.alarmsWritten++;
      return { ok: true, data: { alarm: { id: alias, fire_at: new Date(fireAt).toISOString(), label, status: 'scheduled' } } };
    },
    list_alarms() {
      const rows = alarms.list().map(alarm => ({ id: [...alarmIdByAlias].find(([, id]) => id === alarm.id)?.[0] ?? alarm.id, status: alarm.state === 'pending' ? 'scheduled' : alarm.state, fire_at_utc: alarm.fireAtUtc, label: alarm.label }));
      return { ok: true, data: { alarms: rows } };
    },
    cancel_alarm(args) {
      const id = alarmIdByAlias.get(words(args.alarm_id)) ?? words(args.alarm_id);
      return alarms.cancel(id) ? { ok: true, data: { cancelled: args.alarm_id } } : fail('not_found');
    },
    snooze_alarm(args) {
      const id = alarmIdByAlias.get(words(args.alarm_id)) ?? words(args.alarm_id);
      const minutes = Number(args.minutes ?? 5);
      const next = alarms.snooze(id, clock.now() + minutes * 60_000);
      return next ? { ok: true, data: { snoozed: args.alarm_id } } : fail('not_found');
    },
    stop_alarm(args) {
      const id = alarmIdByAlias.get(words(args.alarm_id)) ?? words(args.alarm_id);
      return alarms.acknowledge(id) ? { ok: true, data: { stopped: args.alarm_id } } : fail('not_found');
    },
    'reminders.create_or_update_series'(args) {
      store.alarmsWritten++;
      return { ok: true, data: { series: args } };
    },
    'reminders.list'() { return { ok: true, data: { series: [] } }; },
    'reminders.cancel_series'(args) { return { ok: true, data: { cancelled: args.series_id } }; },
    'reminders.skip_occurrence'(args) { return { ok: true, data: { skipped: args.series_id } }; },
  };

  return {
    seed, calls, t0, tz, offset, store, alarms,
    available,
    call(expectation: { tool: string; args?: Record<string, unknown> }) {
      const entry = resolveTool(toolMap, expectation.tool);
      const args = expectation.args ?? {};
      record(expectation.tool, entry, args);
      if (!available(expectation.tool)) return fail('capability_absent');
      const handler = handlers[expectation.tool];
      if (handler === undefined) throw new Error(`eval_tool_unfaked: ${expectation.tool} has no fake in the world`);
      return handler(args);
    },
    meetingAlias: id => meetingAliases.get(id),
    alarmAlias: id => [...alarmIdByAlias].find(([, real]) => real === id)?.[0],
    alarmIdFor: alias => alarmIdByAlias.get(alias) ?? (alarms.list().some(alarm => alarm.id === alias) ? alias : undefined),
  };
}

/** Calls one recorded expectation, keeping the caller honest about what the case asked for. */
export function callExpectation(world: FakeWorld, expectation: ToolExpectation): CallResult {
  return world.call({ tool: expectation.tool, args: expectation.args ?? {} });
}
