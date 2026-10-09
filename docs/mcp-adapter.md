# Optional HTTP MCP adapter

This slice is a portable, optional adapter, **not runtime or HTTP service wiring**.
The core service has no adapter import or configured remote endpoint by default.
No account provisioning, model call, automatic configuration discovery, personal-memory
write, database, or schema-to-model publication occurs here.

## Owned seam

ESM imports in a host that explicitly opts in:

```ts
import { createMcpAdapter } from '../server/adapters/mcp/adapter.js';
import { McpRegistry } from '../server/adapters/mcp/registry.js';
import { MemoryResultStore } from '../server/adapters/mcp/store.js';
import type { McpPort, ResultStorePort } from '../server/adapters/mcp/port.js';

const registry = new McpRegistry(); // initially empty
registry.register({
  id: 'public-source', url: 'https://source.example/mcp',
  account: 'locally-selected-account', resource: 'locally-selected-resource',
  // credentialRef: 'one-locally-resolved-reference', // optional
});
registry.enable('public-source');         // connector switch: not authority
registry.allowEgress('public-source');   // separate, explicit local source egress
const adapter: McpPort = createMcpAdapter({
  registry, store: new MemoryResultStore(),
  // resolveCredential: async reference => hostCredentialResolver(reference),
});
const discovered = await adapter.discover('public-source');
// Display the discovered digest/definitions for LOCAL review. Do not send the
// discovered schemas to a model automatically. Connector enablement is not approval.
if (discovered.state === 'discovered') {
  // After an explicit local review of this exact digest, effect and scope:
  registry.approve({
    endpointId: 'public-source', schemaDigest: discovered.schemaDigest,
    toolNames: ['reviewed_read_tool'], effect: 'read',
    account: 'locally-selected-account', resource: 'locally-selected-resource',
    generation: 1,
  });
}
// Always close the SDK session when the owning host shuts down:
await adapter.close();
```

The tool name in this generic example must exist in the locally reviewed discovery;
unknown names are refused. `visibleTools(id)` only returns granted definitions.
It does not publish model tools or give a model approval authority.
`registry.disable(id)`, `denyEgress(id)` and `revoke(id)` invalidate existing authority.
Grants bind endpoint, full schema digest, exact tool-name set, locally classified read
effect, account, resource and monotonically increasing generation. Annotations, including
`readOnlyHint`, are advisory and never consulted for authorization. Calling a remotely
"read-only" tool does not prove absence of hidden side effects.

`McpPort` and `ResultStorePort` are SDK-free declarations in `port.ts`:

- `discover(endpointId)` returns `discovered` (all pages, tools, digest, observedAt) or
  explicit `unavailable`. Discovery is never a grant. Duplicate names, repeated/empty
  cursors, malformed definitions/schemas, exhausted budgets and unavailable servers
  fail without partially ready tools. Empty tool lists are valid empty discovery.
- Every discovery refresh invalidates grants. All JSON definition keys and tool-name
  order are canonicalized in SHA-256; descriptions, schemas, annotations and extensions
  are included. `notifications/tools/list_changed` immediately suspends local grants;
  refresh/review requires a new generation even if the digest is unchanged.
- `call({endpointId, toolName, arguments, generation, account, resource}, signal?)`
  returns `refused` before dispatch, `completed`, `tool-error` (`isError`),
  `protocol-error` (explicit SDK-parsed JSON-RPC error with numeric code), or `unknown`
  after possible dispatch. HTTP errors, malformed results, lost sessions, oversized
  responses, timeout and cancellation are not retried or fabricated as empty results.
  A later explicit discovery can reconnect; it cannot replay a call.
- Concurrent operations on one endpoint are locally refused (`endpoint-busy`).
  Revocation or schema notification during a dispatched call prevents publication of
  its result/handle and returns `unknown`. Local abort returns promptly; the adapter
  best-effort sends `notifications/cancelled` through the SDK with its SDK-generated
  request id and a separate deadline of at most 200 ms. Remote cancellation is unproven.
- `whenSuspended(endpointId)` is a bounded notification observer, not authorization.

## HTTP and credential policy

The exact canonical configured URL is pinned, including origin, path and query.
URL userinfo, fragments and noncanonical spelling are rejected. Plain HTTP is limited
to literal dotted-decimal 127.x.x.x or `[::1]` loopback; `localhost`, integer/hex IPs,
shortened IPv4 and nonloopback HTTP are refused. HTTPS remote endpoints remain explicit.
Redirects (including same-origin redirects) are refused, never followed.

Supported SDK fetch injection owns every outgoing transport request. Only protocol
headers `accept`, `content-type`, `mcp-session-id`, `mcp-protocol-version`,
`last-event-id`, `mcp-method` and `mcp-name` are accepted from the SDK; caller config has
no header, OAuth, Host or Origin option. Node sends no Origin and derives actual Host
from the pinned URL. A credential resolver receives just the configured reference;
its single bearer token is added only at the pinned destination. No OAuth provider
is installed, so 401 causes no token refresh, automatic discovery or retry. Tokens,
sessions, headers, response bodies and remote errors are never logged by the adapter.
Source egress and read grants are checked again after asynchronous credential resolution.

The supported SDK `client.request` API is used for explicit single-page discovery and
calls. This avoids high-level v2 `listTools` cache/aggregation/filtering and `callTool`
automatic header-mismatch refresh/retry. The SDK still owns initialization, message
validation, protocol version, sessions, notifications and parsing. The dispatch guard
also rejects any second `tools/call` dispatch in one operation. Tool-schema header
mirroring, OAuth, stdio and other transports are not supported in this slice.

## Results, resource limits and completeness

Completed states carry source endpoint/URL/account/resource/tool/digest/generation,
`coverage.completeCorpus=false`, `basis=single-tool-result`, remote-side-effects
`unverified`, and freshness `receivedAt` plus `sourceVersion=unknown`. Success is not
independent evidence of hidden effects or corpus completeness.

`projection` is a compact JSON text projection of the SDK result, with explicit
`omitted`, `originalCharacters` and `omittedCharacters` (UTF-16 code units). It is not
necessarily parseable JSON when truncated. A protocol-error projection contains only
its code. Authorized full payload retrieval is separate:

- `payload.state=available` carries an opaque handle, original byte length, SHA-256,
  explicit epoch-ms expiry and encoding `http-response-entity`.
- Original bytes are the exact retained decoded HTTP response entity, including the
  original JSON-RPC envelope or SSE framing, **not reserialized SDK output** and not
  compressed network packets. Server-side test capture independently checks equality.
- `readSlice({handle, endpointId, generation, account, resource, offset, length})`
  returns bounded bytes, or `refused`, `expired`, `unavailable`. The original endpoint,
  exact URL, grant/digest/tool, generation, account and resource are revalidated on
  every read. Copies cannot mutate stored bytes. All slices reconstruct exact originals.
- Payload-store capacity, oversize and store failures are explicit `unavailable`,
  never silent truncated success. Expired entries may be reclaimed for capacity;
  reclaimed handles explicitly return unavailable, not fake empty bytes.

`createMcpAdapter` defaults: timeout 5000 ms, response entity cap 1 MiB, 64 discovery
pages, 1000 tools, projection 2048 characters. All budgets are positive safe integers
and can be overridden via `budgets`. The HTTP notification stream is passed through to the SDK, with a cumulative
per-session byte budget equal to the response entity cap; exhaustion suspends grants
and requires explicit rediscovery. GET connection establishment is deadline-bounded,
without imposing that deadline on an idle connected stream. POST response entities
are bounded before parsing/storage. A response stream that never
finishes hits the deadline and has unknown outcome. This is **not complete corpus
search**; source-native retrieval is an explicitly granted tool call and only that
result is represented.

`MemoryResultStore` defaults: total 4 MiB, 64 entries, TTL 60 seconds, slice cap 16 KiB;
all configurable, with injected clock for expiry tests. It never evicts unexpired
entries silently. Hosts may inject a Didi-owned `ResultStorePort` implementation with
the same bounded/scope semantics. This implementation is volatile and introduces no
second database or automatic persistence to personal memory.

## Verification and provenance

Focused local/managed producer:

```sh
bash scripts/check-mcp.sh
```

This builds the strict TypeScript service and runs only `server/test/mcp.test.ts` via
Node's test runner. Managed workers execute it through their declared controller
check. Fixtures are explicitly synthetic, real localhost HTTP listeners backed by
the official server SDK, not fake success stubs. Retained independent review at the
exact pushed SHA is required; this adapter alone does not close host integration.

Dependencies: official `@modelcontextprotocol/client` **2.3.1** (runtime),
`@modelcontextprotocol/server` **2.3.1** (test only), pinned with npm integrity hashes.
Verified package root exports supply `Client`, `ProtocolError`,
`StreamableHTTPClientTransport`, `Server`, `WebStandardStreamableHTTPServerTransport`;
there is no `/streamableHttp` subpath. The supported `/validators/ajv` export supplies
`AjvJsonSchemaValidator`. Official source metadata points to
<https://github.com/modelcontextprotocol/typescript-sdk>.
SDKs are Apache-2.0; upstream copyright/attribution and full terms are preserved in
`server/adapters/mcp/SDK-LICENSE.txt` and the installed packages' LICENSE files. No
upstream SDK source is modified or copied into the adapter. Distributions must retain
these notices and dependency licenses. The licensed package metadata/types are truth,
not a claim that any separately running source is on the same commit.

A separately authorized live proof may initialize, list all tool-definition pages and
close an existing local source, with no tool execution/content query. Its public health
runtime commit and receipt commit, if present, must be recorded as observed freshness
metadata: a mismatch is not an invented failure or assumed identity. The synthetic
protocol checks do not claim that live integration was verified.
