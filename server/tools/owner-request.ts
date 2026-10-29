import type { ActionKind, RequestAuthorization, OwnerRequestPort } from './types.js';
interface Grant { target?: string; receipt?: unknown; inFlight?: boolean }
interface Request {
  id: string; words: string; start: number; finals: number; journalId: string;
  grants: Map<ActionKind, Grant>; answered?: boolean; pending?: { kind: ActionKind; field: string };
  sources: Record<string, number>; shown: { handle: string; kind: string }[];
}
/** Per tools-owner state. Only finalized spoken or typed owner input may call observe. */
export class OwnerRequests implements OwnerRequestPort {
  private requests = new Map<string, Request>();
  private sequence = 0;
  private seenFinal = new Set<string>();
  private pendingFinal = new Set<string>();
  private finalListeners = new Map<string, Set<() => void>>();
  private external = new Set<string>();
  partial(session: string): void { this.pendingFinal.add(session); }
  async waitForFinal(session: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.seenFinal.has(session) && !this.pendingFinal.has(session)) return;
    await new Promise<void>(resolve => {
      const listeners = this.finalListeners.get(session) ?? new Set<() => void>();
      const timer = setTimeout(() => finish(), 750);
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        listeners.delete(finish);
        if (!listeners.size) this.finalListeners.delete(session);
        resolve();
      };
      listeners.add(finish); this.finalListeners.set(session, listeners);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  constructor(private readonly clock: () => number = () => performance.now()) {}
  observe(session: string, journalId: string, words: string): void {
    this.seenFinal.add(session); this.pendingFinal.delete(session);
    for (const finish of this.finalListeners.get(session) ?? []) finish();
    const previous = this.requests.get(session);
    if (previous?.journalId === journalId) return;
    const grants = new Map<ActionKind, Grant>();
    const cues: [ActionKind, RegExp][] = [
      ['open', /\b(?:open|show|pull up|search for|öffne|oeffne|zeige|zeig)\b/iu],
      ['set_alarm', /\bwake me\b|\bset\b[^.!?]*\balarm\b|\bremind me\s+(?:in|at)\b/i],
      ['cancel_alarm', /\b(?:cancel|stop)\b[^.!?]*\balarm\b/i],
      ['snooze_alarm', /\bsnooze\b/i],
      ['list_alarms', /\bshow\b[^.!?]*\balarms?\b/i],
      ['lux_note', /\b(?:save|remember)\b|\b(?:note|write|put)\b[^.!?]*\blux\b/i],
    ];
    for (const [kind, cue] of cues) {
      const match = cue.exec(words);
      if (!match) continue;
      const before = words.slice(0, match.index);
      if (/\b(?:don['’]?t|do not|never mind|forget it|never|not|no need to)[\s,]*(?:(?:please|you|ever)\s+)*$/i.test(before)) { previous?.grants.delete(kind); continue; }
      grants.set(kind, {});
    }
    if (previous && (!previous.answered || previous.pending) && this.clock() - previous.start <= 120000) {
      previous.words = words.startsWith(previous.words) ? words : `${previous.words} ${words}`;
      previous.finals++; previous.journalId = journalId;
      for (const [kind, grant] of grants) if (!previous.grants.has(kind)) previous.grants.set(kind, grant);
      delete previous.pending;
      return;
    }
    // Retain even a cue-free first fragment: the next final may finish the request.
    this.requests.set(session, { id: `request-${++this.sequence}`, words, start: this.clock(), finals: 1, journalId, grants, sources: {}, shown: [] });
  }

  answered(session: string): void { const request = this.requests.get(session); if (request) request.answered = true; }
  authorize(session: string, kind: ActionKind, target: string): RequestAuthorization {
    const request = this.requests.get(session);
    if (!request) return { code: 'no_owner_request' };
    const common = { id: request.id, words: request.words, journalId: request.journalId };
    const age = this.clock() - request.start;
    if (age < 0 || age > 120000) return { ...common, code: 'request_expired' };
    const grant = request.grants.get(kind);
    if (!grant) return { ...common, code: 'no_owner_request' };
    if (grant.target !== undefined) return !grant.inFlight && grant.target === target
      ? { ...common, code: 'idempotent', receipt: grant.receipt }
      : { ...common, code: 'grant_spent' };
    return { ...common, code: 'allowed' };
  }
  claim(session: string, kind: ActionKind, target: string, requestId: string): RequestAuthorization {
    if (this.requests.get(session)?.id !== requestId) return { code: 'no_owner_request' };
    const authorization = this.authorize(session, kind, target);
    if (authorization.code === 'allowed') {
      const grant = this.requests.get(session)!.grants.get(kind)!;
      grant.target = target; grant.inFlight = true;
    }
    return authorization;
  }
  failed(session: string, kind: ActionKind, target: string, requestId: string): void {
    const request = this.requests.get(session);
    const grant = request?.grants.get(kind);
    if (request?.id === requestId && grant?.inFlight && grant.target === target) {
      delete grant.target; delete grant.inFlight;
    }
  }
  commit(session: string, kind: ActionKind, target: string, receipt: unknown, requestId?: string): void {
    const request = this.requests.get(session);
    if (!request || requestId !== undefined && request.id !== requestId) return;
    const grant = request.grants.get(kind);
    if (!grant || !(grant.inFlight && grant.target === target) && this.authorize(session, kind, target).code !== 'allowed') return;
    grant.target = target; grant.receipt = receipt; delete grant.inFlight;
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
    const grant = request?.grants.get(kind);
    return { ownerFinals: request?.finals ?? 0, requestAgeMs: request ? Math.max(0, Math.round(this.clock() - request.start)) : 0,
      grantKind: kind, grantState: !grant ? 'absent' : grant.target !== undefined ? 'spent' : 'available' };
  }
  release(session: string): void {
    this.requests.delete(session); this.seenFinal.delete(session); this.pendingFinal.delete(session); this.external.delete(session);
    for (const finish of this.finalListeners.get(session) ?? []) finish();
  }
}

export function requestRefusal(code: string): { status: 'refused'; code: string; say: string } {
  const sentences: Record<string, string> = {
    no_owner_request: 'There is no current owner request authorizing that action.',
    request_expired: 'That owner request has expired.', grant_spent: 'That request has already completed this kind of action.',
    target_not_authorized: 'That target is not authorized by this request.', missing_time: 'The alarm request has no time yet.',
    missing_timezone: 'The requested time zone is not recognized.', unsupported_time_expression: 'That time expression is not supported.',
  };
  return { status: 'refused', code, say: sentences[code] ?? 'The host could not authorize that action.' };
}
