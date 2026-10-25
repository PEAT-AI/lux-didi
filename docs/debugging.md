# Debugging Naya from her own logs

Every store a debugger can read sits in the host data directory, which is `--data-dir`, else
`DIDI_STATE_DIR`, else the platform default the host itself uses: `~/Library/Application
Support/Lux Didi` on macOS, `%LOCALAPPDATA%\Lux Didi` on Windows, and `$XDG_DATA_HOME/lux-didi`
(or `~/.local/share/lux-didi`) elsewhere. Every reader resolves it the same way.

| path | holds | privacy |
| --- | --- | --- |
| `<dataDir>/state.sqlite`, `trace` tables | the joinable record: turns, responses, calls, playback, the event spine | metadata is content-free; two content tables are owner content |
| `<dataDir>/logs/host.log` | content-free metadata: enums, counts and timings only | safe to quote in a bug report |
| `<dataDir>/logs/native-live.log` | the app's own voice session journal: closed reason codes, counts and timings | content-free |
| `<dataDir>/logs/audio.log` | numbers only: captured and played byte counts per second | content-free |
| the unified log | the app's own OS log, subsystem `ai.lux.didi` | treat as owner content |

Three files answer three different questions. `state.sqlite` is the only one whose tables join on
host-minted ids, so it is the one to read first; `host.log` keeps the content-free metadata around
it. Canonical transcription lives in `live_journal`; canonical tool views live with their tool executions. Trace content tables retain legacy previews and new transcript references. The unified log can contain retained legacy content. The
JSONL debug journal that used to sit under `<dataDir>/debug` is gone; its event kinds are accounted
for below.

## The trace store

The `trace` migration owner lives in `state.sqlite` beside every other table, on the same
connection. Five metadata tables and two content tables share host-minted keys, so a session is one
query rather than four files that cannot be joined.

| table | holds |
| --- | --- |
| `trace_turn` | one turn: turn id, index, origin (`owner`, `assistant`, `recovery`), open and close time, monotonic ms, close reason, derived summaries, attribution flag |
| `trace_response` | one response or delegation: provider and delegation ids (nullable until observed), connection epoch, turn, status, continuation of another response |
| `trace_call` | one tool call: name, argument and result character counts, intent/execute/output-prepared/output-written times, outcome, ms |
| `trace_playback` | one audio segment: source instance, segment sequence, response and turn (nullable, audio carries no provider id), received/audible/enqueued/started/drained/interrupted times |
| `trace_event` | the append-only causal spine: seq, kind, source (`host`, `native`, `provider`), source sequence, producer wall ms, producer monotonic ms, host ingest time, schema version, typed detail |
| `trace_utterance` | canonical journal references for new transcription; retained legacy text previews, by turn and role |
| `trace_call_result` | retained legacy tool-result previews, capped at 16,384 characters with truncation flag; not full source-result durability |

The adapter and the host write every step of a call, so an absence is never the only evidence:
`delegation.created` names each delegated response with its provider id and call count,
`response.created`, `response.observed` and `response.terminal` carry the response key, the provider
ids and the terminal reason, `call.intent`, `call.executed`, `call.output_prepared` and
`call.output_written` carry the call key, the provider call id and the outcome, and
`continuation.decided` records what the single continuation owner did with the answer (`sent`,
`deferred`, `failed`) and, when it skipped, why (`awaiting_calls`, `draining`, `epoch_stale`). The
host adds `turn.opened`, `turn.closed` with its close reason, and `live.dead_air_stalled` with the
turn's age, whether any audio arrived and the inaudible milliseconds, which is the receipt D12-3 was
missing. All of it lands under the session's `connection_epoch`; a rebuilt socket gets a new epoch
and a late receipt from the one it replaced is refused as `STALE_EPOCH`.

## The host.log event catalog

The `event` value of every line in `host.log` is one name from a closed set. The authority is `server/host/log.ts`: each name below is a `value.event === ...` case in its allowlist, and a name that is not there is dropped before the line is written. The catalog is grouped by family; a line that does not appear here is a doc bug, and a new event is added to `log.ts` and to this table in the same change.

| family | events | what it answers |
| --- | --- | --- |
| `host` | `host_exit`, `host_resources`, `host_started` | start, exit and a resource sample for the host process itself |
| `launch` | `launch_kind` | what a start was allowed to do (kind, autoConnects, windowShown) |
| `live` | `live_answer_audio`, `live_attach_rejected`, `live_context_usage`, `live_dead_air`, `live_dead_air_nudge`, `live_debt`, `live_first_audio`, `live_frame_rejected`, `live_go_away`, `live_handshake`, `live_idle_arm`, `live_instruction_sizes`, `live_interrupted`, `live_mute`, `live_no_pong`, `live_provider_error`, `live_provider_open`, `live_provider_ready`, `live_read_cache`, `live_rebuild`, `live_recovery`, `live_reply_unjournalled`, `live_resumption_fresh`, `live_session_diagnostics`, `live_session_superseded`, `live_stall`, `live_started`, `live_state`, `live_tool_turn`, `live_trace_rejected`, `live_turn_open`, `live_turn_script`, `live_upstream_drop`, `live_upstream_queue`, `live_watchdog` | the call: start, frames, provider open and ready, watchdog, idle arm, state causes, dead air, debt, mute, rebuild, resume, session diagnostics |
| `voice` | `voice_stop`, `voice_stop_candidate` | the stop gate: a matched stop or a rejected near miss |
| `turn` | `turn_failed` | a turn that failed, with its closed reason |
| `playback` | `playback_rearm` | the app asked for playback to be re-armed |
| `delegation` | `delegation_closed`, `delegation_open` | a delegated response opened and closed, with its provider id and call count |
| `continuation` | `continuation_deferred` | the single continuation owner skipped or deferred, and why |
| `provider` | `provider_error_unclassified` | a provider error the adapter could not classify |
| `openai` | `openai_instructions_size` | the size of the composed OpenAI instruction sections |
| `gptlive` | `gptlive_append_ack`, `gptlive_delegation_stalled`, `gptlive_setup_error`, `gptlive_tool_output`, `gptlive_turn_complete`, `gptlive_unknown_frame` | the GPT-Live wire: setup error, unknown frame, append ack, tool output, turn complete, stalled delegation |
| `tool` | `tool_arguments_rejected`, `tool_cancelled`, `tool_ceiling_hit`, `tool_ceiling_late`, `tool_diagnostic_capture`, `tool_failure`, `tool_output_sent`, `tool_redaction` | a tool call: refusal, cancellation, ceiling, redaction, failure, send outcome, diagnostic capture |
| `research` | `research_call_arrived`, `research_first_answer`, `research_joined`, `research_late_findings`, `research_progress`, `research_refused`, `research_routed`, `research_run`, `research_source`, `research_subcall` | a research run: arrival, routing, sub-calls, sources, first answer, late findings, progress, refusal |
| `connector` | `connector_connected`, `connector_failure`, `connector_helper_stderr`, `connector_identity`, `connector_recovered`, `connector_recovery_exhausted`, `google_mcp_path_unsafe` | a connector connection: connected, identity, failure, recovered, recovery exhausted, helper stderr, the Google helper runs from under the reports folder (endpoint id only) |
| `connection` | `connection_quality` | the connection quality sample of the local socket |
| `calendar` | `calendar_digest`, `calendar_digest_refreshed`, `calendar_digest_timeout` | the calendar digest: published, refreshed, timed out |
| `chat` | `chat_timing` | one text chat turn: outcome, rounds, timing |
| `mattermost` | `mattermost_shape` | the shape of a Mattermost answer, no content |
| `mongoose` | `mongoose_catalogue_replaced` | the catalogue was replaced after a re-sign-in |
| `signin` | `signin_requested`, `signin_discovery`, `signin_registration`, `signin_browser_handoff`, `signin_callback`, `signin_token`, `signin_stored` | one Mongoose sign-in hop: the endpoint, an opaque attempt id and a closed outcome (`ok` or why it stopped; a refused token may add its RFC 6749 `oauthError`). `signin_browser_handoff ok` means the URL was handed to the operating system, not that a page showed; the `signin_callback` line proves the browser came back. Never a URL, code, state, verifier, token or registration payload |
| `memory` | `memory_note` | a memory note was written |
| `standing` | `standing_memory_selection` | which standing memory was selected for a prompt |
| `conversation` | `conversation_summary_injection`, `conversation_summary_recovery` | the conversation summary: injected, recovered |
| `opener` | `opener_plan` | the opening line plan for a new call |
| `responses` | `responses_validation_failed` | a provider responses payload failed validation |
| `session` | `session_end` | a live session ended, with its reason |
| `client` | `client_diagnostic` | a diagnostic a client reported |
| `command` | `command_rejected` | a client command was rejected |
| `commentary` | `commentary_sent`, `commentary_skipped` | a commentary line was sent or skipped |
| `config` | `config_seeded` | the config was seeded on first start |
| `consumer` | `consumer_gone_end` | the output consumer went away at the end of a call |
| `debug` | `debug_journal_removal_failed`, `debug_journal_removed` | the debug journal files were removed, or their removal failed |
| `native` | `native_action` | a native action was forwarded to the host |
| `open` | `gmail_account_unknown`, `open_claim_corrected` | a Gmail link fell back to account `/u/0` because the mailbox proved no account (once per session); an open claim was corrected |
| `thinking` | `thinking_sent` | a thinking line was sent |
| `uplink` | `uplink_shed` | uplink backpressure shed a frame |
| `vault` | `vault_write` | a vault note was written |
| `warm` | `warm_prewarm` | the warm context was prewarmed |

Since release 10 the dead-air recovery is legible from `host.log` alone. `tool_output_sent` carries what
the adapter reported for the answer (`outcome`: `sent`, `deferred` or `failed`). `live_debt` records the
audible debt clock as content-free enums and nothing else: `phase: start` with `reason: tool_output` or
`recreate`, `phase: clear` with `reason: audible`, `owner_barge_in` or `turn_end`, and `phase: rung` with
`reason: dead_air` at 8 s, `rebuild` seven seconds later when she is still mute, or `send_failed` at once
for a write the adapter refused. `research_call_arrived` carries the call's shape and never the owner's
words: `action`, `researchIdPresent`, `questionChars` and `lookups`. A result that came back and was never
said is handed to the session that is open as one text item, and `live_unspoken_delivered` names how many
results it carried and which attempt landed.
No duration, no text and no provider word is in any of them, which is why model text, a model turn start
and output transcription can re-arm the response watchdog and still never clear this clock. `turn_failed`
names its reason from the closed set `provider_error`, `delegation_stalled`, `send_failed`, `recreate_failed`,
so the one line she speaks and the log agree.

Only the last two tables hold owner text. Every metadata column is an id, a closed code, a count or
a duration: the writer refuses any field outside its allowlist, so a provider message, a tool
argument, a result preview, a transcript snippet, a path or a title has nowhere to land. A turn
opens at the earliest reliable owner-utterance boundary, never on raw mic frames. Under full duplex
turn N stays open while turn N+1 opens, and nothing is silently reparented.

Every event carries three times: the producer's wall ms, the producer's monotonic ms, and the host
ingestion time. Within one clock domain an interval is exact; an interval between the host clock and
a native instance clock is approximate and is labelled so. Host and native monotonic values are
never subtracted from each other. A native receipt carries `source_instance_id` and `source_seq`,
dedups on that pair, and the reader reports a missing sequence range rather than hiding it.

Retention covers the two content tables only: rows older than 30 days are pruned at host startup.
Metadata rows are untouched by that pass. Deletion is logical, so SQLite WAL frames and free pages
are not forensically erased; see `docs/privacy-and-authority.md`.

## The native logs

`native-live.log` and `audio.log` are the app's own files, so every line carries what a join needs
and the host's record does not: `source_instance_id` (one per app launch), `source_seq` (strictly
increasing per instance), `mono_ms` (the app's own monotonic clock) and a fractional wall time in
`timestamp` plus `wall_ms`. Inside a call every line also carries `liveSessionId`. Both files rotate
at 5 MiB with two rotations (`<name>`, `<name>.1`, `<name>.2`), the shape `host.log` already uses,
so neither grows without a bound.

Five records answer what a launch and a stop did, all content-free: `launch_kind` (the kind, `autoConnects`, `windowShown`, in `native-live.log` and, through the client diagnostic route, in `host.log`; a Dock reopen is its own kind, `reopen`, with `windowShown` false), `startup_prompt` (`prompt` of `grant_alert` or `getting_started`, and `decision` of `deferred`, `shown` or `skipped`, so a prompt that waits for the owner's first window is visible), `goodbye_tone` (`played`, and a `reason` of `no_buffer` or `output_refused` when nothing sounded), `live_stop_outcome` (`confirmed` when the host closed the wire inside the deadline, `host_ended` when the host announced its own voice stop so there is no close receipt to wait for, `deadline` when it did not) and `live_restart` (`reason`). A `presence_state` move to `cold` with trigger `error` is the uncertain session: the socket closed without a terminal frame and presence went cold with no reconnect.

A display change writes `orb_screen_parameters` (`screens`, the count, and `orbScreen`, `main`, `other` or `none`), so an orb that moved after an unplugged screen is explained without a rectangle.

The app forwards its playback receipts (received, enqueued, started, drained, interrupted,
terminated) to the host over the live socket it already holds. Each is one bounded frame with
`segment_seq`, `source_instance_id`, `source_seq`, `mono_ms` and `wall_ms`; the host validates it
against a closed shape, refuses an unknown or free-text field, records it as a `native` trace event
plus its `trace_playback` row, and dedups on `(live_session_id, source_instance_id, source_seq)`. A refused frame is
journaled by typed code and never changes session state. `response_key` and `turn_id` on a playback
row are set only when the host knows them for that segment; a segment the host cannot attribute is
printed outside every turn with `turn=none`, never guessed into one.

## The SQL timeline

`scripts/didi-timeline` reads `state.sqlite` only and prints one timeline. It never reads the
`host.log`. Every command accepts `--data-dir <path>`.

```sh
scripts/didi-timeline latest                                  # the most recent traced session, content hidden
scripts/didi-timeline <sessionId> --turn 3                    # one turn, its responses, calls and playback
scripts/didi-timeline <sessionId> --content                   # add transcript lines and tool result text
scripts/didi-timeline <sessionId> --json                      # the report as JSON, no owner text unless --content
scripts/didi-timeline --export-metadata --session <sessionId> # named metadata columns only, never a dump
```

Tracks overlap as the session did: while turn N's answer plays, turn N+1 prints as its own open
turn, and the playback line stays under turn N. A `GAP` line is a typed obligation with the receipt
that would close it, not a long interval:

- `no_delegation`: a response was created and no provider response or delegation id arrived.
- `no_response`: a continuation was sent and no provider response came back.
- `no_continuation_decision`: a call batch settled and no continuation response or turn close followed.
- `no_audible_output`: an answer completed and no playback segment became audible.
- `no_playback_drain`: playback started and no drain, interruption or termination followed.

Interrupted, superseded or intentionally silent work owes nothing and is never labelled a stall.
Outstanding obligations are listed at capture time, so a timeline taken mid-turn states what was
still owed, not a verdict. `NATIVE-GAP` reports an interior hole in a native instance's own
sequence.

## What the JSONL debug journal used to write

The JSONL journal (`<dataDir>/debug/<day>/<session>.jsonl`) is gone: `server/host/journal.ts` was
deleted with release 3s, because the trace store replaced it. This table accounts for every event
kind it wrote. **Replaced by** names the trace kind or table that now carries the fact; **retained
in** names the log that already carried it; **dropped** means nothing needs it and why.

| journal kind | where it lives now |
| --- | --- |
| `session_start` | replaced by `trace_turn` and `live_started` in `host.log` (provider, model, voice) |
| `session_end` | replaced by `turn.closed` (`session_end`) and `session_end` in `host.log` |
| `transcript` | replaced by `trace_utterance` (owner and model text), legacy previews; new words are canonical journal rows referenced by trace |
| `turn_start` | replaced by `turn.opened` |
| `turn_end` | replaced by `turn.closed` with its close reason and outcome |
| `interrupt` | retained in `host.log` as `live_interrupted`; the turn closes as `interrupted` |
| `tool` | replaced by `call.intent`, `call.executed`, `call.output_prepared`, `call.output_written` and `trace_call_result` for the result text |
| `model_round` | retained in `host.log` as `chat_timing` (rounds, fence, acquire, answer ms) |
| `audio` | replaced by `playback.*` receipts and `live.dead_air_stalled`; the byte counts stay in `host.log` |
| `audio_marker` | replaced by `live.dead_air_stalled` (`anyAudio`, `inaudibleMs`) and `live_stall` in `host.log` |
| `deadline` | retained in `host.log` as `session_end` reason and `turn_failed` |
| `turn_failed` | retained in `host.log` as `turn_failed`, with a reason from `provider_error`, `delegation_stalled`, `send_failed`, `recreate_failed` |
| `provider_setup` | retained in `host.log` as `live_started` and `gptlive_setup_error` |
| `provider_error` | retained in `host.log` as `live_provider_error` and `provider_error_unclassified` |
| `provider_close` | retained in `host.log` as `session_end` |
| `context_usage` | retained in `host.log` as `live_context_usage` |
| `continuity` | retained in `host.log` as `live_recovery`; the turn closes as `recovered` |
| `recovery` | retained in `host.log` as `live_recovery` |
| `playback_receipt_rejected` | retained in `host.log` as `live_trace_rejected` (kind plus the store's typed code) |
| native `native` receipt | retained in `native-live.log` and `host.log`; the stored rows also carry it |

Every trace kind above is allowlisted in `server/trace/record.ts`: ids, closed codes, counts and durations only. Legacy trace content remains in `trace_utterance` and `trace_call_result`; new text and source results have canonical owners described in [the diagnostic store guide](diagnostic-store.md).

### Removing the old day directories

The journal wrote `<dataDir>/debug/<YYYY-MM-DD>/<session>.jsonl` with owner content inside. Nothing
writes there any more and nothing reads it, so the host removes that exact directory once at start
and writes one `debug_journal_removed` receipt with the byte count; a start that finds no journal
writes no receipt, and nothing else in the data directory is touched. A directory it cannot remove
(say a read-only subdirectory left by hand) never holds the start up: one
`debug_journal_removal_failed` receipt names the errno token, and the directory stays for the owner.

To do it by hand instead, on a host that has not started since this change:

```sh
rm -rf "$HOME/Library/Application Support/Lux Didi/debug"
```

On Linux substitute the state directory (`${XDG_DATA_HOME:-$HOME/.local/share}/lux-didi/debug`).
The files hold transcripts, and deleting them is the point.

## The reader

`scripts/naya-logs.mjs` reads `host.log` and prints aligned plain text, capped at 200 lines per
command. Every command accepts `--data-dir <path>`, `--json` and `--lines <n>`. `host.log` is
content-free by contract, so nothing it prints is owner text; for the per-turn record, including
what was said, read the trace store with `scripts/didi-timeline` (see the SQL timeline above).

```sh
node scripts/naya-logs.mjs sessions                      # id, kind, start, duration, provider, turns, tools, terminal
node scripts/naya-logs.mjs sessions --since 24h --kind live
node scripts/naya-logs.mjs tools <id>                    # each tool receipt: time, event, call, ms
node scripts/naya-logs.mjs errors --since 24h            # failures across sessions
node scripts/naya-logs.mjs slow --since 24h --over 5000   # the slowest tool and answer timings first
node scripts/naya-logs.mjs native <id>                    # the app's own OS log for the session window
```

There is no `timeline` command: its journal half is gone and its per-turn half is
`scripts/didi-timeline`, which reads SQL and prints turns, responses, calls with their continuation,
first audible and the playback track. `native` reads the app subsystem (`ai.lux.didi`) from
`/usr/bin/log show` for the session window; `NAYA_LOG_BIN` overrides the binary, `NAYA_LOG_SUBSYSTEM`
the subsystem.

## When the owner says "inspect the logs"

1. `didi-timeline latest` for the shape of the session and its typed `GAP` obligations.
2. `sessions --since 24h` and find the same session by start time, duration and terminal code.
3. `errors --since 24h` and see whether that session is already named there.
4. `didi-timeline latest --content` for the words: the owner and model utterances in turn order.
5. `slow --over 5000` for the timings, then `tools <id>` for which call it was.
6. `native <id>` when the question is about what the app did with the audio.

Read content only as far as the question needs it: the point of the ordering is to find the one
line that matters before reading a transcript.

## Release gates

A gate is a script under `scripts/` that builds first, runs its own compiled suite and refuses to be green on a
zero test count. Run it before a voice release; it prints its verdict and its own refusals.

```sh
bash scripts/check-live-session.sh    # the host live session, its summaries, journals, adapters and the voice
                                      # fault-replay scenarios (release gate F1)
```

The fault-replay part of that gate drives the real OpenAI adapter and the real host live session together over a
virtual monotonic clock, against a scriptable fake provider socket, scriptable fake tools and the driver's own
playback receipts, so no test in it sleeps, opens a provider or reads the owner's data directory. Each scenario
asserts the six council invariants: one terminal disposition and one output submission per observed call, one
continuation per ready batch, no write for a settled generation, no repeated uncertain action, no obligation
dropped because audio went quiet, and an answer or a typed failure inside the scenario's virtual deadline.

A scenario the current code fails is marked `todo` with the assertion it falsifies quoted, and named here with the
wagon that owes the fix: wagon S4a owns the late-callback repeat, the partial-batch continuation, the duplicate
terminal event and the failed backend response. A trace is a list of `{at_ms, direction, event}` built by
`server/test/voice-replay/sanitize.ts` from a recorded provider log of test data only, with every free text field
replaced by a placeholder.

Fidelity limit: the replay injects `LiveVoiceClock` into the adapter and `now`/`schedule` into the host, so every
turn-taking window and every host timer runs on virtual time. The adapter's transport timers (handshake, idle,
deadline, close) are real `setTimeout`s compared against real `Date.now()` (server/adapters/live-voice/openai.ts,
the `Date.now() >= this.deadlineMs` guard), so they cannot fire in a replay where virtual time outruns the wall
clock. The driver anchors the virtual origin at `Date.now()` and sets those budgets far beyond any scenario, so
they never fire and no scenario depends on them; a scenario that must prove the transport deadline needs a
production seam, not a longer trace.

## Privacy rule

Legacy trace content tables and the unified log can contain transcript and tool preview text. New canonical journal, tool execution and source dispatch tables hold their own protected content.
Only the owner and owner-authorized Claude sessions read them. Never paste a transcript or a tool
result into a public issue, a pull request, a commit, a test
fixture or a message, and never read the owner's real data directory from a test or a check.

## Current canonical transcription and coverage

New transcription text is retained once in `live_journal`; `trace_utterance.journal_id` references it and its text column stays empty. Existing legacy bytes are preserved until their existing 30-day trace expiry. The supported `didi-timeline --content` reader checks the canonical history session owner, current class, lineage and exclusion state before reading journal text or any legacy preview. A denied source never falls back to a trace preview. Class-unknown legacy sources report unavailable; direct owner SQLite inspection is a separate forensic interface and is never a model permission path.

The timeline includes canonical transcription outside traced turns, including model-first greetings. Text is automatic recognition or generated-output transcription, not proof of words heard. Metadata reports unassociated transcription rows, diagnostic metadata/content coverage, native receipt observation and a failure-count lower bound. Journal completeness keeps its existing independent meaning. A trace-reference write can fail while the journal stays complete; this now records partial trace coverage. Native receipt observation does not mean every generated audio byte was played.

Call and response trace keys are scoped to session and connection epoch; raw provider ids are separate. Event clock domains identify host process or native producer. Historical null domains remain unknown. Execution duration is calculated only from measured start/completion observations in the same non-null domain. Prepared and written events remain distinct; a missing completion is unknown, never zero work. A new host holding the exclusive Store writer lock marks previously in-progress capture unknown/host_terminated. No audio-frame transaction was added.

Always pass `--data-dir` for the installed app: `~/Library/Application Support/ai.peat.lux-didi`. The CLI's older default `Lux Didi` directory is a different runtime. Default timeline and metadata export exclude content. `--content` is protected owner-local inspection and uses current lifecycle/class gating; it is not an external sharing command. The existing trace preview limit and retention do not promise complete durable source results; those require a verified canonical dispatch record.

Focused actual-runtime proof: after server compilation, run `node server/test/diagnostic-trace.integration.mjs`. It exercises actual adapter, Store and CLI, new reference resolution, model-first greeting, forced write failure, forgotten/class-denied content, restart unknown state, scoped call/response ids and unlike-clock observations. No provider or audio device is used.

## Canonical tool inspection

See [the diagnostic store guide](diagnostic-store.md) for the installed versus development database paths, Live session and Chat run mapping, exact requested/effective input stages, supported full source envelopes, current source gating and tested read-only SQL. `didi-timeline --content` resolves canonical source content and keeps bounded model projections distinct. Metadata-only defaults do not select argument or body columns.
