import type { DataClass, ToolResultBinding } from '../adapters/model/types.js';
import type { SQLRow, StorePort, Transaction } from '../contracts/storage.js';
import { historyEvidenceCurrent, type HistorySourceRef } from '../domain/history-reader.js';
import { HISTORY_CLASSES } from '../domain/history-lifecycle.js';
import { bindingDigestOf } from '../adapters/mcp/port.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import { projectionAuthentic } from '../tools/diagnostic-input.js';
import type { ConnectionPolicy } from '../tools/types.js';

interface Read { get: Transaction['get']; all: Transaction['all'] }
export interface DiagnosticOrigin {
  executionId: string; name: string; callId?: string; result: { id: string; sha256: string };
  sourceDispatchRefs: string[]; historySources: HistorySourceRef[];
}
export interface DiagnosticEpoch { at: number; dataClasses: DataClass[]; origins: DiagnosticOrigin[] }
export interface DiagnosticContext { version: 2; withheld: boolean; sealed: boolean; epochs: DiagnosticEpoch[] }
const sticky = new Set<string>();
const active = new Set<string>();
const key = (owner: string, run: string) => JSON.stringify([owner, run]);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const classes = (v: unknown): v is DataClass[] => Array.isArray(v) && v.length > 0 && v.every(c => HISTORY_CLASSES.includes(c as DataClass)) && new Set(v).size === v.length && JSON.stringify(v) === JSON.stringify(HISTORY_CLASSES.filter(c => v.includes(c)));
function fail(): never { throw Error('diagnostic_context_unavailable'); }
export const activateDiagnosticContext = (owner: string, run: string): void => { active.add(key(owner, run)); };
export const closeDiagnosticContext = (owner: string, run: string): void => { active.delete(key(owner, run)); };
export const diagnosticContextCurrent = (owner: string, run: string, marker: DiagnosticContext): boolean => !marker.withheld && !diagnosticWithheld(owner, run) && (marker.sealed || active.has(key(owner, run)));
export const diagnosticWithheld = (owner: string, run: string): boolean => sticky.has(key(owner, run));
export function initialDiagnosticContext(dataClasses: readonly DataClass[]): DiagnosticContext {
  return { version: 2, withheld: false, sealed: false, epochs: [{ at: Date.now(), dataClasses: HISTORY_CLASSES.filter(c => dataClasses.includes(c)), origins: [] }] };
}
export function parseDiagnosticContext(value: unknown): DiagnosticContext {
  if (!record(value) || !exact(value, ['version', 'withheld', 'sealed', 'epochs']) || value.version !== 2 || typeof value.withheld !== 'boolean' || typeof value.sealed !== 'boolean' || !Array.isArray(value.epochs) || !value.epochs.length) fail();
  let previous: DiagnosticEpoch | undefined;
  for (const epoch of value.epochs) {
    if (!record(epoch) || !exact(epoch, ['at', 'dataClasses', 'origins']) || !Number.isSafeInteger(epoch.at) || Number(epoch.at) < 0 || !classes(epoch.dataClasses) || !Array.isArray(epoch.origins)) fail();
    const identities = new Set<string>();
    for (const origin of epoch.origins) {
      if (!record(origin) || !exact(origin, ['executionId', 'name', 'callId', 'result', 'sourceDispatchRefs', 'historySources']) || !nonempty(origin.executionId) || !nonempty(origin.name) || (origin.callId !== undefined && !nonempty(origin.callId)) || !record(origin.result) || !exact(origin.result, ['id', 'sha256']) || !nonempty(origin.result.id) || !hash(origin.result.sha256) || !Array.isArray(origin.sourceDispatchRefs) || !origin.sourceDispatchRefs.every(nonempty) || new Set(origin.sourceDispatchRefs).size !== origin.sourceDispatchRefs.length || !Array.isArray(origin.historySources)) fail();
      if (identities.has(origin.executionId)) fail();
      identities.add(origin.executionId);
      for (const source of origin.historySources) if (!record(source) || !exact(source, ['kind', 'id', 'first', 'last', 'transcriptKind', 'dataClass', 'fingerprint']) || !['entry', 'live', 'summary'].includes(String(source.kind)) || !nonempty(source.id) || !Number.isSafeInteger(source.first) || !Number.isSafeInteger(source.last) || typeof source.transcriptKind !== 'string' || !HISTORY_CLASSES.includes(source.dataClass as DataClass) || !hash(source.fingerprint)) fail();
    }
    const current = epoch as unknown as DiagnosticEpoch;
    if (previous && (current.at < previous.at || previous.dataClasses.some(c => !current.dataClasses.includes(c)) || previous.origins.some(o => !current.origins.some(n => canonicalJSON(n) === canonicalJSON(o))))) fail();
    previous = current;
  }
  return value as unknown as DiagnosticContext;
}
/** A leaf predicate: no conversation gate, live authority lookup or recursive source read. */
export function diagnosticSourceCurrent(read: Read, row: SQLRow, owner: string, allowed: readonly DataClass[]): boolean {
  if (row.owner_id !== owner || !allowed.includes(row.source_class as DataClass)) return (console.error('CHAT11 provenance predicate 1'), false);
  const snapshot = read.get('SELECT snapshot_json,snapshot_sha256 FROM tool_runs WHERE owner_id=? AND run_id=?', [owner, row.run_id!]);
  const current = read.get('SELECT policy_sha256,policy_json,generation,enabled FROM tool_connections WHERE owner_id=? AND connection_id=?', [owner, row.connection_id!]);
  if (!snapshot || typeof snapshot.snapshot_json !== 'string' || snapshot.snapshot_sha256 !== row.run_snapshot_sha256 || sha256(snapshot.snapshot_json) !== snapshot.snapshot_sha256 || !current || current.enabled !== 1 || typeof current.policy_json !== 'string' || sha256(current.policy_json) !== current.policy_sha256 || current.policy_sha256 !== row.policy_sha256 || current.generation !== row.generation) return (console.error('CHAT11 provenance predicate 2'), false);
  const frozen = JSON.parse(snapshot.snapshot_json), policy = JSON.parse(current.policy_json) as ConnectionPolicy;
  if (frozen.acceptance?.ownerId !== owner || frozen.acceptance?.runId !== row.run_id || !Array.isArray(frozen.connections) || !frozen.connections.some((c: { connectionId: string; sha256: string }) => c.connectionId === row.connection_id && c.sha256 === row.policy_sha256) || policy.endpoint.id !== row.endpoint_id || bindingDigestOf(policy.endpoint) !== row.binding_digest || policy.schemaDigest !== row.schema_digest || policy.sourcePolicy.id !== row.source_policy_id || policy.sourcePolicy.revision !== row.source_policy_revision || policy.sourcePolicy.unknownClass !== row.source_class || policy.endpoint.account !== row.account_id || policy.endpoint.resource !== row.resource_id) return (console.error('CHAT11 provenance predicate 3'), false);
  if (row.arguments_json !== null && (typeof row.arguments_json !== 'string' || !projectionAuthentic(String(row.arguments_fidelity), row.arguments_json, String(row.arguments_sha256)))) return (console.error('CHAT11 provenance predicate 4'), false);
  return row.source_json === null || (typeof row.source_json === 'string' && sha256(row.source_json) === row.source_sha256 && Buffer.byteLength(row.source_json) === row.source_bytes);
}
export function diagnosticOriginCurrent(read: Read, owner: string, run: string, origin: DiagnosticOrigin, allowed: readonly DataClass[]): boolean {
  const row = read.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [owner, run, origin.executionId]);
  const snapshot = read.get('SELECT snapshot_json,snapshot_sha256 FROM tool_runs WHERE owner_id=? AND run_id=?', [owner, run]);
  if (!row || !['completed', 'failed', 'refused'].includes(String(row.state)) || row.result_id !== origin.result.id || row.result_sha256 !== origin.result.sha256 || typeof row.result_json !== 'string' || sha256(row.result_json) !== origin.result.sha256 || typeof row.intent_json !== 'string' || typeof snapshot?.snapshot_json !== 'string' || sha256(snapshot.snapshot_json) !== snapshot.snapshot_sha256) return (console.error('CHAT11 provenance predicate 5'), false);
  const intent = JSON.parse(row.intent_json), result = JSON.parse(row.result_json), frozen = JSON.parse(snapshot.snapshot_json);
  if (frozen.acceptance?.ownerId !== owner || frozen.acceptance?.runId !== run || intent.runId !== run || intent.executionId !== origin.executionId || intent.toolName !== origin.name || intent.callId !== origin.callId || row.call_id !== (origin.callId ?? null) || result.intentSha256 !== sha256(row.intent_json) || result.routeIdentity !== frozen.acceptance.route?.identity || !Array.isArray(result.dataClasses) || result.dataClasses.some((c: DataClass) => !allowed.includes(c)) || canonicalJSON(result.sourceDispatchRefs ?? []) !== canonicalJSON(origin.sourceDispatchRefs)) return (console.error('CHAT11 provenance predicate 6'), false);
  { const checks = [((row.state === 'completed'), (result.hostEvidenceRequired) && !origin.sourceDispatchRefs.length && !origin.historySources.length)]; if (checks.some(Boolean)) return (console.error("CHAT11 fields", checks), false); }
  if (origin.historySources.length && origin.name !== 'conversation_history') return (console.error('CHAT11 provenance predicate 8'), false);
  const tx: Transaction = { get: read.get.bind(read), all: read.all.bind(read), run: () => fail() };
  if (!historyEvidenceCurrent(tx, owner, { sources: origin.historySources })) return (console.error('CHAT11 provenance predicate 9'), false);
  return origin.sourceDispatchRefs.every(id => {
    const source = read.get('SELECT * FROM tool_dispatches WHERE owner_id=? AND run_id=? AND dispatch_id=?', [owner, run, id]);
    if (!source || source.state !== 'completed' || !diagnosticSourceCurrent(read, source, owner, allowed)) return (console.error('CHAT11 provenance predicate 10'), false);
    return source.execution_id === origin.executionId || !!read.get("SELECT 1 FROM tool_dispatch_reuse WHERE owner_id=? AND run_id=? AND execution_id=? AND origin_dispatch_id=? AND state='referenced'", [owner, run, origin.executionId, id]);
  });
}
export function diagnosticEpochCovers(read: Read, row: SQLRow): boolean {
  if (!read.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chat_runs'")) return false;
  const chat = read.get('SELECT trace FROM chat_runs WHERE owner_assistant_id=? AND run_id=?', [row.owner_id!, row.run_id!]);
  if (!chat) return false;
  const marker = parseDiagnosticContext(JSON.parse(String(chat.trace)).diagnostic);
  return !marker.withheld && marker.epochs.some(e => e.at <= Number(row.started_at) && e.dataClasses.at(-1) === row.session_class);
}
export function protectDiagnosticTrace(owner: string, run: string, trace: Record<string, unknown>): Record<string, unknown> {
  return diagnosticWithheld(owner, run) ? { ...trace, diagnostic: { ...(record(trace.diagnostic) ? trace.diagnostic : {}), withheld: true } } : trace;
}
export function sealDiagnosticTrace(owner: string, run: string, trace: Record<string, unknown>): Record<string, unknown> {
  const protectedTrace = protectDiagnosticTrace(owner, run, trace);
  try { return { ...protectedTrace, diagnostic: { ...parseDiagnosticContext(protectedTrace.diagnostic), sealed: true } }; }
  catch { return protectedTrace; }
}
export function withholdDiagnostics(store: StorePort, owner: string, run: string): void {
  sticky.add(key(owner, run));
  try { store.transaction(tx => { tx.run("UPDATE chat_runs SET trace=json_set(CASE WHEN json_valid(trace) THEN trace ELSE '{}' END,'$.diagnostic.withheld',json('true')) WHERE owner_assistant_id=? AND run_id=?", [owner, run]); }); } catch { console.warn(JSON.stringify({ event: 'diagnostic_capture_failed', runId: run, reason: 'withholding_write_failed' })); }
}
export function captureDiagnosticContext(tx: Transaction, owner: string, run: string, actual: readonly DataClass[], bindings: readonly ToolResultBinding[], history: ReadonlyMap<string, HistorySourceRef[]>, evidence: unknown[]): void {
  if (diagnosticWithheld(owner, run)) fail();
  const row = tx.get('SELECT trace FROM chat_runs WHERE owner_assistant_id=? AND run_id=?', [owner, run]);
  const trace = JSON.parse(String(row?.trace)), marker = parseDiagnosticContext(trace.diagnostic);
  if (marker.withheld) fail();
  const previous = marker.epochs.at(-1)!;
  const dataClasses = HISTORY_CLASSES.filter(c => previous.dataClasses.includes(c) || actual.includes(c));
  const origins = [...previous.origins];
  for (const binding of bindings) {
    const stored = tx.get('SELECT result_json FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [owner, run, binding.executionId]);
    const value = JSON.parse(String(stored?.result_json));
    const origin: DiagnosticOrigin = { executionId: binding.executionId, name: binding.name, ...(binding.callId ? { callId: binding.callId } : {}), result: { ...binding.result }, sourceDispatchRefs: value.sourceDispatchRefs ?? [], historySources: history.get(binding.executionId) ?? [] };
    const existing = origins.find(o => o.executionId === origin.executionId);
    if (existing && canonicalJSON(existing) !== canonicalJSON(origin)) fail();
    if (!existing) origins.push(origin);
  }
  if (!origins.every(o => diagnosticOriginCurrent(tx, owner, run, o, dataClasses))) fail();
  if (canonicalJSON(previous.dataClasses) !== canonicalJSON(dataClasses) || canonicalJSON(previous.origins) !== canonicalJSON(origins)) marker.epochs.push({ at: Math.max(Date.now(), previous.at), dataClasses, origins });
  trace.diagnostic = marker;
  if (evidence.length) trace.toolEvidence = evidence;
  if (tx.run('UPDATE chat_runs SET trace=? WHERE owner_assistant_id=? AND run_id=?', [JSON.stringify(trace), owner, run]) !== 1) fail();
}
