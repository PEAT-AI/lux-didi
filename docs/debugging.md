# Debugging Naya

Investigate the host and call that actually failed. The installed app and a source-run host can use different state directories and source commits. Do not restart the owner's application, change audio routing, delete state or run a real-account smoke just to obtain a cleaner log.

## Start with safe evidence

1. Record the observed action, time window and visible state without copying the owner's utterance or account content.
2. Use **Copy diagnostics** in the app when asking for support. Review any export before publishing it.
3. Verify the running bundle/host identity and its selected data directory. [Local runtime](local-runtime.md) explains descriptors and authority; [releases.md](releases.md) owns installed-source verification.
4. Start with metadata. Request content inspection only when authorized and necessary to distinguish the remaining causes.

The canonical private database is `state.sqlite`. Operational host logs are under the selected data directory's `logs/`. They are not interchangeable: safe metadata in `host.log` does not make the entire database or every old log safe to share.

## Diagnose an account-identity failure first

An identity failure is reported as a closed code and never as an address, a token or a URL:

- `identity_mismatch`: the connector answered for another account. The endpoint is latched until an explicit sign-in or a host restart; the matching `connector_latched` line names the endpoint id and the code, once.
- `identity_unverified`: the connector answered with no account at all, a token that cannot be decoded, or a refusal such as `credential_missing`. Same latch, same single line.
- `not_signed_in`: nothing to prove yet. The row stays parked for a sign-in.
- Mongoose: a sign-in that lands on a different Google account arrives as `signin_callback outcome=account_mismatch` (Mongoose refused it) or `signin_token outcome=identity_mismatch` (Didi decoded the minted token and refused it). Both store nothing and show the Settings sentence.
- A sign-in that never receives its callback ends with `signin_callback outcome=timeout` and a closing `signin_finished` line, so an abandoned tab is visible without reading memory.

A latched endpoint is expected to stay down: the recovery ladder does not retry it, and an owner turn never re-probes it. Sign in again, or restart the host, before investigating anything else.

## Read metadata with the repository tools

```sh
node scripts/naya-logs.mjs --help
node scripts/naya-logs.mjs sessions --since 24h --data-dir /absolute/host/data
node scripts/naya-logs.mjs errors --since 24h --data-dir /absolute/host/data
node scripts/naya-logs.mjs tools latest --data-dir /absolute/host/data
node scripts/naya-logs.mjs slow --over 5000 --data-dir /absolute/host/data
```

`sessions` distinguishes Live and chat; `--kind` narrows that view. `tools` and `slow` show recorded receipts rather than infer success from Naya's words. The reader also supports `native`, `--json` and an explicit `--lines` cap. Native records concern the app's observation, not a reconstructed provider transcript.

For a correlated call timeline:

```sh
node scripts/didi-timeline latest --data-dir /absolute/host/data --json
node scripts/didi-timeline "LIVE_SESSION_OR_CHAT_RUN_ID" --data-dir /absolute/host/data --json
```

`didi-timeline call <session|latest>` assembles one call's ordered story from the store and every log, and `didi-timeline doctor` reports log health and the lines no session can be attributed to.

`latest` means latest Live session. A chat run ID is not its conversation session ID. [Diagnostic store](diagnostic-store.md) owns the table relationships, gated `--content` inspection and read-only SQL recipes.

A voice that changes inside one call is read from two closed events, never from listening back, because no audio is kept. `live_voice_profile` is written once per model response that played audio, with `liveSessionId`, `generation`, a closed `responseId`, `audibleMs`, `f0Hz` (median fundamental over voiced frames), `f0P10Hz`, `f0P90Hz`, `voicedRatio` and `rmsDbfs`, measured on the output PCM the host already forwarded to playback. `live_voice_shift` follows the profile it was measured against when that response's median F0 differs from the session's running median by more than the configured ratio (default 1.35x, roughly the female-to-male speaking-pitch gap). `didi-timeline call <session>` prints the `f0Hz` column per response, so a female-to-male switch shows as a ratio beyond the band on one `live_voice_shift` line, not as an inference: a `voicedRatio` near zero means the response was mostly silence or noise and its pitch line should not be read as a voice at all.

## Read one line of host.log

Every host.log line carries the same envelope, so a call can be assembled without guessing:

| Field | Meaning |
| --- | --- |
| `timestamp` | wall time, ISO milliseconds UTC |
| `monoMs` | milliseconds since this process started, from the monotonic clock |
| `pid`, `seq` | the process, and this process's line counter: a gap is a lost line, not a gap in time |
| `level` | `debug`, `info`, `warn` or `error`, from the event name, never from the caller |
| `cause` | `tool`, `provider`, `owner`, `network`, `audio`, `host`, `connector` or `config`, on the lines whose name states a domain |

A `live_rebuild` and a `live_recovery` line read their `cause` off the outcome, never off the event name. `network` needs a transport receipt: an upstream drop, a missing pong, a stall, a socket error. A planned research rebuild is `cause=host`. A model that went quiet, and the recovery that follows it, are `cause=provider`. The `trigger` is a closed set too, and `line_dropped` is no longer a default: a research rebuild is `trigger=research_context`, a silent model is `no_output_after_owner` or `no_output_after_ambient`, a window end is `session_window`, and a reason the host does not recognise is a typed error rather than a guess.

The silence lines carry no static `cause` at all: `live_heard_silence` and `live_dead_air` name what really owned the silence in their own `silence` field (`tool`, `provider` or `owner`). When a socket closes, its close code and a sanitized reason (no URLs, no tokens) sit on that session's outcome and on the next `live_rebuild` or `live_recovery` line, so "the provider dropped us" is a receipt and not an inference.
| `liveSessionId`, `generation` | the call every live line belongs to, and the provider session inside it |
| `runId`, `researchId`, `endpointId`, `attempt` | the same joins on chat, research and connector lines |

A normal end (`closed`, `voice_stop`, `user_stop`, `idle_timeout`) is `level: info` on a `live_terminal` line; only a failing end is a `host_error`. One `clock_sync` line follows every host start and every call open: it carries the wall time and this process's `monoMs`, so two processes' clocks can be ordered against each other. Never sort raw `monoMs` values across processes.

Host lines carry no content: no utterance, query, address or body. The assembled utterance of a closed turn lives in `trace_utterance` where `final=1`, which is what answers "what was said"; `live_journal` keeps the fragments and an empty closing row, so every concatenating reader still yields each turn once.

## Locate the failing owner

| Observation | Distinguish before changing code | Owner |
| --- | --- | --- |
| App never reaches host readiness | Bundle runtime validity, child startup, handshake and authentication | `NativeServiceSupervisor` in `Sources/LuxDidi/NativeServiceSupervisor.swift`; `server/host/supervision.ts` |
| No microphone or output | Permission, capture format, voice processing and engine startup | `AudioOwner` in `Sources/LuxDidi/AudioOwner.swift` |
| Connector unavailable | Missing catalog, sign-in, source permission, discovery or approval | `server/host/mcp.ts`; [MCP configuration](mcp-configuration.md) |
| Mongoose endpoint refuses | That endpoint's resource-bound sign-in versus upstream data/team admission | `server/host/mongoose-auth.ts`; `server/connectors/mongoose.ts` |
| Open says it failed | Accepted handle, destination allowlist and native open receipt | `server/tools/open-handles.ts`; `Sources/LuxDidi/NativeActions.swift` |
| Long silence | Source work still pending, result written, continuation, provider audio and native audibility | `LiveSessionOwner` in `server/live/index.ts`; trace schemas |
| Memory seems stale after deletion | Current provider context versus future accepted/rebuilt context | Entry-delete path in `server/http/server.ts`; [privacy boundary](privacy-and-authority.md) |

A successful HTTP response alone does not prove an answer was spoken. A provider audio frame alone does not prove native playback was audible. A write intent alone does not prove a remote effect completed.

## Logs are closed projections

`safeEvent` in `server/host/log.ts` defines the accepted event fields. Keep new diagnostics as closed reason codes, IDs, counts and durations; never pass exception messages, tool arguments, query text, document titles or credential objects through a catch-all logger. A test in `server/test/host-log.test.ts` enumerates every event literal handed to the emitter and fails when one has no branch, so an unrecognised event is a red build rather than a silently dropped line.

A tool handler that throws after dispatch is never silent: `tool_handler_error` carries the tool name, the error class from a closed list (`Error`, `TypeError`, `SqliteError`, and `Unknown` for anything else) and the recorded closed reason. It never carries the error's message or stack, so a failing handler is diagnosable from `host.log` alone without leaking the note text, arguments or paths the handler was holding.

The Live owner records `live_dead_air` evidence separately from the nudge/recovery actions. A busy tool and a silent provider are different failures; keep their attribution rather than labeling every delay a reconnect defect. `live_heard_silence` carries that attribution as `silence` (`tool` while a call is really in flight, `provider` while the model is generating, `owner` otherwise). Trace storage and correlation are owned by `server/trace/schema.ts`, `server/trace/record.ts` and `server/trace/timeline.ts`.

One research call leaves one line per phase with its research id: `research_call_arrived` (start), `research_source` (each source settle, with `ms` and `outcome`), `research_still_searching` (the 10 s line, with `spoken`), `research_first_answer` (`kind` is `early`, `full` or `hard_stop`, with `elapsedMs`) and `research_late_findings` (`delivered` and `reason` when a block was spoken or parked). Read those five before guessing at a slow answer; `research_operation_deadline` says the host had to settle a call itself.

A research call that never read anything leaves one refusal or block line, and the reason is a closed code. `research_refused` names the argument shape that was rejected (`reason` is one of `RESEARCH_REFUSAL_REASONS`, for example `topic_length`, `lookups_count`, `lookup_history` or `entity_rewrite`) and carries the call's shape as `topicChars`, `questionChars`, `queryChars` and the closed `lookupSources`: lengths and names only, never the owner's words or a lookup value. `research_blocked` names the admission rule that applied: `no_owner_turn` (no finalized owner turn yet), `turn_spent` (this turn's one research operation is already spent), `no_turn_since_result` (the result was delivered and the owner has not spoken since) or `answer_already_given` (the model already answered this turn, so a new run would be an orphan). The model is told the same reason verbatim in the blocked reply's `reason` field, with the one-line `directive` for it. In the trace, such a call is `trace_call.outcome` `refused` (bad arguments) or `blocked` (admission), never `completed`, and the timeline counts a blocked call as `call.blocked`.

Old JSONL debug journals can contain private content. Current metadata readers are not permission to upload those directories. Preserve evidence for authorized local inspection; do not delete unknown files or promise forensic erasure.

## Verification after diagnosis

Reproduce the defect with a targeted synthetic fixture or concrete authorized observation, then fix the owning layer. [Checks](checks.md) names the existing producers; [local development](local-development.md) explains managed routing and browser/compile prerequisites. Real-account probes, audio hardware checks and installed-app lifecycle work require separate authorization and cannot be inferred from an offline green suite.
