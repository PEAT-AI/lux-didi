# Canonical tools owner

`server/tools` is an additive portable owner, **shared by the host composition and Live acceptance**. It implements the accepted model journal and result gate without changing their signatures. It uses the existing Store and MCP registry/adapter, and the accepted Lux knowledge reader. Its typed `tools` version-1 migration adds `tool_connections`, `tool_runs`, and `tool_calls`. Version 2 adds the immutable `tool_connection_semantics` discriminator table without rewriting legacy policies. There is no Chat foreign key, second database, refusal table or independent authorization registry.

## Trusted composition

Supply `toolsMigrations` when opening the existing Store, then construct one `createToolsOwner` for that Store object lifetime. Store acquires the exclusive `writer.sqlite` lock before tools initialization. Owner construction atomically seals only its own pending intents `unknown`, once. It does not replay, retry, rekey, recover another owner's rows, or use the persistent authority epoch as a process-start identifier. A second owner on the same Store object is rejected, even with a different owner ID. Host composition constructs this owner once; never create a replacement owner over a live Store.

The trusted `lookupAuthority(runId, signal)` returns live owner/actor/run/epoch/revision, the exact provider/model route, permitted classes, connection IDs, and the accepted run hash (or null). It must read application authority, not echo HostContext, connection configuration, or model input. Host grants are not this owner's permission source.

`applyConnection` takes a strict explicit `ConnectionPolicy`. No defaults: IDs, schemaVersion, enabled flag, endpoint URL/account/resource/credential reference, read-only names, approved schema digest/generation, source policy ID/revision/unknown class/allowset, route identity/allowset and positive safe-integer query/get/entity/result budgets are required. Identical canonical policy bytes are a SQL no-op; changed bytes strictly advance generation. Connection identity and endpoint ID cannot change or be deleted. SQL guards also prevent INSERT OR REPLACE from bypassing retained identity. Endpoints cannot be reused by another connection for this owner.

Policy changes commit **before** projecting suspend/revoke into the existing MCP registry. A projection error cannot undo revocation. Egress enabling and reviewed discovery are separate trusted setup. `projectConnection` approves only persisted enabled policy against matching endpoint configuration and reviewed discovery. It cannot roll a live registry back to a prior generation or reapprove a suspended generation. A newly composed registry after reopen may project persisted enabled approval; disabled policies cannot resurrect it. There is no DB/network atomicity claim. MCP's existing final transport grant reread covers credential-await suspension, not the future model transport boundary.

`snapshotRun(tx, acceptance)` participates in the supplied existing synchronous transaction. It stores immutable acceptance and every bound policy's generation, digest and exact canonical bytes, and returns the accepted hash for application authority. Identical acceptance is idempotent; differing acceptance collides. No network or awaited authority lookup occurs in the transaction. Every run update/delete and call identity/intent/argument modification is forbidden by SQL triggers. Only pending intent-to-terminal transitions are permitted; terminal bytes never change.

`definitions(runId)` produces strict `additionalProperties:false` declarations for `search_knowledge({query,limit})` and `get_insight({ids})`, limited to approved names. It binds account/resource/policy/route outside arguments. Multiple connections with colliding tool names are rejected; future name routing is not silently invented. Selected-note recall stays separate.

## Execution and continuation

The accepted loop commits journal intent before executor dispatch. Duplicate exact intent returns existing and stops uncertain; a collision throws, without creating a replacement refusal or invoking the tool again. Targetless refusal can create a terminal record only for a fresh identity. Call IDs are retained uniquely within an owner/run, including across execution keys.

Executors validate exact committed identity/arguments/scope, await live authoritative lookup, and reread the selected connection policy synchronously before calling the accepted reader. The reader forwards the signal to actual MCP dispatch. Abort before dispatch causes zero calls; abort after potentially remote completion remains unknown. Unknown completion cannot be overwritten later. Terminal snapshots contain detached model-visible JSON, intent binding hash, result ID and exact UTF8-byte SHA256 in one atomic transaction. There are no remote calls inside SQLite transactions. A failed result write is latched for that execution so the loop cannot manufacture a replacement failed receipt and continue. The latch only denies fallback writes; it is not another authorization authority.

Before **every** provider request, including initial requests and runs with no connections or no result references, the result gate verifies authoritative scope, accepted hash, exact route/classes, the current enabled policy and registry projection for each result being released. The persisted-policy reread occurs after awaited lookup, catching revocation during the await. It validates each exact result reference/hash and stored execution/name/call/arguments binding. Unknown/pending, foreign, missing, corrupt or disallowed results deny the whole request. Returned response objects are detached copies. The accepted loop retains coverage/order and response matching checks; this owner does not replace them. Gate/storage failure stops the next provider request rather than stripping evidence and continuing.

## Lux evidence coverage

The actual Lux reader and MCP adapter are used, not a direct raw-result path. The owner reads slices of at most 512 bytes, verifies complete entity length/hash/expiry and endpoint URL/account/resource/schema/generation/tool scope, decodes strict UTF8 and supports only a JSON-RPC 2.0 text-only MCP result envelope. Oversize, incomplete, expired, missing, capacity, protocol, unsupported envelope and transport errors are not empty successes. Empty valid `content:[]` is a distinct successful empty text snapshot. No upstream text is silently truncated into complete evidence. Only bounded projected text and provenance persist; the ephemeral HTTP archive/handle and credentials do not enter durable tool receipts or provider context.

The reader's `unknown` and `local-only` labels are unconditional conservative defaults, **not source-supplied prohibitions**. Explicit trusted `unknownClass` plus source/route/actor consent may create a separate classified snapshot without mutating raw reader evidence. Missing unknown policy is an invalid DTO; `unknownClass:null` denies. No markdown classification inference occurs. `projectLuxResult` additionally accepts separate trusted typed restrictions: actual local-only/non-disclosure denies, and known classes must remain allowed and are retained. The current reader does not parse arbitrary typed restriction metadata. The supported envelope rejects additional result/content forms without claiming semantic enforcement of arbitrary source metadata. Application wiring for trustworthy typed metadata is not delivered here.

Provenance preserves unknown source version, observation time, original entity integrity hash and single-tool-result coverage, with `completeCorpus:false` and remote side effects unverified. Get `requestedIds` are explicitly unverified caller input, never verified returned entities. This is not full-transcript coverage. Root-approved real endpoint/source/account policy is future configuration.

## Verification and remaining boundaries

The registered acceptance producers are `bash scripts/check-tool-owner.sh`, `bash scripts/check-model.sh`, `bash scripts/check-mcp.sh`, and `bash scripts/check-knowledge-connector.sh`. Managed workers run them only through their controller-declared check commands. The new producer stages only the affected owner/Store/model/MCP/reader integration under a temporary ESM artifact directory, uses existing installed TypeScript/Node/MCP dependencies, compiles with the repository's strict NodeNext flags and runs Node's timed test runner. Synthetic nonempty MCP requests run through the real SDK using injected fetch/credentials, no live egress. Fixture Store directories and temporary build artifacts are removed.

Still explicitly absent: Chat/host connection loader and acceptance wiring; actual account permission policy; the final credential-resolution guard at the **actual host model transport boundary**; and installed tool calling. Deferred model credential revocation is not claimed by these tests. Release assembly must register this exact producer; no package scripts, planning, CI or existing producer files are changed here.

## Runtime composition (W-C)

`server/host/runtime.ts` constructs one `composeMcpRuntime` at startup on the already-open Store. It builds a single registry, adapter and `createToolsOwner`, discovers every configured endpoint (bounded, never blocking startup), and returns a `LiveToolsComposition` shape `{ owner, connectionIds() }`. `connectionIds()` returns the ids of the configured, enabled, egress-allowed endpoints at call time. The composition is passed to `composeLive` as the trailing argument and exposed on the host result as `tools`; a missing or unreachable endpoint yields a typed error state and a refused connector call, never fabricated empty data. The grant evaluator is unchanged: discovery alone never grants authority.

### Explicit voice remembering

Live sessions declare the gateway-owned `remember_note` tool with `text` (1 to 500 characters) and `kind` (`fact`, `preference`, or `task`), and no other arguments. It executes locally, not over MCP. The **owner-trusted explicit voice memory rule** permits only this built-in write identity in `owner-trusted-reads`; explicit grant mode leaves it unapproved, and a remote MCP tool with the same name receives none of its permission. Other writes remain unapproved. Original argument validation, owner authority checks, intent journaling, result authorization and result journaling still apply.

The gateway saves the owner's finalized input transcription, not the model's proposed note. The latest finalized explicit remember command in a bounded 64-fragment journal window supplies the payload. The model text must match that payload after case, whitespace and terminal-punctuation normalization, or be a normalized substring of it. A missing finalized command refuses with `owner_transcript_not_final`; a mismatch refuses with `owner_text_mismatch`. One finalized utterance can produce only one entry; a repeat refuses with `already_remembered` and identifies the existing entry. Provenance identifies `live-voice`, the Live session id and the finalized utterance journal sequence. The entry's existing source-reference note retains `kind:<kind>` without changing its owner-authored content.

Voice remembering writes **ordinary memory only**. An explicit request to classify the note as private or sensitive refuses with `private_memory_unsupported`; it is never silently downgraded. Private notes must use an owner-controlled workflow, not this voice tool. Live-voice entries have **no deletion control yet**. Durable memory deletion is deferred to a separate wagon, not available through the Live projection or the selected-memory picker.

A successful result is only `{remembered: true, entryId}`; refusals return `{remembered: false, code}` (duplicate refusals additionally identify the existing entry). Note text is never echoed in the tool result. Naya confirms aloud only after success and otherwise reports the refusal. Saving does not modify the running session's `accepted_prompt_snapshot` or `prompt_identity`: recall occurs at the next session CREATE.


## Text chat consumption

Text chat consumes the canonical owner and the host's existing connection
selection; it does not create another evaluator, journal, result gate or schema
derivation. A frozen conversation acceptance limits which original read
declarations can be supplied. Every actual dispatch remains subject to live
owner authorization and registry revocation. The acceptance binds the provider,
model, route, permitted classes and connection policy identity, and cannot be
reused after those route inputs change. New approvals require a new conversation.

The shared model tool loop has a four-request bound in chat. Every provider
request, including an evidence follow-up, requires current conversation consent.
The model sees only the result gate's accepted projection; browser cards are
bounded markdown and permitted sources from that same boundary, not raw MCP
content or tool_calls JSON. Chat reuses the canonical gate at the finite loop
boundary before projecting the last accepted results. Denial remains denial,
never a connector-specific fallback or authority synthesized from model output.

## Connection-scoped admission (T8-FIX, council option B)

Acceptance freezes the admitted connection ID set and the route's explicit allowed-class set. Host IDs are the intersection of owner-approved local connections and usable current grants, not every endpoint with a healthy handshake. Discovery can make a connection available to a later run, but never adds it to an existing snapshot. Each execution selects only its own bound connection: unrelated connections cannot poison an otherwise authorized read. Connection policy `route.identity` is retained for legacy/audit compatibility; it is not a model-route approval and is never compared with the run route identity.

Before MCP dispatch and again before result release, the owner checks admitted membership, live authority, current approval generation/hash, local READ classification, original-schema validation and approval binding, connector restrictions, source class and result scope/freshness. Source class must be a member of each explicit applicable class set, including the run route's set; there is no ordinal class hierarchy at either gate. The bounded local `unknownClass` supplies the source classification when no approved local tool/source classification is more specific. Intent and terminal result JSON both journal the run's `routeIdentity`; terminal hashes bind it to the original intent.

New explicit owner approval adopts `bindingMode: 'connection'` and records that semantic discriminator in the version-2 table. Migration alone grants no authority to legacy rows, even if their route identity equals an endpoint ID. Host reconciliation may adopt unambiguous endpoint-bound legacy rows only from explicit bounded local configuration under the existing owner-trusted-read approval; ambiguous legacy routes fail closed. Null/absent classifications cannot become executable connection approvals. There is no wildcard route identity.

Startup preserves persisted approval fields, bounds and revocations. It compares canonical security-relevant content and uses owner CAS only when it changes; unchanged restarts do not bump generation. Newly discovered tool names, endpoint changes or classification lowering require explicit owner approval. Classification tightening and removal of previously approved tools apply immediately. Classification ordering is used only to distinguish a tightening config change from a lowering, never to authorize data release.

T8-FIX-R1 invariant coverage uses real host composition with fake connector/model transports: the actual Live acceptance builder, and the public `snapshotRun` API with chat-style route identity. W-U owns the later real ChatService extension. R4 admits this integration file to the canonical compiler; no ChatService composition is fabricated here.

## Rich, clean Live tool results

`server/tools/live-shape.ts` is the single shaping seam for the text a connector result puts in front of the model. It is pure and deterministic: `renderGoogleTool` (Gmail/Calendar), `renderMattermostTool` and `projectLuxResult` delegate to it, so Live and Chat read the same `response.text`; the full raw wire result is still retained in the MCP payload/entity store, so nothing is lost. Gmail bodies are HTML-converted and stripped of quoted chains, signatures, MIME boilerplate, inline base64 and tracking URLs while keeping sender, recipients, date, subject, labels and attachment names; Gmail lists keep sender, date, subject, snippet, unread flag and thread size. Mattermost keeps full text, author, channel, timestamp, reaction count and thread position, and drops system join/leave posts. Calendar events keep time, title, location, attendees, description and conferencing presence. Lux knowledge search keeps title, type, date, id and a substantial excerpt, and `get_insight` return bodies.

Named per-tool bounds (`GMAIL_BODY_CHARS`, `GMAIL_LIST_MESSAGES`, `CALENDAR_EVENTS`, `MATTERMOST_MESSAGE_CHARS`, `MATTERMOST_MESSAGES`, `KNOWLEDGE_EXCERPT_CHARS`, `KNOWLEDGE_HITS`) are generous, and the list bounds equal the largest slice the connector can fetch, so a list is never cut. When a bound does cut, the text says so explicitly and never mid-sentence: a lux search hit names `search_knowledge`'s real `limit` follow-up, a lux excerpt names `get_insight` with the hit id, and a single message or post cut is reported as final because those tools have no partial re-read argument (W7-R2).

Warm connectors: one `McpAdapter` is composed per host runtime (`server/host/mcp.ts`), and its `sessions` map (`server/adapters/mcp/adapter.ts`) returns the existing stdio child for every later call, restarting only after the child closes or a call fails. There is no pool and no hedging. Batch dispatch inside one provider batch is concurrent in `server/tools/declarations.ts`; same-endpoint calls run concurrently up to the adapter's per-endpoint limit (default 6) and queue beyond it, so a provider batch reaches different endpoints and one endpoint at once through one combined `toolResponse`.

## Public web evidence

Public queries use Gemini `gemini-3.8-flash` with `google_search`, low thinking, one candidate and a 1,100 output-token ceiling. The synthesis is at most 220 words with up to five cited sources. The single total deadline is 6 seconds, or 10 seconds for weather and news. An empty, ungrounded or cap-emptied result gets one broader query retry within that same deadline. No private connector context is sent.

`web_insufficient` carries the typed reason `empty`, `ungrounded`, `capped` or `reply_budget`. A success must retain at least one supported claim and source after the word cap. Reply compaction retains whole supported sentences and the first source line, and tells the model it may ask for the full result; evidence that cannot fit is insufficient, never a successful empty finding. Citation URLs and attribution have a separate 12,000 character metadata budget outside the 2,500 character spoken reply. Early replies are capped again after the pending envelope is attached and preserve the more-available sentence.

Fallback public-fact routing includes prices, versions, public names, dates, population, exchange rates and scores. Questions naming mail, calendar, chat, our, my or we never acquire web from that fallback. Explicit routed web reads are unchanged. Query bounds remove filler words before retaining whole entity, date and place tokens.
