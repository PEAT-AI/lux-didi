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

System, text-only whole initial history, declared classes, settings and deadlines are copied/validated before credentials or networking. Empty history is valid for initial audio; no fabricated user turn is sent. Initial history uses `clientContent` with `turnComplete:false`, after actual `setupComplete`. `ready` is not socket-open: exactly one setup requests AUDIO, configured voice and input/output transcription. Automatic activity detection is provider-owned with `START_SENSITIVITY_LOW`. Continuous input supports full duplex; `endAudioStream()` is optional and is never required for each turn. The adapter provides no manual activity or per-turn cancel API.

Input is nonempty even-byte PCM16 little-endian 16 kHz. Output requires `audio/pcm;rate=24000` and valid even-byte PCM16 little-endian data. No resampling is performed. Early audio is refused with `not_ready`, never buffered. Each accepted audio frame is sent once, without reconnect, retry, resend or tool replay. A malformed audio argument or disallowed class fails the call without silently writing it. Frame or socket congestion limits terminate the session explicitly.

## Events and truthful boundaries

One session spans multiple turns. Events have a monotonically increasing adapter-owned sequence, not provider IDs or durable turn IDs. Supported events: `ready`, `audio`, `inputTranscription`, `outputTranscription`, `modelText`, `generationComplete`, `turnComplete`, `interrupted`, `waitingForInput`, `interactionStatus`, `goAway`, `resumptionAvailability`, and one terminal `outcome`. Audio events expose an owned Uint8Array and the validated output MIME type. Text transcription events preserve optional provider `finished`; this is not a heard, committed or recallable flag. `modelText.thought` preserves thought versus other model text; neither is labeled a spoken answer.

Combined serverContent fields are not discarded. Deterministic projection within one envelope is model parts, input transcription, output transcription, interruption, generation boundary, turn boundary, then activity facts. Ordering across envelopes follows actual ws delivery. Input transcription can arrive after output completion and remains independent evidence; durable association belongs to later orchestration. Interrupted output is followed by turnComplete without generationComplete. Generated audio does not prove playback.

Unknown harmless protocol additions are ignored. Empty envelopes, malformed recognized fields, invalid PCM/rates and premature or repeated setup completion fail closed. Tool batches are surfaced as events; the host executes already-granted tools and answers each batch in one response frame. `goAway` projects the documented duration then closes honestly. Resumption updates expose only availability; raw handles are never emitted or persisted and no resumption is attempted. Sliding-window context compression and documented history/VAD controls are included; no resumption or reconnect is attempted.

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

Optional `languageCode` is a bare ISO 639-1 code (`ar` becomes `ar-XA`). Setup includes `historyConfig.initialHistoryInClientContent`, sliding-window compression with `targetTokens: 32000` and no trigger threshold, and LOW start-of-speech sensitivity. Models other than 3.8 Live receive `thinkingConfig: {thinkingLevel: 'minimal'}`.

A `toolCall` event carries the entire provider batch, and `toolCallCancellation` carries cancelled ids. The host answers all outstanding ids in exactly one `sendToolResponse({responses})` call, producing one `toolResponse.functionResponses` frame. Microphone frames while a batch is unanswered are buffered in an ordered, bounded PCM FIFO (`AUDIO_BUFFER_HIGH_WATER_BYTES`, ten seconds of 16 kHz mono 16-bit); accepted bytes are never silently dropped. Sustained local speech energy (`AUDIO_SPEECH_RMS_THRESHOLD` for `AUDIO_SPEECH_MIN_BYTES`) or the high-water mark supersedes the batch: the adapter marks the outstanding ids answered, sends one neutral `toolResponse` frame ("the result was set aside"), then flushes the buffered frames in order at 4x real-time in bounded chunks (`AUDIO_FLUSH_CHUNK_BYTES` every `AUDIO_FLUSH_INTERVAL_MS`, so a ten-second buffer drains in about 2.5 s) and live frames queue behind the flush in order. A quiet pending batch under the high-water mark answers normally and its buffered frames follow the response in order. `toolCallCancellation` removes cancelled ids before any supersession, so they receive no response. The adapter reports superseded ids to the owner through a typed `toolCallSuperseded` event carrying the reason; the owner records the late completion with a superseded disposition and never sends a second provider response. Drain-time drops are counted by `drainingDropCalls` and `drainingDropBytes`. Tool authorization and execution remain outside the adapter; the fixed endpoint, transport headers, limits, credential scrubbing and no-reconnect behavior are unchanged.

An upstream 1007 close before setup readiness is classified as `provider_setup_rejected`; provider close reason text is never included in the outcome.

Provider frames are validated independently for every known key: setupComplete, serverContent, toolCall, toolCallCancellation, goAway, sessionResumptionUpdate and voiceActivity. Voice activity ACTIVITY_START and ACTIVITY_END project through waitingForInput markers to listening and thinking; empty serverContent objects and empty modelTurn parts are valid informational content when accompanied by voiceActivity. Unknown informational siblings (including usageMetadata) are ignored, counted up to 65,535 per session, and logged as structured stderr key names only, once per retained name (at most 32 identifier-shaped names of 64 characters). Values are never logged. Empty top-level frames, malformed known content or tool calls, setupComplete after ready, provider errors, and serverContent before ready remain fail-closed.

After setup readiness, empty `serverContent` frames are informational, with or without siblings: they are counted on the session and their key name is logged once through the bounded `live_provider_informational_key` event. Gemini voice activity uses `voiceActivity: {type: 'ACTIVITY_START' | 'ACTIVITY_END'}` to emit the existing waiting-for-input activity events; the legacy `voiceActivityType` field remains accepted. Content before readiness, malformed model-turn parts and malformed tool calls still fail closed.

## Connection resumption contract

Each adapter owns exactly one provider connection and never reconnects itself.
Setup always includes `sessionResumption: {}`; a handle supplied by the live owner
changes it to `{handle}`. Updates are typed private owner events
`resumptionHandle` with a handle or null, never public markers. A typed `goAway`
event carries `timeLeftMs`; it stops outbound admission without finishing the
connection. The owner may replace the draining connection immediately.

Outcomes classify network failures and transport closes 1006/1011 as recoverable,
as well as completion of a provider drain. Policy/setup rejection (including
1008), authentication, quota, protocol errors and local session, idle or deadline
expiry are final. Limits supplied by the owner override connection timers,
including the remaining session/idle budget on resumed connections. Recovery
attempts and durable continuity belong only to the live owner.


At the socket boundary, any non-101 HTTP upgrade response is a final
`provider_setup_rejected`, including 401/403 authentication and 429 quota
refusals. Established WebSocket `WS_ERR_*` protocol failures are final
`protocol_error` (message-length overflow remains `incoming_limit`). Unknown
socket errors are final, not inferred network failures. Known network errno
failures such as `ECONNRESET`, `ETIMEDOUT` and `EPIPE`, abnormal close1006 without
a prior protocol failure, server-error close1011 and provider drains retain
recoverability. HTTP refusal bodies and error text are never diagnostics.
