import type { McpPort } from '../adapters/mcp/port.js';
import { bindingDigestOf } from '../adapters/mcp/port.js';
import type { LuxKnowledgeResult, LuxKnowledgeSource } from '../connectors/lux-knowledge.js';
import type { DataClass } from '../adapters/model/types.js';
import type { ConnectionPolicy, ModelSnapshot, TrustedRestrictions } from './types.js';
import { canonicalJSON, detached, sha256 } from './canonical.js';

/** Only a complete, integrity-checked text envelope becomes model-visible evidence. */
export function projectLuxResult(evidence: LuxKnowledgeResult, policy: ConnectionPolicy, port: McpPort, restrictions?: TrustedRestrictions): ModelSnapshot {
  if (evidence.state !== 'completed') throw Error('result_not_completed');
  // Explicit discriminated binding digest: the connector spreads the adapter scope, so the
  // digest is present at runtime; the connector's public type is extended here (type-only).
  const source = evidence.source as LuxKnowledgeSource & { bindingDigest: string };
  if (source.endpointId !== policy.endpoint.id || source.bindingDigest !== bindingDigestOf(policy.endpoint) || source.account !== policy.endpoint.account || source.resource !== policy.endpoint.resource || source.schemaDigest !== policy.schemaDigest || source.generation !== policy.generation || !('toolName' in source) || source.toolName !== evidence.tool || !policy.toolNames.includes(evidence.tool)) throw Error('result_scope_mismatch');
  const unknownClass = policy.sourcePolicy.unknownClass;
  if (!unknownClass || !policy.sourcePolicy.allowedClasses.includes(unknownClass) || !policy.route.allowedClasses.includes(unknownClass)) throw Error('unknown_source_denied');
  const dataClasses: DataClass[] = [unknownClass];
  if (restrictions) {
    if (restrictions.localOnly || restrictions.nonDisclosure || restrictions.dataClasses.some(c => !policy.sourcePolicy.allowedClasses.includes(c) || !policy.route.allowedClasses.includes(c))) throw Error('source_restriction_denied');
    for (const c of restrictions.dataClasses) if (!dataClasses.includes(c)) dataClasses.push(c);
  }
  const payload = evidence.response;
  if (payload.state !== 'available' || payload.encoding !== 'http-response-entity' || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 1 || payload.byteLength > policy.bounds.maxEntityBytes || !/^[a-f0-9]{64}$/.test(payload.sha256) || payload.expiresAt <= Date.now()) throw Error('entity_unavailable_or_oversize');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.byteLength;) {
    const length = Math.min(512, payload.byteLength - offset);
    const slice = port.readSlice({ handle: payload.handle, endpointId: source.endpointId, generation: source.generation, account: source.account, resource: source.resource, offset, length });
    if (slice.state !== 'available' || slice.byteLength !== payload.byteLength || slice.sha256 !== payload.sha256 || slice.bytes.byteLength !== length || slice.expiresAt !== payload.expiresAt || slice.expiresAt <= Date.now()) throw Error('entity_slice_incomplete');
    chunks.push(slice.bytes.slice()); offset += length;
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== payload.byteLength || sha256(bytes) !== payload.sha256) throw Error('entity_hash_mismatch');
  const packet: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!isRecord(packet) || packet['jsonrpc'] !== '2.0' || !['string', 'number'].includes(typeof packet['id']) || !onlyKeys(packet, ['jsonrpc', 'id', 'result']) || !isRecord(packet['result'])) throw Error('unsupported_mcp_envelope');
  const result = packet['result'];
  if (!onlyKeys(result, ['content', 'isError']) || result['isError'] === true || (result['isError'] !== undefined && typeof result['isError'] !== 'boolean') || !Array.isArray(result['content'])) throw Error('unsupported_mcp_result');
  const texts: string[] = [];
  for (const content of result['content']) {
    if (!isRecord(content) || !onlyKeys(content, ['type', 'text']) || content['type'] !== 'text' || typeof content['text'] !== 'string') throw Error('unsupported_mcp_content');
    texts.push(content['text']);
  }
  const response = {
    status: 'completed', text: texts.join('\n'), source: detached(source), entitySha256: payload.sha256,
    sourceVersion: 'unknown', observedAt: evidence.observedAt, coverage: detached(evidence.coverage),
    ...(evidence.requestedIds === undefined ? {} : { requestedIds: [...evidence.requestedIds], requestedIdsVerified: false }),
  };
  if (Buffer.byteLength(canonicalJSON({ response, dataClasses }), 'utf8') > policy.bounds.maxResultBytes) throw Error('model_snapshot_oversize');
  return { response, dataClasses };
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
