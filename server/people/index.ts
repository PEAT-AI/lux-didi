// W15: the owner's people roster. The file is `people.json` beside the active owner profile, synced
// there by the emissary's persona sync (wagon E1) and read once at host start as an immutable snapshot.
// This module owns the closed schema, the renderer, the deterministic resolver and the read-only
// lookup. No network source, no fuzzy or phonetic binding: roster membership is the only evidence.
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { ConfigError, parseJson, readPrivate, validateRoot } from '../config/files.js';

/** The instructions section's own ceiling; the total instruction still answers to LIVE_INSTRUCTION_HARD_LIMIT. */
export const PEOPLE_CHAR_LIMIT = 6_000;
/** A 130 person roster is about 40 KB; this bound is generous and still refuses an unrelated file. */
export const PEOPLE_FILE_MAX_BYTES = 262_144;
export const PEOPLE_HEADING = '# People';

export const PEOPLE_CIRCLES = Object.freeze(['plantix', 'helm', 'external', 'family', 'friend', 'project'] as const);
export type PeopleCircle = (typeof PEOPLE_CIRCLES)[number];

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly role: string;
  readonly circle: PeopleCircle;
  readonly project: string;
  readonly tier: 1 | 2;
  readonly email: readonly string[];
  readonly mattermost: string;
  readonly note: string;
}

export interface PeopleSnapshot {
  readonly version: 1;
  readonly people: readonly Person[];
  /** The utf8 bytes the file took, for the load receipt. */
  readonly bytes: number;
}

export type PeopleLoadResult =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'loaded'; readonly snapshot: PeopleSnapshot; readonly rendered: { readonly text: string; readonly dropped: number; readonly droppedTier2: number } };

export class PeopleError extends Error {
  constructor(readonly reason: string) {
    super(`people error: ${reason}`);
    this.name = 'PeopleError';
  }
}

const PERSON_KEYS = ['id', 'name', 'aliases', 'role', 'circle', 'project', 'tier', 'email', 'mattermost', 'note'] as const;
const REQUIRED_KEYS = ['id', 'name', 'aliases', 'role', 'circle', 'tier', 'email', 'mattermost'] as const;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const HANDLE = /^$|^[A-Za-z0-9._-]{1,64}$/u;
const ADDRESS = /^[^\s@]+@[^\s@]+$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function record(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PeopleError(reason);
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: readonly string[], reason: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new PeopleError(reason);
}

function required(value: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(value, key)) throw new PeopleError(`missing_${key}`);
  return value[key];
}

/** A bounded, printable, trimmed string; an untrimmed or control-bearing value is refused, not repaired. */
function plain(value: unknown, key: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || CONTROL.test(value) || value !== value.trim()) throw new PeopleError(`invalid_${key}`);
  if (value.length > max || (!allowEmpty && value.length === 0)) throw new PeopleError(`invalid_${key}`);
  return value;
}

function texts(value: unknown, key: string, max: number, most: number): readonly string[] {
  if (!Array.isArray(value) || value.length > most) throw new PeopleError(`invalid_${key}`);
  return Object.freeze(value.map(entry => plain(entry, key, max)));
}

function person(value: unknown, seen: Set<string>): Person {
  const raw = record(value, 'invalid_person');
  closed(raw, PERSON_KEYS, 'unknown_person_key');
  for (const key of REQUIRED_KEYS) required(raw, key);
  const id = plain(required(raw, 'id'), 'id', 64);
  if (!ID.test(id) || seen.has(id)) throw new PeopleError('duplicate_id');
  seen.add(id);
  const circle = required(raw, 'circle');
  if (typeof circle !== 'string' || !(PEOPLE_CIRCLES as readonly string[]).includes(circle)) throw new PeopleError('invalid_circle');
  const tier = required(raw, 'tier');
  if (tier !== 1 && tier !== 2) throw new PeopleError('invalid_tier');
  const email = texts(required(raw, 'email'), 'email', 120, 5);
  for (const address of email) if (!ADDRESS.test(address)) throw new PeopleError('invalid_email');
  return Object.freeze({
    id,
    name: plain(required(raw, 'name'), 'name', 80),
    aliases: texts(required(raw, 'aliases'), 'aliases', 60, 12),
    role: plain(required(raw, 'role'), 'role', 80),
    circle: circle as PeopleCircle,
    project: Object.hasOwn(raw, 'project') ? plain(raw['project'], 'project', 60, true) : '',
    tier,
    email,
    mattermost: handle(required(raw, 'mattermost')),
    note: Object.hasOwn(raw, 'note') ? plain(raw['note'], 'note', 80, true) : '',
  });
}

function handle(value: unknown): string {
  if (typeof value !== 'string' || !HANDLE.test(value)) throw new PeopleError('invalid_mattermost');
  return value;
}

/** Strict: unknown keys are refused and a malformed file yields nothing at all, never a partial roster. */
export function parsePeople(value: unknown): PeopleSnapshot {
  const root = record(value, 'invalid_root');
  closed(root, ['version', 'people'], 'unknown_root_key');
  if (root['version'] !== 1) throw new PeopleError('invalid_version');
  if (!Array.isArray(root['people'])) throw new PeopleError('invalid_people');
  const seen = new Set<string>();
  const people = Object.freeze(root['people'].map(entry => person(entry, seen)));
  return Object.freeze({ version: 1 as const, people, bytes: Buffer.byteLength(JSON.stringify(value), 'utf8') });
}

/** Case and accent folded, whitespace collapsed: the one comparison the resolver makes. */
export function foldName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** The exact keys a spoken form may bind on: the canonical name, every curated alias and every handle. */
function bindingKeys(person: Person): readonly string[] {
  const addresses = person.email.flatMap(address => [address, address.slice(0, address.indexOf('@'))]);
  return [person.name, ...person.aliases, person.mattermost, ...addresses].filter(key => key.length > 0).map(foldName);
}

export type PersonBinding =
  | { readonly kind: 'resolved'; readonly person: Person }
  | { readonly kind: 'ambiguous'; readonly people: readonly Person[] }
  | { readonly kind: 'unknown'; readonly name: string };

/** One spoken part to one roster answer. Never a fuzzy pick: two people sharing a key are a question. */
export function bindPerson(snapshot: PeopleSnapshot, spoken: string): PersonBinding {
  const key = foldName(spoken);
  if (key.length === 0) return { kind: 'unknown', name: spoken };
  const matched = snapshot.people.filter(person => bindingKeys(person).includes(key));
  if (matched.length === 0) return { kind: 'unknown', name: spoken };
  if (matched.length === 1) return { kind: 'resolved', person: matched[0]! };
  return { kind: 'ambiguous', people: Object.freeze(matched) };
}

/** The resolver's own phrase split: "and", commas and "with" separate spoken people, nothing else. */
export function splitSpoken(text: string): readonly string[] {
  return text.split(/\s+and\s+|\s*,\s*|\s+with\s+/iu).map(part => part.trim()).filter(part => part.length > 0);
}

export function resolveSpoken(snapshot: PeopleSnapshot, text: string): readonly PersonBinding[] {
  return Object.freeze(splitSpoken(text).map(part => bindPerson(snapshot, part)));
}

function renderPerson(person: Person): string {
  if (person.tier === 2) return `${person.name} - ${person.role}`;
  const parts = [person.name];
  if (person.aliases.length > 0) parts[0] = `${person.name} (${person.aliases.join(', ')})`;
  parts.push(person.role, person.project.length > 0 ? `${person.circle}/${person.project}` : person.circle);
  const locals = person.email.map(address => address.slice(0, address.indexOf('@')));
  if (locals.length > 0) parts.push(locals.join(', '));
  if (person.mattermost.length > 0) parts.push(`@${person.mattermost}`);
  return parts.join(' - ');
}

/**
 * Deterministic rendering in file order within the section ceiling. Tier 2 lines yield first, from the
 * end; the count is the receipt, and the total instruction still answers to the hard limit.
 */
export function renderPeople(snapshot: PeopleSnapshot, limit = PEOPLE_CHAR_LIMIT): { text: string; dropped: number; droppedTier2: number } {
  const lines = snapshot.people.map(person => ({ tier: person.tier, text: renderPerson(person) }));
  const text = (): string => [PEOPLE_HEADING, ...lines.map(line => line.text)].join('\n');
  let dropped = 0;
  let droppedTier2 = 0;
  while (text().length > limit && lines.length > 0) {
    let index = lines.length - 1;
    while (index >= 0 && lines[index]!.tier !== 2) index -= 1;
    if (index === -1) index = lines.length - 1; else droppedTier2 += 1;
    lines.splice(index, 1);
    dropped += 1;
  }
  return { text: text(), dropped, droppedTier2 };
}

/** The question an ambiguous spoken name earns: the roster's own names and roles, never a connector list. */
export function ambiguityQuestion(_spoken: string, people: readonly Person[]): string {
  return `${people.map(person => `${person.name} in ${person.role}`).join(' or ')}?`;
}

let current: { readonly snapshot: PeopleSnapshot; readonly section: string } | null = null;

/** The host installs the loaded roster once at start; nothing else replaces it during a run. */
export function installPeople(snapshot: PeopleSnapshot | null): void {
  const section = snapshot === null ? '' : renderPeople(snapshot).text;
  current = snapshot === null ? null : Object.freeze({ snapshot, section });
}

export function peopleSnapshot(): PeopleSnapshot | null { return current?.snapshot ?? null; }

/** The rendered section for the instructions, or undefined when no roster is installed. */
export function peopleSection(): string | undefined {
  const section = current?.section ?? '';
  return section.length > 0 ? section : undefined;
}

function bind(spoken: string): PersonBinding {
  const snapshot = current?.snapshot;
  return snapshot === undefined ? { kind: 'unknown', name: spoken } : bindPerson(snapshot, spoken);
}

/** The resolver answer for the installed roster, for a call site that holds no snapshot of its own. */
export function currentBinding(spoken: string): PersonBinding { return bind(spoken); }

/** The canonical roster name for a spoken form, when the roster resolves it exactly. */
export function canonicalName(spoken: string): string | undefined {
  const binding = bind(spoken);
  return binding.kind === 'resolved' ? binding.person.name : undefined;
}

export function lookupPeople(snapshot: PeopleSnapshot, spoken: string): readonly Person[] {
  const found = new Map<string, Person>();
  for (const binding of resolveSpoken(snapshot, spoken)) {
    if (binding.kind === 'resolved') found.set(binding.person.id, binding.person);
    if (binding.kind === 'ambiguous') for (const person of binding.people) found.set(person.id, person);
  }
  return Object.freeze([...found.values()]);
}

export function personByEmail(snapshot: PeopleSnapshot, address: string): Person | undefined {
  const key = foldName(address);
  return snapshot.people.find(person => person.email.some(candidate => foldName(candidate) === key));
}

/** The model-callable read: a name or alias in, the roster entries out. It never calls a connector. */
export const PEOPLE_LOOKUP_DECLARATION = {
  name: 'people_lookup',
  description: 'Look a person up in the owner people roster by name, first-name alias or handle. Returns the matching roster entries with role, circle and contact handles; nothing is read from any account.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 60, description: 'The spoken name, alias or handle.' } },
    required: ['name'],
    additionalProperties: false,
  },
} as const;

export interface PeopleLookupEntry {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly role: string;
  readonly circle: PeopleCircle;
  readonly project: string;
  readonly email: readonly string[];
  readonly mattermost: string;
  readonly note: string;
}

export function validatePeopleLookup(args: unknown): args is { name: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  return Object.keys(value).length === 1 && typeof value['name'] === 'string'
    && value['name'].length >= 1 && value['name'].length <= 60;
}

export function peopleLookupResult(args: unknown): { readonly people: readonly PeopleLookupEntry[]; readonly ambiguous: boolean } {
  const value = record(args, 'invalid_arguments');
  closed(value, ['name'], 'invalid_arguments');
  const name = plain(required(value, 'name'), 'name', 60);
  const snapshot = peopleSnapshot();
  const bindings = snapshot === null ? [] : resolveSpoken(snapshot, name);
  const entries = snapshot === null ? [] : lookupPeople(snapshot, name);
  return {
    // Two people the owner named are a pair, not an ambiguity; only a part the roster cannot split is.
    ambiguous: bindings.some(binding => binding.kind === 'ambiguous'),
    people: Object.freeze(entries.map(person => Object.freeze({
      id: person.id, name: person.name, aliases: person.aliases, role: person.role, circle: person.circle,
      project: person.project, email: person.email, mattermost: person.mattermost, note: person.note,
    }))),
  };
}

/**
 * Read `people.json` beside the owner profile, reusing the profile's own directory resolution and its
 * private-file rules. Absent is not an error; a malformed file is, and it yields no roster at all.
 */
export function loadPeople(profilePath: string): PeopleLoadResult {
  const dir = dirname(profilePath);
  try {
    if (!validateRoot(dir)) return { status: 'invalid', reason: 'directory_untrusted' };
    const raw = readPrivate(join(dir, 'people.json'), PEOPLE_FILE_MAX_BYTES);
    let parsed: unknown;
    try { parsed = parseJson(raw); } catch (error) {
      return { status: 'invalid', reason: error instanceof ConfigError ? error.code : 'invalid_json' };
    }
    const snapshot = parsePeople(parsed);
    const rendered = renderPeople(snapshot);
    return { status: 'loaded', snapshot, rendered };
  } catch (error) {
    if (error instanceof PeopleError) return { status: 'invalid', reason: error.reason };
    if (error instanceof ConfigError) return error.code === 'file_missing' ? { status: 'absent' } : { status: 'invalid', reason: error.code };
    return { status: 'invalid', reason: 'io_error' };
  }
}
