export type ActionKind = 'open' | 'set_alarm' | 'list_alarms' | 'cancel_alarm' | 'snooze_alarm' | 'lux_note';
export type RequestCode = 'allowed' | 'idempotent' | 'no_owner_request' | 'request_expired' | 'grant_spent';
interface Grant { target?: string; receipt?: unknown }
interface Request {
  id: string; words: string; start: number; finals: number; journalId: string;
  grants: Map<ActionKind, Grant>; pending?: { kind: ActionKind; field: string };
  sources: Record<string, number>;
}
export type RequestAuthorization =
  | { code: 'no_owner_request'; id?: string; words?: string; journalId?: string }
  | { code: Exclude<RequestCode, 'no_owner_request'>; id: string; words: string; journalId: string; receipt?: unknown };

/** Per tools-owner state. Only finalized owner transcription may call observe. */
export class OwnerRequests {
  private requests = new Map<string, Request>();
  private sequence = 0;
  constructor(private readonly clock: () => number = () => performance.now()) {}
  observe(session: string, journalId: string, words: string): void {
    const previous = this.requests.get(session);
    if (previous?.journalId === journalId) return;
    const direct = !/["“”]|\b(?:he|she|they|mail|email|note|summary)\s+(?:said|says|asked)|\b(?:if|hypothetically|suppose)|\bshould\s+(?:i|we|you)\b/i.test(words);
    const grants = new Map<ActionKind, Grant>();
    if (direct) {
      const cues: [ActionKind, RegExp][] = [
        ['open', /\b(?:open|launch|show)\b/i],
        ['set_alarm', /\bwake me\b|\b(?:set|make|create)\b[^.!?]*\balarm\b/i],
        ['cancel_alarm', /\b(?:cancel|delete|remove|stop)\b[^.!?]*\balarm\b/i],
        ['snooze_alarm', /\bsnooze\b/i],
        ['list_alarms', /\b(?:list|show|what)\b[^.!?]*\balarms?\b/i],
        ['lux_note', /\b(?:save|remember|put)\b[^.!?]*\b(?:lux|this|that|it)\b/i],
      ];
      for (const [kind, cue] of cues) if (cue.test(words)) grants.set(kind, {});
    }
    if (!grants.size && direct && previous?.pending && this.clock() - previous.start <= 120000
      && /^(?:(?:a\.?m\.?|p\.?m\.?)\b|singapore\b|sgt\b|(?:ten|quarter|half|\d+)\s+(?:past|to)\b|in\s+(?:\w+|\d+)\s+(?:minutes?|hours?)\b)/i.test(words.trim())) {
      previous.words += ` ${words}`; previous.finals++; previous.journalId = journalId;
      delete previous.pending;
      return;
    }
    if (!grants.size) { this.requests.delete(session); return; }
    this.requests.set(session, { id: `request-${++this.sequence}`, words, start: this.clock(), finals: 1, journalId, grants, sources: {} });
  }
  authorize(session: string, kind: ActionKind, target: string): RequestAuthorization {
    const request = this.requests.get(session);
    if (!request) return { code: 'no_owner_request' };
    const common = { id: request.id, words: request.words, journalId: request.journalId };
    const age = this.clock() - request.start;
    if (age < 0 || age > 120000) return { ...common, code: 'request_expired' };
    const grant = request.grants.get(kind);
    if (!grant) return { ...common, code: 'no_owner_request' };
    if (grant.target !== undefined) return grant.target === target
      ? { ...common, code: 'idempotent', receipt: grant.receipt }
      : { ...common, code: 'grant_spent' };
    return { ...common, code: 'allowed' };
  }
  commit(session: string, kind: ActionKind, target: string, receipt: unknown): void {
    if (this.authorize(session, kind, target).code !== 'allowed') return;
    const grant = this.requests.get(session)!.grants.get(kind)!;
    grant.target = target; grant.receipt = receipt;
  }
  clarify(session: string, kind: ActionKind, field: string): void {
    const request = this.requests.get(session);
    if (request?.grants.has(kind) && (field === 'missing_time' || field === 'missing_timezone' || field === 'unsupported_time_expression')) request.pending = { kind, field };
  }
  source(session: string, kind: string): void {
    const request = this.requests.get(session);
    if (request && this.clock() - request.start <= 120000) request.sources[kind] = (request.sources[kind] ?? 0) + 1;
  }
  sources(session: string): Record<string, number> { return { ...this.requests.get(session)?.sources }; }
  audit(session: string, kind: ActionKind): { ownerFinals: number; requestAgeMs: number; grantKind: ActionKind; grantState: string } {
    const request = this.requests.get(session);
    const grant = request?.grants.get(kind);
    return { ownerFinals: request?.finals ?? 0, requestAgeMs: request ? Math.max(0, Math.round(this.clock() - request.start)) : 0,
      grantKind: kind, grantState: !grant ? 'absent' : grant.target !== undefined ? 'spent' : 'available' };
  }
  release(session: string): void { this.requests.delete(session); }
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
