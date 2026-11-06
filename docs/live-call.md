# Live voice calls

A Live call is a host-owned conversation with native microphone capture and playback. The provider receives audio and accepted instructions; the Mac app receives the host's state, audio and transcript events. Text chat is a separate owner, described in [text-chat.md](text-chat.md).

## User controls

Tap bare Right Command, or use the status menu, the Dock menu or the window pill, to start, mute and resume; a click on the orb starts and stops nothing. Use Stop or say "Naya, stop listening" to end the call. Muting keeps the call open but closes capture; stopping ends the call. The native presence machine, not a web component's local guess, determines which state the controls show. [User guide](user-guide.md) and [Mac experience](mac-experience.md) own the interaction details.

An interactive launch can start one call automatically; login and installer relaunches do not. Microphone permission and a usable voice configuration are independent prerequisites. A provider error is not permission to switch the system's audio device or silently disable voice processing.

## Implementation map

| Contract | Owner |
| --- | --- |
| Call lifecycle and provider recovery | `LiveSessionOwner` in `server/live/index.ts` |
| Public host composition | `createLiveSessionOwner` in `server/live/index.ts`; `server/host/live.ts` |
| Accepted profile, limits and feature switches | `validateLiveProfile`, `defaultLiveLimits`, `liveFeatures` in `server/live/config.ts` |
| Durable call records | `server/live/schema.ts`, `server/live/journal.ts` |
| Provider transport | `LiveVoicePort` and `liveVoiceProviders` in `server/adapters/live-voice/types.ts` |
| Microphone and speaker | `AudioOwner` in `Sources/LuxDidi/AudioOwner.swift` |
| Native connection and presence | `Sources/LuxDidi/LiveSessionCoordinator.swift`, `Sources/LuxDidi/NativePresence.swift` |
| Stop-speech normalization | `normalizeStopSpeech` in `server/live/stop-phrase.ts` |

Read the owning types for frame schemas, lifecycle unions and timer bounds. Keep those contracts in source rather than copying a second protocol specification here.

## Acceptance and authority

A call accepts provider, route, permitted classes, prompt and usable tool context before dispatch. The provider selection is explicit; there is no permission to borrow another provider's key. The instruction can include selected local memory and an explicitly activated owner profile. [Provider configuration](provider-configuration.md), [prompt composition](prompt-composition.md) and [selected memory](selected-memory.md) own those inputs.

A reconnect must not expand the accepted tool grant. Current revocation and source/class gates still apply to results. A stale provider generation cannot speak into a newer active call merely because it eventually returned a response.

## Work and spoken delivery

The voice model talks; a host-owned text helper does the work. A finalized owner
utterance reaches the helper without a voice-model tool call. World-dependent
questions and actions are handed off in the same turn. The voice waits for an
actual result rather than inventing progress or claiming a lookup happened.
General explanation and plain conversation can be answered directly.

Delivery keeps exact entities verbatim and leaves other wording to her. Fenced COMMENTARY
items carry a typed result, partial result, no_action or failure as data. A requested full
result is told completely once, with no rounded amounts, altered qualifications, invented
facts, filler or meta-status. An acknowledgement at the hand-off usually needs no words
and never promises work. The voice collects the complete commentary sequence before speaking.

### Open-line task delivery (10.11)

Finalized owner speech starts or revises the helper after 600 ms without new owner transcript.
New words restart this host-owned quiet; adapter finalization consumes the same interval, not an extra delay.
The bound is `OWNER_QUIET_MS` in `server/tasks/call.ts`: 600 ms is the ceiling the contract set, not a
measured minimum. From `host.log` `owner_final` to `task_lifecycle` start/revision on the 2026-11-05
01:11 and 07:18 calls, the adapter had already credited at least 693 ms of the interval on every
observed finalization, so the residual wait is zero today and the ceiling only guards an adapter that
credits less. A later fragment still revises the running task rather than splitting the ask.
There is no lexical hesitation classifier. Stop commands,
mic pacing and barge-in retain their existing paths. Longer gaps can revise running work.

OpenAI results use commentary on the current provider generation with its latest delegation id,
or null when there is none. The host waits for owner speech and output quiet, then appends ordered
fenced JSON items of at most 450 characters, including the fence and encoded fields. Provider timeline acknowledgement settles each chunk, not exact
transcription or proven playback. An explicit rejection retries once on the same line and then logs
failure. Delivery never reconnects and has no heard deadline. Within one context it does not resend
accepted items; a fresh session restarts an unfinished envelope at its header, even if earlier
items were accepted. Acceptance is timeline evidence, not proof that facts were spoken. Store records pending sends and only records delivered after provider acknowledgement.

A real socket rebuild retains the bounded transcript through rebuildSeed. The complete unfinished envelope
is appended header-first as commentary after ready, with a null id until this generation has a delegation.
Accepted chunks are not replayed; no say-first instructions replace conversation history.
Recovery timing is unchanged. Verified helper status names whether a rebuild happened and its closed
cause; live_rebuild metadata names running_task, finished_answer_pending or nothing_owed.

A no_action result releases an open delegation with situation-only commentary: no lookup is needed,
and the voice should answer from its own mind and the conversation. Without an open delegation it
sends nothing. A no-tool complete or incomplete result is suppressed if the voice already spoke and
no delegation is open. Tool evidence is always delivered; failure and incomplete text is not rewritten.
Stale revisions never deliver. Gemini retains its tool-response route apart from the shared input quiet.

Synthetic providers prove routing, ordering, acknowledgement state, holds and bounded rejection handling.
They cannot prove audibility, exact wording, model weaving, or remembered meaning. Real-wire trials
established null-id commentary and retained history; transcript matches are not delivery receipts.

### Fast evidence (FR1)

A finished utterance that refers to the past or to his calendar is read by the host itself, with no model
call and no network. `classifyCue` matches whole words only: memory cues are the phrases that point at
something already said (last time, I told you, you said, we talked, remember, yesterday, a month name, a
weekday name); calendar cues are today, tomorrow, this week, next week, meeting, calendar, schedule,
appointment. A memory cue runs one bounded FTS5 read over her call history; a calendar cue reads the
digest the session already holds. The whole read is budgeted at 100 ms, and a read that throws or overruns
sends nothing.

When the read finds something it appends one commentary group, kind `partial`, opening with
`Local recall, provisional, the helper is still checking:` and carrying at most five facts, each dated and
capped at 240 characters, so every item stays inside the 450-character transport limit. It rides
`session.commentary.append` with a null delegation id, which the provider accepts as general session
context even while a delegation is current (`sendSessionCommentary`), and it is marked as local recall so
she never presents it as the helper's answer. Zero hits send nothing at all. The read runs after the helper
has already started and is never awaited on its path, so it never holds or moves the reply. One host event,
`fast_evidence`, records the cue classes, the outcome, the hit count, the elapsed budget and whether the
channel took the items.

### Fewer rebuilds, by holding them rather than shortening anything (C-REBUILD)

Three shapes were measured on the 10-25 to 11-01 window (19 owner rebuilds): 7 tore down a response in flight under 9.7 s old, 2 followed a response's end within 4 s, and 8 had no response at all for 29 s or more. The council's ruling is one rule applied three times: a rebuild trigger may only be lengthened or removed, never shortened, and no filler speech may answer a silence he was happy to leave.

**A response in flight holds the rebuild to its ceiling.** `inFlightResponseHold` compares the host's own monotonic stamp of the response's creation with `MAX_IN_FLIGHT_RESPONSE_AGE_MS` (12,000 ms, against a longest healthy silent response of 9,680 ms over 69 responses). A rebuild that arrives first is held for exactly the remaining age, on the timer the step already owns, so a response that finishes inside the wait cancels it and one that does not is rebuilt at the ceiling exactly as before. `RESPONSE_WATCHDOG_NUDGE_MS` (8,000), `RESPONSE_WATCHDOG_RECOVERY_MS` (7,000) and `AUDIBLE_DEBT_RUNG_MS` (8,000) are untouched. `live_rebuild_held` names the reason, the response's age, the wait taken and the count.

**Nothing is written into a response that is in flight.** The unspoken result is not handed over at the rung while a response is open: it waits for that response's own terminal, which is the continuation path that carries it, and if the response is torn down instead it travels in the new session's opening. A late finding is held the same way, without a timer: `lateCommentarySilence` returns `response_in_flight` and `lateHoldMs` gives that reason no delay, so the finding stays in the ledger for the next continuation and only a torn down generation leaves it there for good.

**An owner turn that asked for nothing is no longer a rebuild trigger.** `silentOwnerTurn` names a turn with owner words, no tool call and no response created. Its rebuild is removed, and the accepted failure is stated: a socket that is really dead on such a turn waits until he speaks again, and his next final recovers through the triggers still in force. `session_window`, `line_dropped` and a provider close are unchanged. `live_rebuild_removed` names the reason and the count.

**A rebuild settles what it tears down.** A response the provider announced and never terminated is written as `response.terminal` with status `superseded` when the session closes, so the trace store never keeps a response pending for the life of a call.

## Recovery is not replay

Provider-drop handling is implemented by `#recoverFromDrop` and `#openRecovery` inside `LiveSessionOwner`. Failed resumption can fall back to a fresh open; exhausted recovery settles with `provider_recovery_exhausted`. Neither path grants authority to repeat a helper action or replay an uncertain remote write.

The public `LiveSessionOwner.recover()` method has a different purpose: it sweeps interrupted durable sessions at host startup. Do not confuse that startup bookkeeping with opening a replacement provider connection.

Native capture recovery is another boundary again. Diagnose native audio, transport, provider and host-lifecycle failures separately rather than attaching one "reconnect" explanation to all of them. A terminal connection-lost state requires an explicit owner reconnect; it is not a successful answer.

The seed a rebuild opens with is built from finished-turn boundaries, with adjacent same-role runs merged, and it is bounded before it reaches an adapter (`fitSeedTurns`): the history owns at most 127 messages, every appended turn (ledger, dropped-line mark, pickup line) is counted, and the whole seed stays inside `SEED_CHAR_LIMIT`, which is under the adapter's 8,192-token proxy. An adapter given a longer history trims its oldest turns instead of refusing the open, and its validation covers the turns it keeps. A locally refused seed is never resent unchanged: the first retry carries the newest half of the conversation and the last attempt is a plain open with only the summary context. The old provider session is closed only after the new one opened, so a refusal leaves the call on the session it already had.

Two silences are not failures. A bare acknowledgement after the model spoke ("okay", "ok", "mhm", "right", "yeah", "thanks", up to three words and never a question) closes the turn at the watchdog instead of spending a rebuild. When recovery does give up, the call settles `provider_recovery_exhausted`, the native app sounds the existing goodbye tone, and the one `live_session_diagnostics` line for the call is written at settle so its `terminalCode` is the code the call actually ended with, never the field default. A rejected journal write is logged as `host_error` with its closed code (`persistence_failed`), not as a bare `Error`.

## Voice processing and the audio graph (#1101)

`NativeLiveAudioDevice` builds its voice-processing graph once per start and settles every release.

- One build. Ducking is configured first, then voice processing is enabled once, on the input node:
  enabling either IO node enables the other (`AVAudioIONode.h`: "Voice processing requires both input
  and output nodes to be in the voice processing mode. Enabling this mode on either of the IO nodes
  automatically enables it on the other IO node."). The player is attached and connected after that,
  the engine is prepared once, then started. Nothing reconfigures the unit between those steps, because
  each reconfiguration asks CoreAudio for another DSP graph build.
- Settled teardown. A release stops the engine, keeps the engine and player handles alive for
  `releaseSettleMs` (250 ms), keeps waiting while an `AVAudioEngineConfigurationChange` or a moving
  default device is still in flight, bounded by `settleConfigWaitLimitMs` (1000 ms), then resets and
  drops them. Every release-then-build path (unmute, the mic-watchdog restart, route recovery) awaits
  that settle, so two engines are never alive at once.
- Journal. `audio_graph_built` carries the build steps in order, whether voice processing was on, the
  configuration-change notifications seen during the start, and the call's engine start count.
  `audio_release_settled` carries the settle it waited and whether a configuration change was pending.
  `logs/audio.log` therefore proves or refutes a start and a release without a recording.

The downlink half of Apple's voice processing cannot be separated from the uplink half: the mode is
per IO node pair, and the whole `AUVoiceIO` property surface (`AudioUnitProperties.h`) is uplink
(bypass, AGC, mute output, quality), other-audio ducking, or iOS-only and deprecated. Keeping
input-side echo cancellation keeps the downlink chain, so we build that graph cleanly and stop
rebuilding it rather than trying to take her voice out of it.

Every thin AVFAudio call that can raise instead of returning (attach, connect, installTap, prepare,
removeTap, scheduleBuffer, play) goes through `Sources/LuxDidi/AVFAudioGuard.h`, the one Objective-C
file, because only Objective-C can catch what AVFAudio raises: in Swift the exception unwinds the
frame and leaves the concurrency runtime's current executor pointing at a dead stack. The guard
throws `NativeAudioGraphException`, the call ends, and `audio_graph_exception` in `logs/audio.log`
names the call and the exception. It is a boundary check, never a fallback.

The tap installs with `format: nil`, so AVFAudio uses the node's own current output format and can
never compare a stale client format against the hardware: on the headset route that comparison
raised `Format mismatch: input hw 1 ch 48000 Hz, client format 1 ch 16000 Hz` and failed the tap.
The capture buffer takes its converter from the first buffer it actually receives, so nothing
downstream depends on the format read before the tap.

A call start writes `logs/call-start.json` before presence starts, with the pid, the wall time and
the output transport, and clears it once a capture frame and one model chunk have both arrived or
the call ends cleanly. A launch that finds a marker younger than two minutes from another pid logs
`launch_after_failed_start` in native-live.log and does not auto connect: on 2026-11-01 three
crashes in 35 s each launched straight back into the same fault. The app stays open and a key press
still starts a call, and the orb visuals are unchanged.

The input node sits behind one seam (`NativeLiveInputSeam`). A routine check injects
`NativeFakeInputSeam` through `engineFactoryForTesting`, so no check, gate or agent enables voice
processing, constructs a real input node, pins a device or stops and resets a real engine: measured
before this seam existed, the test binaries caused 907 speaker DSP graph rebuilds against 12 from
real calls (see the 2026-11-01 audio investigation). Real voice processing coverage is now the
owner-only command `scripts/owner-audio-hardware-proof.sh`, which no check calls and which starts no
engine, so nothing is audible.

## Notes and deletion

The host-owned task helper can save local memories and Lux notes through Task Authority. After outside-text exposure, writes use the isolated effect check; Lux saves do not require the retired phrase-grant or staged-readback protocol. Only an actual connector receipt establishes a remote save. Trello writes remain board-scoped and use the same task-effect authority boundary. [Privacy and authority](privacy-and-authority.md) owns these distinctions.

Deleting a local memory can scrub later accepted/rebuilt context, but cannot remove bytes already held by an open provider connection. Stop and restart the call when discarding that current context matters.

## Truth about her own state

The runtime context carries one compact line of live connector state per family, connected or not signed in or needs approval, rebuilt at every call start and after any sign-in, and Naya may deny or claim a sign-in or a capability only from that line or a live tool check. An open loop older than 24 hours, or one a later summary records as finished, is never an opening option, and an opener never credits a past failure to the owner. When the owner says her voice or accent changed she believes him, says she cannot hear her own output and offers to keep going, never that she is still the same. A line from an earlier conversation's summary is spoken only when it answers what he just asked, and no answer ends on a reflex tag such as "okay?". The summary prompt records a failed request, an unanswered ask and a complaint about Naya herself as open loops.

## Helper results and recovery context

The Live voice receives speech-ready results from the host-owned helper rather than calling source tools itself. The helper performs the typed tool work; the voice reads its result completely, retaining names, numbers, dates and qualifications. A partial result, a gap or a failure must remain explicit rather than becoming a claim that the work succeeded.

The 6,214-character check applies to the public worker instruction block, not to a serialized voice-tool reply. The helper's registered tools own their result shapes and continuation behavior. There is no shared voice-facing source-result envelope or delivered-answer character counter controlling this helper lifecycle.

### What she already said (C-REPEAT)

The helper's input carries what she already said as plain labelled data: the last answer's text, bounded at 4,000
characters with a `truncated` flag, and how far its delivery got as accepted chunks of the spoken total. A cut
answer is accepted below total, so an answer interrupted by his voice is distinguishable from one that finished.
The record lives on the call's delivery, so it survives every revision of a task and a provider rebuild inside
the call; it is never re-derived from the transcript. `already_said` is data, never an order: the helper decides
whether words that add no new ask return no_action, whether an answer he wants to hear again is spoken, or
whether a cut answer continues from where it stopped.

The host passes exactly one fact about overlap, `owner_words_overlapped_her_speech`: true when his words
arrived while her audio was still audible (`taskOutputQuiet === false`). The host draws no conclusion from it.

The helper's input also carries `verified_status` as facts only: `other_work_running` (false for a sole run),
`last_task` with its terminal status and the failed tools with their closed failure codes, plus the existing
`rebuilt`, `rebuild_cause` and `staged_deletion`. No field claims a run is running, so a question about what she
is doing is answered from what the host can see. `no_action` delivery is unchanged: she is told only while she
is actually waiting, and it is never silent.

The helper receives the same people roster text the voice prompt renders, from the same source and without the
owner lore, so a first name he says resolves to the right person on the first search. `workerInstructions`
appends the roster only when a roster is installed, bounded by the same `PEOPLE_CHAR_LIMIT` of 6,000 characters
the voice prompt uses; a synthetic roster of one person adds 69 characters to a block that measures 6,214
characters without one.

Fresh session recovery uses the call transcript seed built by `LiveSessionOwner.#rebuildSeed` and `#seedHistory`. The current seed contains transcript turns only; it adds no separate helper-result ledger. Session recovery and a helper's follow-up tool reads are distinct operations, and recovery does not grant authority to replay an uncertain remote write.

## Verification

[Checks](checks.md) names the focused Live, gateway, transport and native proofs. Offline fixtures do not prove real provider availability, microphone permission or audible hardware playback. Do not launch an installed owner app or make a real call without authorization. [Debugging](debugging.md) gives the evidence-first path for a real failure.

### Spoken work delivery (10.10)

The voice model talks and receives results; it has no source tools. The host-owned
text helper does the work with typed tools. The spoken work policy is always
included, even when the Live session declares no tools. Memory yields first,
then runtime context; the work policy never yields and the hard limit still
fails loudly. String checks prove instruction delivery, not model behaviour.
The release owner runs the real-wire probe and synthetic replay separately.


### Typed work commentary

The voice receives fenced `COMMENTARY` JSON as data, never a sentence supplied by the host to read aloud. A logical envelope is an ordered sequence of commentary items, each at most 450 characters including its JSON and fence. Items share a short envelope `id`, `part` (`i/n`), and `final` marker. Header items carry `kind` (`result`, `partial`, `no_action`, or `failure`), `cause`, `what_failed`, `next_step`, and `exact`; further header items can continue the exact list. Content items carry helper prose. The voice collects all parts through `final:true` before answering. Transport acceptance and the delivery record advance per item, not per logical envelope. A fresh session receives the complete unfinished envelope from part 1, including already accepted headers and exact entities. The cumulative unique-item acceptance count is preserved, never treated as evidence that facts were spoken. Recovery context seeds also carry the complete envelope.

Exact entities are reproduced verbatim, including names, dates, times, amounts, numbers and qualifications. Everything else is phrased in her own voice, with no invented facts, filler or meta-status. Requested full results are told completely once. `partial` gives what exists and names the gap; `no_action` answers from the conversation without mentioning a lookup; `failure` gives the supplied cause and repair once without inventing a next step. Work runs in silence.

The helper returns JSON with `spoken` connected prose and an `exact` list, or `{"status":"no_action"}`. When an older result has no exact list, deterministic host extraction retains names, numeric values, dates, times, currency, units and email addresses. Entity strings are never severed across items; an entity or header too large for the transport fails closed as `invalid_result` rather than being silently truncated. Sentence boundaries are preferred; an overlong sentence can be divided at whitespace outside exact entities.

Recovery inputs are typed `recovery` envelopes with `cause` (`connection_dropped` or `provider_silent`) and `mid_answer`. They ask for continuation without a greeting or an explanation of the pause. Task identities, attempts, receipts and delivery counters never enter model-visible commentary; the envelope id and part counters only assemble its data.

## Helper failure facts

The commentary cause remains a reason code. The host supplies factual clauses for her to phrase, not spoken lines. A tool failure keeps its own repair text; unknown model failure codes retain the generic model-request description.

| Cause | What failed | Next step |
| --- | --- | --- |
| deadline | the helper did not answer within the time allowed | ask again |
| provider_rejected | the provider refused the helper's request | nothing to retry until the request is fixed |
| provider_auth, credential_unavailable | the helper's sign-in is not valid | sign in again in the app |
| provider_rate_limited | the provider is rate limiting | ask again in a moment |
| provider_unavailable | the provider could not be reached | ask again |
| provider_incomplete, provider_empty | the provider returned no usable answer | ask again |
### Opening facts and delivered-topic exclusions

At each call start the host supplies a bounded fenced `OPENING_FACTS` data block: local time, today's calendar digest, the last open thread, dated commitments, saved notes and excluded topics from the last three delivered openings. These are facts, not opening kinds, ranked choices or suggested sentences. The model chooses its angle and words under the persona; with no usable facts it opens plainly. It must not open on an excluded topic. Section ids `opening-options` and `previous-openers` remain stable for diagnostics.

The host withholds family-circle names and aliases from the people roster, subjects named by the authored lore's humour floors, illness, Freya and the boat, and monetary amounts or balances. The persona independently enforces its own floors. After the first spoken assistant turn completes or is interrupted, the host records only its semantic topic/entity keys with the call id and UTC timestamp in `delivered_opening_topics`. Later turns cannot overwrite that opening. Retention is bounded to 30 days and 100 calls; route/history authority still governs which calls seed the next opening. `opener_facts` logs counts only, never the facts or spoken text.

The host's closed illness-word list is a conservative backstop; the persona's floor rule supplies the judgment layer.

### Helper inference attempts

`didi-timeline call <id> --audit` lists each observed unsuccessful inference attempt in order under its task, with its revision and elapsed milliseconds. `superseded` means the next revision cancelled the request, not a provider failure. `failed` names the reason code and closed provider error class; `deadline` means the helper exhausted its budget. Per-call outcome counts summarize these log observations. A persisted settled reason is a fallback, not another attempt. Provider diagnostics include an HTTP status and bounded request id when available, never a new free-text error field.

## How deep an answer is

For information asks, the helper includes every supported fact that matters to the question, in time or relevance order. Overlapping facts appear once; incidental hits stay out. Missing information is named at the end. Length follows the facts, without a target or a recap. There is no preamble or narration of the search. Banter, greetings and remarks without a lookup stay short and in character. Later words can revise an earlier fragment; the answer addresses the latest whole request.

Host speech instructions (the alarm opening, the muted-answer offer and the
post-tool continuation request) use a session-level `session.commentary.append`
with explicit `delegation_id: null`, not a typed owner turn. Typed owner input
keeps its existing response commands; their client-delegation compatibility is
a known gap. Provider rejection metadata includes the client event id, its prefix
and the command type when retained in the adapter's bounded recent-command map,
without logging instruction content.
