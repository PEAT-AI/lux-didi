import type { ActionKind, RequestAuthorization, OwnerRequestPort } from './types.js';
interface Grant { target?: string; receipt?: unknown; inFlight?: boolean }
interface Request {
  id: string; words: string; start: number; finals: number; journalId: string;
  grants: Map<ActionKind, Grant>; pending?: { kind: ActionKind; field: string };
  sources: Record<string, number>; shown: { handle: string; kind: string }[];
}
/** Per tools-owner state. Only finalized owner transcription may call observe. */
export class OwnerRequests implements OwnerRequestPort {
  private requests = new Map<string, Request>();
  private sequence = 0;
  private seenFinal = new Set<string>();
  private pendingFinal = new Set<string>();
  private finalListeners = new Map<string, Set<() => void>>();
  private external = new Set<string>();
  partial(session: string): void { this.pendingFinal.add(session); }
  async waitForFinal(session: string, signal: AbortSignal): Promise<void> {
    if (!this.seenFinal.has(session) || !this.pendingFinal.has(session) || signal.aborted) return;
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
  constructor(private readonly clock: () => number = () => performance.now()) {}
  observe(session: string, journalId: string, words: string): void {
    this.seenFinal.add(session); this.pendingFinal.delete(session);
    for (const finish of this.finalListeners.get(session) ?? []) finish();
    const previous = this.requests.get(session);
    if (previous?.journalId === journalId) return;
    const direct = !/^["“”]|\b(?:he|she|they|mail|email|note|summary)\s+(?:said|says|asked)|\b(?:hypothetically|suppose)|\bif\s+(?:i|we|you|he|she|they|it|someone)|\bshould\s+(?:i|we|you)\b/i.test(words);
    const grants = new Map<ActionKind, Grant>();
    if (direct) {
      const cues: [ActionKind, RegExp][] = [
        ['open', /^(?:open|launch|show)\b/i],
        ['set_alarm', /^wake me\b|^(?:set|make|create)\b[^.!?]*\balarm\b/i],
        ['cancel_alarm', /^(?:cancel|delete|remove|stop)\b[^.!?]*\balarm\b/i],
        ['snooze_alarm', /^snooze\b/i],
        ['list_alarms', /^(?:list|show|what)\b[^.!?]*\balarms?\b/i],
        ['lux_note', /^(?:save|remember)\b|^put\b[^.!?]*\blux\b/i],
      ];
      const clauses = words.split(/\b(?:and then|and|then|also)\b|[;.!]/i).map(clause => clause.trim()
        .replace(/^(?:(?:please|okay|ok|right|now)\b[\s,]*)+/i, '')
        .replace(/^(?:(?:can|could|would|will) you(?: please)?|i (?:want|need|would like) you to)\s+/i, ''));
      for (const [kind, cue] of cues) if (clauses.some(clause => cue.test(clause))) grants.set(kind, {});
    }
    if (!grants.size && direct && previous?.pending && this.clock() - previous.start <= 120000
      && /^(?:(?:a\.?m\.?|p\.?m\.?)\b|singapore\b|sgt\b|(?:ten|quarter|half|\d+)\s+(?:past|to)\b|in\s+(?:\w+|\d+)\s+(?:minutes?|hours?)\b)/i.test(words.trim())) {
      previous.words += ` ${words}`; previous.finals++; previous.journalId = journalId;
      delete previous.pending;
      return;
    }
    if (!grants.size) {
      if (!previous || this.clock() - previous.start > 120000 || !direct || /\b(?:what|when|where|why|how|who|can|could|tell|explain|compare|find|look|read|search|show|set|open|save|remember|put|cancel|snooze)\b/i.test(words)) this.requests.delete(session);
      return;
    }
    this.requests.set(session, { id: `request-${++this.sequence}`, words, start: this.clock(), finals: 1, journalId, grants, sources: {}, shown: [] });
  }
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
