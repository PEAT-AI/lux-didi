import type { ActionKind, RequestAuthorization, OwnerRequestPort } from './types.js';
import { composeGrantKinds } from './compose.js';
import { advancesExposure, tierOf } from './tiers.js';
const normalizeOwnerWords = (words: string): string => words.replace(/(\d)\s*:\s*(\d)/g, '$1:$2');
/** Every free write whose authority is the open owner call itself, never a phrase of his. */
/** A clause he negated commands nothing: "do not open the deck" is not an ask to open it. */
const NEGATED_CLAUSE = /\b(?:don['’]?t|do not|never mind|forget it|never|not|no need to)\s+([^.!?]*)/gi;
/** What a negated clause has to name to void this kind, and only this kind. */
const NEGATED_ACTION: Record<string, RegExp> = {
  open: /\b(?:open|show|launch)\b/i,
  set_alarm: /\b(?:set|put|make|create|add)\b.*\balarm\b|\bwake me\b|\bremind me\b/i,
  cancel_alarm: /\b(?:cancel|stop)\b/i,
  snooze_alarm: /\bsnooze\b/i,
  list_alarms: /\b(?:list|show)\b.*\balarm/i,
  lux_note: /\b(?:save|remember|note|write|put)\b/i,
  draft_email: /\b(?:draft|write|send|e-?mail|mail|message|reply)\b/i,
  draft_chat: /\b(?:draft|write|send|message|reply|post)\b/i,
  create_event: /\b(?:schedule|block|add|put|book|calendar|event)\b/i,
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
    if (process.env.DIDI_PROBE) console.error('PROBE observe', session, journalId, JSON.stringify(words), 'prev=', previous && { id: previous.id, journalId: previous.journalId, finals: previous.finals, start: previous.start, age: this.clock() - previous.start });
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
    if (previous && !settled && this.clock() - previous.start <= 120000) {
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
  /** C-PERMTIER: assistant speech is not owner speech, so it never withdraws an ask. */
  answered(_session: string, _spoken?: string): void {}
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
    const request = this.requests.get(session);
    if (!request) return { code: 'no_owner_request' };
    const common = { id: request.id, words: request.words, journalId: request.journalId, observedAt: request.observedAt };
    const age = this.clock() - request.start;
    if (age < 0 || age > 120000) return { ...common, code: 'request_expired' };
    // P-R6: a free write needs at least one owner final in this session as well as the fence, so with
    // no owner words nothing writes and nothing opens.
    if ((this.positions.get(session)?.owner ?? 0) === 0) return { ...common, code: 'no_owner_request' };
    if (this.negated(request.words, kind)) return { ...common, code: 'no_owner_request' };
    if (this.fenced(session)) return { ...common, code: 'external_text_only' };
    return this.settle(request, kind, target, common);
  }
  private negated(words: string, kind: ActionKind): boolean {
    const governed = NEGATED_ACTION[kind];
    if (governed === undefined) return false;
    for (const match of words.matchAll(NEGATED_CLAUSE)) if (governed.test(match[1]!)) return true;
    return false;
  }
  private settle(request: Request, kind: ActionKind, target: string,
    common: { id: string; words: string; journalId: string; observedAt: number }): RequestAuthorization {
    const authority = request.grants.get(kind);
    if (!authority) return { ...common, code: 'no_owner_request' };
    const grant = kind === 'open' ? authority.targets?.get(target) ?? {} : authority;
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
      const grant = kind === 'open' ? this.openGrant(authority, target) : authority;
      grant.target = target; grant.inFlight = true;
    }
    return authorization;
  }
  failed(session: string, kind: ActionKind, target: string, requestId: string): void {
    const request = this.requests.get(session);
    const authority = request?.grants.get(kind);
    const grant = kind === 'open' ? authority?.targets?.get(target) : authority;
    if (request?.id === requestId && grant?.inFlight && grant.target === target) {
      delete grant.target; delete grant.inFlight;
    }
  }
  commit(session: string, kind: ActionKind, target: string, receipt: unknown, requestId?: string): void {
    const request = this.requests.get(session);
    if (!request || requestId !== undefined && request.id !== requestId) return;
    const authority = request.grants.get(kind);
    const grant = kind === 'open' && authority ? this.openGrant(authority, target) : authority;
    if (!grant || !(grant.inFlight && grant.target === target) && this.authorize(session, kind, target).code !== 'allowed') return;
    grant.target = target; grant.receipt = receipt; delete grant.inFlight;
  }
  private openGrant(authority: Grant, target: string): Grant {
    authority.targets ??= new Map();
    let grant = authority.targets.get(target);
    if (!grant) { grant = {}; authority.targets.set(target, grant); }
    return grant;
  }
  clarify(session: string, kind: ActionKind, field: string): void {
    const request = this.requests.get(session);
    if (request?.grants.has(kind) && (field === 'missing_time' || field === 'missing_timezone' || field === 'unsupported_time_expression')) request.pending = { kind, field };
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
    no_owner_request: 'There is no current owner request authorizing that action.',
    external_text_only: 'Outside text arrived after your last words; say it again and I will do it.',
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
