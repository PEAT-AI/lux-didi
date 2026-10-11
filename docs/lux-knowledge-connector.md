# Optional local Lux Knowledge reader

This slice is an optional, local, read-only **connector** over the accepted HTTP MCP adapter
([mcp-adapter.md](mcp-adapter.md)). It binds exactly two Lux Knowledge tools —
`search_knowledge` and `get_insight` — through the existing explicit endpoint/account/resource/
schema-digest/generation read grant.

It is **not** wired into the host, HTTP service, UI, model, Domain or chat. It declares no model
tool, makes no model call, writes no durable memory and starts no background fetch. There is no
second store, no byte cache and no protocol implementation: transport, retention and slicing stay
in `server/adapters/mcp/`. The core service has no connector import; a future composition opts in
explicitly. This unit does **not** claim user-visible connected knowledge.

## Owned seam

The only exported seam is
`server/connectors/index.ts`, re-exporting `server/connectors/lux-knowledge.ts`. It is SDK-free:
it imports only types from `../adapters/mcp/port.js` and `../adapters/mcp/registry.js`.

```ts
import { createLuxKnowledgeReader } from '../server/connectors/index.js';
import { createMcpAdapter } from '../server/adapters/mcp/adapter.js';
import { McpRegistry } from '../server/adapters/mcp/registry.js';
import { MemoryResultStore } from '../server/adapters/mcp/store.js';

const registry = new McpRegistry();
registry.register({
  id: 'lux-knowledge', url: 'http://127.0.0.1:8765/mcp',
  account: 'local-actor', resource: 'lux-knowledge:lux-knowledge',
  // credentialRef: 'one-locally-resolved-reference', // optional
});
registry.enable('lux-knowledge'); registry.allowEgress('lux-knowledge');

const adapter = createMcpAdapter({ registry, store: new MemoryResultStore() });
const discovered = await adapter.discover('lux-knowledge');       // explicit, no auto-connect
if (discovered.state !== 'discovered') throw new Error(discovered.reason);
// Explicit trusted-owner approval: binds the reviewed digest, generation and exact read set.
registry.approve({
  endpointId: 'lux-knowledge', schemaDigest: discovered.schemaDigest,
  toolNames: ['search_knowledge', 'get_insight'], effect: 'read',
  account: 'local-actor', resource: 'lux-knowledge:lux-knowledge', generation: 1,
});

const reader = createLuxKnowledgeReader({
  port: adapter, registry,
  config: {
    endpointId: 'lux-knowledge', account: 'local-actor', resource: 'lux-knowledge:lux-knowledge',
    schemaDigest: discovered.schemaDigest, generation: 1,
    maxSearchLimit: 25, maxGetIds: 8, maxQueryChars: 200,
  },
});
```

Construction performs no I/O: the connector never calls `discover`, never approves anything,
never enables egress and never grants a wildcard. It does validate the numeric budgets
(`generation`, `maxSearchLimit`, `maxGetIds`, `maxQueryChars`) as positive finite safe integers
and throws `invalid-connector-config` otherwise; they are captured once and never silently
defaulted or clamped, and later caller mutation of `config` cannot change behavior.

## Two methods, strict input

`search({ query, limit }, signal?)` and `get({ ids }, signal?)` only.

Both accept an optional `AbortSignal`, forwarded unchanged to the existing MCP
adapter. Input validation and registry preflight still run first. An already
aborted valid request is refused (`cancelled-before-dispatch`) without calling
the remote tool. In-flight cancellation remains owned by that adapter; its
structured `refused`/`unknown` outcome and reason are preserved. If completed
or error evidence arrives after cancellation, the reader returns `unknown`
(`cancelled-after-dispatch`) instead of exposing usable evidence. Exceptions
still propagate. There is no extra transport, detached race or automatic retry.

Inputs are read once as a strict plain-data snapshot; validated primitives are copied into the
outgoing arguments a single time. There is no getter re-read and no caller iterator use.

- Exactly those own keys; any extra key — including symbol and non-enumerable keys — is refused
  before any dispatch, as is any accessor property or non-plain prototype.
- `query` is a non-empty string no longer than `maxQueryChars`; `limit` is a positive finite safe
  integer within `maxSearchLimit`.
- `ids` is a dense array of unique positive safe integers within `maxGetIds`; holes, accessor
  elements, extra own keys, symbols and a custom iterator are refused.
- The tool name is a literal in the module; the arguments are built exactly as
  `{ query, limit, include_sensitive: false }` and `{ ids, include_links: false }`. There is no
  arbitrary tool name, no advanced-argument pass-through and no callback that could authorize a
  writer.

Before each dispatch the connector re-checks the accepted registry: the endpoint is enabled and
egress-approved, a current grant exists, its digest matches the reviewed `schemaDigest` (else
`schema-drift`), its generation matches (`grant-generation-mismatch`), its account/resource match
(`grant-scope-mismatch`), every visible granted tool is one of the two eligible read tools
(`ineligible-tool-granted`) and the requested tool is present (`required-definition-absent`).
Remote tool annotations, including `readOnlyHint`, are never consulted as authority.

## Result

A settled call returns `completed`, an explicit `tool-error`, an explicit `protocol-error`, a
pre-dispatch `refused` or a post-dispatch `unknown`. It never catches to empty and never retries.
The `completed`/`tool-error`/`protocol-error` shape carries:

- `classification: 'unknown'` — constant; returned markdown cannot change it.
- `capability: 'local-only'` — no model/egress capability.
- `source` — the configured source plus `observedAt` and `response.sha256` (original bytes); this
  is not proof of a live deployment revision or of classification.
- `coverage` — `completeCorpus: false`, `basis: 'single-tool-result'`, `remoteSideEffects:
  'unverified'`.
- a bounded `projection.text` with `omitted`/character counts, and a scoped `response` handle with
  `sha256`, `byteLength` and `expiresAt`, or an explicit `unavailable` reason (`capacity`,
  `oversize`, `store-unavailable`).
- `requestedIds` on `get` only — the caller's requested IDs, **not** verified returned entities.

Original bytes are retrieved only through `McpPort.readSlice` with full scope/generation/handle
checks. Expired, revoked or scoped-out handles are refused by the store and are never silently
refetched. A `completed` remote result does not prove side-effect purity, an empty textual result
is not fake coverage, and no memory-zeroization claim is made. The connector promises no complete
corpus.

## Packaging

`server/connectors/**/*.ts` is in `server/tsconfig.json`, so `dist/connectors/` is part of the
canonical build, and `dist/connectors` is listed in `server/package.json` `files`, so the packed
tarball includes it. The list is in the manifest, not in a private compiler list.

## Tests

`server/test/knowledge-connector.test.ts` runs against the real accepted adapter, a disposable
synthetic official MCP HTTP server and the real result store, with real wire capture and no live
Lux Knowledge call. It proves positive `search`/`get` round trips, exact argument constants,
malformed/extra-field refusal with zero dispatch, the required grant, writer refusal,
schema/scope/generation drift refusal, hostile/sensitive-shaped markdown staying
unknown/local-only with no extra call, per-response hashes, response/handle budgets, exact slice
reconstruction, expiry/revocation without refetch, honest `tool-error`/`unknown` outcomes, pre-abort with zero remote calls, in-flight
abort reaching the real adapter, and unusable late results for both methods.
`scripts/check-knowledge-connector.sh` compiles the canonical source and runs only this file.
