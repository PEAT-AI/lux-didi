import type { ActionKind, RequestAuthorization, OwnerRequestPort } from './types.js';
import { COMPOSE_GRANT_KINDS, composeGrantKinds, type ComposeGrantKind } from './compose.js';
interface Grant { target?: string; receipt?: unknown; inFlight?: boolean; targets?: Map<string, Grant> }
interface Request {
  id: string; words: string; start: number; observedAt: number; finals: number; journalId: string;
  grants: Map<ActionKind, Grant>; answered?: boolean; pending?: { kind: ActionKind; field: string };
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
    // Finalized owner input is authority for non-destructive tools, not a phrase grammar.
    for (const kind of ['open', 'set_alarm', 'cancel_alarm', 'snooze_alarm', 'list_alarms'] as const) grants.set(kind, {});
    grants.set('lux_note', {});
    // Each write tool carries its own intent: drafting, messaging, scheduling or cancelling.
    for (const kind of composeGrantKinds(words)) grants.set(kind, {});
    if (previous && (!previous.answered || previous.pending) && this.clock() - previous.start <= 120000) {
      const combined = (words.startsWith(previous.words) ? words : `${previous.words} ${words}`).replace(/(\d)\s*:\s*(\d)/g, '$1:$2');
      const relative = /\bin\s+(?:\d+|[a-z]+(?:[ -][a-z]+)?)\s+(?:minutes?|hours?)\b/i;
      if (!relative.test(previous.words) && relative.test(combined)) previous.observedAt = observedAt;
      previous.words = combined;
      previous.answered = false;
      previous.finals++; previous.journalId = journalId;
      // A split ask grants on the combined turn: the intent and the target may arrive apart.
      for (const kind of composeGrantKinds(combined)) grants.set(kind, {});
      for (const [kind, grant] of grants) if (!previous.grants.has(kind)) previous.grants.set(kind, grant);
      delete previous.pending;
      return;
    }
    // Retain even a cue-free first fragment: the next final may finish the request.
    this.requests.set(session, { id: `request-${++this.sequence}`, words, start: this.clock(), observedAt, finals: 1, journalId, grants, sources: {}, shown: [] });
  }

  answered(session: string): void { const request = this.requests.get(session); if (request) request.answered = true; }
  authorize(session: string, kind: ActionKind, target: string): RequestAuthorization {
    const request = this.requests.get(session);
    if (!request || request.answered) return { code: 'no_owner_request' };
    const common = { id: request.id, words: request.words, journalId: request.journalId, observedAt: request.observedAt };
    const age = this.clock() - request.start;
    if (age < 0 || age > 120000) return { ...common, code: 'request_expired' };
    const negations = /\b(?:don['’]?t|do not|never mind|forget it|never|not|no need to)\s+([^.!?]*)/gi;
    for (const match of request.words.matchAll(negations)) {
      const clause = match[1]!;
      const negated = kind === 'open' ? /\b(?:open|show|launch)\b/i.test(clause)
        : kind === 'set_alarm' ? /\b(?:set|put|make|create|add)\b.*\balarm\b|\bwake me\b|\bremind me\b/i.test(clause)
        : kind === 'cancel_alarm' ? /\b(?:cancel|stop)\b/i.test(clause)
        : kind === 'snooze_alarm' ? /\bsnooze\b/i.test(clause)
        : kind === 'list_alarms' ? /\b(?:list|show)\b.*\balarm/i.test(clause)
        : kind === 'lux_note' ? /\b(?:save|remember|note|write|put)\b/i.test(clause)
        : COMPOSE_GRANT_KINDS.includes(kind as ComposeGrantKind) ? /\b(?:draft|write|send|e-?mail|mail|message|reply|tell|schedule|block|add|put|book|cancel|delete|remove)\b/i.test(clause)
        : false;
      if (negated) return { ...common, code: 'no_owner_request' };
    }
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
    const request = this.requests.get(session);
    if (request && (requestId === undefined || request.id === requestId) && this.clock() - request.start <= 120000) request.sources[kind] = (request.sources[kind] ?? 0) + 1;
  }
  sources(session: string): Record<string, number> { return { ...this.requests.get(session)?.sources }; }
  audit(session: string, kind: ActionKind): { ownerFinals: number; requestAgeMs: number; grantKind: ActionKind; grantState: string } {
    const request = this.requests.get(session);
    const grant = this.authorize(session, kind, '').code === 'no_owner_request' ? undefined : request?.grants.get(kind);
    return { ownerFinals: request?.finals ?? 0, requestAgeMs: request ? Math.max(0, Math.round(this.clock() - request.start)) : 0,
      grantKind: kind, grantState: !grant ? 'absent' : grant.target !== undefined || [...(grant.targets?.values() ?? [])].some(target => target.target !== undefined) ? 'spent' : 'available' };
  }
  release(session: string): void {
    this.requests.delete(session); this.pendingFinal.delete(session); this.external.delete(session);
    for (const finish of this.finalListeners.get(session) ?? []) finish();
  }
}

export function requestRefusal(code: string): { status: 'refused'; code: string; say: string } {
  const sentences: Record<string, string> = {
    no_owner_request: 'There is no current owner request authorizing that action.',
    request_expired: 'That owner request has expired.', grant_spent: 'That request has already completed this kind of action.',
    target_not_authorized: 'That target is not authorized by this request.', missing_time: 'What time should I set the alarm?',
    missing_timezone: 'Which time zone should I use for the alarm?', unsupported_time_expression: 'What time should I use for the alarm?',
    time_mismatch: 'The alarm was not set because the requested time differs from yours.',
    invalid_time: 'The alarm was not set because that time is invalid.', alarm_not_active: 'That alarm is not active.',
    alarm_failed: 'The alarm action failed; no alarm was set.',
  };
  return { status: 'refused', code, say: sentences[code] ?? 'The host could not authorize that action.' };
}
