import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * New public neutral Naya base shipped in the repository. It is Architect-authored
 * companion content, not a private persona clone: no biography, no model specifics,
 * no recon or farmer prompt text.
 */
export const NAYA_BASE = `# Naya

Naya is the owner's personal voice companion: warm, direct and a little witty. Naya speaks briefly, usually one to three sentences, and lets a written answer carry the detail.

Naya is honest about work. When a tool is running, Naya says so in a few words; when it returns, Naya reports what actually came back and never invents a result. Naya asks at most one short clarifying question before acting.

Naya stays in spoken register, uses plain words, and never reads out long lists, code or URLs unless asked. If a request is unclear, or beyond what Naya can do, Naya says so plainly instead of guessing.

Naya does not describe a training history, a maker or any biography; Naya is simply this owner's companion.`;

/**
 * Architect-authored tool-conduct section, added verbatim when a session declares at least one tool.
 * It is generic: it names tool families, never a schema or a connector.
 */
export const NAYA_TOOLS = `# Tools

Naya can use tools in this conversation. The owner's knowledge base is the first stop for anything about the owner's notes, decisions, projects or past work: search it before answering from memory, and answer from what it returned. Calendar tools answer what is on the schedule; mail tools answer what someone sent; company tools answer company questions; team-chat tools answer questions about the team's conversations.

When a question needs a tool, say in a few words that Naya is looking, then call it; do not narrate the call itself. Pass the user's own words as the query. Call one tool at a time unless two are independent. When results arrive, answer from them in one to three spoken sentences; the written answer on screen carries the detail and the sources. If a tool returns nothing, an error or a refusal, say so plainly and offer what Naya can still do. If a tool was deferred because the work takes longer, tell the owner Naya will call back when it is done, then carry on with the conversation.

Never invent a tool result, a source or a date.`;

const maxOverlayBytes = 16 * 1024;
const maxOptionalBytes = 4096;
const budgetChars = 60_000;
const separator = '\n\n';
const overlayKeys = ['schemaVersion', 'text', 'greeting', 'accent'];

export type PersonaOverlayErrorCode = 'invalid_overlay' | 'overlay_too_large';

/** Typed local-overlay failure; surfaced by the Live loader, never a silent base fallback. */
export class PersonaOverlayError extends Error {
  constructor(readonly code: PersonaOverlayErrorCode) {
    super(`Persona overlay error: ${code}`);
    this.name = 'PersonaOverlayError';
  }
}

/** The local private layer: owner-authored persona text, an optional greeting and an optional accent. */
export interface PersonaOverlay {
  readonly schemaVersion: 1;
  readonly text: string;
  readonly greeting?: string;
  readonly accent?: string;
}

export interface ComposedSection {
  readonly id: 'base' | 'tools' | 'overlay' | 'voice';
  readonly chars: number;
  readonly sha256: string;
}

export interface ComposedLiveInstruction {
  readonly text: string;
  readonly sha256: string;
  readonly sections: readonly ComposedSection[];
}

export interface ComposeLiveInstructionInput {
  readonly base: string;
  readonly overlay?: PersonaOverlay;
  readonly language?: string;
  readonly tools?: readonly string[];
}

function bytes(text: string): number { return Buffer.byteLength(text, 'utf8'); }
function digest(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

function optionalText(source: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (typeof value !== 'string' || !value.length || bytes(value) > maxOptionalBytes) throw new PersonaOverlayError('invalid_overlay');
  return value;
}

/** Strict closed overlay record. Unknown keys, wrong versions and empty text fail closed. */
export function validatePersonaOverlay(raw: unknown): PersonaOverlay {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PersonaOverlayError('invalid_overlay');
  const source = raw as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length < 2 || keys.some(key => !overlayKeys.includes(key))) throw new PersonaOverlayError('invalid_overlay');
  if (source['schemaVersion'] !== 1) throw new PersonaOverlayError('invalid_overlay');
  const text = source['text'];
  if (typeof text !== 'string' || !text.length) throw new PersonaOverlayError('invalid_overlay');
  if (bytes(text) > maxOverlayBytes) throw new PersonaOverlayError('overlay_too_large');
  const greeting = optionalText(source, 'greeting');
  const accent = optionalText(source, 'accent');
  return Object.freeze({
    schemaVersion: 1, text,
    ...(greeting !== undefined ? { greeting } : {}),
    ...(accent !== undefined ? { accent } : {}),
  });
}

/**
 * Read the optional local overlay. A missing file is no overlay; a present but
 * unreadable, oversized or malformed file is a typed error.
 */
export function loadPersonaOverlay(options: { dataDir: string }): PersonaOverlay | undefined {
  const path = join(options.dataDir, 'persona-overlay.json');
  let initial;
  try { initial = lstatSync(path); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return undefined; throw new PersonaOverlayError('invalid_overlay'); }
  if (initial.isSymbolicLink() || !initial.isFile()) throw new PersonaOverlayError('invalid_overlay');
  if (initial.size > maxOverlayBytes) throw new PersonaOverlayError('overlay_too_large');
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new PersonaOverlayError('invalid_overlay'); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new PersonaOverlayError('invalid_overlay'); }
  return validatePersonaOverlay(raw);
}

/**
 * Bare ISO 639-1 lower-case primary subtag for speechConfig.languageCode, or undefined
 * when the tag is absent or not a two-letter language. The adapter pins `ar` -> `ar-XA`.
 */
export function canonicalSpeechLanguage(language: string | undefined): string | undefined {
  if (typeof language !== 'string') return undefined;
  const primary = language.split('-')[0] ?? '';
  return /^[A-Za-z]{2}$/.test(primary) ? primary.toLowerCase() : undefined;
}

function displayLanguage(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code; }
  catch { return code; }
}

function voiceAnchor(language: string | undefined, accent: string | undefined): string {
  const languageLine = language === undefined
    ? 'LANGUAGE: Speak in the language the user uses.'
    : `LANGUAGE: Speak and answer in ${displayLanguage(language)} by default.`;
  const accentLine = `ACCENT: ${accent ?? 'Speak with a clear, natural voice.'}`;
  const follows = "LANGUAGE FOLLOWS THE USER: the user's own voice outranks any setting; answer in whatever language they actually speak, and keep doing so.";
  const final = 'FINAL ANCHOR: these language and voice instructions hold for the whole session; begin speaking now in the voice and accent defined for Naya.';
  return [languageLine, accentLine, follows, final].join(separator);
}

function overlaySection(overlay: PersonaOverlay): string {
  return [overlay.text, ...(overlay.greeting !== undefined ? [overlay.greeting] : [])].join(separator);
}

function assemble(parts: readonly string[]): string { return parts.join(separator); }

/**
 * Compose the Live system instruction: public base, the optional local overlay (verbatim), the
 * optional tool conduct, then the terminal LANGUAGE AND VOICE anchor. Empty sections are stripped,
 * survivors join with one blank line, and the 60k budget yields the overlay first, then the tools
 * section. The base and the voice anchor never yield. No memory or history enters this unit.
 */
export function composeLiveInstruction(input: ComposeLiveInstructionInput): ComposedLiveInstruction {
  if (!input || typeof input.base !== 'string' || !input.base.length) throw new PersonaOverlayError('invalid_overlay');
  const base = input.base;
  const voice = voiceAnchor(input.language, input.overlay?.accent);
  const overlayText = input.overlay !== undefined ? overlaySection(input.overlay) : undefined;
  const toolsText = input.tools !== undefined && input.tools.length ? NAYA_TOOLS : undefined;

  type Entry = { id: ComposedSection['id']; text: string };
  const select = (overlay: string | undefined, tools: string | undefined): Entry[] => {
    const entries: Entry[] = [{ id: 'base', text: base }];
    if (tools !== undefined) entries.push({ id: 'tools', text: tools });
    if (overlay !== undefined) entries.push({ id: 'overlay', text: overlay });
    entries.push({ id: 'voice', text: voice });
    return entries;
  };
  const fits = (entries: Entry[]): boolean => assemble(entries.map(entry => entry.text)).length <= budgetChars;

  let overlay = overlayText;
  let tools = toolsText;
  if (!fits(select(overlay, tools))) {
    if (overlay !== undefined) {
      const others = [base, ...(tools !== undefined ? [tools] : []), voice];
      const remaining = budgetChars - assemble(others).length - separator.length;
      overlay = remaining <= 0 ? undefined : overlay.slice(0, remaining).replace(/\s+$/, '');
    }
    if (!fits(select(overlay, tools))) tools = undefined;
  }
  const entries = select(overlay, tools);
  const text = assemble(entries.map(entry => entry.text));
  const sections = entries.map(entry => Object.freeze({ id: entry.id, chars: entry.text.length, sha256: digest(entry.text) }));
  return Object.freeze({ text, sha256: digest(text), sections: Object.freeze(sections) });
}

/**
 * Insert the tool conduct into an already-composed Live instruction: right after the public base when
 * the text is the Naya composition, otherwise after the whole text. With no declarations the input is
 * returned byte-identical, so a session without tools composes exactly as before.
 */
export function withToolsSection(text: string, tools: readonly string[]): string {
  if (!tools.length) return text;
  const base = `${NAYA_BASE}${separator}`;
  return text.startsWith(base)
    ? `${base}${NAYA_TOOLS}${separator}${text.slice(base.length)}`
    : `${text}${separator}${NAYA_TOOLS}`;
}
