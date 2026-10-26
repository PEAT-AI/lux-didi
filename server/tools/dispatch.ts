import { diagnosticEpochCovers } from '../trace/diagnostic-context.js';
import { projectDiagnosticInput, projectionAuthentic } from './diagnostic-input.js';
export { projectDiagnosticInput } from './diagnostic-input.js';
import { historyForgotten } from '../domain/history-lifecycle.js';
import { LUX_KNOWLEDGE_TOOLS } from '../connectors/lux-knowledge.js';
import { GOOGLE_TOOLS } from '../connectors/google.js';
import { MONGOOSE_READ_TOOLS } from '../connectors/mongoose.js';
import { MATTERMOST_READ_TOOLS } from '../connectors/mattermost.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CallRequest, CallResult, CompletedResult, McpPort } from '../adapters/mcp/port.js';
import type { StorePort, Transaction, SQLRow } from '../contracts/storage.js';
import type { DataClass, ToolCallRefusal } from '../adapters/model/types.js';
import type { BoundConnection } from './types.js';
import { bindingDigestOf, sourceBindingOf, mcpCallObservation, SOURCE_DISPATCH, type SourceDispatchRef } from '../adapters/mcp/port.js';
import { hostClockDomain, hostMonotonicMs } from '../trace/clock.js';
import { diagnosticContentAccess, type DiagnosticContentAuthority, type DiagnosticContentRead } from '../trace/content.js';
import { sha256 } from './canonical.js';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/**
 * W10: the lux-google-mcp envelope keys (google_mcp/server.py `_envelope`). The four load-bearing
 * fields are always present; the helper's own extras are named, so a projection of some other shape
 * is never vouched for even when its text and structured forms happen to agree.
 */
const GOOGLE_ENVELOPE_KEYS = ['family', 'tool', 'method', 'account', 'data', 'coverage', 'diagnostics'] as const;
function googleEnvelope(value: unknown, toolName: string): boolean {
  if (!record(value) || Object.keys(value).some(key => !(GOOGLE_ENVELOPE_KEYS as readonly string[]).includes(key))) return false;
  return (value['family'] === 'gmail' || value['family'] === 'calendar') && value['tool'] === toolName && record(value['data']) && record(value['coverage']);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) freeze(child); }
  return value;
}
export type DispatchRef = SourceDispatchRef;
export type ObservedCallResult = CallResult & { [SOURCE_DISPATCH]?: DispatchRef };
export interface DispatchScope { readonly call: Readonly<ToolCallRefusal>; readonly bound: BoundConnection; readonly snapshotSha256: string; readonly allowedClasses: readonly DataClass[] }
interface ScopeState { readonly scope: DispatchScope; ordinal: number }
export interface DispatchOwner {
  port: McpPort;
  run<T>(scope: DispatchScope, body: () => T): T;
  reuse(ref: DispatchRef | undefined): void;
}
interface Access { revision: number | null; dataClass: string | null }
export function createDispatchOwner(options: {
  store: StorePort; port: McpPort; ownerId: string;
  current(tx: Transaction, scope: DispatchScope): boolean;
  failure(reason: string, scope?: DispatchScope): void;
}): DispatchOwner {
  const {store,port,ownerId} = options;
  const context = new AsyncLocalStorage<ScopeState>();
  const warn = (reason: string,scope?: DispatchScope): void => {
    try { options.failure(reason,scope); } catch { /* Capture observers cannot cancel an authorized source read. */ }
  };
  // `capture` is false for a call made with no run context: the audit row still records that a
  // context-free wire call happened, but no diagnostic receipt is armed for it (#479).
  const coverage = (kind: string, reason: string, scope?: DispatchScope, capture = true): void => {
    if (capture) warn(reason,scope);
    try { store.transaction(tx => { tx.run('INSERT INTO tool_dispatch_coverage(id,owner_id,run_id,execution_id,kind,reason,observed_at) VALUES(?,?,?,?,?,?,?)',[randomUUID(),ownerId,scope?.call.runId ?? null,scope?.call.executionId ?? null,kind,reason,Date.now()]); }); } catch { warn('coverage_write_failed',scope); }
  };
  const access = (tx: Transaction, scope: DispatchScope): Access | null => {
    if (!options.current(tx,scope)) return null;
    const current = diagnosticContentAccess(tx,scope.call.runId,{ownerId,allowedClasses: scope.allowedClasses});
    return current.state === 'allowed' ? {revision: current.revision,dataClass: current.dataClass} : null;
  };
  store.transaction(tx => {
    tx.run("UPDATE tool_dispatches SET state='unknown',completed_at=?,completed_mono_ms=?,completed_clock_domain=?,reason='host_terminated',source_outcome='unknown',wire_state='unknown' WHERE owner_id=? AND state='pending'",[Date.now(),hostMonotonicMs(),hostClockDomain,ownerId]);
  });
  const decorated = new Proxy(port, { get(target,key) {
    if (key === 'recordReuse') return (ref: DispatchRef | undefined) => resultOwner.reuse(ref);
    if (key !== 'call') { const value = Reflect.get(target,key,target) as unknown; return typeof value === 'function' ? value.bind(target) : value; }
    return async (request: CallRequest,signal?: AbortSignal): Promise<ObservedCallResult> => {
      const state = context.getStore();
      // #479: a call made with no run context (a start-up connector probe) is not a per-run event, so it
      // arms no diagnostic capture; the old `context_absent` receipt was written at every start.
      if (!state) {
        const result = await port.call(request,signal);
        coverage('unattributed',mcpCallObservation(result)?.wire === 'observed' ? 'wire_observed_context_absent' : mcpCallObservation(result)?.wire === 'not_dispatched' ? 'pre_wire_context_absent' : 'dispatch_unknown_context_absent',undefined,false);
        return result;
      }
      const {scope} = state, p = scope.bound.policy;
      const ordinal = ++state.ordinal, id = randomUUID(), startedAt = Date.now(), startedMono = hostMonotonicMs();
      const input = projectDiagnosticInput(request.toolName,request.arguments);
      let recorded = false, startedAccess: Access | null = null, rejected = false, guardPassed = false, recordFailed = false;
      try {
        store.transaction(tx => {
          const row = tx.get('SELECT state FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?',[ownerId,scope.call.runId,scope.call.executionId]);
          if (!row || row.state !== 'intent' || signal?.aborted || request.endpointId !== p.endpoint.id || request.generation !== p.generation || request.account !== p.endpoint.account || request.resource !== p.endpoint.resource || !p.toolNames.includes(request.toolName) || !options.current(tx,scope)) { rejected = true; return; }
          guardPassed = true;
          startedAccess = access(tx,scope);
          tx.run("INSERT INTO tool_dispatches(dispatch_id,owner_id,run_id,execution_id,ordinal,connector,connection_id,policy_sha256,run_snapshot_sha256,binding_digest,schema_digest,source_policy_id,source_policy_revision,account_id,resource_id,session_revision,session_class,source_class,authority_epoch,endpoint_id,tool_name,generation,arguments_json,arguments_sha256,arguments_fidelity,arguments_key_count,arguments_keys,started_at,started_mono_ms,clock_domain,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')",[id,ownerId,scope.call.runId,scope.call.executionId,ordinal,p.connector,scope.bound.connectionId,scope.bound.sha256,scope.snapshotSha256,bindingDigestOf(p.endpoint),p.schemaDigest,p.sourcePolicy.id,p.sourcePolicy.revision,p.endpoint.account,p.endpoint.resource,startedAccess?.revision ?? null,startedAccess?.dataClass ?? null,p.sourcePolicy.unknownClass!,scope.call.authorityEpoch,request.endpointId,request.toolName,request.generation,startedAccess ? input.json : null,input.sha256,startedAccess ? input.fidelity : 'hash_only_source_denied_v1',input.keyCount,input.keys === null ? null : JSON.stringify(input.keys),startedAt,startedMono,hostClockDomain]);
          recorded = true;
        });
      } catch {
        if (guardPassed) { recordFailed = true; warn('insert_write_failed',scope); }
        else rejected = true;
      }
      if (rejected) { coverage('pre_wire_rejected','execution_not_active_or_scope_changed',scope); return {state: 'refused',reason: 'diagnostic_execution_not_active'}; }
      let pending: Promise<CallResult>;
      try { pending = port.call(request,signal); } catch { pending = Promise.resolve({state:'unknown',reason:'source_threw'}); }
      let result: CallResult;
      try { result = await pending; } catch { result = {state:'unknown',reason:'source_threw'}; }
      if (!recorded) {
        if (recordFailed) coverage(mcpCallObservation(result)?.wire === 'not_dispatched' ? 'pre_wire_rejected' : 'wire_record_failed',mcpCallObservation(result)?.wire === 'observed' ? 'insert_failed_wire_observed' : mcpCallObservation(result)?.wire === 'not_dispatched' ? 'insert_failed_pre_wire_refused' : 'insert_failed_dispatch_unknown',scope);
        return result;
      }
      let body: {json: string; hash: string; bytes: number; entityHash: string; entityBytes: number} | undefined;
      // STATE.md S-07: a connector that refuses a read names why ('cancelled-before-dispatch');
      // the state is our closed token, the reason is theirs, and the row keeps both.
      let reason = result.state === 'completed' ? 'unsupported_source_result' : ('reason' in result && result.reason.length > 0 ? result.reason : result.state);
      if ('payload' in result) {
        try { body = extractVerifiedSource(result,request,scope.bound,port); reason = 'captured_complete_v1'; }
        catch (error) { reason = error instanceof SourceCaptureError ? error.message : 'source_verification_failed'; }
      }
      let sealed = false;
      try {
        store.transaction(tx => {
          const current = access(tx,scope);
          if (!startedAccess) { body = undefined; reason = 'source_unclassified'; }
          else if (!current) { body = undefined; reason = historyForgotten(tx,scope.call.runId) ? 'excluded_before_seal' : 'source_changed'; }
          else if (current.revision !== startedAccess.revision || current.dataClass !== startedAccess.dataClass) { body = undefined; reason = 'source_changed'; }
          if (tx.run("UPDATE tool_dispatches SET state=?,completed_at=?,completed_mono_ms=?,completed_clock_domain=?,reason=?,source_outcome=?,wire_state=?,wire_at=?,wire_mono_ms=?,wire_clock_domain=?,entity_sha256=?,entity_bytes=?,source_json=?,source_sha256=?,source_bytes=? WHERE dispatch_id=? AND state='pending'",[body ? 'completed' : 'unavailable',Date.now(),hostMonotonicMs(),hostClockDomain,reason,result.state,mcpCallObservation(result)?.wire ?? 'unknown',mcpCallObservation(result)?.dispatchedAt ?? null,mcpCallObservation(result)?.dispatchedMonoMs ?? null,mcpCallObservation(result)?.clockDomain ?? null,body?.entityHash ?? null,body?.entityBytes ?? null,body?.json ?? null,body?.hash ?? null,body?.bytes ?? null,id]) !== 1) throw Error('dispatch_seal_not_pending');
          sealed = !!body;
        });
      } catch { coverage('seal_write_failed','seal_write_failed',scope); }
      return sealed ? Object.assign({},result,{[SOURCE_DISPATCH]: Object.freeze({id})}) : result;
    };
  } });
  const resultOwner: DispatchOwner = {
    port: decorated,
    run(scope,body) { return context.run({scope: freeze(structuredClone(scope)),ordinal: 0},body); },
    reuse(ref) {
      const scope = context.getStore()?.scope;
      if (!scope) { coverage('unattributed','reuse_context_absent',undefined,false); return; }
      try { store.transaction(tx => {
        const origin = ref ? tx.get("SELECT state FROM tool_dispatches WHERE dispatch_id=? AND owner_id=?",[ref.id,ownerId]) : undefined;
        const available = origin?.state === 'completed';
        tx.run('INSERT INTO tool_dispatch_reuse(id,owner_id,run_id,execution_id,origin_dispatch_id,observed_at,state,reason) VALUES(?,?,?,?,?,?,?,?)',[randomUUID(),ownerId,scope.call.runId,scope.call.executionId,available ? ref!.id : null,Date.now(),available ? 'referenced' : 'unavailable',available ? 'cache_reuse' : 'creator_provenance_unavailable']);
      }); } catch { coverage('seal_write_failed','reuse_write_failed',scope); }
    },
  };
  return resultOwner;
}
class SourceCaptureError extends Error {}
function fail(reason: string): never { throw new SourceCaptureError(reason); }
/**
 * The read envelope the capture gate admits, per connector: the connector module's own published read
 * list, so a tool the module can call is never refused here as `unsupported_source_tool`.
 */
export const SOURCE_TOOL_GATE: Readonly<Record<string,readonly string[]>> = {'lux-knowledge':LUX_KNOWLEDGE_TOOLS,google:GOOGLE_TOOLS,mongoose:MONGOOSE_READ_TOOLS,mattermost:MATTERMOST_READ_TOOLS};
function extractVerifiedSource(result: CompletedResult,request: CallRequest,bound: BoundConnection,port: McpPort) {
  const p = bound.policy,source = result.source,payload = result.payload;
  if (!SOURCE_TOOL_GATE[p.connector]?.includes(request.toolName)) fail('unsupported_source_tool');
  const expected = 'transport' in p.endpoint ? bindingDigestOf(p.endpoint) : p.endpoint.url;
  if (source.endpointId !== request.endpointId || source.toolName !== request.toolName || sourceBindingOf(source) !== expected || source.account !== request.account || source.resource !== request.resource || source.generation !== request.generation || source.schemaDigest !== p.schemaDigest) fail('source_scope_mismatch');
  if (payload.state !== 'available' || payload.encoding !== 'http-response-entity' || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 1 || payload.byteLength > p.bounds.maxEntityBytes || !/^[a-f0-9]{64}$/.test(payload.sha256) || payload.expiresAt <= Date.now()) fail('source_entity_unavailable');
  const chunks: Uint8Array[] = [];
  for (let offset = 0;offset < payload.byteLength;) {
    const length = Math.min(512,payload.byteLength-offset),slice = port.readSlice({handle: payload.handle,endpointId: source.endpointId,generation: source.generation,account: source.account,resource: source.resource,offset,length});
    if (slice.state !== 'available' || slice.byteLength !== payload.byteLength || slice.sha256 !== payload.sha256 || slice.expiresAt !== payload.expiresAt || slice.expiresAt <= Date.now() || slice.bytes.byteLength !== length) fail('source_slice_incomplete');
    chunks.push(slice.bytes.slice()); offset += length;
  }
  const entity = Buffer.concat(chunks);
  if (sha256(entity) !== payload.sha256) fail('source_entity_hash_mismatch');
  const wireText = new TextDecoder('utf-8',{fatal:true}).decode(entity).replace(/^\uFEFF/,'');
  let candidates: unknown[];
  try { candidates = [JSON.parse(wireText)]; }
  catch {
    candidates = wireText.split(/\r\n\r\n|\n\n|\r\r/).flatMap(frame => {
      const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /,''));
      if (!data.length) return [];
      try { return [JSON.parse(data.join('\n'))]; } catch { return []; }
    });
  }
  if (!candidates.some(packet => isDeepStrictEqual(record(packet) && packet.jsonrpc === '2.0' ? packet.result ?? packet.error : packet,result.decodedResult))) fail('source_decoded_entity_mismatch');
  const value = result.decodedResult;
  if (!record(value) || Object.keys(value).some(k => !['content','structuredContent','isError','_meta'].includes(k)) || !Array.isArray(value.content) || (value.isError !== undefined && typeof value.isError !== 'boolean')) fail('unsupported_source_shape');
  const texts: string[] = [];
  for (const part of value.content) {
    if (!record(part) || Object.keys(part).some(k => !['type','text'].includes(k)) || part.type !== 'text' || typeof part.text !== 'string') fail('unsupported_source_content');
    texts.push(part.text);
  }
  let structuredEquivalence: 'lux_string_v1' | 'mongoose_json_dictionary_v1' | 'google_envelope_v1' | undefined;
  if (value.structuredContent !== undefined) {
    const structured = value.structuredContent;
    if (p.connector === 'lux-knowledge' && texts.length === 1 && record(structured) && Object.keys(structured).length === 1 && structured.result === texts[0]) {
      structuredEquivalence = 'lux_string_v1';
    } else if (p.connector === 'mongoose' && texts.length === 1 && record(structured)) {
      let parsed: unknown;
      try { parsed = JSON.parse(texts[0]!); } catch { /* Non-JSON text cannot prove dictionary equivalence. */ }
      if (isDeepStrictEqual(parsed,structured)) structuredEquivalence = 'mongoose_json_dictionary_v1';
    } else if (p.connector === 'google' && texts.length === 1 && record(structured)) {
      let parsed: unknown;
      try { parsed = JSON.parse(texts[0]!); } catch { /* Non-JSON text cannot prove envelope equivalence. */ }
      if (googleEnvelope(parsed, request.toolName) && isDeepStrictEqual(parsed,structured)) structuredEquivalence = 'google_envelope_v1';
    }
    if (!structuredEquivalence) fail('structured_source_projection_unavailable');
  }
  if (!Number.isSafeInteger(result.freshness.receivedAt) || result.freshness.receivedAt < 0) fail('source_receipt_invalid');
  const json = JSON.stringify({version:1,content: texts.map(text => ({type:'text',text})),isError: value.isError ?? false,
    ...(structuredEquivalence ? {structuredEquivalence} : {}),
    source:{endpointId:source.endpointId,toolName:source.toolName,generation:source.generation,schemaDigest:source.schemaDigest,account:source.account,resource:source.resource,bindingDigest:bindingDigestOf(p.endpoint)},
    coverage:{completeCorpus:false,basis:'single-tool-result',remoteSideEffects:'unverified'},sourceVersion:'unknown',receivedAt:result.freshness.receivedAt});
  if (Buffer.from(json,'utf8').toString('utf8') !== json) fail('source_serialization_invalid');
  return {json,hash: sha256(json),bytes: Buffer.byteLength(json),entityHash: payload.sha256,entityBytes: payload.byteLength};
}
function gatedDispatch(read: DiagnosticContentRead,row: SQLRow,authority: DiagnosticContentAuthority): SQLRow {
  const access = diagnosticContentAccess(read,String(row.run_id),authority);
  const snapshot = read.get('SELECT snapshot_json,snapshot_sha256 FROM tool_runs WHERE owner_id=? AND run_id=?',[row.owner_id!,row.run_id!]);
  const current = read.get('SELECT policy_sha256,policy_json,generation FROM tool_connections WHERE owner_id=? AND connection_id=?',[row.owner_id!,row.connection_id!]);
  const allowed = access.state === 'allowed' && !!snapshot && snapshot.snapshot_sha256 === row.run_snapshot_sha256 && typeof snapshot.snapshot_json === 'string' && sha256(snapshot.snapshot_json) === snapshot.snapshot_sha256 && !!current && current.policy_sha256 === row.policy_sha256 && typeof current.policy_json === 'string' && sha256(current.policy_json) === current.policy_sha256 && current.generation === row.generation && row.session_revision === access.revision && (row.session_class === access.dataClass || diagnosticEpochCovers(read,row)) && authority.allowedClasses.includes(row.source_class as 'ordinary');
  if (!allowed) return {...row,arguments_json:null,source_json:null,read_state:'source_changed'};
  if (row.arguments_json !== null && (typeof row.arguments_json !== 'string' || !projectionAuthentic(String(row.arguments_fidelity), row.arguments_json, String(row.arguments_sha256)))) return {...row,arguments_json:null,source_json:null,read_state:'stored_input_hash_mismatch'};
  if (row.source_json !== null && (typeof row.source_json !== 'string' || sha256(row.source_json) !== row.source_sha256 || Buffer.byteLength(row.source_json) !== row.source_bytes)) return {...row,source_json:null,read_state:'stored_hash_mismatch'};
  return {...row,read_state:'allowed'};
}
/** This reader never falls back to bounded snapshots or expiring adapter payloads after denial. */
export function readDiagnosticDispatches(read: DiagnosticContentRead,session: string,authority?: DiagnosticContentAuthority): {access: ReturnType<typeof diagnosticContentAccess>;dispatches: SQLRow[];reuse: SQLRow[]} {
  const access = diagnosticContentAccess(read,session,authority);
  if (access.state !== 'allowed') return {access,dispatches:[],reuse:[]};
  const dispatches = read.all('SELECT * FROM tool_dispatches WHERE owner_id=? AND run_id=? ORDER BY execution_id,ordinal',[authority!.ownerId,session]).map(row => gatedDispatch(read,row,authority!));
  const reuse = read.all('SELECT * FROM tool_dispatch_reuse WHERE owner_id=? AND run_id=? ORDER BY observed_at,id',[authority!.ownerId,session]).map(edge => {
    const origin = edge.origin_dispatch_id ? read.get('SELECT * FROM tool_dispatches WHERE dispatch_id=? AND owner_id=?',[edge.origin_dispatch_id,authority!.ownerId]) : undefined;
    const checked = origin && gatedDispatch(read,origin,authority!);
    return checked?.read_state === 'allowed' && checked.state === 'completed' ? {...edge,source_json:checked.source_json!,source_sha256:checked.source_sha256!,read_state:'allowed'} : {...edge,source_json:null,read_state:'origin_unavailable_or_denied'};
  });
  return {access,dispatches,reuse};
}
