# Debugging Naya

Investigate the host and call that actually failed. The installed app and a source-run host can use different state directories and source commits. Do not restart the owner's application, change audio routing, delete state or run a real-account smoke just to obtain a cleaner log.

## Start with safe evidence

1. Record the observed action, time window and visible state without copying the owner's utterance or account content.
2. Use **Copy diagnostics** in the app when asking for support. Review any export before publishing it.
3. Verify the running bundle/host identity and its selected data directory. [Local runtime](local-runtime.md) explains descriptors and authority; [releases.md](releases.md) owns installed-source verification.
4. Start with metadata. Request content inspection only when authorized and necessary to distinguish the remaining causes.

The canonical private database is `state.sqlite`. Operational host logs are under the selected data directory's `logs/`. They are not interchangeable: safe metadata in `host.log` does not make the entire database or every old log safe to share.

## A crash triage starts with the HIExceptions line

The first step of a Didi crash triage is one read only query: `log show --predicate 'process == "LuxDidi" AND category == "HIExceptions"' --style compact --last 1h`. It names the Objective-C exception and the thread that swallowed it, which is what a native audio fault leaves behind; the crash report alone showed only a wild program counter in a Swift runtime frame. The app also registers `NSApplicationCrashOnExceptions`, so a swallowed exception can no longer leave a corrupt process running, and the report names the exception path.

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

`didi-timeline call <session|latest>` assembles one call's ordered story from the store and every log, `didi-timeline marks` prints every `Mark distortion` press with or without a call, and `didi-timeline doctor` reports log health and the lines no session can be attributed to.

Every one of those commands only reads. #1011: `scripts/didi-timeline` used to rebuild `server/dist` when the dist was missing or older than its source, so a read wrote a build into a shared checkout. A stale, missing or older `server/dist` is now reported and the command stops with exit 1, printing the build to run first:

```sh
npm --prefix server run build
```

## Review a call in one command

```sh
node scripts/didi-timeline call latest --audit
node scripts/didi-timeline call LIVE_SESSION_ID --audit --json
node scripts/didi-timeline sessions --since 2026-10-20 --audit-summary
node scripts/didi-timeline sessions --since 2026-10-20 --audit-summary --json
```

`call --audit` prints, in order: session coverage and clock health; one row per tool call; one row per owner turn; then the aggregates. A call the store holds without a turn row is still a row of that table, with `turn` printed as `-`. `sessions --audit-summary` prints the same aggregates across every session with a turn or a call since the date. `--json` is the stable shape and carries its own schema number (`version`), so a reader pins a number rather than a field list.

| Column | Means |
| --- | --- |
| `turn` | the turn id (`<liveSessionId>:t<n>`), the same id every log line inside that turn carries |
| `call key` | the one key a tool call keeps across its admit, dispatch and outcome lines, and the store's `trace_call.call_key` |
| `tool` | the tool name the model called |
| `execution` | `executionMs`: the call's own execution span, absent when the trace has no pair of stage receipts |
| `total` | `totalMs`: the store's measured intent-to-output duration for the call |
| `outcome` | the call's closed outcome: `completed`, `failed`, `refused`, `blocked`, `cancelled` or `unknown` |
| `refusal` | the closed refusal code from the outcome line (`grant_not_permitted`, `invalid_arguments`, `unknown_tool`, `no_owner_input`, and the rest of that union); `missing` when the outcome line named none |
| `ownerFinal` | when the owner's last finished transcription of the turn landed, epoch ms, from the `owner_final` line |
| `providerFirstAudio` | when the provider's first audible frame of the turn arrived, from `live_first_audio` or `live_answer_audio` |
| `nativeFirstAudible` | the turn's first audibility receipt from the native player, from the trace store |
| `firstSoundProvider` | `providerFirstSound - ownerFinal`: the wait the owner sat through before her voice existed. A first sound, not an answer |
| `firstSoundNative` | `nativeFirstSound - ownerFinal`: the wait until her first sound reached his speaker. A first sound, not an answer |
| `answerComplete` | the last drain among the turn's own playback segments minus `ownerFinal`: the wait until the answer had finished playing. Only when every segment of the turn drained and every response the log heard produce audio owns one of those drained segments: a segment still playing, interrupted or absent, or a continuation whose playback receipt never arrived, leaves it `missing`, because `trace_turn.playback_drained_at` is the earliest drain and cannot stand for completion |
| `segments` | how many playback segments the store joined to this turn. A `0` beside `no_native_receipt` says the app's receipt never joined the turn, which is a different fact from a receipt the app never sent |
| `flags` | the inverted pairs of the row, e.g. `final_after_provider_audio`: the end receipt is stamped before the final it is measured from. The measurement is then `missing`, never a clamped zero |
| `missing` | why a measurement is absent (`no_owner_final`, `no_provider_audio`, `no_native_receipt`) |
| `no_provider_audio` reading | `fragment` when the next owner final follows within `FRAGMENT_FOLLOW_MS` (5 s) and is answered, because the turn splitter writes one final per fragment of one spoken sentence; `unanswered` otherwise, including the last final of a call |

`no_native_receipt` is not a lost transcript. It means the turn has provider audio and no native audibility receipt on its row. #1011 replays both shapes in `server/test/trace.test.ts`, and the store is not where either is refused: a `playback.audible` that lands after the host's `response.terminal` and `turn.closed` still sets `trace_turn.first_audible_at`, because `playback.audible` in `server/trace/record.ts` writes the playback row and the turn through `playback_key` alone. What does lose the receipt is attribution: `#playbackAttribution` in `server/live/index.ts` caches the turn that was open when the first receipt of a segment arrived, so a segment received with no open turn records with `turn_id` NULL and joins no turn ever after. The audit now shows that: `segments` stays `0` on the turn, and `playback segments attributed=... unattributed=...` counts the receipts the store could not tie to a turn. What she said is still in `live_journal` as `outputTranscription` and in the turn's `trace_utterance`; the receipt, not the text, is the missing row.


The aggregates are the five slowest calls, the refusals counted per code, the calls that did not complete grouped by tool, outcome and code, the turns over four seconds from final to first sound, the announced claims the turn never acted on, and the dead-air events. `first sound coverage owner-turns=N provider=a/N native=b/N answer-complete=c/N` is the denominator behind every one of those waits: a `p50` over two of nine turns is not the call's latency, and a measure with no receipt prints `missing` rather than a zero. A call counts as a refusal by its refusal code whatever its outcome string says, because the store records a real refusal as `failed` with the code on the row; an outcome that named no code counts as `uncoded`. Refusals print `none` only when the store carried refusal data and it was empty, and `missing` when the window or the store has none. `sessions --audit-summary` adds counts per tool, p50 and p90 latency per tool, refusals per code, and p50 and p90 of the owner-final-to-audio wait.

A missing measurement prints as `missing` or `null` and is never printed as zero, so an absent native receipt cannot read as an instant answer. A missing number is answered by a missing receipt, never by inference from a neighbour.

The output carries ids, durations, counts and closed codes only. It carries no transcript, no prompt, no mail, calendar or chat content, no tool argument and no tool result, with or without `--content`, because the audit reads only metadata columns and the metadata-only log envelope.

The envelope is what makes the join possible: every host log line emitted inside a turn carries `turnId`, and every tool-call line carries `callKey` and the tool name, so `grep <call_key> host.log` returns exactly one call's lines. `msSinceReady` and `msSinceOpen` on `live_first_audio` measure the provider's own open, not the wait the owner felt; the owner-facing wait is `finalToProviderFirstAudioMs` on that same line and `msSinceOwnerFinal` on `live_response_latency`. `msSinceResponseCreated` is the time from the provider announcing a response to its first audio: it is not owner-facing latency, because it excludes everything between his last word and that announcement.

`latest` means latest Live session. A chat run ID is not its conversation session ID. [Diagnostic store](diagnostic-store.md) owns the table relationships, gated `--content` inspection and read-only SQL recipes.

A voice that changes inside one call is read from two closed events, never from listening back, because no audio is kept. `live_voice_profile` is written once per model response that played audio, with `liveSessionId`, `generation`, a closed `responseId`, `audibleMs`, `f0Hz` (median fundamental over voiced frames), `f0P10Hz`, `f0P90Hz`, `voicedRatio` and `rmsDbfs`, measured on the output PCM the host already forwarded to playback. `live_voice_shift` follows the profile it was measured against when that response's median F0 differs from the session's running median by more than the configured ratio (default 1.35x, roughly the female-to-male speaking-pitch gap). `didi-timeline call <session>` prints the `f0Hz` column per response, so a female-to-male switch shows as a ratio beyond the band on one `live_voice_shift` line, not as an inference: a `voicedRatio` near zero means the response was mostly silence or noise and its pitch line should not be read as a voice at all.

## When she sounds wrong: read a distortion mark

The owner presses the status menu item `Mark distortion` at the moment he hears the distortion. One
press appends one `audio_distortion_mark` line to `native-live.log`; nothing is recorded, in memory or
on disk, and no device property is written. A mark works with no call running, which is the case he
reports, and it carries the call id only when a call was running.

```sh
node scripts/didi-timeline marks
node scripts/didi-timeline marks --json
node scripts/didi-timeline call latest        # marks made inside a call appear in the story
/usr/bin/log show --start "<t-5m>" --end "<t+1m>" --style compact \
  --predicate 'process == "coreaudiod" OR eventMessage CONTAINS "setPlayState" OR process == "audiomxd"'
```

`marks` prints every press in the day's logs, oldest first, including the ones no call can be
attributed to. The last line counts them and says how many happened inside a call. Run the `log show`
command around the mark's own timestamp when the Mac's own audio daemon may be involved.

| Field | Means |
| --- | --- |
| `output` | the output device UID and its transport: `built-in`, `Bluetooth`, `USB` |
| `volume` | every volume control the device publishes, as `element=value`; a device with a master and two channels lists three, and an unreadable control is left out rather than shown as zero |
| `voiceProcessing` | `on`, or `off/<reason>`. With no call it reads `off/no_call`; inside a call the reason is `output_not_builtin`, `device_busy` or `vpio_failed` |
| `engine` | the build generation this mark belongs to. Two marks with the same number heard the same engine |
| `lastChange` | what last moved the graph: `route_change`, `configuration_change` or `none` |
| `ducking` | what the build asked for and what CoreAudio read back, so a lost minimum ducking is visible |
| `overSamples` | samples at or over -3 dBFS in the window that was open, measured on the decoded provider PCM before any OS processing |
| `flatTopRuns` | runs of identical loud samples, diagnostic only: a flat top is what clipping looks like in PCM |
| `overloads` | processor overload notifications on this output since the call's build |
| `load` | the load average as the press found it |

`playback_level` in `audio.log` carries `outputVolume`, `voiceProcessing`, `overSamples` and
`flatTopRuns` too, so a level line reads with the slider and the voice stage it was played at.
`output_volume` records the same device, transport and volume set before call preparation, after route
selection, after teardown and on every default-device change; `output_volume_changed` records a
volume property notification on the current output. A notification never says who changed the volume,
so no record claims a writer.

## Read one line of host.log

Every host.log line carries the same envelope, so a call can be assembled without guessing:

| Field | Meaning |
| --- | --- |
| `timestamp` | wall time, ISO milliseconds UTC |
| `monoMs` | milliseconds since this process started, from the monotonic clock |
| `pid`, `seq` | the process, and this process's line counter: a gap is a lost line, not a gap in time |
| `level` | `debug`, `info`, `warn` or `error`, from the event name, never from the caller |
| `cause` | `tool`, `provider`, `owner`, `network`, `audio`, `host`, `connector` or `config`, on the lines whose name states a domain |

A `live_rebuild` and a `live_recovery` line read their `cause` off the outcome, never off the event name. `network` needs a transport receipt: an upstream drop, a missing pong, a stall, a socket error. A planned delivery rebuild is `cause=host`. A model that went quiet, and the recovery that follows it, are `cause=provider`. Read the closed trigger actually recorded; do not assign an old lookup-context trigger to a helper delivery reconnect. A reason the host does not recognize stays unknown rather than becoming a guessed network fault.

The silence lines carry no static `cause` at all: `live_heard_silence` and `live_dead_air` name what really owned the silence in their own `silence` field (`tool`, `provider` or `owner`). When a socket closes, its close code and a sanitized reason (no URLs, no tokens) sit on that session's outcome and on the next `live_rebuild` or `live_recovery` line, so "the provider dropped us" is a receipt and not an inference.
A `live_dead_air` and a `live_rebuild` line also carry `responseCreated` and `msSinceResponseCreated`: whether the provider announced a response for the owner final now in flight, and how long ago it did. `responseCreated=false` is a model that never spoke; `true` with a small age is a response the host saw begin and could not read, which is what separates model silence from a provider stall. The pair is telemetry only: no recovery, reconnect or rebuild rule reads it.
| `liveSessionId`, `generation` | the call every live line belongs to, and the provider session inside it |
| `runId`, `taskId`, `endpointId`, `attempt` | the same joins on chat, helper and connector lines |

A normal end (`closed`, `voice_stop`, `user_stop`, `idle_timeout`, and a `shell_lost` close) is `level: info` on a `live_terminal` line; only a failing end is a `host_error`. On a `live_terminal` and a `session_end` the `cause` follows the code in the record: `shell_lost` is the supervised shell disappearing, so `cause=host`; `session_lost` is the app's socket closing with no terminal frame while the host kept running, so `cause=provider`; every end the app asked for stays `cause=owner`. One `clock_sync` line follows every host start and every call open: it carries the wall time and this process's `monoMs`, so two processes' clocks can be ordered against each other. Never sort raw `monoMs` values across processes.

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

For helper work, follow the task id, revision, operation id and delivery generation from `server/tasks/`. A started read, a completed read, a committed effect and a delivered answer are different observations. A busy helper is not a stalled voice provider. Keep closed failure reasons and the returned repair guidance; never infer success from the model's wording.

Old JSONL debug journals can contain private content. Current metadata readers are not permission to upload those directories. Preserve evidence for authorized local inspection; do not delete unknown files or promise forensic erasure.

## Verification after diagnosis

Reproduce the defect with a targeted synthetic fixture or concrete authorized observation, then fix the owning layer. [Checks](checks.md) names the existing producers; [local development](local-development.md) explains local commands and browser/compile prerequisites. Real-account probes, audio hardware checks and installed-app lifecycle work require separate authorization and cannot be inferred from an offline green suite.

## Direct asks, safe receipts and calendar validation

`server/tasks/authority.ts` owns direct asks, outside-text exposure, exact open provenance and later calendar-delete confirmation. There is no phrase gate or expiring owner-request verb set in this task path. A pending or unknown operation cannot be retried as a new effect. Inspect the stored operation receipt before claiming an open or save succeeded.

Arguments are checked against each tool's declared schema. A bad shape goes back to the helper with repair guidance, not an invented empty result. Preserve closed validation metadata and never log argument values.

### Lookup silence and unfinished chat reads

Follow actual task state and delivery receipts. Work may finish while voice is disconnected; a retained result is not proof of spoken playback. An old revision must not become the current answer after a correction.

An ambiguous or missing chat channel is a completed, speakable empty read, not a handler
failure. A read handler that throws closes its journal row as failed. A completion
transaction that rolls back can still write that failed terminal; a storage failure
that also prevents the failure write remains a reported `tool_journal_failed`, never a
successful read. No software can promise persistence while storage refuses every write.

`scripts/didi-timeline call <session> --audit` counts finalized lookup announcements such as “looking this up”,
“let me check”, and “one second, checking” with no following tool call in the same turn.
This count does not export transcript text. It is a lower bound when content has been
pruned, and is merged with the host's existing no-call receipts without double-counting
the larger of the two counts.

Status tick regression: `bash Tests/DidiStatusTests/check-status-quiet.sh` runs headless with a base-red proof; live calls still poll every two seconds, but unchanged status fields and orb click-through do not write, and notification capability refreshes only at launch, activation or explicit permission request. Installed WindowServer rate acceptance belongs to a separately authorized owner observation, not shared-desktop UI tests.

### Where a turn's time went

One audit row per owner turn now carries the whole decomposition: `speechEndToFinalMs` (the capture
path's own end of speech to the owner's final), `finalToCreateMs` (the final to the first response's
create), `createToFirstAudioMs` (that create to the first PCM), `toolOutputToCreateMs` (the last tool
output written to the continuation's create) and `connectorMs` (every connector request the turn made,
from `connector_request`). `node scripts/didi-timeline call <id> --audit` prints them under a `latency`
table; a step the turn did not take prints a dash, because an absent segment is never a zero.

`response_first_audio` is the segment's own receipt: `firstItemAt` is the provider's first output-item
envelope and `firstAudioAt` the first audible PCM. An audio-first response delivers its PCM BEFORE the
item envelope, so `firstItemAt` can be later than `firstAudioAt` or absent; the pair is written as
measured and never clamped. `provider_output_ack` closes the other wait: the call and the milliseconds
between the output going out and the provider opening the response that carries it.

A playback segment's `audible` instant is the native device's first audible chunk, which is the same
chunk `received` names, so the timeline prints `same-chunk` there instead of a second stamp that would
read as a 0 ms audio path.
