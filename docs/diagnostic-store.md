# Inspect a conversation locally

Didi's canonical local store is `state.sqlite` in the service data directory. It connects conversation entries, remembered notes, history eligibility, tool executions and diagnostic source results by explicit identifiers. Lux Knowledge remains its own source database. Mongoose remains a remote source. Recording a tool response locally does not automatically add it to later model context or merge those databases.

Use the exact data directory reported by the installed service's launch configuration. The development service default on macOS is `~/Library/Application Support/Lux Didi`. The packaged supervisor explicitly passes `~/Library/Application Support/ai.peat.lux-didi` as `--data-dir` (Sources/LuxDidi/InstalledRuntime.swift and NativeServiceSupervisor.swift). These are different runtimes. Verify the running launch identity before choosing one. The operator should substitute the verified installed prefix in the commands below. Do not search for private configuration or print provider credentials to discover it.

```sh
node scripts/didi-timeline latest --data-dir "$DIDI_DATA_DIR" --json
node scripts/didi-timeline "$LIVE_SESSION_ID" --data-dir "$DIDI_DATA_DIR" --json --content
node scripts/didi-timeline "$CHAT_RUN_ID" --data-dir "$DIDI_DATA_DIR" --json --content
```

The command opens SQLite read-only in one snapshot. `latest` means the latest Live session, not the latest text conversation. An explicit Chat run ID selects that run's canonical tool rows. `--turn N` filters traced Live turns, not independently associated source executions. It never assigns an unassociated source result to a guessed turn.

Default output contains named metadata, hashes, lifecycle states and source identities, with no transcript, argument values or result body. `--content` is an explicit local owner inspection and uses the canonical current class, revision, source and exclusion gates. A denied source does not fall back to a legacy preview or expiring adapter body. The command assumes access to the local owner database; it is not an unauthenticated network endpoint. Local and legacy executions without a durable verified source lineage show unavailable content rather than borrowing another call's authority.

Chat diagnostic context uses a closed version 2 marker in `chat_runs.trace.diagnostic`. Its epochs monotonically record actual outbound model classes and exact consumed canonical result IDs/hashes, verified dispatch references and local-history fingerprints. These are dependency metadata, not duplicated result bodies or cache-reuse events. The run is gated conservatively: consuming sensitive evidence withholds the whole run from ordinary/private-only diagnostic readers, and changing any consumed origin withholds derived content even when its target connector remains ordinary. All-class readers can still read legitimately sealed earlier rows when their recorded class is covered by a validated earlier epoch. This does not infer actual use from the route's wider permitted ceiling.

An unfinished Chat context remains unsealed. Only its active canonical owner in the same process can gate that marker; a separate CLI process withholds its content until the canonical terminal transaction seals it. Metadata remains available. Abrupt termination or recovery never fabricates a seal. Capture failure is sticky: subsequent successful trace writes, terminal writes and shutdown preserve withholding, and a stale unsealed marker remains denied after restart even if no withholding write succeeded. Logging-only failure can leave otherwise authorized model/tool work running; actual source revocation still blocks delivery. A successful result with no provable durable origin withholds diagnostics rather than claiming complete provenance. Legacy version 1, malformed and unknown markers receive no backfill.

## What is stored

| Table | Relationship and useful fields |
| --- | --- |
| `live_sessions` | `live_session_id`, lifecycle, terminal outcome, `journal_complete`, diagnostic and native coverage states, failure lower bound |
| `live_journal` | Session plus increasing `journal_id`; exact received transcript fragment text, provider sequence/event ID when supplied, connection epoch, observed receipt clock, optional provider intervals and finalization origin |
| `sessions`, `entries`, `routing_labels` | Text conversation and durable note entries; each current entry and parent label has a revision. Captured conversation text remains private unless explicitly reviewed. |
| `chat_runs`, `chat_run_policy` | Chat `run_id` points to conversation `session_id` and exact user/final entries, accepted dispatch state and frozen source labels. Run and session IDs differ. |
| `tool_runs` | Immutable accepted source/configuration snapshot, referenced by `snapshot_sha256` |
| `tool_calls` | One canonical execution per `owner_id/run_id/execution_id`; requested validated input projection/hash/fidelity, terminal result ID/hash, bounded model-facing `result_json` |
| `tool_dispatches` | One observed source attempt per execution/ordinal; actual effective input projection, logical destination, generation, binding/schema/policy/accepted-snapshot digests, attempt/wire/seal receipts, full supported normalized source text and exact stored/entity hashes |
| `tool_dispatch_reuse` | Explicit cache edge to the original dispatch, no copied body and no invented wire call |
| `tool_dispatch_coverage` | Closed failure/pre-wire/unattributed metadata. Context-free startup calls have no borrowed conversation or body. |
| `trace_turn`, `trace_response`, `trace_call`, `trace_event` | Live correlation and receipt stages. A turn that a second owner utterance replaces is closed as `superseded` and the new turn names it, so only a killed session leaves a turn open. A call's execution time is the `call.executed` to `call.output_written` span; there is no separate completion receipt. New call-result references point at canonical result identity/hash; they do not duplicate a full response. |
| `trace_playback` | Native/app playback receipts when actually reported. A segment carries the turn and the response that were open at its first receipt, and every later receipt of it reuses that attribution. `playback.audible` is the app's own first-audible-chunk receipt; until any segment in a session reports it, a started segment is unknown audibility and raises no gap, and once one does, a started answer with no audible receipt is a real gap. |
| `trace_call_result`, `trace_utterance` | The two trace content tables. A completed tool call writes its model-facing result through `recordCallResult` from the live tool-result path, which is also where the journal's tool status is settled; both tables are pruned at 30 days. |
| research receipts (`research_progress`, `research_routed`, `research_subcall`) | Metadata only. Each names the model call it answers (`callKey`, the id `trace_call.provider_call_id` also holds) so host.log and the trace read as one record, and a calendar read carries its resolved window as two dates beside the closed window kind. `continuation_deferred` is written only when a call is really awaited. |
| `history_sessions`, `history_dependencies`, `history_exclusions` | Current history class/revision, derived-session parent revisions and soft exclusions |
| `source_references` | Explicit remembered-entry source coordinates. A debug dispatch row alone does not create a remembered note. |
| `conversation_summaries` | Separate derived summary with source class/revision, not a substitute for original transcript fragments |

`result_json` in `tool_calls` is a bounded model-facing projection, not the complete source body. `source_json` in `tool_dispatches` is the full supported meaningful result that actually arrived, after verified entity reassembly. It preserves every supported text part and quoted history without a new diagnostic truncation cap. Source-side clipping and existing transport/entity limits still apply. A complete capture is not proof that the remote corpus was complete.

Supported source envelopes are all-text MCP results on Didi's closed Lux Knowledge, Mongoose, Google and Mattermost read tools. Current Lux paired `{result: sameText}` structured output is accepted only when exactly equal to its sole text block. Current Mongoose dictionary structured output is accepted only when the complete parsed JSON text dictionary equals it. Original text is retained exactly. Unknown fields, mismatched or additional meaningful structured content, structured-only results, binary/resource blocks and unsupported tools show explicit unavailable coverage. A normalized capture omits transport `_meta`, authorization/header/environment objects and RPC framing. Secret-looking words inside authorized document text remain document text.

Requested arguments are validated model arguments, before connector defaults. Effective arguments are the actual source request after defaults, one per dispatch. Their separate hashes use the exact serialized stage bytes. Closed Didi-owned field maps authorize retained values; discovered open schemas do not authorize arbitrary logging. Unknown fields and unsupported tools remain hash/count-only. Current typed Mongoose body, ticket, company, item and search pagination/detail fields are supported. Other approved Mongoose reads can execute while their inputs remain explicitly hash-only until a closed projection is defined.

The human-readable destination is `connector/endpoint_id` with account/resource metadata and exact generation/binding/schema/accepted snapshot digests. This identifies Lux, Mongoose or Gmail and the accepted binding. A hash and today's configuration cannot reconstruct a historical URL. No raw secret-bearing URL, endpoint environment or credential object is printed by this reader.

## Read-only SQL

[diagnostic-queries.sql](diagnostic-queries.sql) contains the named queries used by the synthetic reopened-SQLite replay. Direct owner SQL is privileged forensics and deliberately bypasses model retrieval gates. Do not expose these raw queries as model tools or use them to resurrect excluded content. Read-only access still exposes private content when a query selects text, arguments or results.

```sh
sqlite3 -readonly "$DIDI_DATA_DIR/state.sqlite"
```

Inside SQLite, set the exact source identity, then paste the required named query:

```sql
.parameter init
.parameter set :session 'LIVE_SESSION_ID'
.parameter set :run 'LIVE_SESSION_ID_OR_CHAT_RUN_ID'
.parameter set :conversation 'TEXT_CONVERSATION_SESSION_ID'
```

Start with `live_sessions` or `chat_runs`. For a Live conversation, run ID equals its Live session ID. For text, `chat_runs` maps the conversation to each separate run. Read `transcript_fragments` in `journal_id` order; use `canonical_calls` for requested input and the bounded model result; `source_dispatches` and `source_text_parts` expose effective requests and every full supported text part. `accepted_source_identity` joins the exact immutable snapshot. `source_reuse` resolves explicit original provenance. Inspect `capture_coverage`, `unassociated_host_coverage`, `tool_trace_stages` and `playback_receipts` before drawing timing or completeness conclusions. `memory_links` and `history_dependencies` show actual remembered-note/history relationships.

## Timing, transcription and completeness limits

Provider automatic speech recognition, generated answer text, accepted model tool context, locally written output and actual audible playback are separate facts. The UI fragment-spacing correction preserves provider text; it does not correct misunderstood words or prove recognition accuracy. This implementation does not record raw microphone or speaker audio and cannot reconstruct words the provider never transcribed. A transcript fragment is not a word-alignment record. Optional provider start/end fields are retained only when observed and are not invented per-word timestamps.

GPT Live transcript delta text appends exactly; the existing Gemini word-joining convention remains provider-specific. Native dictation cumulative replacements are separate. This adapter does not configure a separate contextual speech-recognition hint or independent final-ASR pipeline. Input finalization can be application quiet/model-start and output finalization application response-end. Inspect `final_origin`; an app boundary is not provider-certified acoustic verbatim completion.

Compare monotonic times only within an identical non-null `clock_domain`. `attempt_to_wire_ms` covers the observed attempt to the actual adapter wire checkpoint, including the initial diagnostic write and adapter queue. `attempt_to_seal_ms` also includes response receipt, verification and local persistence; it is not pure provider compute time. Wall clocks correlate approximately across native/host/provider domains. A zero or missing timestamp never proves instant execution. The current OpenAI adapter still stamps `call.executed` inside `writeAnswered` when output is prepared (server/adapters/live-voice/openai.ts); it does not produce a measured whole delegated execution start/completion pair. That split remains unavailable. Use observed MCP attempt/wire/seal clocks instead of treating preparation as execution start. First provider byte, first generated audio and first audible native receipt are different milestones. Generated text and enqueued bytes do not prove the owner heard them.

The default journal budget is 16,384 events and 16 MiB of retained payload per session (server/live/config.ts); configured bounds may differ. Reaching it records journal_limit rather than silently declaring the retained prefix complete. Coverage counts are observations, not a claim of complete capture. Pending rows, unavailable bodies, hash-only input, unknown wire status, refused pre-wire attempts and failed capture markers remain distinct. Host-wide unattributed observations cannot be assigned to a session by count or proximity. If the database and independent log both fail, no durable marker is guaranteed. Restart marks previously pending observations unknown rather than fabricating their result. Journal-limit or storage failure can make a session incomplete even when its retained text looks fluent.

Legacy trace content has a 30-day pruning policy. New trace utterances reference canonical journal rows; full source bodies reside in canonical dispatch rows. They do not inherit the ephemeral adapter payload lifetime or that trace-preview deadline. The reopened adapter-empty and simulated seven-day controls prove this distinction, not seven real elapsed days. This change does not alter the existing trace retention period or add a cleanup daemon, legacy backfill or physical erasure promise. Soft exclusion blocks gated use while privileged SQL can still see retained bytes.

## Verified Llama patterns

The source comparison used local Llama revision `14fdfc20`, read-only. Useful inherited patterns are explicit correlation/exchange ordinals, separate input/output ledgers, handling late carryover, loud persistence coverage and separate first-byte/first-audio milestones. Didi implements these through its own journal IDs, scoped connection/call keys, per-execution dispatch ordinals, explicit reuse references, native receipts and SQLite lifecycle gates. This is a reuse of verified engineering patterns, not a claim that Llama's storage, voice provider or acoustic behavior is identical.

## Focused replay

After building the service, these use generated neutral content, local SDK HTTP and temporary stores only:

```sh
node server/test/dispatch-source-envelope.integration.mjs
node server/test/dispatch-current-inputs.integration.mjs
node server/test/diagnostic-tool-cli.integration.mjs
node server/test/diagnostic-trace.integration.mjs
```

They check supported/mismatched source shapes, exact input stages, unique tails beyond20k, stored hashes, close/reopen with empty adapter memory, metadata-only defaults and content opt-in, source changes and exclusions. They make no claims about installed microphone recognition, natural voice identity or real audible delivery.

The past-session UI refreshes an archived conversation as later cursor pages arrive. The focused actual-main browser replay checks all 220 generated fixture tokens in order and the final owner correction from 223 journal rows (221 nonempty transcription fragments), then checks four interleaved owner/model fragments in a new active session. These are presentation/persistence controls, not evidence about microphone recognition or audible output.

A `research_refused` host event records closed, content-free argument validation metadata before canonical source dispatch. Retrieve its reason from the host log and the corresponding `trace_call` outcome from SQLite. `trace_call.outcome = 'refused'` can coexist with `output_written_at` because the error result was delivered to the provider. Zero `tool_calls` and `tool_dispatches` rows are expected for this pre-dispatch refusal and do not establish source unavailability.
