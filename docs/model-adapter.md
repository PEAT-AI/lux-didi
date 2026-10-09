# Portable model adapter

`server/adapters/model/index.ts` exposes the asynchronous `ModelPort`, native-fetch
`GeminiAdapter`, and deterministic `runTools` orchestration. No SDK, Pi, Llama,
HTTP server, database, credential file, global environment loading, or real effect
handler is part of this unit. All automated tests are offline injected HTTP/SSE
fixtures with synthetic content and synthetic credentials.

## Integration

SERVICE owns package installation/compilation (Node >=26, strict TypeScript ESM,
`.js` imports). Include `adapters/model/**/*.ts` and `test/model.test.ts` in the
SERVICE build. `bash scripts/check-model.sh` compiles just this unit and executes
Node's test runner. It uses installed `server/node_modules`, or the sibling
SERVICE worktree's installed TypeScript/@types/node when this isolated worktree
has no manifest. `DIDI_TYPESCRIPT_ROOT` can identify an already installed tooling
root; the script never downloads tooling or changes manifests. No runtime sibling
implementation imports exist.

The host supplies:

- An explicitly configured model ID, a single named key reference and an injected
  credential resolver. The adapter does not select the newest model or probe
  availability. A later authorized synthetic deployment probe must verify the
  configured model/key. Changing provider means injecting another `ModelPort`;
  there is no implicit failover.
- An explicit enabled route bound to `gemini`, the exact model ID and permitted
  data classes. Every request class and selected evidence class must be allowed
  **before payload construction, key resolution or network**. Classification and
  external-processing consent belong to the host; this is not a content scanner.
- Host-authored system/context inputs, prompt version, selected evidence IDs and
  a bounded evidence character budget. No archive/session is appended implicitly.
  Whole evidence snippets that exceed the remaining budget are omitted, not
  silently clipped. Omission IDs include unselected snippets. The budget measures
  snippet text; total serialized request also has a 1 MB cap and 100-content cap.
  Metadata hashes the actual serialized provider request with SHA-256 (not the
  credential). Generic persona and any private local overlay remain separate,
  host-versioned inputs; the transport hardcodes no personality.
- A signal and absolute epoch-millisecond deadline. Deadline uses the real wall
  clock; an injected monotonic `now` measures latency only. Fixture latency is
  labelled `synthetic`, not a provider-performance claim.

Requests go only to
`https://generativelanguage.googleapis.com/v1beta/models/{configured-model}:streamGenerateContent?alt=sse`.
Model IDs cannot contain path/query characters. The key travels only in
`x-goog-api-key`. Redirects are disabled; redirected/nonmatching response URLs
are rejected. Errors contain fixed reason codes, never HTTP bodies, resolver
exceptions, credential values, or transport exception messages. A transport
injection is a trusted in-process test seam, **not an operator-configurable URL**;
an injected transport can see the key and therefore must never be untrusted.

`ModelEvent` text is provisional. Only a validated `STOP` with visible output or
function calls is `complete`. EOF without a terminal event or an incomplete SSE
frame is `truncated`; safety, model errors, empty output, cancellation, deadline
and route denial remain distinct. SSE parses arbitrary byte boundaries including
UTF-8 and CR/LF splits. Response bytes are capped at 4 MB. Final internal
`providerContent` retains opaque thought signatures and provider parts for exact
continuation; **never send these raw parts to UI or log them**. Thought text is
excluded from visible text and events; signatures are not reasoning content.

## Tools are requests, not authority

The registry is explicit: each tool declares its name, schema, validator, read or
write effect, and host-bound account/resource. Declarations derive only from that
registry, not model/handler text or request-supplied declarations. Tool arguments
are untrusted. Validators must reject undeclared fields and identity overrides;
handlers receive actor/run/authority/revision/account/resource separately from
trusted host context. Unknown tools, invalid arguments, absent grants and stale
or revoked authority produce `refused` results without handler dispatch.

`authority.isCurrent` must consult live authority/revision state before every
execution. The owning async effect port **must also atomically revalidate and
persist execution-ID deduplication at dispatch**, honoring its signal. A local
preflight cannot make an external effect atomic or undo a dispatched effect.
Cancellation of a non-cooperative port returns promptly; a dispatched write is
recorded `unknown` if interrupted/throws. An explicit handler `failed` remains
failed; completed results are preserved. Unknown outcomes stop the loop as
`uncertain`, with no transport or effect retry. Duplicate provider call IDs are
refused. If Gemini omits an optional call ID, it is not fabricated in the wire
response; the trusted execution ID remains `runId:step:index`.

Tool output is untrusted evidence returned in a `functionResponse`, never a new
registry/grant/system instruction. IDs and signature-bearing model parts survive
continuation. `LoopResult.continuation` returns host-only history for an explicit
next-turn selection, including the final complete answer. Never serialize it to
UI; the host must bound/reclassify history before reuse. Incomplete model output
is not appended as a completed turn; an interrupted tool batch may have pending
calls, so non-complete continuations must not be blindly replayed. Result values above 100 KB or unserializable values are omitted
explicitly without falsely relabelling the effect outcome. Limits are 1–32 model
steps, 32 registered tools, and 16 calls per step. Exhaustion is `limit`, never
success. A final assistant answer does not override refused/failed tool records;
clients must render those records rather than infer effects from model prose.

## Official contract evidence (retrieved 2026-10-09)

- https://ai.google.dev/api/generate-content — v1beta
  `models.streamGenerateContent`, `contents`, `systemInstruction`, candidate
  `finishReason`, `Part.thought`, `thoughtSignature`, function calls/responses.
- https://ai.google.dev/gemini-api/docs/function-calling — REST declarations,
  `functionCall`/`functionResponse`, optional call IDs and preservation of opaque
  thought signatures in multi-turn tool continuation.
- https://ai.google.dev/gemini-api/docs/models — documents the exact
  `gemini-2.5-flash` ID used by synthetic fixtures. This is **not a claim that it
  is newest or available to the deployment key**. Earlier readiness material
  mentioned Gemini 3.8; historical knowledge mentioned 3.7. Neither name was
  adopted from memory. Deployment model selection is deliberately unresolved and
  configurable (MODEL-R1); the adapter has no hardcoded default model.

No live model request was made. Fetching public documentation is not a model
availability check. Source snippets and tool text remain untrusted regardless of
persona. Host context ownership, consent and durable effect authority are
required integration dependencies, not implemented network side effects here.
