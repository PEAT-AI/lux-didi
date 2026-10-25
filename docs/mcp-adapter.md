# MCP adapter

The MCP adapter implements protocol transport and accepted result handling. It is wired by the canonical host in `server/host/mcp.ts`; old descriptions of it as an unintegrated HTTP-only slice no longer describe the release.

## Components and contracts

| Symbol | Source and responsibility |
| --- | --- |
| `createMcpAdapter` | `server/adapters/mcp/adapter.ts`, transport/session composition |
| `McpPort` | `server/adapters/mcp/port.ts`, asynchronous discovery and call boundary |
| `EndpointConfig` | `server/adapters/mcp/port.ts`, HTTP or stdio endpoint configuration |
| `McpRegistry` | `server/adapters/mcp/registry.ts`, registered endpoints and approved tool context |
| `ResultStorePort` | `server/adapters/mcp/port.ts`, accepted result storage contract |
| `MemoryResultStore` | `server/adapters/mcp/store.ts`, in-memory implementation for that contract |
| `canonicalToolDigest` | `server/adapters/mcp/registry.ts`, canonical tool-schema identity |
| `composeMcpConnection` | `server/host/mcp.ts`, host-owned connection composition |

Read the interfaces for exact request/result shapes. The adapter does not select accounts, authorize arbitrary remote tools or turn a discovered schema into a model grant.

## HTTP and stdio are different boundaries

HTTP endpoints use validated destinations and credential resolution; stdio endpoints use an explicitly approved executable, arguments and environment. `validateEndpointUrl` and `validateApprovedStdioEnv` in `registry.ts` own those validation rules. Stdio is not permission to run a model-supplied command or inherit arbitrary secrets from a developer shell.

`HTTP_CONNECT_TIMEOUT_MS`, `STDIO_CONNECT_TIMEOUT_MS` and `ConnectTimeoutMs` in `adapter.ts` own connection budgets. Keep handshake, source-call and whole-operation deadlines distinct. A failed handshake is not an empty successful read, and a slow child must not hold a call indefinitely.

## Accepted evidence and revocation

A discovered tool is not yet approved. Endpoint identity, schema digest, connection generation and current policy bind dispatch. Results must pass the accepted-result and connector projection boundaries before a model sees them. Unknown result envelopes or mismatched lineage remain unavailable rather than falling back to raw response text.

`server/tools/` owns durable intent/result references and reauthorization; the adapter is not a second authority registry or a complete persistence layer. `MemoryResultStore` does not replace the host's canonical durable tool records. See [tool-owner.md](tool-owner.md) and [diagnostic-store.md](diagnostic-store.md).

## Configure and diagnose through the host

[MCP configuration](mcp-configuration.md) owns protected profiles, helper environments, sign-in and approval modes. [Connectors](connectors.md) owns source-specific envelopes and projections. Do not copy an old schema example here into a current private profile without checking the validator.

For failures, use safe reason codes and transport state, never exception bodies, endpoint environments or credential objects. [Debugging](debugging.md) explains the metadata-first workflow. [Checks](checks.md) names the adapter and connector producers; fakes do not prove that a real account is signed in.
