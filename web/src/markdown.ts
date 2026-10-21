import type { ChatStep } from './tool-phrases.ts';
import { connectorProse, stepFinished, stepRunning, stepsSummary, toolConnector } from './tool-phrases.ts';
import type { ToolEvidence } from './protocol.ts';

// Minimal, dependency-free Markdown to safe HTML. Every model-supplied string is
// escaped; only http: and https: links become anchors. No raw HTML passes through.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPES[character]!);
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Stored feed text can arrive HTML-encoded (an older build wrote it that way). Decoding here, before
 * escaping, means the owner reads the words and never the entity names (UI3b). One pass only: a decoded
 * ampersand is never re-read as the start of another entity. */
export function decodeEntities(value: string): string {
  return String(value ?? '').replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (whole, dec: string, hex: string, name: string) => {
    if (dec || hex) {
      const code = dec ? Number(dec) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const FENCE = /^```/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const ORDERED_START = /^\s*(\d+)[.)]\s+/;
/** An indented continuation line of the list item above it (V3 item 9). */
const CONTINUATION = /^\s{1,3}\S/;
const QUOTE = /^\s*>\s?/;

/** Options that keep a bubble's own title above its body text and turn raw links into chips. */
export interface MarkdownOptions {
  /** The bubble's top heading level: a markdown H1/H2 maps here so a bubble never grows an H1/H2. */
  headingBase?: number;
  /** Render a bare http(s) URL as a named chip instead of leaving it as plain text. */
  linkify?: boolean;
}
/** The Live answer card and the Chat answer bubble render model text through this one renderer. */
export const TRANSCRIPT_MARKDOWN: MarkdownOptions = { headingBase: 3, linkify: true };

const BARE_URL = /https?:\/\/[^\s<>"']+/g;
/** The U1 source-chip label for a bare url: its host with www stripped, then its first path part. */
function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const segment = parsed.pathname.split('/').find(Boolean);
    return segment ? `${host}/${segment}` : host;
  } catch { return url; }
}

/** Inline spans over already HTML-escaped text. Held spans are restored last so
 * emphasis never re-parses code or link markup. */
function inline(raw: string, options: MarkdownOptions = {}): string {
  const held: string[] = [];
  const hold = (html: string) => { held.push(html); return `\u0000${held.length - 1}\u0000`; };
  let text = escapeHtml(raw);
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => hold(`<code>${code}</code>`));
  text = text.replace(LINK, (match, label: string, href: string) => {
    if (!/^https?:\/\//i.test(href)) return match;
    return hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  if (options.linkify) text = text.replace(BARE_URL, url => hold(`<a class="answer-source" href="${url}" target="_blank" rel="noopener noreferrer">${urlLabel(url)}</a>`));
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => held[Number(index)]!);
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') { index++; continue; }
    if (FENCE.test(line)) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !FENCE.test(lines[index]!)) { body.push(lines[index]!); index++; }
      if (index < lines.length) index++;
      blocks.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) { const level = Math.min(3, Math.max(options.headingBase ?? 1, heading[1]!.length)); blocks.push(`<h${level}>${inline(heading[2]!, options)}</h${level}>`); index++; continue; }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const marker = ordered ? ORDERED : BULLET;
      const start = ordered ? Number(ORDERED_START.exec(line)![1]) : 1;
      const items: string[] = [];
      while (index < lines.length && marker.test(lines[index]!)) {
        const parts = [`<li>${inline(lines[index]!.replace(marker, ''), options)}`];
        index++;
        // A blank line plus an indented paragraph stays in the item, so the paragraph aligns with the
        // item text and the numbering never restarts (V3 items 7 and 9).
        for (;;) {
          const save = index;
          while (index < lines.length && lines[index]!.trim() === '') index++;
          if (index >= lines.length || !CONTINUATION.test(lines[index]!)) { index = save; break; }
          const paragraph: string[] = [];
          while (index < lines.length && lines[index]!.trim() !== '' && CONTINUATION.test(lines[index]!)) { paragraph.push(inline(lines[index]!.replace(/^\s{1,3}/, ''), options)); index++; }
          parts.push(`<p>${paragraph.join('<br>')}</p>`);
        }
        while (index < lines.length && lines[index]!.trim() === '') index++;
        parts.push('</li>');
        items.push(parts.join(''));
      }
      blocks.push(`<${ordered ? 'ol' : 'ul'}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) { quoted.push(inline(lines[index]!.replace(QUOTE, ''), options)); index++; }
      blocks.push(`<blockquote>${quoted.join('<br>')}</blockquote>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== '' && !FENCE.test(lines[index]!) && !HEADING.test(lines[index]!) && !BULLET.test(lines[index]!) && !ORDERED.test(lines[index]!) && !QUOTE.test(lines[index]!)) { paragraph.push(inline(lines[index]!, options)); index++; }
    blocks.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return blocks.join('\n');
}

/** Chat consumes only bounded accepted projections, never connector HTML or provider parts. */
/** A saved or latest answer body: markdown inside a div, because a p cannot hold block elements. */
export function answerMarkup(text: string): string {
  return `<div class="markdown">${renderMarkdown(text, TRANSCRIPT_MARKDOWN)}</div>`;
}

/** A friendly, owner-facing connector name; an unknown tool returns '' so its card shows no name. */
const TOOL_LABELS: readonly [RegExp, string][] = [
  [/^gmail_/, 'Gmail'],
  [/^(gcal_|calendar_)/, 'Calendar'],
  [/^mattermost_/, 'Mattermost'],
  [/^(search_knowledge|get_insight|knowledge_|lux_)/, 'Knowledge'],
  [/^mongoose/, 'Mongoose'],
];
export function toolLabel(name: string): string {
  for (const [pattern, label] of TOOL_LABELS) if (pattern.test(name)) return label;
  return '';
}

/** One compact 'Sources' line of named links separated by a middle dot, never bullets or boxes. */
export function sourcesFooter(sources: readonly { title: string; url?: string }[]): string {
  const items = sources.slice(0, 8).map(source => {
    const label = escapeHtml(source.title.slice(0, 256));
    const url = source.url?.slice(0, 2048);
    return url && /^https?:\/\//i.test(url)
      ? `<a class="answer-source" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<span class="answer-source">${label}</span>`;
  });
  if (!items.length) return '';
  return `<div class="sources answer-sources"><span class="answer-sources-label">Sources</span> <span class="answer-sources-list">${items.join('<span class="answer-sources-sep"> · </span>')}</span></div>`;
}

/** Chat consumes only bounded accepted projections, never connector HTML or provider parts. */
export function chatEntryMarkup(role: 'user' | 'assistant', text: string): string {
  return role === 'assistant'
    ? `<article class="entry assistant">${answerMarkup(text)}</article>`
    : `<article class="entry user"><p class="bubble">${escapeHtml(text)}</p></article>`;
}

/** Mirrors server/tools/live-shape.ts stripModelOnlyNotes: the model-only bracket annotations
 * (`[omitted: ...]`, `[+N chars]`, `[id ...]`) must never reach the owner, including from evidence
 * persisted before the server-side strip. Kept local so the web bundle carries no server import. */
const MODEL_ONLY_NOTE = /[ \t]*\n*\[(?:omitted: [^\]\n]*|\+\d+ chars|id [^\]\s]*)\]/g;

/** The source label for one piece of evidence: an owner-facing connector name, never a tool id. */
function sourceLabel(name: string): string { return toolLabel(name) || toolConnector(name); }

const ITEM_START = /^(?:[-*]\s|#{1,6}\s|\*\*)/;
const OMITTED_LINE = /^\[(?:omitted:|[+-]\d+ chars)/;
const RAW_ID = /\[(?:id|post) [^\]\s]*\]/g;
// Emphasis only: `*` and backticks. An underscore is prose here (channel, branch and note names).
const EMPHASIS = /[*`]{1,2}/g;
const SNIPPET_CHARS = 120;

/** One evidence row: the one-line shape the owner reads, its optional snippet, and its sort stamp. */
export interface EvidenceRow { line: string; snippet: string; at: number }

function clipWords(text: string): string {
  const plain = String(text ?? '').replace(EMPHASIS, '').replace(/\s+/g, ' ').trim();
  return plain.length > SNIPPET_CHARS ? `${plain.slice(0, SNIPPET_CHARS).trimEnd()}...` : plain;
}

/** The fields of one shaped line, with the bullet, the emphasis and every raw id removed. */
function fields(line: string): string[] {
  return line.replace(/^[-*#]+\s*/, '').replace(EMPHASIS, '').replace(RAW_ID, '').replace(/\s+/g, ' ').trim()
    .split(/\s+\|\s+/).map(field => field.trim()).filter(Boolean);
}

/** Item blocks of shaped tool markdown: a bullet or a bold heading starts one, a following plain line is
 * its snippet. The model-only omission notes are dropped, never shown. */
function blocksOf(markdown: string): { fields: string[]; snippet: string }[] {
  const blocks: { fields: string[]; snippet: string }[] = [];
  for (const raw of String(markdown ?? '').replace(MODEL_ONLY_NOTE, '').split('\n')) {
    const line = raw.trim();
    if (!line || OMITTED_LINE.test(line)) continue;
    if (ITEM_START.test(line) || !blocks.length) { blocks.push({ fields: fields(line), snippet: '' }); continue; }
    const last = blocks[blocks.length - 1]!;
    last.snippet = `${last.snippet} ${line}`.trim();
  }
  return blocks.slice(0, 12);
}

/** Epoch ms for a shaped stamp: ISO, epoch ms or epoch seconds. 0 when the source carries no usable time. */
function stampOf(raw: string): number {
  const value = String(raw ?? '').replace(/^date:\s*/i, '').trim();
  if (!value) return 0;
  if (/^\d{10,13}$/.test(value)) { const epoch = Number(value); return epoch < 1e12 ? epoch * 1000 : epoch; }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const MONTH_DAY = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' });
const CLOCK = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false });
const DAY_AND_CLOCK = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** A stamp as relative words. An unusable stamp renders nothing, so no ISO string reaches the owner. */
export function relativeWords(raw: string, now = Date.now()): string {
  const at = stampOf(raw);
  if (!at) return '';
  const seconds = Math.round((now - at) / 1000), ahead = seconds < 0, size = Math.abs(seconds);
  if (size < 90) return ahead ? 'in a moment' : 'just now';
  const minutes = Math.round(size / 60);
  if (minutes < 60) return ahead ? `in ${minutes} min` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ahead ? `in ${hours} h` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return ahead ? 'tomorrow' : 'yesterday';
  if (days < 30) return ahead ? `in ${days} days` : `${days} days ago`;
  return MONTH_DAY.format(at);
}

function midnight(value: number): number { const day = new Date(value); day.setHours(0, 0, 0, 0); return day.getTime(); }

/** A calendar start as the owner reads it: "10:00" today, "tomorrow 10:00", else "Tue 3 Nov, 10:00". */
export function eventWords(raw: string, now = Date.now()): string {
  const at = stampOf(raw);
  if (!at) return '';
  const offset = Math.round((midnight(at) - midnight(now)) / 86_400_000);
  if (offset === 0) return CLOCK.format(at);
  if (offset === 1) return `tomorrow ${CLOCK.format(at)}`;
  if (offset === -1) return `yesterday ${CLOCK.format(at)}`;
  return DAY_AND_CLOCK.format(at).replace(',', '');
}

/** One block of shaped tool output as the shape its source deserves. No raw id, no ISO stamp, ever. */
export function evidenceRow(tool: ToolEvidence, block: { fields: string[]; snippet: string }, now = Date.now()): EvidenceRow {
  const parts = block.fields;
  const snippet = clipWords(block.snippet);
  if (/^mattermost_/.test(tool.name)) {
    const stamp = parts[2] ?? '';
    return { line: [parts[0], parts[1], relativeWords(stamp, now)].filter(Boolean).join(' · '), snippet: snippet || clipWords(parts[3] ?? ''), at: stampOf(stamp) };
  }
  if (/^gmail_/.test(tool.name)) {
    // The shaper omits a field the source lacks, so a role is recognised by its own prefix and a field it
    // does not carry is dropped, never shifted into the sender slot (F2).
    const fromIndex = parts.findIndex((part, index) => index > 0 && /^from:/i.test(part));
    const dateIndex = parts.findIndex((part, index) => index > 0 && /^date:/i.test(part));
    // A hit with no From still renders its sender slot, in words (K4-R2), never a stamp in its place.
    const sender = fromIndex > 0 ? parts[fromIndex]!.replace(/^from:\s*/i, '') : 'unknown sender';
    const stamp = dateIndex > 0 ? parts[dateIndex]!.replace(/^date:\s*/i, '') : '';
    const leftover = parts.filter((_part, index) => index !== 0 && index !== fromIndex && index !== dateIndex);
    return { line: [sender, parts[0], relativeWords(stamp, now)].filter(Boolean).join(' · '), snippet: clipWords(leftover.join(' ')) || snippet, at: stampOf(stamp) };
  }
  // The app's own calendar tool is `calendar_list_events`; `gcal_` is the older name, kept for
  // the answers already stored. Without both, a calendar row fell through to the raw line.
  if (/^(gcal_|calendar_)/.test(tool.name)) {
    const pieces = (parts[0] ?? '').split(',').map(piece => piece.trim());
    return { line: [eventWords(pieces[0] ?? '', now), pieces[1]].filter(Boolean).join(' · '), snippet: clipWords(pieces.slice(2).join(', ')) || snippet, at: stampOf(pieces[0] ?? '') };
  }
  // Knowledge and Mongoose: the heading reads "title (type | date)".
  const flat = parts.join(' | ');
  const kind = /\(([^)]*)\)/.exec(flat)?.[1]?.trim() ?? '';
  return { line: [clipWords(flat.replace(/\s*\([^)]*\)/, '')), clipWords(kind.split(' | ')[0] ?? '')].filter(Boolean).join(' · '), snippet, at: stampOf(kind.split(' | ')[1] ?? '') };
}

/** Evidence: per source, a compact list of the items the answer used, folded under the answer. Raw shaped
 * tool output is never rendered here and never as the answer body (target turn, items 3 and 4). */
export function evidenceMarkup(evidence: readonly ToolEvidence[], now = Date.now()): string {
  const groups = new Map<string, EvidenceRow[]>();
  for (const tool of evidence.slice(0, 8)) {
    const rows = blocksOf(tool.markdown).map(block => evidenceRow(tool, block, now)).filter(row => row.line);
    rows.sort((left, right) => right.at - left.at);
    const label = sourceLabel(tool.name);
    groups.set(label, (groups.get(label) ?? []).concat(rows));
  }
  const sections: string[] = [];
  for (const [label, rows] of groups) {
    const kept = rows.sort((left, right) => right.at - left.at).slice(0, 6);
    if (!kept.length) continue;
    const items = kept.map(row => `<li class="chat-evidence-item"><span class="chat-evidence-line">${escapeHtml(row.line)}</span>${row.snippet ? `<span class="chat-evidence-snippet">${escapeHtml(row.snippet)}</span>` : ''}</li>`).join('');
    sections.push(`<section class="chat-evidence-source"><h4>${escapeHtml(label)}</h4><ul>${items}</ul></section>`);
  }
  if (!sections.length) return '';
  return `<details class="chat-evidence"><summary>Evidence</summary>${sections.join('')}</details>`;
}

/** The one deduped row of source chips for an answer, capped at three plus "+N" (target turn, item 5). */
export function sourcesMarkup(evidence: readonly ToolEvidence[], cap = 3): string {
  const seen = new Set<string>();
  const all: { title: string; url?: string }[] = [];
  for (const tool of evidence) for (const source of tool.sources ?? []) {
    const key = (source.url || source.title || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key); all.push(source);
  }
  if (!all.length) return '';
  const chips = all.slice(0, cap).map(source => {
    const label = escapeHtml((source.title || source.url || '').slice(0, 96));
    const url = source.url?.slice(0, 2048);
    return url && /^https?:\/\//i.test(url)
      ? `<a class="answer-source" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<span class="answer-source">${label}</span>`;
  });
  const rest = all.length - chips.length;
  return `<div class="chat-sources"><span class="chat-sources-label">Sources</span>${chips.join('')}${rest > 0 ? `<span class="chat-sources-more">+${rest}</span>` : ''}</div>`;
}

/** While a run works: one quiet line per tool. Once the answer lands the same lines fold into a single
 * summary line that expands to the per-tool lines (target turn, item 2). */
export function stepsMarkup(steps: readonly ChatStep[], collapsed: boolean): string {
  if (!steps.length) return '';
  const lines = steps.map(step => {
    const phase = step.phase === 'end' ? 'end' : 'start';
    const text = phase === 'end' ? stepFinished(step) : stepRunning(step);
    return `<li class="chat-step" data-phase="${phase}">${escapeHtml(text)}</li>`;
  }).join('');
  if (!collapsed) return `<ol class="chat-steps" role="status" aria-label="What Naya is doing">${lines}</ol>`;
  const summary = stepsSummary(steps);
  if (!summary) return '';
  return `<details class="chat-steps-done"><summary>${escapeHtml(summary)}</summary><ol class="chat-steps">${lines}</ol></details>`;
}

/** Plain copy for a partial or timed-out turn, naming the sources that did not answer. */
export function partialWords(pending: readonly string[]): string {
  const names = [...new Set(pending.map(connectorProse))];
  if (!names.length) return 'I ran out of time before finishing. Here is what I found.';
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `I ran out of time before checking ${list}. Here is what I found.`;
}

/** The honest state for a run that finished with no answer: never the raw evidence as the body. */
export const NO_ANSWER_WORDS = 'Naya did not save an answer for this turn. Ask again to get one.';


/** Plain words for a failed run: what happened, and what the owner can do next. The raw outcome
 * code and the old "No saved answer: outcome_unknown" filler never reach the panel (M1). */
export function runFailureWords(outcome: string | null, mayHaveBeenSent: boolean): string {
  const detail: Record<string, string> = {
    outcome_unknown: 'The app was interrupted before it could save an answer. Ask again to get a fresh answer.',
    not_dispatched: 'The request never reached the model. Ask again.',
    unavailable: 'The model is not available right now. Check the service, then ask again.',
    input_too_large: 'Your message is too long for the model. Shorten it and ask again.',
    compile_failed: 'The app could not build the request. Ask again; if it repeats, check the service log.',
    persistence_failed: 'The answer could not be saved. Ask again.',
    denied: 'The model declined the request. Rephrase and ask again.',
    blocked: 'The request was blocked. Rephrase and ask again.',
    error: 'The model failed. Ask again.',
    empty: 'The model returned no answer. Ask again.',
    truncated: 'The answer was cut short. Ask for a shorter answer, or ask again.',
    cancelled: 'You cancelled this request. Ask again when ready.',
    deadline: 'The model ran out of time. Ask again.',
  };
  const base = detail[outcome ?? ''] ?? 'The run did not finish. Ask again.';
  return mayHaveBeenSent ? `${base} Content may have been sent before it stopped.` : base;
}
