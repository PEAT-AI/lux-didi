import { randomUUID } from 'node:crypto';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import type { DataClass, HostContext, JsonObject, ToolCallIntent, ToolCallRefusal, ToolDefinition, ToolResultBinding, ToolResultGate, ToolResultRef } from '../adapters/model/types.js';
import { validateEndpointUrl } from '../adapters/mcp/registry.js';
import { createLuxKnowledgeReader } from '../connectors/lux-knowledge.js';
import { canonicalJSON, detached, sha256 } from './canonical.js';
import { projectLuxResult } from './lux-knowledge.js';
import type { BoundConnection, ConnectionApplyResult, ConnectionPolicy, ModelSnapshot, RunAcceptance, RunSnapshot, ToolsOwner, ToolsOwnerOptions } from './types.js';
export { toolsMigrations } from './schema.js';
export type * from './types.js';

const ownedStores = new WeakSet<object>();
const ownerBindings = new WeakMap<object, Pick<ToolsOwnerOptions, 'store' | 'registry' | 'ownerId'>>();
/** Factory identity check: no second owner, port or registry may substitute for canonical authority. */
export function assertToolsOwnerBinding(owner: ToolsOwner, expected: Pick<ToolsOwnerOptions, 'store' | 'registry' | 'ownerId'>): void {
  const binding = ownerBindings.get(owner);
  if (!binding || binding.store !== expected.store || binding.registry !== expected.registry || binding.ownerId !== expected.ownerId) throw Error('tools_owner_binding_mismatch');
}
const classes = ['ordinary', 'private', 'sensitive'];
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) throw Error('invalid_policy_shape');
}
function text(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw Error('invalid_identifier'); }
function positive(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 1) throw Error('invalid_positive_integer'); }
function classSet(value: unknown): asserts value is DataClass[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(c => !classes.includes(c))) throw Error('invalid_classes');
}
export function validatePolicy(input: ConnectionPolicy): ConnectionPolicy {
  const p = detached(input);
  exact(p, ['schemaVersion', 'ownerId', 'connectionId', 'generation', 'enabled', 'endpoint', 'toolNames', 'schemaDigest', 'sourcePolicy', 'route', 'bounds']);
  if (p.schemaVersion !== 1 || typeof p.enabled !== 'boolean') throw Error('invalid_policy_version');
  [p.ownerId, p.connectionId].forEach(text); positive(p.generation);
  exact(p.endpoint, ['id', 'url', 'account', 'resource', 'credentialRef']);
  [p.endpoint.id, p.endpoint.account, p.endpoint.resource, p.endpoint.url].forEach(text); validateEndpointUrl(p.endpoint.url);
  if (p.endpoint.credentialRef !== null) text(p.endpoint.credentialRef);
  if (!Array.isArray(p.toolNames) || p.toolNames.length < 1 || p.toolNames.length > 2 || new Set(p.toolNames).size !== p.toolNames.length || p.toolNames.some(n => !['search_knowledge', 'get_insight'].includes(n)) || !/^[a-f0-9]{64}$/.test(p.schemaDigest)) throw Error('invalid_read_tools');
  exact(p.sourcePolicy, ['id', 'revision', 'unknownClass', 'allowedClasses']); text(p.sourcePolicy.id); positive(p.sourcePolicy.revision); classSet(p.sourcePolicy.allowedClasses);
  if (p.sourcePolicy.unknownClass !== null && !classes.includes(p.sourcePolicy.unknownClass)) throw Error('invalid_unknown_class');
  exact(p.route, ['identity', 'allowedClasses']); text(p.route.identity); classSet(p.route.allowedClasses);
  exact(p.bounds, ['maxQueryChars', 'maxSearchLimit', 'maxGetIds', 'maxEntityBytes', 'maxResultBytes']); Object.values(p.bounds).forEach(positive);
  return p;
}
function validateAcceptance(input: RunAcceptance): RunAcceptance {
  const a = detached(input);
  exact(a, ['ownerId', 'actorId', 'runId', 'authorityEpoch', 'revision', 'route', 'allowedClasses', 'connectionIds']);
  [a.ownerId, a.actorId, a.runId, a.authorityEpoch].forEach(text); positive(a.revision); classSet(a.allowedClasses);
  exact(a.route, ['identity', 'provider', 'modelId', 'allowedClasses']); [a.route.identity, a.route.modelId].forEach(text); classSet(a.route.allowedClasses);
  if (a.route.provider !== 'gemini' || !Array.isArray(a.connectionIds) || new Set(a.connectionIds).size !== a.connectionIds.length || a.connectionIds.length > 32) throw Error('invalid_run_acceptance');
  a.connectionIds.forEach(text); return a;
}
function callDTO(input: ToolCallRefusal): ToolCallRefusal {
  const c = detached(input);
  exact(c, ['runId', 'actorId', 'authorityEpoch', 'revision', 'executionId', 'toolName', 'argumentsHash'], ['callId', 'accountId', 'resourceId']);
  [c.runId, c.actorId, c.authorityEpoch, c.executionId, c.toolName].forEach(text); positive(c.revision);
  if (!/^[a-f0-9]{64}$/.test(c.argumentsHash)) throw Error('invalid_arguments_hash');
  if (c.callId !== undefined) text(c.callId);
  if (c.accountId !== undefined) text(c.accountId); if (c.resourceId !== undefined) text(c.resourceId);
  return c;
}
function hostMatches(a: RunAcceptance, h: Pick<HostContext, 'runId' | 'actorId' | 'authorityEpoch' | 'revision'>): boolean {
  return a.runId === h.runId && a.actorId === h.actorId && a.authorityEpoch === h.authorityEpoch && a.revision === h.revision;
}

export function createToolsOwner(options: ToolsOwnerOptions): ToolsOwner {
  const { store, registry, port, lookupAuthority, ownerId } = options; text(ownerId);
  if (ownedStores.has(store)) throw Error('duplicate_store_tools_owner');
  ownedStores.add(store);
  // Failure latch is not authority: it only prevents fallback journal writes after failed persistence.
  const persistenceFailures = new Set<string>();
  const connection = (tx: Transaction, id: string): BoundConnection => {
    const row = tx.get('SELECT * FROM tool_connections WHERE owner_id=? AND connection_id=?', [ownerId, id]);
    if (!row || typeof row.policy_json !== 'string' || sha256(row.policy_json) !== row.policy_sha256) throw Error('connection_policy_missing_or_corrupt');
    const policy = validatePolicy(JSON.parse(row.policy_json) as ConnectionPolicy);
    if (canonicalJSON(policy) !== row.policy_json || policy.ownerId !== ownerId || policy.connectionId !== id || policy.endpoint.id !== row.endpoint_id || policy.generation !== row.generation || Number(policy.enabled) !== row.enabled) throw Error('connection_policy_binding');
    return { connectionId: id, generation: policy.generation, sha256: String(row.policy_sha256), policy };
  };
  const readRun = (tx: Transaction, runId: string): { snapshot: RunSnapshot; hash: string } => {
    const row = tx.get('SELECT * FROM tool_runs WHERE owner_id=? AND run_id=?', [ownerId, runId]);
    if (!row || typeof row.snapshot_json !== 'string' || sha256(row.snapshot_json) !== row.snapshot_sha256) throw Error('run_missing_or_corrupt');
    const snapshot = JSON.parse(row.snapshot_json) as RunSnapshot;
    validateAcceptance(snapshot.acceptance);
    if (snapshot.acceptance.ownerId !== ownerId || snapshot.acceptance.runId !== runId || snapshot.acceptance.authorityEpoch !== store.authorityEpoch) throw Error('run_scope_mismatch');
    return { snapshot, hash: String(row.snapshot_sha256) };
  };
  const currentPolicies = (tx: Transaction, snapshot: RunSnapshot): boolean => {
    if (snapshot.connections.length !== snapshot.acceptance.connectionIds.length) return false;
    return snapshot.connections.every((bound, index) => {
      if (bound.connectionId !== snapshot.acceptance.connectionIds[index]) return false;
      const current = connection(tx, bound.connectionId);
      const p = current.policy; const c = p.sourcePolicy.unknownClass;
      if (current.sha256 !== bound.sha256 || current.generation !== bound.generation || canonicalJSON(p) !== canonicalJSON(bound.policy) || !p.enabled || p.route.identity !== snapshot.acceptance.route.identity || c === null) return false;
      return [p.sourcePolicy.allowedClasses, p.route.allowedClasses, snapshot.acceptance.allowedClasses, snapshot.acceptance.route.allowedClasses].every(set => set.includes(c));
    });
  };
  const currentProjection = (snapshot: RunSnapshot): boolean => snapshot.connections.every(({ policy: p }) => {
    try {
      const endpoint = registry.endpoint(p.endpoint.id); const grant = registry.currentGrant(p.endpoint.id);
      return !!grant && endpoint.url === p.endpoint.url && endpoint.account === p.endpoint.account && endpoint.resource === p.endpoint.resource && (endpoint.credentialRef ?? null) === p.endpoint.credentialRef &&
        grant.generation === p.generation && grant.schemaDigest === p.schemaDigest && grant.account === p.endpoint.account && grant.resource === p.endpoint.resource && canonicalJSON(grant.toolNames) === canonicalJSON(p.toolNames);
    } catch { return false; }
  });
  const callRow = (tx: Transaction, call: ToolCallRefusal): SQLRow | undefined => tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND (execution_id=? OR (? IS NOT NULL AND call_id=?))', [ownerId, call.runId, call.executionId, call.callId ?? null, call.callId ?? null]);
  const exactIntent = (tx: Transaction, call: ToolCallRefusal): SQLRow => {
    const row = callRow(tx, call);
    if (!row || row.execution_id !== call.executionId || row.intent_json !== canonicalJSON(call)) throw Error('intent_mismatch');
    return row;
  };
  const target = (snapshot: RunSnapshot, call: ToolCallRefusal): BoundConnection => {
    const matches = snapshot.connections.filter(b => b.policy.toolNames.includes(call.toolName as 'search_knowledge' | 'get_insight') && b.policy.endpoint.account === call.accountId && b.policy.endpoint.resource === call.resourceId);
    if (matches.length !== 1) throw Error('intent_scope_mismatch'); return matches[0]!;
  };
  const validateCallRun = (tx: Transaction, call: ToolCallRefusal): RunSnapshot => {
    const { snapshot } = readRun(tx, call.runId);
    if (!hostMatches(snapshot.acceptance, call)) throw Error('intent_run_mismatch'); return snapshot;
  };
  const persistTerminal = (tx: Transaction, call: ToolCallRefusal, state: 'completed' | 'failed' | 'unknown' | 'refused', value: ModelSnapshot, fresh = false): ToolResultRef => {
    const bytes = canonicalJSON({ ...value, intentSha256: sha256(canonicalJSON(call)) }); const ref = { id: randomUUID(), sha256: sha256(bytes) };
    if (fresh) tx.run('INSERT INTO tool_calls(owner_id,run_id,execution_id,call_id,intent_json,state,result_id,result_json,result_sha256) VALUES (?,?,?,?,?,?,?,?,?)', [ownerId, call.runId, call.executionId, call.callId ?? null, canonicalJSON(call), state, ref.id, bytes, ref.sha256]);
    else if (tx.run("UPDATE tool_calls SET state=?,result_id=?,result_json=?,result_sha256=? WHERE owner_id=? AND run_id=? AND execution_id=? AND state='intent'", [state, ref.id, bytes, ref.sha256, ownerId, call.runId, call.executionId]) !== 1) throw Error('terminal_immutable');
    return ref;
  };
  // Store constructor already holds the exclusive writer lock. Seal this owner's intents once.
  store.transaction(tx => {
    for (const row of tx.all("SELECT * FROM tool_calls WHERE owner_id=? AND state='intent'", [ownerId])) {
      const call = JSON.parse(String(row.intent_json)) as ToolCallRefusal;
      if (call.runId !== row.run_id || call.executionId !== row.execution_id) throw Error('recovery_intent_corrupt');
      persistTerminal(tx, call, 'unknown', { response: { status: 'unknown', reason: 'recovered_intent' }, dataClasses: [] });
    }
  });

  const complete = (input: ToolCallIntent, response: JsonObject, dataClasses: readonly DataClass[]): ToolResultRef => {
    const call = callDTO(input);
    try {
      return store.transaction(tx => {
        const row = exactIntent(tx, call); if (row.state !== 'intent') throw Error('terminal_immutable');
        const snapshot = validateCallRun(tx, call); const bound = target(snapshot, call);
        if (!currentPolicies(tx, snapshot)) throw Error('completion_policy_denied');
        classSet(dataClasses); exact(response, [], Object.keys(response));
        if (dataClasses.some(c => !bound.policy.sourcePolicy.allowedClasses.includes(c) || !bound.policy.route.allowedClasses.includes(c) || !snapshot.acceptance.allowedClasses.includes(c) || !snapshot.acceptance.route.allowedClasses.includes(c))) throw Error('completion_class_denied');
        const value = { response: detached(response), dataClasses: [...dataClasses] };
        if (Buffer.byteLength(canonicalJSON({ ...value, intentSha256: sha256(canonicalJSON(call)) })) > bound.policy.bounds.maxResultBytes) throw Error('model_snapshot_oversize');
        return persistTerminal(tx, call, 'completed', value);
      });
    } catch (error) { persistenceFailures.add(call.executionId); throw error; }
  };
  const journal: ToolsOwner['journal'] = {
    intent(input) {
      const call = callDTO(input);
      return store.transaction(tx => {
        const existing = callRow(tx, call);
        if (existing) { if (existing.intent_json !== canonicalJSON(call) || existing.execution_id !== call.executionId) throw Error('intent_collision'); return 'existing'; }
        const snapshot = validateCallRun(tx, call); target(snapshot, call);
        if (!currentPolicies(tx, snapshot)) throw Error('intent_policy_denied');
        tx.run("INSERT INTO tool_calls(owner_id,run_id,execution_id,call_id,intent_json,state) VALUES (?,?,?,?,?,'intent')", [ownerId, call.runId, call.executionId, call.callId ?? null, canonicalJSON(call)]);
        return 'fresh';
      });
    },
    refuse(input, _reason) {
      const call = callDTO(input);
      return store.transaction(tx => {
        if (callRow(tx, call)) throw Error('refusal_collision'); validateCallRun(tx, call);
        return persistTerminal(tx, call, 'refused', { response: { status: 'refused', reason: 'tool_refused' }, dataClasses: [] }, true);
      });
    },
    fail(input, status, _reason) {
      const call = callDTO(input);
      if (persistenceFailures.has(call.executionId)) throw Error('result_persistence_failed');
      if (status !== 'failed' && status !== 'unknown') throw Error('invalid_terminal_status');
      return store.transaction(tx => {
        if (exactIntent(tx, call).state !== 'intent') throw Error('terminal_immutable'); validateCallRun(tx, call);
        return persistTerminal(tx, call, status, { response: { status, reason: status === 'unknown' ? 'tool_unknown' : 'tool_failed' }, dataClasses: [] });
      });
    },
  };
  const resultGate: ToolResultGate = {
    async authorize(host, bindings, baseClasses, signal) {
      if (signal.aborted) return { state: 'refused', reason: 'cancelled' };
      const liveInput = await lookupAuthority(host.runId, signal);
      if (!liveInput || signal.aborted) return { state: 'refused', reason: 'authority_denied' };
      const live = detached(liveInput); const { acceptedRunHash, ...liveAcceptance } = live;
      validateAcceptance(liveAcceptance); classSet(baseClasses);
      // All persisted state is reread synchronously AFTER the awaited authoritative lookup.
      return store.transaction(tx => {
        const { snapshot, hash } = readRun(tx, host.runId); const accepted = snapshot.acceptance;
        const denied = { state: 'refused' as const, reason: 'authority_policy_or_result_denied' };
        if (live.ownerId !== ownerId || !hostMatches(accepted, host) || hash !== acceptedRunHash || canonicalJSON(liveAcceptance) !== canonicalJSON(accepted) || !currentPolicies(tx, snapshot) || !currentProjection(snapshot) || baseClasses.some(c => !live.allowedClasses.includes(c) || !live.route.allowedClasses.includes(c))) return denied;
        const results: { binding: ToolResultBinding; response: JsonObject; dataClasses: readonly DataClass[] }[] = [];
        for (const binding of bindings) {
          const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, host.runId, binding.executionId]);
          if (!row || row.state === 'intent' || row.state === 'unknown' || row.result_id !== binding.result.id || row.result_sha256 !== binding.result.sha256 || typeof row.result_json !== 'string' || sha256(row.result_json) !== binding.result.sha256) return denied;
          const call = callDTO(JSON.parse(String(row.intent_json)) as ToolCallRefusal);
          if (!hostMatches(accepted, call) || call.executionId !== binding.executionId || call.toolName !== binding.name || call.callId !== binding.callId || row.call_id !== (call.callId ?? null)) return denied;
          if (row.state !== 'refused') target(snapshot, call);
          const value = JSON.parse(row.result_json) as ModelSnapshot & { intentSha256: string }; classSet(value.dataClasses);
          if (value.intentSha256 !== sha256(canonicalJSON(call))) return denied;
          if (value.dataClasses.some(c => !live.allowedClasses.includes(c) || !live.route.allowedClasses.includes(c))) return denied;
          if (row.state === 'completed') {
            const bound = target(snapshot, call);
            if (value.dataClasses.some(c => !bound.policy.sourcePolicy.allowedClasses.includes(c) || !bound.policy.route.allowedClasses.includes(c)) || Buffer.byteLength(row.result_json) > bound.policy.bounds.maxResultBytes) return denied;
          }
          results.push({ binding: detached(binding), response: detached(value.response), dataClasses: [...value.dataClasses] });
        }
        return { state: 'allowed' as const, results };
      });
    },
  };
  const apply = (input: ConnectionPolicy, expected: string | null | undefined): ConnectionApplyResult => {
    const p = validatePolicy(input); if (p.ownerId !== ownerId) throw Error('connection_owner_mismatch');
    const bytes = canonicalJSON(p); const hash = sha256(bytes);
    const changed = store.transaction(tx => {
      const row = tx.get('SELECT * FROM tool_connections WHERE owner_id=? AND connection_id=?', [ownerId, p.connectionId]);
      const current = row ? connection(tx, p.connectionId) : undefined;
      if (current && canonicalJSON(current.policy) === bytes) return false;
      if (expected !== undefined && expected !== (current?.sha256 ?? null)) throw Error('connection_predecessor_mismatch');
      if (current && (p.generation <= current.generation || canonicalJSON(p.endpoint) !== canonicalJSON(current.policy.endpoint))) throw Error('connection_identity_or_generation');
      if (row) tx.run('UPDATE tool_connections SET generation=?,enabled=?,policy_json=?,policy_sha256=? WHERE owner_id=? AND connection_id=?', [p.generation, Number(p.enabled), bytes, hash, ownerId, p.connectionId]);
      else tx.run('INSERT INTO tool_connections VALUES (?,?,?,?,?,?,?)', [ownerId, p.connectionId, p.endpoint.id, p.generation, Number(p.enabled), bytes, hash]);
      return true;
    });
    // Durable commit wins even when projection is unavailable.
    if (changed || !p.enabled) { if (p.enabled) registry.suspend(p.endpoint.id); else registry.revoke(p.endpoint.id); }
    return { state: changed ? 'applied' : 'unchanged', sha256: hash };
  };
  const endpointMatches = (p: ConnectionPolicy): boolean => {
    const endpoint = registry.endpoint(p.endpoint.id);
    return endpoint.url === p.endpoint.url && endpoint.account === p.endpoint.account && endpoint.resource === p.endpoint.resource && (endpoint.credentialRef ?? null) === p.endpoint.credentialRef;
  };
  const owner: ToolsOwner = {
    journal, resultGate, complete,
    applyConnection(input) { apply(input, undefined); },
    applyConnectionIntent(intent) {
      exact(intent, ['expectedPolicySha256', 'policy']);
      if (intent.expectedPolicySha256 !== null && (typeof intent.expectedPolicySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(intent.expectedPolicySha256))) throw Error('invalid_predecessor');
      return apply(intent.policy, intent.expectedPolicySha256);
    },
    async restoreConnection(id, assertCurrentBinding) {
      let selected: BoundConnection;
      try {
        selected = store.transaction(tx => connection(tx, id));
        if (!selected.policy.enabled || !endpointMatches(selected.policy)) return { state: 'refused', reason: 'connection-not-enabled' };
        assertCurrentBinding();
      } catch { return { state: 'refused', reason: 'binding-not-current' }; }
      let discovered: Awaited<ReturnType<typeof port.discover>>;
      try { discovered = await port.discover(selected.policy.endpoint.id); } catch { discovered = { state: 'unavailable', reason: 'discovery-unavailable' }; }
      try {
        const current = store.transaction(tx => connection(tx, id));
        if (!current.policy.enabled || current.sha256 !== selected.sha256 || !endpointMatches(current.policy)) return { state: 'refused', reason: 'authority-changed' };
        if (discovered.state !== 'discovered') return { state: 'unavailable', reason: 'discovery-unavailable' };
        if (discovered.endpointId !== current.policy.endpoint.id || discovered.schemaDigest !== current.policy.schemaDigest) return { state: 'refused', reason: 'catalog-changed' };
        assertCurrentBinding();
        // Callback may synchronously mutate policy. Reread and install with no await gap.
        return store.transaction(tx => {
          const latest = connection(tx, id); const p = latest.policy;
          if (!p.enabled || latest.sha256 !== selected.sha256 || !endpointMatches(p)) return { state: 'refused', reason: 'authority-changed' };
          registry.restore({ endpointId: p.endpoint.id, schemaDigest: p.schemaDigest, generation: p.generation, account: p.endpoint.account, resource: p.endpoint.resource, toolNames: p.toolNames, effect: 'read' });
          return { state: 'restored' };
        });
      } catch { return { state: 'refused', reason: 'binding-or-consent-not-current' }; }
    },
    projectConnection(id) {
      const p = store.transaction(tx => connection(tx, id).policy); if (!p.enabled) throw Error('connection_disabled');
      const endpoint = registry.endpoint(p.endpoint.id);
      if (endpoint.url !== p.endpoint.url || endpoint.account !== p.endpoint.account || endpoint.resource !== p.endpoint.resource || (endpoint.credentialRef ?? null) !== p.endpoint.credentialRef) throw Error('projection_endpoint_mismatch');
      const grant = registry.currentGrant(p.endpoint.id);
      if (grant && grant.generation === p.generation && grant.schemaDigest === p.schemaDigest && canonicalJSON(grant.toolNames) === canonicalJSON(p.toolNames)) return;
      registry.approve({ endpointId: p.endpoint.id, schemaDigest: p.schemaDigest, generation: p.generation, account: p.endpoint.account, resource: p.endpoint.resource, toolNames: p.toolNames, effect: 'read' });
    },
    snapshotRun(tx, input) {
      const acceptance = validateAcceptance(input);
      if (acceptance.ownerId !== ownerId || acceptance.authorityEpoch !== store.authorityEpoch) throw Error('snapshot_authority_mismatch');
      const snapshot: RunSnapshot = { acceptance, connections: acceptance.connectionIds.map(id => connection(tx, id)) };
      const bytes = canonicalJSON(snapshot); const hash = sha256(bytes);
      const existing = tx.get('SELECT snapshot_json FROM tool_runs WHERE owner_id=? AND run_id=?', [ownerId, acceptance.runId]);
      if (existing) { if (existing.snapshot_json !== bytes) throw Error('run_snapshot_collision'); return { sha256: hash }; }
      tx.run('INSERT INTO tool_runs VALUES (?,?,?,?)', [ownerId, acceptance.runId, bytes, hash]); return { sha256: hash };
    },
    definitions(runId) {
      const snapshot = store.transaction(tx => readRun(tx, runId).snapshot);
      const definitions: ToolDefinition[] = [];
      for (const bound of snapshot.connections) {
        const p = bound.policy;
        const reader = createLuxKnowledgeReader({ port, registry, config: { endpointId: p.endpoint.id, account: p.endpoint.account, resource: p.endpoint.resource, schemaDigest: p.schemaDigest, generation: p.generation, ...p.bounds } });
        for (const name of p.toolNames) {
          if (definitions.some(d => d.name === name)) throw Error('ambiguous_model_tool_name');
          const search = name === 'search_knowledge';
          const validate = (args: unknown): boolean => {
            try {
              const a = detached(args); exact(a, search ? ['query', 'limit'] : ['ids']);
              if (search) return typeof a['query'] === 'string' && a['query'].trim().length > 0 && a['query'].length <= p.bounds.maxQueryChars && Number.isSafeInteger(a['limit']) && Number(a['limit']) > 0 && Number(a['limit']) <= p.bounds.maxSearchLimit;
              return Array.isArray(a['ids']) && a['ids'].length > 0 && a['ids'].length <= p.bounds.maxGetIds && new Set(a['ids']).size === a['ids'].length && a['ids'].every(id => Number.isSafeInteger(id) && id > 0);
            } catch { return false; }
          };
          definitions.push({ name, description: search ? 'Search bounded Lux knowledge evidence.' : 'Get bounded Lux knowledge evidence; requested IDs are unverified input.', effect: 'read', accountId: p.endpoint.account, resourceId: p.endpoint.resource, validate,
            parameters: search ? { type: 'object', additionalProperties: false, required: ['query', 'limit'], properties: { query: { type: 'string', minLength: 1, maxLength: p.bounds.maxQueryChars }, limit: { type: 'integer', minimum: 1, maximum: p.bounds.maxSearchLimit } } } :
              { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', minItems: 1, maxItems: p.bounds.maxGetIds, uniqueItems: true, items: { type: 'integer', minimum: 1 } } } },
            async execute(args, context) {
              if (context.signal.aborted) return { status: 'unknown' };
              if (!validate(args)) return { status: 'failed' };
              const gate = await resultGate.authorize({ ...context, grants: [] }, [], [], context.signal);
              if (context.signal.aborted) return { status: 'unknown' };
              if (gate.state !== 'allowed') return { status: 'failed' };
              const call = store.transaction(tx => {
                const row = tx.get('SELECT * FROM tool_calls WHERE owner_id=? AND run_id=? AND execution_id=?', [ownerId, context.runId, context.executionId]);
                if (!row || row.state !== 'intent') throw Error('intent_missing_or_terminal');
                const committed = callDTO(JSON.parse(String(row.intent_json)) as ToolCallIntent);
                const expected = { runId: context.runId, actorId: context.actorId, authorityEpoch: context.authorityEpoch, revision: context.revision, executionId: context.executionId, accountId: context.accountId, resourceId: context.resourceId, toolName: name, argumentsHash: sha256(JSON.stringify(args)), ...(committed.callId === undefined ? {} : { callId: committed.callId }) };
                exactIntent(tx, expected); const accepted = validateCallRun(tx, expected);
                if (!currentPolicies(tx, accepted) || target(accepted, expected).connectionId !== bound.connectionId) throw Error('executor_policy_denied');
                return expected;
              });
              const evidence = search ? await reader.search(args as { query: string; limit: number }, context.signal) : await reader.get(args as { ids: number[] }, context.signal);
              if (context.signal.aborted || evidence.state === 'unknown') return { status: 'unknown' };
              if (evidence.state !== 'completed') return { status: 'failed' };
              let value: ModelSnapshot;
              try { value = projectLuxResult(evidence, p, port); } catch { return { status: 'failed' }; }
              return { status: 'completed', result: complete(call, value.response, value.dataClasses) };
            },
          });
        }
      }
      return definitions;
    },
  };
  ownerBindings.set(owner, { store, registry, ownerId });
  return owner;
}
