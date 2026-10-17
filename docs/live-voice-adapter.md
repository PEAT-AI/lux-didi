# Optional Gemini Live voice transport

The provider sends binary WebSocket frames carrying UTF-8 JSON; the adapter accepts both binary and text JSON frames.

This standalone adapter does not change the text ModelPort or install voice into the app. It provides transport evidence, not proof of playback, consent, durable transcript ownership or voice parity. Future service composition owns consent and aborts the session on invalidation. Native composition owns capture, playback and device permissions.

## Composition

Import `GeminiLiveVoiceAdapter` and the `LiveVoicePort` types from `dist/adapters/live-voice/index.js` in the canonical service artifact. Supply an explicit `models/<Live-model-id>`, explicit voice name, credential reference, Credentials resolver and enabled Gemini route with exactly the same model and allowed data classes. There is no default or inference from the text model. The adapter resolves only the supplied reference; it reads no environment, key file or account state.

The production destination is fixed to the official endpoint:

`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`

It uses the production `ws` dependency, not a Node global WebSocket or SDK private fields. `socketFactory` is a trusted in-process dependency injection seam for loopback tests, not a custom production URL feature, CLI, environment variable or public route. Redirects and per-message compression are disabled. No Domain, database, native, HTTP or config implementation is imported.

```ts
const port = new GeminiLiveVoiceAdapter({
  modelId: composition.liveModelId,
  voice: composition.liveVoice,
  keyReference: composition.liveKeyReference,
  credentials: composition.credentials,
  route: composition.liveRoute,
});
const session = port.open({
  system: { text: composition.system, dataClass: 'ordinary' },
  history: [],
  dataClasses: ['ordinary'],
}, { signal: composition.signal, deadlineMs: composition.deadlineMs });
// Start the single event consumer immediately to avoid filling bounded retention.
const consume = (async () => {
  for await (const event of session.events) composition.observeTransport(event);
})();
await session.ready;
session.sendAudio({ pcm: composition.pcm16LE16k, dataClass: 'ordinary' });
// When capture stops, optional documented audioStreamEnd (not turn cancellation).
session.endAudioStream();
// At service shutdown or consent invalidation, close or abort instead.
session.close();
await session.done;
await consume;
```

System, text-only whole initial history, declared classes, settings and deadlines are copied/validated before credentials or networking. Empty history is valid for initial audio; no fabricated user turn is sent. Initial history uses `clientContent` with `turnComplete:false`, after actual `setupComplete`. `ready` is not socket-open: exactly one setup requests AUDIO, configured voice and input/output transcription. Automatic activity detection is provider-owned; the setup sends `prefixPaddingMs: 300`, `silenceDurationMs: 1200`, `startOfSpeechSensitivity: START_SENSITIVITY_LOW` and `endOfSpeechSensitivity: END_SENSITIVITY_LOW` from `liveVoiceActivityDefaults`, so the first syllables are not clipped and a mid-sentence thinking pause does not end the turn. These are the Google Live API `setup.realtimeInputConfig.automaticActivityDetection` fields (https://ai.google.dev/api/live, AutomaticActivityDetection: prefixPaddingMs, silenceDurationMs, startOfSpeechSensitivity, endOfSpeechSensitivity). Continuous input supports full duplex; `endAudioStream()` is optional and is never required for each turn. The adapter provides no manual activity or per-turn cancel API. `languageCode` accepts a BCP-47 language or language-region tag (`xx` or `xx-YY`) and is passed through unchanged, preserving the existing `ar` to `ar-XA` mapping; the adapter never selects the code, the profile does.

Input is nonempty even-byte PCM16 little-endian 16 kHz. Output requires `audio/pcm;rate=24000` and valid even-byte PCM16 little-endian data. No resampling is performed. Early audio is refused with `not_ready`, never buffered. Each accepted audio frame is sent once, without reconnect, retry, resend or tool replay. A malformed audio argument or disallowed class fails the call without silently writing it. Frame or socket congestion limits terminate the session explicitly.

## Events and truthful boundaries

One session spans multiple turns. Events have a monotonically increasing adapter-owned sequence, not provider IDs or durable turn IDs. Supported events: `ready`, `audio`, `inputTranscription`, `outputTranscription`, `modelText`, `generationComplete`, `turnComplete`, `interrupted`, `waitingForInput`, `interactionStatus`, `goAway`, `contextUsage`, `upstreamQueue`, `resumptionHandle`, and one terminal `outcome`. `contextUsage` is provider-neutral token use decoded from the provider's usage metadata (no behaviour reads it yet); `upstreamQueue` is the elevated send-queue depth. Audio events expose an owned Uint8Array and the validated output MIME type. Text transcription events preserve optional provider `finished`; this is not a heard, committed or recallable flag. `modelText.thought` preserves thought versus other model text; neither is labeled a spoken answer.

Combined serverContent fields are not discarded. Deterministic projection within one envelope is model parts, input transcription, output transcription, interruption, generation boundary, turn boundary, then activity facts. Ordering across envelopes follows actual ws delivery. Input transcription can arrive after output completion and remains independent evidence; durable association belongs to later orchestration. Interrupted output is followed by turnComplete without generationComplete. Generated audio does not prove playback.

Unknown harmless protocol additions are ignored. Empty envelopes, malformed recognized fields, invalid PCM/rates and premature or repeated setup completion fail closed. Tool batches are surfaced as events; the host executes already-granted tools and answers each batch in one response frame. `goAway` projects the documented duration then closes honestly. Resumption updates expose only availability; raw handles are never emitted or persisted and no resumption is attempted. Sliding-window context compression and documented history/VAD controls are included; no resumption or reconnect is attempted.

When a provider frame is rejected, the adapter emits one bounded stderr diagnostic event `live_frame_rejected` carrying the error code, the frame kind (the recognized top-level key, or `unknown`, `non_object` or `invalid_json`), the wire byte length and a bounded list of top-level and nested key-name paths. It never carries a value, text, audio or id. The host persists it to `host.log` through the closed `safeEvent` whitelist.

## Failure and resource bounds

`LiveVoiceError` exposes a fixed code/message only. Outcomes expose `{status, code}`. Requested shutdown is `closed`; abort is `cancelled`; absolute deadline is `deadline`; other terminal failures are `failed` with a specific code. Provider failures, transport errors and unsolicited remote closes are distinct. Resolver errors, ws stacks, raw URLs, keys, provider error messages and close reasons are not returned or logged. Recognized text containing the resolved synthetic/test key is rejected rather than exposed. The adapter does no logging.

`ready` rejects with a sanitized error if setup never completes. `done` resolves after owned cleanup; it does not claim a model answer completed. There is exactly one terminal outcome. A caller may always inspect done, including if it cannot keep up with events. Event overflow retains prior queued evidence and a reserved fixed terminal event; it does not silently drop speech. Only one event iterator and one pending next call are supported. Ending the iterator closes the session.

All limits are configurable positive finite safe integers, snapshotted at construction:

| Limit | Default | Purpose |
| --- | --- | --- |
| maxIncomingBytes | 1 MiB | Real ws maxPayload before parsing |
| maxOutgoingBytes | 1 MiB | Single serialized frame |
| maxBufferedBytes | 2 MiB | Existing ws bufferedAmount plus next frame |
| maxEventBytes | 1 MiB | Retained event payload budget and maximum single event |
| maxEvents | 128 | Retained event count, plus one reserved terminal outcome |
| maxRequestBytes | 256 KiB | UTF-8 JSON system/history budget, whole history only |
| maxHistoryTurns | 128 | Initial text turn count |
| handshakeMs | 15 seconds | Socket handshake and actual setup completion |
| idleMs | 60 seconds | No accepted inbound/outbound activity after readiness |
| sessionMs | 15 minutes | Whole session, including deferred credentials |
| closeMs | 1 second | Graceful close cleanup before forced termination |

Timers must also fit Node's 32-bit timer range. Absolute deadline is validated and checked before/after deferred credential resolution, before socket construction and at writes/event work boundaries. Handshake, idle, session, deadline and close timers are owned and cleaned on terminal paths. Defaults are configurable operational bounds, not claims that every transient network delay is fatal. Short test timers are synthetic test bounds, not product latency guarantees.

## Build and offline verification

Run `bash scripts/check-live-voice.sh` for the canonical server compiler, focused real-loopback ws tests and offline production tarball import. Run `bash scripts/check-package.sh` for existing package/artifact assertions. Canonical package files include the adapter and bundle locked ws 8.22.0 (MIT). Development type dependency is @types/ws 8.18.2 (MIT), not a runtime dependency. No unrelated dependency upgrade or private compiler path is needed.

No live account, provider call, microphone, speaker, browser, permission prompt or cloud credential is needed. Fixtures use fake credentials and synthetic silent PCM. Canary secret-bearing errors, close reasons and resumption handles must not appear in public serialization or captured logs.

## Primary technical references

- Google Live protocol, fixed endpoint and message schemas: <https://ai.google.dev/api/live>
- ws API, maxPayload, bufferedAmount, handshakeTimeout and termination: <https://github.com/websockets/ws/blob/master/doc/ws.md>
- Locked production release metadata: <https://registry.npmjs.org/ws/8.22.0>
- Type release metadata: <https://registry.npmjs.org/@types%2Fws/8.18.2>

These references document transport behavior. Local offline tests do not establish provider availability, model fluency, playback or an installed voice experience.


## Tool batches and setup parity

`LiveVoiceRequest.tools` accepts the frozen host-generated function declarations. Setup sends one `tools: [{functionDeclarations}]` array when nonempty. The shared declarations helper derives provider-compatible schemas while retaining the original tool-definition schemas; provider schemas never become grant identities or validation authority.

Optional `languageCode` is a BCP-47 language with an optional two-letter region, case-normalised to lower language and upper region (`en`, `en-IN`, `de-DE`); bare `ar` becomes `ar-XA`. Setup includes `historyConfig.initialHistoryInClientContent`, sliding-window compression with `targetTokens: 32000` and no trigger threshold, and LOW start-of-speech sensitivity. The adapter derives its declared `LiveVoiceCapabilities` once from the model id: a provider-default thinking level (no `thinkingConfig`) for 3.8 Live, and `thinkingConfig: {thinkingLevel: 'minimal'}` when `capabilities.thinking` is `minimal`.

A `toolCall` event carries the entire provider batch, and `toolCallCancellation` carries cancelled ids. The host answers all outstanding ids in exactly one `sendToolResponse({responses})` call, producing one `toolResponse.functionResponses` frame. The wire-38 experiment (10 real Gemini 3.8 Live sessions, `wire-38-report.md`) confirmed that realtimeInput sent while a BLOCKING call is pending is accepted, transcribed and answered, that barge-in is signalled by `serverContent.interrupted` and never by `toolCallCancellation`, and that a late toolResponse after that interruption is accepted silently. Microphone frames are therefore forwarded live in order while a batch is unanswered, never dropped or buffered; a batch always answers once when it completes. Drain-time drops are counted by `drainingDropCalls` and `drainingDropBytes`. Tool authorization and execution remain outside the adapter; the fixed endpoint, transport headers, limits, credential scrubbing and no-reconnect behavior are unchanged.

An upstream 1007 close before setup readiness is classified as `provider_setup_rejected`; provider close reason text is never included in the outcome.

Provider frames are validated independently for every known key: setupComplete, serverContent, toolCall, toolCallCancellation, goAway, sessionResumptionUpdate and voiceActivity. Voice activity ACTIVITY_START and ACTIVITY_END project through waitingForInput markers to listening and thinking; empty serverContent objects and empty modelTurn parts are valid informational content when accompanied by voiceActivity. Unknown informational siblings (including usageMetadata) are ignored, counted up to 65,535 per session, and logged as structured stderr key names only, once per retained name (at most 32 identifier-shaped names of 64 characters). Values are never logged. Empty top-level frames, malformed known content or tool calls, setupComplete after ready, provider errors, and serverContent before ready remain fail-closed.

After setup readiness, empty `serverContent` frames are informational, with or without siblings: they are counted on the session and their key name is logged once through the bounded `live_provider_informational_key` event. Gemini voice activity uses `voiceActivity: {type: 'ACTIVITY_START' | 'ACTIVITY_END'}` to emit the existing waiting-for-input activity events; the legacy `voiceActivityType` field remains accepted. Content before readiness, malformed model-turn parts and malformed tool calls still fail closed.

## Capabilities and accent placement

The adapter declares `LiveVoiceCapabilities` on the port (`capabilities` in `server/adapters/live-voice/types.ts`): `provider`, `supportsResumption`, `supportsGoAway`, `supportsInterruption`, `supportsServerVadConfig`, `inputRates`, `outputRates`, `outputModalities`, `thinking`, `supportsToolScheduling` and `toleratesEmptyReadyLifecycle`. The host and shared session code read these flags; a model id is read only inside the Gemini adapter, once, to derive the flags. There is no accent capability (the accent is a prompt input every provider receives) and no tool-execution capability: the host is the sole executor of tools.

The accent lives in exactly two places: the system instruction (the head block and the terminal voice anchor composed by the prompt layer) and the setup parameters (`voiceConfig.prebuiltVoiceConfig.voiceName` and `speechConfig.languageCode`). A function response carries the tool data only: there is no per-tool `_voice_anchor`, and the model-first opening trigger carries no accent text.

## Connection resumption contract

Each adapter owns exactly one provider connection and never reconnects itself.
Setup always includes `sessionResumption: {}`; a handle supplied by the live owner
changes it to `{handle}`. Updates are typed private owner events
`resumptionHandle` with a handle or null, never public markers. A typed `goAway`
event carries `timeLeftMs`; it stops outbound admission without finishing the
connection. The owner may replace the draining connection immediately.

Outcomes classify network failures and transport closes 1006/1011 as recoverable,
as well as completion of a provider drain. A rejected frame after ready is also
recoverable, so the owner can resume it. Pre-ready failures, policy/setup
rejection (including 1008), authentication, quota and local session, idle or
deadline expiry stay final. Limits supplied by the owner override connection timers,
including the remaining session/idle budget on resumed connections. Recovery
attempts and durable continuity belong only to the live owner.

The adapter also watches its own send path for a dead upstream and hands a
recoverable `transport_error` to the owner before the provider session is lost. A
socket whose queued bytes stay above 128 KB for 2 s, or that does not drain at all
for 2 s, is stalled, in addition to the existing hard ceiling (half the send buffer
held for `upstreamStallMs`). The adapter sends a websocket ping every 5 s and two
missed pongs declare the socket stalled. While the queue is above 64 KB its depth is
surfaced about once a second for logging.


At the socket boundary, any non-101 HTTP upgrade response is a final
`provider_setup_rejected`, including 401/403 authentication and 429 quota
refusals. Established WebSocket `WS_ERR_*` protocol failures are final
`protocol_error` (message-length overflow remains `incoming_limit`). Unknown
socket errors are final, not inferred network failures. Known network errno
failures such as `ECONNRESET`, `ETIMEDOUT` and `EPIPE`, abnormal close1006 without
a prior protocol failure, server-error close1011 and provider drains retain
recoverability. HTTP refusal bodies and error text are never diagnostics.

## GPT-Live turn taking

`gpt-live-1` publishes no turn detection, speech start or spoken-response end, and the
protocol has no input buffer commit, clear or output-audio-done frame: the server owns turn
taking (`server/adapters/live-voice/openai.ts`). The adapter therefore derives both
boundaries itself, and never drops an output frame doing it.

- No permanent frame dropping. Every valid `session.output_audio.delta` of an open session is
  forwarded at 24 kHz, and an input transcript event can never silence future output audio. The
  one exception is bounded and never latches: see "A cut answer does not replay" below.
- Think time. `gpt-live-1` sends no generation-start event on a plain turn, so when an input
  episode ends with no assistant audio playing or held the adapter synthesizes the pair the host
  needs: the owner's input transcript finished and a `modelTurnStarted`. The host maps that to
  THINKING unless she is already speaking, and it resets the turn's completion flag, which is
  what arms the response watchdog, so every owner turn is watched rather than only the first.
- Audible silence. When output deltas have been quiet for 500 ms (`OUTPUT_SILENCE_MS`) and the
  modelled playback has drained, the adapter emits `waitingForInput` true: the host leaves
  SPEAKING for LISTENING there instead of waiting out the 2000 ms synthesized `turnComplete`,
  which stays the semantic end of the turn. New audio before that completion re-enters SPEAKING.
- A cut answer does not replay. After a barge-in flush the frames of the answer the owner cut
  keep arriving; they are dropped until the output stream shows a gap of 400 ms
  (`POST_FLUSH_GAP_MS`) or 2500 ms have passed since the flush (`POST_FLUSH_DROP_LIMIT_MS`),
  whichever comes first, and then forwarded again. The window is bounded, so it cannot latch,
  and it reports `gptlive_post_flush_dropped_ms` {ms} once when it ends.
- Barge-in. The adapter emits `interrupted`, once per input episode, only when assistant audio
  is queued or playing (the modelled playback queue below) and the assembled input transcript
  of that episode holds at least two words. An input episode ends after 700 ms with no
  input-transcript delta (`INPUT_EPISODE_QUIET_MS`), which resets the assembled transcript and
  re-arms the once-per-episode latch, so the deltas of one word count as one word and a
  one-word utterance ("mm", "stop") never cuts the reply. The host flushes its native playback
  queue on `interrupted`.
- Head start. gpt-live-1 sends output audio at about 1x real time and the native jitter buffer is 80 ms, so the
  first audio of each speaking stretch is held and forwarded as one event once it holds 300 ms of audio
  (`HEAD_START_MS`) or 300 ms of clock time have passed, whichever comes first; after that every delta passes
  through. A barge-in, a provider error or a close discards the hold, and held audio counts as playback to be cut.
- Delegated calls. The host answers each delegated call on its own, so the adapter records each answer and sends
  one `function_call_output` per pending call of the turn plus a single `response.create` when the last one arrives.
  A call id the turn never delegated is a `protocol_error`.
- End of turn. The adapter emits `turnComplete` and closes the output transcript once when all
  hold: audio was forwarded since the last completion, no output delta for 2000 ms
  (`TURN_IDLE_QUIET_MS`), the modelled playback queue has drained, and no delegated response is
  outstanding between `response.created` and `response.done`. A delegated `response.done`
  clears the outstanding flag and never declares playback drained. Later audio simply reopens
  speaking.
- Playback drain. No native playback-drained signal reaches the host, so the adapter models the
  queue from forwarded PCM: 24 kHz s16 mono is 48,000 bytes per second, appended behind whatever
  is still queued and reset by a flush or a provider error.
- Receipts, metadata only and never transcript text: `gptlive_flush` {words, queuedMs},
  `gptlive_turn_complete` {idleMs, drained}, `gptlive_post_flush_audio_ms` {ms} for the audio
  still received after a barge-in before the next input episode, and `openai_instructions_size`
  {chars, bytes} at session start, which proves in a log that the instructions were not cut.
  Empty and whitespace-only input transcript deltas carry no word: they start no episode and
  never flush.
- The wrapper instructions additionally carry OpenAI's live prompting lines "Do not treat a
  cough, music, or nearby conversation as a new request." and "Keep listening while the owner
  pauses to think."
