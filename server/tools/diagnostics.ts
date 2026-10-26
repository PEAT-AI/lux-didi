import type { SQLRow } from '../contracts/storage.js';
import { diagnosticContentAccess, type DiagnosticContentAuthority, type DiagnosticContentRead } from '../trace/content.js';
import { readDiagnosticDispatches } from './dispatch.js';
import { sha256 } from './canonical.js';
import { projectionAuthentic } from './diagnostic-input.js';

export interface ToolDiagnostics {
  coverage: { state: 'observed_rows_only' | 'legacy_unavailable'; calls: number; recordedAttempts: number; recordedObservedWire: number; pending: number; unavailable: number; unknownWire: number; captureFailures: number; unattributedHostObservations: number };
  calls: SQLRow[]; dispatches: SQLRow[]; reuse: SQLRow[]; capture: SQLRow[];
  contentAccess?: ReturnType<typeof diagnosticContentAccess>;
}
const table = (read: DiagnosticContentRead,name: string): boolean => !!read.get("SELECT name FROM sqlite_schema WHERE type='table' AND name=?",[name]);
const dispatchColumns = 'dispatch_id,owner_id,run_id,execution_id,ordinal,connector,connection_id,endpoint_id,tool_name,generation,binding_digest,schema_digest,policy_sha256,run_snapshot_sha256,source_policy_id,source_policy_revision,account_id,resource_id,session_revision,session_class,source_class,arguments_sha256,arguments_fidelity,arguments_key_count,arguments_keys,content_pruned_at,started_at,started_mono_ms,clock_domain,state,completed_at,completed_mono_ms,completed_clock_domain,reason,source_outcome,wire_state,wire_at,wire_mono_ms,wire_clock_domain,entity_sha256,entity_bytes,source_sha256,source_bytes';
const record = (value: unknown): value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Three outcomes, not two: a body whose content was pruned at 30 days is not a body that fails its
 * own hash. Keeping them apart is what stops a month-old call reading as tampered (lane-6 2.3). */
export function resultBodyState(stored: {result_json?: unknown; result_sha256?: unknown; content_pruned_at?: unknown}, expectedSha: string): 'ok' | 'pruned' | 'mismatch' {
  if (typeof stored.result_json !== 'string') return stored.content_pruned_at === null || stored.content_pruned_at === undefined ? 'mismatch' : 'pruned';
  return sha256(stored.result_json) === expectedSha ? 'ok' : 'mismatch';
}

/** Content comes only from canonical rows after the same current source gate; metadata never selects body columns. */
export function readToolDiagnostics(read: DiagnosticContentRead,run: string,options: {content?: boolean; authority?: DiagnosticContentAuthority} = {}): ToolDiagnostics {
  const supported = table(read,'tool_dispatches');
  const calls = supported ? read.all(`SELECT owner_id,run_id,execution_id,call_id,state,result_id,result_sha256,input_sha256,input_fidelity,input_key_count,
    json_extract(intent_json,'$.toolName') AS tool_name,json_extract(intent_json,'$.accountId') AS account_id,json_extract(intent_json,'$.resourceId') AS resource_id
    FROM tool_calls WHERE run_id=? ORDER BY execution_id`,[run]) : [];
  const dispatches = supported ? read.all(`SELECT ${dispatchColumns} FROM tool_dispatches WHERE run_id=? ORDER BY execution_id,ordinal`,[run]) : [];
  for(const row of dispatches){
    row.attempt_to_seal_ms=row.clock_domain===row.completed_clock_domain&&Number(row.completed_mono_ms)>=Number(row.started_mono_ms)?Number(row.completed_mono_ms)-Number(row.started_mono_ms):null;
    row.attempt_to_wire_ms=row.clock_domain===row.wire_clock_domain&&row.wire_mono_ms!==null&&Number(row.wire_mono_ms)>=Number(row.started_mono_ms)?Number(row.wire_mono_ms)-Number(row.started_mono_ms):null;
  }
  const reuse = supported ? read.all('SELECT id,owner_id,run_id,execution_id,origin_dispatch_id,observed_at,state,reason FROM tool_dispatch_reuse WHERE run_id=? ORDER BY observed_at,id',[run]) : [];
  const capture = supported ? read.all('SELECT id,owner_id,run_id,execution_id,kind,reason,observed_at FROM tool_dispatch_coverage WHERE run_id=? ORDER BY observed_at,id',[run]) : [];
  const unattributed = supported ? Number(read.get("SELECT count(*) AS n FROM tool_dispatch_coverage WHERE run_id IS NULL AND kind='unattributed'")?.n ?? 0) : 0;
  const report: ToolDiagnostics = {calls,dispatches,reuse,capture,coverage:{state:supported?'observed_rows_only':'legacy_unavailable',calls:calls.length,recordedAttempts:dispatches.length,recordedObservedWire:dispatches.filter(row=>row.wire_state==='observed').length,pending:dispatches.filter(row=>row.state==='pending').length,unavailable:dispatches.filter(row=>row.state==='unavailable').length,unknownWire:dispatches.filter(row=>row.wire_state===null||row.wire_state==='unknown').length,captureFailures:capture.filter(row=>row.kind==='wire_record_failed'||row.kind==='seal_write_failed').length,unattributedHostObservations:unattributed}};
  if (!options.content) return report;
  if (!supported) { report.contentAccess=diagnosticContentAccess(read,run,options.authority);return report; }
  const checked = readDiagnosticDispatches(read,run,options.authority);
  report.contentAccess = checked.access;
  if (checked.access.state !== 'allowed') return report;
  const byDispatch = new Map(checked.dispatches.map(row=>[String(row.dispatch_id),row]));
  const byReuse = new Map(checked.reuse.map(row=>[String(row.id),row]));
  for (const row of dispatches) {
    const source=byDispatch.get(String(row.dispatch_id));
    row.read_state=source?.read_state??'source_unavailable';
    row.arguments_json=source?.arguments_json??null;row.source_json=source?.source_json??null;
  }
  for (const row of reuse) {
    const source=byReuse.get(String(row.id));row.read_state=source?.read_state??'origin_unavailable_or_denied';
    row.source_json=source?.source_json??null;row.source_sha256=source?.source_sha256??null;
  }
  for (const call of calls) {
    const own=checked.dispatches.filter(row=>row.owner_id===call.owner_id&&row.execution_id===call.execution_id);
    const reused=checked.reuse.filter(row=>row.owner_id===call.owner_id&&row.execution_id===call.execution_id);
    // A local/legacy result has no durable source lineage here and cannot borrow another call's authority.
    const current=own.length+reused.length>0&&own.every(row=>row.read_state==='allowed')&&reused.every(row=>row.read_state==='allowed');
    call.read_state=current?'allowed':'source_provenance_unavailable_or_denied';
    if (!current) continue;
    const stored=read.get('SELECT input_json,result_json,result_sha256,content_pruned_at,input_fidelity FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?',[call.owner_id!,run,call.execution_id!]);
    if(typeof stored?.input_json==='string'&&projectionAuthentic(String(stored.input_fidelity),stored.input_json,String(call.input_sha256)))call.input_json=stored.input_json;
    else call.input_json=null;
    const body=stored?.result_json, bodyState=resultBodyState(stored??{},String(call.result_sha256));
    if(bodyState==='pruned'){call.result_read_state='pruned';continue;}
    if(bodyState==='mismatch'||typeof body!=='string'){call.result_read_state='unavailable_or_hash_mismatch';continue;}
    try{
      const value:unknown=JSON.parse(body);
      if(!record(value)||!Array.isArray(value.dataClasses)||!value.dataClasses.every(c=>typeof c==='string'&&options.authority!.allowedClasses.includes(c as 'ordinary'))){call.result_read_state='class_denied';continue;}
      call.result_json=body;call.result_read_state='bounded_model_projection';
    }catch{call.result_read_state='invalid_stored_projection';}
  }
  return report;
}
