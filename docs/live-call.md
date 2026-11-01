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

## Research and dead air

The merged release bounds research by owner-turn admission. `owner_turn_required` in `server/tools/research.ts` refuses a model-driven continuation without a new finalized owner turn. A partial result should be answered honestly from available evidence, not turned into an automatic cascade of more tool calls while the owner hears nothing.

Patience (owner order 2026-10-26, call 01c4bd89): `RESEARCH_OPERATION` in `server/tools/research.ts` names one budget. A call waits for the sources its question needs up to 15 s, and answers early only when they have settled; at 10 s an owner still waiting hears one short "still searching" line through the speakable-progress channel (`research_still_searching` says whether the adapter carried it); at 20 s the call stops whatever is still reading, answers with what it has, and the reply names the source that did not return in time. A source still reading is never called a timeout, and a `continue` refused as `turn_spent` is not a reason to wait silently: the model may collect the pending results of its own research once.

Admitted paging is host-owned and bounded. Partial coverage remains partial; records examined, matches and represented results are different quantities. The model must not call a partial scan complete or treat an unknown total as zero. [Tool owner](tool-owner.md) owns research and coverage details.

`LiveSessionOwner` distinguishes pending tool work from an answer the provider owes after a result. Dead-air recovery must not rebuild over an admitted operation within its deadline, and a stuck operation must not suppress recovery forever. `live_heard_silence` now names what owned the silence (`tool`, `provider` or `owner`) instead of a boolean that read `tool` whenever the turn had followed a tool output. `live_dead_air` receipts describe observed timing; they are not proof that audio was audible on the Mac. Use the trace playback evidence described in [diagnostic-store.md](diagnostic-store.md).

### A silent text response never outlives its own end (C-DEADAIR)

A post-tool continuation asks the provider for a response with a bare `response.create`: no output modalities, no instructions, no voice. The delegated backend can answer that request with text and no audio at all (2026-10-27 07:02:59Z: 112 response tokens, `delegation_closed`, `playback_level` at -120 dB, and no `session.output_audio.delta`), and the adapter has no path for a delegated response's text, so the answer is generated and never spoken. The host cannot make the provider speak, so it notices the shape: when a response ends after writing text for an owed answer and no audible frame arrived, `#deliverUnspoken` hands the result to the live session at that end, exactly once, with no ladder wait. `live_response_latency` records the provider's share of the wait separately (owner final words, response announced, first audio). The audible-debt rung stays at 8 s, and a response the owner cannot hear buys it `DEAD_AIR_RESPONSE_GRACE_MS` (500 ms) instead of the seven seconds that made the 2026-10-27 calls wait 15 s.

### Fewer rebuilds, by holding them rather than shortening anything (C-REBUILD)

Three shapes were measured on the 10-25 to 11-01 window (19 owner rebuilds): 7 tore down a response in flight under 9.7 s old, 2 followed a response's end within 4 s, and 8 had no response at all for 29 s or more. The council's ruling is one rule applied three times: a rebuild trigger may only be lengthened or removed, never shortened, and no filler speech may answer a silence he was happy to leave.

**A response in flight holds the rebuild to its ceiling.** `inFlightResponseHold` compares the host's own monotonic stamp of the response's creation with `MAX_IN_FLIGHT_RESPONSE_AGE_MS` (12,000 ms, against a longest healthy silent response of 9,680 ms over 69 responses). A rebuild that arrives first is held for exactly the remaining age, on the timer the step already owns, so a response that finishes inside the wait cancels it and one that does not is rebuilt at the ceiling exactly as before. `RESPONSE_WATCHDOG_NUDGE_MS` (8,000), `RESPONSE_WATCHDOG_RECOVERY_MS` (7,000) and `AUDIBLE_DEBT_RUNG_MS` (8,000) are untouched. `live_rebuild_held` names the reason, the response's age, the wait taken and the count.

**Nothing is written into a response that is in flight.** The unspoken result is not handed over at the rung while a response is open: it waits for that response's own terminal, which is the continuation path that carries it, and if the response is torn down instead it travels in the new session's opening. A late finding is held the same way, without a timer: `lateCommentarySilence` returns `response_in_flight` and `lateHoldMs` gives that reason no delay, so the finding stays in the ledger for the next continuation and only a torn down generation leaves it there for good.

**An owner turn that asked for nothing is no longer a rebuild trigger.** `silentOwnerTurn` names a turn with owner words, no tool call and no response created. Its rebuild is removed, and the accepted failure is stated: a socket that is really dead on such a turn waits until he speaks again, and his next final recovers through the triggers still in force. `session_window`, `line_dropped` and a provider close are unchanged. `live_rebuild_removed` names the reason and the count.

**A rebuild settles what it tears down.** A response the provider announced and never terminated is written as `response.terminal` with status `superseded` when the session closes, so the trace store never keeps a response pending for the life of a call.

## Recovery is not replay

Provider-drop handling is implemented by `#recoverFromDrop` and `#openRecovery` inside `LiveSessionOwner`. Failed resumption can fall back to a fresh open; exhausted recovery settles with `provider_recovery_exhausted`. Neither path grants another research operation or permission to replay an uncertain remote write.

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

Voice can save local memories and owner-requested Lux notes. Composed Lux notes are gated off by default and require staged readback and confirmation; a tool call alone is not a save. Trello card writes have their own board-scoped authority. [Privacy and authority](privacy-and-authority.md) owns these distinctions.

Deleting a local memory can scrub later accepted/rebuilt context, but cannot remove bytes already held by an open provider connection. Stop and restart the call when discarding that current context matters.

## Truth about her own state

The runtime context carries one compact line of live connector state per family, connected or not signed in or needs approval, rebuilt at every call start and after any sign-in, and Naya may deny or claim a sign-in or a capability only from that line or a live tool check. An open loop older than 24 hours, or one a later summary records as finished, is never an opening option, and an opener never credits a past failure to the owner. When the owner says her voice or accent changed she believes him, says she cannot hear her own output and offers to keep going, never that she is still the same. A line from an earlier conversation's summary is spoken only when it answers what he just asked, and the "okay?" tag is limited to once in a few answers. The summary prompt records a failed request, an unanswered ask and a complaint about Naya herself as open loops.

## Research context rebuild

A call keeps the research answers it has been given in the provider conversation, which is what made one call grow from 15k to 44k tokens (LAT-1023). Two things bound that growth, and one of them is not a rebuild.

**The reply cap (C-CONTINUITY T-11).** Every `research` result delivered into the voice session is capped at `RESEARCH.voiceReplyChars` (3,000 chars) after final serialization, envelope and cursor included, findings first. The cut is deterministic and lands on a whole line, never mid-word, and it is marked (`cut: voice_reply_chars`). The full result stays host-side for the call: a `continue` with the reply's `cursor` pages the stored answer and re-runs no search, and a cursor this call does not hold is the closed error `cursor_unavailable`, never a new question the owner did not ask. The cap is applied once, in `capVoiceReply`, on the one path a research result takes into the session, so a deadline partial and a resumed run obey it too.

**The rebuild.** The host counts exactly the research text it hands the provider. Once that count passes `RESEARCH.rebuildThresholdChars` (60,000 delivered chars), the next safe boundary rebuilds the session through the existing `fresh_seeded` recovery. The new session is seeded by one builder for every `fresh_seeded` open, including the mute recovery and the drop recovery: the `#seedHistory` transcript (bounded by `SEED_CHAR_LIMIT`, 8,000 chars, with the latest owner and the latest assistant utterance always surviving) and then the research ledger as a distinct, host-attributed section (`HOST_LEDGER_HEADER`), at most `RESEARCH.ledgerChars` (6,000 chars). The conversation therefore survives the rebuild instead of being replaced by it.

The ledger is cumulative: `ResearchLedgerLog` accumulates one extractive record from every successful research batch and continuation in the call (the question, per source id lines, the excerpt lines that survived, the gaps, the cursors), oldest evicted first, and a record it had to cut is marked. A refused or failed batch adds nothing to the ledger and nothing to the rebuild counter, so it can never replace earlier records with an empty header; it does count in the total-context figure the `research_context_rebuild` line carries. Every successfully opened fresh session resets the counter and drops a pending seed, and only after the provider says the new session is ready, so a mute recovery no longer buys a second destructive rebuild seconds later.

The rebuild is spent at the response boundary and never from the batch that filled the conversation, and it is deferred rather than dropped: while the assistant is streaming, a response is pending, a barge in is open or a recovery is in flight, the seed waits for the next boundary, and one crossing fires at most one rebuild. Recovery, the connection epoch, barge in and the 6,000 ms operation deadline are unchanged.

The receipts are content free and truthful. The rebuild logs `live_rebuild trigger=research_context cause=host`; `line_dropped` is no longer the arm everything falls into, and a reason the host does not know is a typed error. The `research_context_rebuild` line reaches `host.log` with retained chars, ledger chars, seed transcript chars, rebuild count and the call's total context. Every socket close records its close code and a sanitized reason (no URLs, no tokens) on the outcome, and the next rebuild or recovery line carries them.

## Verification

[Checks](checks.md) names the focused Live, gateway, transport and native proofs. Offline fixtures do not prove real provider availability, microphone permission or audible hardware playback. Do not launch an installed owner app or make a real call without authorization. [Debugging](debugging.md) gives the evidence-first path for a real failure.
