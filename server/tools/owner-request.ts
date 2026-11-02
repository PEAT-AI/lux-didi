import type { ActionKind, RequestAuthorization, OwnerRequestPort } from './types.js';
import { composeGrantKinds } from './compose.js';
import { advancesExposure, tierOf } from './tiers.js';
import { hostLogEvent } from './host-events.js';
const normalizeOwnerWords = (words: string): string => words.replace(/(\d)\s*:\s*(\d)/g, '$1:$2');
/** Every free write whose authority is the open owner call itself, never a phrase of his. C-NOTEGATE
 *  (#874): a free write never reads a clause of his speech, since a regex over speech voided an open
 *  owner call in three releases; the fence and the one-owner-final rule are the free gate. */
/** The one guarded kind that still reads a negated clause, its own selector unchanged. */
const NEGATED_CLAUSE = /\b(?:don['’]?t|do not|never mind|forget it|never|not|no need to)\s+([^.!?]*)/gi;
/** What a negated clause has to name to void this kind, and only this kind. */
const NEGATED_ACTION: Record<string, RegExp> = {
  delete_event: /\b(?:cancel|delete|remove)\b/i,
};
const isFreeKind = (kind: ActionKind): boolean =>
  kind === 'open' || kind === 'lux_note' || tierOf(kind) === 'free';
const FREE_ACTION_KINDS: readonly ActionKind[] = ['open', 'set_alarm', 'list_alarms', 'cancel_alarm', 'snooze_alarm',
  'lux_note', 'draft_email', 'draft_chat', 'create_event'];
interface Grant { target?: string; receipt?: unknown; inFlight?: boolean; targets?: Map<string, Grant> }
interface Request {
  id: string; words: string; start: number; observedAt: number; finals: number; journalId: string;
  grants: Map<ActionKind, Grant>; alarmWords?: string; answered?: boolean; pending?: { kind: ActionKind; field: string };
  /** A clarified or failed ask is spent: the next final is read on its own words. */
  spent?: boolean;
  sources: Record<string, number>; shown: { handle: string; kind: string }[];
}
/** Per tools-owner state. Only finalized spoken or typed owner input may call observe. */
export class OwnerRequests implements OwnerRequestPort {
  private requests = new Map<string, Request>();
  private sequence = 0;
  private pendingFinal = new Set<string>();
  private finalListeners = new Map<string, Set<() => void>>();
  private external = new Set<string>();
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
  constructor(private readonly clock: () => number = () => performance.now(), private readonly wallClock: () => number = Date.now) {}
  observe(session: string, journalId: string, words: string, observedAt = this.wallClock()): void {
    this.pendingFinal.delete(session);
    for (const finish of this.finalListeners.get(session) ?? []) finish();
    const previous = this.requests.get(session);
    if (previous?.journalId === journalId) return;
    const grants = new Map<ActionKind, Grant>();
    // C-PERMTIER: a finalized owner turn is authority for every free tool. There is no cue regex and
    // no verb set here, and no later fragment can take an earned grant back.
    for (const kind of FREE_ACTION_KINDS) grants.set(kind, {});
    // Only the guarded compose writes read his words at all, and they keep their own selector.
    for (const kind of composeGrantKinds(words)) grants.set(kind, {});
    // C-PERMTIER: a request whose write already completed is not joined again, so the next ask earns a
    // fresh grant instead of replaying a spent one. Only an unsettled ask merges (the split-ask case).
    const settled = previous !== undefined && [...previous.grants.values()].some(grant =>
      grant.target !== undefined || grant.inFlight === true || (grant.targets?.size ?? 0) > 0);
    // C-TIME: a clarified or failed ask still takes the short answer it asked for ("ten five,
    // today"), and never absorbs a complete new ask ("set an alarm for 6 pm"), which the retry
    // reads on its own words.
    const completeAsk = /\b(?:set|put|make|create|add)\b[^.!?]{0,24}\balarm\b|\bwake me\b|\bremind me\b|\bsnooze\b|\bcancel\b/i.test(words);
    if (previous && !settled && !(previous.spent === true && completeAsk) && this.clock() - previous.start <= 120000) {
      // A split ask grants on the combined turn: the intent and the target may arrive apart.
      const combined = normalizeOwnerWords(words.startsWith(previous.words) ? words : `${previous.words} ${words}`);
      const relative = /\bin\s+(?:\d+|[a-z]+(?:[ -][a-z]+)?)\s+(?:minutes?|hours?)\b/i;
      if (!relative.test(previous.words) && relative.test(combined)) previous.observedAt = observedAt;
      previous.words = combined;
      previous.alarmWords = combined;
      previous.journalId = journalId;
      previous.finals++;
      delete previous.pending;
      for (const [kind, grant] of grants) if (!previous.grants.has(kind)) previous.grants.set(kind, grant);
      if (/[\p{L}\p{N}]/u.test(words)) this.mark(session, 'owner');
      return;
    }
    if (/[\p{L}\p{N}]/u.test(words)) this.mark(session, 'owner');
    this.requests.set(session, { id: `request-${++this.sequence}`, words, start: this.clock(), observedAt, finals: 1, journalId,
      grants, alarmWords: words, sources: {}, shown: [] });
  }

  invalidateAlarm(session: string): void {
    const request = this.requests.get(session);
    if (!request) return;
    request.grants.delete('set_alarm');
    delete request.alarmWords;
    if (request.pending?.kind === 'set_alarm') delete request.pending;
  }
  /**
   * C-PERMTIER: assistant speech is not owner speech, so it never grants and never withdraws an ask the
   * model asked back about. A turn that ends with no question does close an ask whose writes all
   * completed, so the next tool call needs his next final instead of riding the previous one.
   */
  answered(session: string, spoken?: string): void {
    const request = this.requests.get(session);
    if (!request || request.pending !== undefined) return;
    if (spoken !== undefined && /\?\s*$/.test(spoken.trim())) return;
    const spent = [...request.grants.values()].some(grant => grant.target !== undefined || (grant.targets?.size ?? 0) > 0);
    if (spent) this.requests.delete(session);
  }
  /** The guarded gate: a write that reaches another person or deletes something keeps its own selector. */
  authorize(session: string, kind: ActionKind, target: string): RequestAuthorization {
    // C-PERMTIER: a free kind is admitted by the open owner call itself, never by his exact words.
    if (isFreeKind(kind)) return this.freeGate(session, kind, target);
    const request = this.requests.get(session);
    if (!request) return { code: 'no_owner_request' };
    const common = { id: request.id, words: request.words, journalId: request.journalId, observedAt: request.observedAt };
    const age = this.clock() - request.start;
    if (age < 0 || age > 120000) return { ...common, code: 'request_expired' };
    if (this.negated(request.words, kind)) return { ...common, code: 'no_owner_request' };
    return this.settle(request, kind, target, common);
  }
  /**
   * C-PERMTIER: the free gate. The owner's live call is open and no third-party text reached the model
   * after his last words; nothing else is asked of his speech.
   */
  freeGate(session: string, kind: ActionKind, target: string): RequestAuthorization {
    const decision = this.freeDecision(session, kind, target);
    this.gateDecision(session, kind, decision.code);
    return decision;
  }
  private freeDecision(session: string, kind: ActionKind, target: string): RequestAuthorization {
    const request = this.requests.get(session);
    if (!request) return { code: 'no_owner_request' };
    const common = { id: request.id, words: request.words, journalId: request.journalId, observedAt: request.observedAt };
    const age = this.clock() - request.start;
    if (age < 0 || age > 120000) return { ...common, code: 'request_expired' };
    // P-R6: a free write needs at least one owner final in this session as well as the fence, so with
    // no owner words nothing writes and nothing opens.
    if ((this.positions.get(session)?.owner ?? 0) === 0) return { ...common, code: 'no_owner_request' };
    if (this.fenced(session)) return { ...common, code: 'external_text_only' };
    return this.settle(request, kind, target, common);
  }
  /** C-NOTEGATE (#828): the gate's answer as closed fields: the tool, the decision, the code, the two
   *  fence positions and whether any owner final existed. Never a word of his. */
  private gateDecision(session: string, kind: ActionKind, code: string): void {
    const at = this.positions.get(session);
    hostLogEvent({ event: 'gate_decision', tool: kind, decision: code === 'allowed' ? 'allowed' : 'refused',
      code, owner: at?.owner ?? 0, exposure: at?.exposure ?? 0, ownerFinal: (this.requests.get(session)?.finals ?? 0) > 0 });
  }
  private negated(words: string, kind: ActionKind): boolean {
    const governed = NEGATED_ACTION[kind];
    if (governed === undefined) return false;
    for (const match of words.matchAll(NEGATED_CLAUSE)) {
      // C-NEGATION: a negator in front of "forget" asks him to remember, so it commands the action
      // it names rather than voiding it. The negator "forget it" itself still cancels what follows.
      if (/^forget\b/i.test(match[1]!)) continue;
      if (governed.test(match[1]!)) return true;
    }
    return false;
  }
  private settle(request: Request, kind: ActionKind, target: string,
    common: { id: string; words: string; journalId: string; observedAt: number }): RequestAuthorization {
    const authority = request.grants.get(kind);
    if (!authority) return { ...common, code: 'no_owner_request' };
    // P-R10: every free write carries its own target, so one completed write never spends another.
    const grant = authority.targets?.get(target) ?? {};
    if (grant.target !== undefined) return !grant.inFlight && grant.target === target
      ? { ...common, code: 'idempotent', receipt: grant.receipt }
      : { ...common, code: 'grant_spent' };
    return { ...common, code: 'allowed' };
  }
  claim(session: string, kind: ActionKind, target: string, requestId: string): RequestAuthorization {
    if (this.requests.get(session)?.id !== requestId) return { code: 'no_owner_request' };
    const authorization = this.authorize(session, kind, target);
    if (authorization.code === 'allowed') {
      const authority = this.requests.get(session)!.grants.get(kind)!;
      const grant = this.grantFor(authority, target);
      grant.target = target; grant.inFlight = true;
    }
    return authorization;
  }
  failed(session: string, kind: ActionKind, target: string, requestId: string): void {
    const request = this.requests.get(session);
    const authority = request?.grants.get(kind);
    const grant = authority?.targets?.get(target);
    if (request?.id === requestId && grant?.inFlight && grant.target === target) {
      delete grant.target; delete grant.inFlight;
    }
    // C-TIME: a failed ask is spent too, so the next final stands on its own words.
    if (request?.id === requestId) request.spent = true;
  }
  commit(session: string, kind: ActionKind, target: string, receipt: unknown, requestId?: string): void {
    const request = this.requests.get(session);
    if (!request || requestId !== undefined && request.id !== requestId) return;
    const authority = request.grants.get(kind);
    const grant = authority ? this.grantFor(authority, target) : undefined;
    if (!grant || !(grant.inFlight && grant.target === target) && this.authorize(session, kind, target).code !== 'allowed') return;
    grant.target = target; grant.receipt = receipt; delete grant.inFlight;
  }
  private grantFor(authority: Grant, target: string): Grant {
    authority.targets ??= new Map();
    let grant = authority.targets.get(target);
    if (!grant) { grant = {}; authority.targets.set(target, grant); }
    return grant;
  }
  clarify(session: string, kind: ActionKind, field: string): void {
    const request = this.requests.get(session);
    if (!request?.grants.has(kind)) return;
    request.pending = { kind, field };
    // C-TIME: a clarified ask is spent, so the next final is read on its own words and a retry is
    // never merged with the sentence that failed.
    request.spent = true;
  }
  shown(session: string, requestId: string, handles: readonly { handle: string; kind: string }[]): void {
    const request = this.requests.get(session);
    if (!request || request.id !== requestId || this.clock() - request.start > 120000) return;
    for (const handle of handles) if (!request.shown.some(shown => shown.handle === handle.handle)) request.shown.push({ ...handle });
  }
  topShown(session: string, kinds: readonly string[]): string | undefined {
    const request = this.requests.get(session);
    if (!request || this.clock() - request.start > 120000) return undefined;
    return request.shown.find(shown => kinds.includes(shown.kind))?.handle;
  }
  currentId(session: string): string | undefined {
    const request = this.requests.get(session);
    return request && this.clock() - request.start <= 120000 ? request.id : undefined;
  }
  externalContentPresent(session: string): boolean { return this.external.has(session); }
  source(session: string, kind: string, requestId?: string): void {
    this.external.add(session);
    // C-PERMTIER: third-party text advances the exposure position before the model ever sees it.
    if (advancesExposure(kind)) this.mark(session, 'exposure');
    const request = this.requests.get(session);
    if (request && (requestId === undefined || request.id === requestId) && this.clock() - request.start <= 120000) request.sources[kind] = (request.sources[kind] ?? 0) + 1;
  }
  /**
   * C-PERMTIER injection floor. Owner finals and third-party exposures share one monotonic order for
   * the whole session, so no model turn, assistant speech, tool result or retry moves the owner mark.
   */
  private order = 0;
  private positions = new Map<string, { owner: number; exposure: number }>();
  private mark(session: string, side: 'owner' | 'exposure'): void {
    const at = this.positions.get(session) ?? { owner: 0, exposure: 0 };
    at[side] = ++this.order;
    this.positions.set(session, at);
  }
  /** Called immediately before third-party text (mail, chat, web, research) is handed to the model. */
  expose(session: string): void { this.mark(session, 'exposure'); }
  private fenced(session: string): boolean {
    const at = this.positions.get(session);
    return at !== undefined && at.exposure > at.owner;
  }
  sources(session: string): Record<string, number> { return { ...this.requests.get(session)?.sources }; }
  audit(session: string, kind: ActionKind): { ownerFinals: number; requestAgeMs: number; grantKind: ActionKind; grantState: string } {
    const request = this.requests.get(session);
    const grant = this.authorize(session, kind, '').code === 'no_owner_request' ? undefined : request?.grants.get(kind);
    return { ownerFinals: request?.finals ?? 0, requestAgeMs: request ? Math.max(0, Math.round(this.clock() - request.start)) : 0,
      grantKind: kind, grantState: !grant ? 'absent' : grant.target !== undefined || [...(grant.targets?.values() ?? [])].some(target => target.target !== undefined) ? 'spent' : 'available' };
  }
  release(session: string): void {
    this.requests.delete(session); this.pendingFinal.delete(session); this.external.delete(session); this.positions.delete(session);
    for (const finish of this.finalListeners.get(session) ?? []) finish();
  }
}

export function requestRefusal(code: string): { status: 'refused'; code: string; say: string } {
  const sentences: Record<string, string> = {
    no_owner_request: 'There is no current owner request authorizing that action; it needs your words in this session.',
    external_text_only: 'Outside text arrived after your last words, so that write was refused. It clears when you next speak.',
    request_expired: 'That owner request has expired.', grant_spent: 'That request has already completed this kind of action.',
    target_not_authorized: 'That target is not authorized by this request.', missing_time: 'What time should I set the alarm?', ambiguous_time: 'Morning or evening?', past_time: 'That time has already passed today. Which time should I set?',
    missing_timezone: 'Which time zone should I use for the alarm?', unsupported_time_expression: 'What time should I use for the alarm?',
    time_mismatch: 'The alarm was not set because the requested time differs from yours.',
    rule_mismatch: 'The alarm was not set because the recurrence differs from yours.',
    invalid_time: 'The alarm was not set because that time is invalid.', no_alarm: 'There is no alarm to cancel.', several_alarms: 'Which alarm should I cancel?', alarm_not_active: 'That alarm is not active.',
    alarm_failed: 'The alarm action failed; no alarm was set.',
  };
  return { status: 'refused', code, say: sentences[code] ?? 'The host could not authorize that action.' };
}
