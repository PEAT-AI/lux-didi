import type { Delivery, RevisionIdentity, Said } from './controller.js';
import type { WorkerResult } from './worker.js';
/** Acceptance confirms timeline receipt, not wording or audibility. */
export type DeliveryState = 'sent' | 'accepted' | 'retry' | 'undelivered';
/** A sequence id correlates only envelope parts, never a task or delivery identity. */
let envelopeSequence = 0;
export type CommentaryKind = 'result' | 'partial' | 'no_action' | 'failure';
export interface Commentary {
  kind: CommentaryKind; exact: string[]; content: string; cause: string; what_failed: string; next_step: string;
}
export type CommentaryAnswer = WorkerResult & {
  exact?: string[];
  failure?: { stage: string; reason_code: string; detail: string };
};
export function commentaryEnvelope(value: object): string {
  return '```COMMENTARY\n' + JSON.stringify(value) + '\n```';
}
/** Recall is preferred: every match is a verbatim slice, never a normalized value. */
export function extractExact(content: string): string[] {
  const patterns = [
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu,
    /(?:[A-Z]{3}|[$€£])\s?\d[\d,.]*(?:\s?(?:million|billion|thousand))?/gu,
    /\b\d[\d,.]*\s?(?:%|kg|km|cm|mm|m|g|mg|ml|litres?|hours?|minutes?|seconds?|USD|EUR|GBP)\b/gu,
    /\b\d{1,2}:\d{2}(?:\s?(?:AM|PM|CET|CEST|UTC|GMT))?\b/gu,
    /\b\d{4}-\d{2}-\d{2}\b/gu,
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s?\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})?/gu,
    /\b[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)+/gu,
    /\b\d[\d,.]*\b/gu,
  ];
  return [...new Set(patterns.flatMap(pattern => [...content.matchAll(pattern)].map(match => match[0].trim())))];
}
const failureFacts: Record<string, { what_failed: string; next_step: string }> = {
  deadline: { what_failed: 'the helper did not answer within the time allowed', next_step: 'ask again' },
  provider_rejected: { what_failed: "the provider refused the helper's request", next_step: 'nothing to retry until the request is fixed' },
  provider_auth: { what_failed: "the helper's sign-in is not valid", next_step: 'sign in again in the app' },
  credential_unavailable: { what_failed: "the helper's sign-in is not valid", next_step: 'sign in again in the app' },
  provider_rate_limited: { what_failed: 'the provider is rate limiting', next_step: 'ask again in a moment' },
  provider_unavailable: { what_failed: 'the provider could not be reached', next_step: 'ask again' },
  provider_incomplete: { what_failed: 'the provider returned no usable answer', next_step: 'ask again' },
  provider_empty: { what_failed: 'the provider returned no usable answer', next_step: 'ask again' },
};
export function resultCommentary(answer: CommentaryAnswer): Commentary {
  const noAction = !answer.failure && (answer.status === 'no_action' || !answer.text.trim());
  const failed = answer.findings.find(finding => finding.status === 'failed');
  const failure = answer.failure;
  const facts = failure && Object.hasOwn(failureFacts, failure.reason_code) ? failureFacts[failure.reason_code] : undefined;
  // Some verified work and one failure is a mixed account: neither a total failure nor a plain result.
  const mixed = answer.findings.some(finding => finding.status !== 'failed') && (failure !== undefined || (answer.failures?.length ?? 0) > 0);
  return {
    kind: answer.failure ? (mixed ? 'partial' : 'failure') : noAction ? 'no_action' : mixed || answer.status === 'incomplete' ? 'partial' : 'result',
    exact: noAction ? [] : answer.exact ?? extractExact(answer.text),
    content: noAction ? '' : answer.text,
    cause: noAction ? '' : failure?.reason_code ?? answer.failures?.[0]?.reason_code ?? failed?.reason_code ?? '',
    what_failed: noAction ? '' : failure ? facts?.what_failed ?? "the helper's model request" : answer.failures?.[0]?.tool ?? '',
    next_step: noAction ? '' : failed?.repair || facts?.next_step || '',
  };
}
export interface DeliveryPorts {
  isCurrent(identity: RevisionIdentity): boolean;
  append(delegationId: string | null, text: string): string | undefined;
  state(identity: RevisionIdentity, state: DeliveryState, chunk: number): void;
}
/** Split only outside exact entities; prefer complete sentences, then words for overlong sentences. */
export function splitSpokenText(text: string, limit = 450, exact: readonly string[] = []): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest) {
    if (rest.length <= limit) { chunks.push(rest); break; }
    const protectedRanges = exact.flatMap(entity => {
      if (!entity) return [];
      const ranges: [number, number][] = [];
      let start = rest.indexOf(entity);
      while (start >= 0) { ranges.push([start, start + entity.length]); start = rest.indexOf(entity, start + entity.length); }
      return ranges;
    });
    const safe = (position: number) => !protectedRanges.some(([start, end]) => start < position && position < end);
    let end = 0;
    for (const match of rest.matchAll(/(?<=[.!?])\s+|\n\s*\n/gu)) if (match.index <= limit && safe(match.index)) end = match.index;
    if (!end) for (const match of rest.matchAll(/\s+/gu)) if (match.index <= limit && safe(match.index)) end = match.index;
    if (!end) throw new RangeError('commentary entity exceeds transport capacity');
    chunks.push(rest.slice(0, end)); rest = rest.slice(end).trimStart();
  }
  return chunks;
}
/** Every wire item is independently fenced JSON and remains within the real adapter limit. */
export function commentaryItems(commentary: Commentary, id = (++envelopeSequence).toString(36)): string[] {
  type Part = Partial<Commentary> & { section: 'header' | 'content' };
  const parts: Part[] = [];
  // Reserve ten-digit part counters and the longer false marker before partitioning.
  const wire = (part: Part, index = 9999999999, total = 9999999999) => commentaryEnvelope({ id, part: `${index}/${total}`, final: false, ...part });
  const fits = (part: Part) => wire(part).length <= 450;
  try {
    const header: Part = { section: 'header', kind: commentary.kind, cause: commentary.cause, what_failed: commentary.what_failed, next_step: commentary.next_step, exact: [] };
    if (!fits(header)) throw new RangeError('commentary header exceeds transport capacity');
    parts.push(header);
    for (const entity of commentary.exact) {
      let last = parts[parts.length - 1]!;
      const combined = { ...last, exact: [...last.exact!, entity] };
      if (fits(combined)) { parts[parts.length - 1] = combined; continue; }
      last = { section: 'header', exact: [entity] };
      if (!fits(last)) throw new RangeError('commentary entity exceeds transport capacity');
      parts.push(last);
    }
    // Size by the encoded JSON, not just prose characters (quotes and newlines expand).
    let rest = commentary.content.trim();
    while (rest) {
      let limit = Math.min(rest.length, 450);
      let chunk = rest;
      while (!fits({ section: 'content', content: chunk })) {
        limit -= 1;
        if (limit < 1) throw new RangeError('commentary content exceeds transport capacity');
        chunk = splitSpokenText(rest, limit, commentary.exact)[0]!;
      }
      parts.push({ section: 'content', content: chunk }); rest = rest.slice(chunk.length).trimStart();
    }
    return parts.map((part, index) => commentaryEnvelope({ id, part: `${index + 1}/${parts.length}`, final: index === parts.length - 1, ...part }));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Never sever an exact entity or emit a payload the adapter silently refuses.
    return [commentaryEnvelope({ id, part: '1/1', final: true, section: 'header', kind: 'failure', exact: [], cause: 'invalid_result', what_failed: 'commentary transport capacity', next_step: '' })];
  }
}
interface Pending {
  identity: RevisionIdentity; answer: WorkerResult; chunks: string[]; chunk: number;
  command?: string | undefined; attempt: number; started: boolean; requiresDelegation: boolean; blocked: boolean;
}
export class TaskDelivery implements Delivery {
  #pending: Pending | undefined;
  #following: { identity: RevisionIdentity; answer: CommentaryAnswer; requiresDelegation: boolean } | undefined;
  #binding: string | null = null;
  #delegated: RevisionIdentity | undefined;
  #ready = true;
  #quiet = true;
  #owner = false;
  /** What she said last and how far its chunks got; kept for the next ask and across a rebuild. */
  #said: Said | undefined;
  constructor(readonly ports: DeliveryPorts) {}
  said(): Said | undefined { return this.#said; }
  waitingAnswer(): { identity: RevisionIdentity; text: string } | undefined {
    const pending = this.#current();
    return pending && !pending.requiresDelegation ? { identity: pending.identity, text: pending.chunks.join(' ') } : undefined;
  }
  #current(): Pending | undefined {
    if (this.#pending && !this.ports.isCurrent(this.#pending.identity)) this.#pending = undefined;
    return this.#pending;
  }
  socket(_generation: number, ready = true): void {
    this.#binding = null; this.#ready = ready; this.#quiet = true;
    const pending = this.#current(); if (pending) { pending.chunk = 0; pending.command = undefined; pending.attempt = pending.blocked ? 1 : 0; pending.started = false; pending.blocked = false; }
    this.#drain();
  }
  ready(): void { this.#ready = true; this.#resume(); }
  attach(identity: RevisionIdentity, binding: string): void {
    if (!this.ports.isCurrent(identity)) return;
    this.#binding = binding; this.#delegated = identity; const pending = this.#current(); if (pending) pending.requiresDelegation = false; this.#resume();
  }
  progress(_identity: RevisionIdentity): void {}
  deliver(identity: RevisionIdentity, answer: CommentaryAnswer, requiresDelegation = false): void {
    if (!this.ports.isCurrent(identity) || answer.status === 'cancelled') return;
    const pending = this.#current();
    if (pending && pending.identity.task_id === identity.task_id && pending.identity.task_revision === identity.task_revision) {
      if (pending.answer.progress && !answer.progress) this.#following = { identity, answer, requiresDelegation };
      return;
    }
    const noLookup = !answer.failure && (answer.status === 'no_action' || !answer.text.trim());
    const chunks = commentaryItems(resultCommentary(answer));
    this.#said = { text: answer.text, accepted: 0, total: chunks.length };
    this.#pending = { identity, answer, chunks, chunk: 0, attempt: 0, started: false, blocked: false, requiresDelegation: !answer.failure && (requiresDelegation || noLookup) && !(this.#delegated && this.ports.isCurrent(this.#delegated)) };
    this.#drain();
  }
  activity(input: { outputQuiet: boolean; ownerSpeaking: boolean }): void {
    this.#quiet = input.outputQuiet; this.#owner = input.ownerSpeaking; this.#drain();
  }
  accepted(command: string): void {
    const pending = this.#current(); if (!pending || pending.command !== command) return;
    this.ports.state(pending.identity, 'accepted', pending.chunk);
    if (this.#said !== undefined) this.#said.accepted = Math.max(this.#said.accepted, pending.chunk + 1);
    if (++pending.chunk === pending.chunks.length) {
      this.#pending = undefined;
      const following = this.#following; this.#following = undefined;
      if (following) this.deliver(following.identity, following.answer, following.requiresDelegation);
      return;
    }
    pending.command = undefined; pending.attempt = 0; this.#drain();
  }
  rejected(command: string): void {
    const pending = this.#current(); if (!pending || pending.command !== command) return;
    pending.command = undefined; this.#retry();
  }
  /** Timeline acceptance is not speech: a fresh context needs every part of an unfinished envelope. */
  closed(_identity: RevisionIdentity): void { this.disconnected(); }
  disconnected(): void {
    this.#ready = false; this.#binding = null;
    const pending = this.#current(); if (pending) pending.command = undefined;
  }
  dispose(): void { this.#pending = undefined; this.#binding = null; this.#ready = false; }
  #resume(): void {
    const pending = this.#current(); if (pending?.blocked) { pending.blocked = false; pending.attempt = 1; }
    this.#drain();
  }
  #drain(): void {
    const pending = this.#current();
    if (!pending || pending.blocked || pending.requiresDelegation || !this.#ready || this.#owner || (!this.#quiet && !pending.started) || pending.command) return;
    pending.command = this.ports.append(this.#binding, pending.chunks[pending.chunk]!);
    if (!pending.command) { this.#retry(); return; }
    pending.started = true; this.ports.state(pending.identity, 'sent', pending.chunk);
  }
  #retry(): void {
    const pending = this.#current(); if (!pending) return;
    if (pending.attempt++ === 0) { this.ports.state(pending.identity, 'retry', pending.chunk); this.#drain(); return; }
    pending.blocked = true;
    this.ports.state(pending.identity, 'undelivered', pending.chunk);
  }
}
