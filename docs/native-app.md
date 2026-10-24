# The native app

Reader: anyone who changes the Swift app in `Sources/LuxDidi`.

The app owns the microphone, the speaker and presence, and it owns nothing else. This page covers the native live client, the conversation protocol between app and host, pending request recovery, and the companion protocol and trust boundary that govern both.

## Native Live client


The Foundation protocol client is composed with native HTTP, audio and app controls. Native requests contact only the configured loopback service, never a provider directly. CompanionClient remains the sole descriptor, credential and readiness owner. Construction and app launch do not request microphone permission, create an audio engine, play audio or attach a Live socket. Hardware/provider acceptance is a separate human trial, not a claim established by silent synthetic tests.

### Injected boundaries

`LiveSessionCoordinator` accepts `LiveOperatorHTTP`, `LiveSocketConnecting`, and `LiveAudioSink`. HTTP status/create/snapshot/journal/revoke are typed injected operations: the coordinator neither serializes REST requests nor obtains credentials. The binder must combine the canonical operator status and Live profile status, enforce operator authority, send only `inputClass` in a create body and the supplied exact idempotency key in its header, bound response decoding, honor task cancellation, and return safe errors.

`LiveSocketTransport` accepts `LiveAuthenticatedRequestFactory`. It validates each factory result **before creating a task**: exact bound `ws://127.0.0.1:<port>` origin and that session's audio path, GET, no query/fragment/userinfo/body, exact Host, one non-folded Authorization header, epoch and profile pin, no Cookie/Origin/subprotocol/proxy authorization. Credentials are not rebuilt in the coordinator. Transport uses `URLSession.webSocketTask(with: URLRequest)` in a dedicated ephemeral session with cookies, cache, credential storage, and redirects disabled. No shared session, Network-framework fallback, generic proxy, or automatic reconnect is provided.

### Intent and finite states

An explicit `begin` freezes origin, assistant ID, authority epoch, provider, model, voice, profile identity, and input data class. Status must match before create; the returned snapshot and grant must match before attachment. A fresh key is generated only by a new explicit begin. A lost create response enters `createUnknown` while preserving its key/meaning; `retryCreate` replays only that exact key/meaning after fresh status validation. A terminal or already-consumed snapshot cannot attach. No restart replay, automatic create/rekey/attach, or list endpoint exists.

States are `idle`, `checking`, `creating`, `createUnknown`, `attaching`, `active`, `closing`, `terminal`, `outcomeUnknown`, and `failed`. Only server facts produce a known terminal outcome; a socket close or failed revoke does not imply successful close. A new explicit begin/stop fences old callbacks by generation; explicit recovery reads also fence operation order. All public errors are fixed enum values, not raw Foundation errors, headers, credentials, provider codes, or payloads.

`stop` is an explicit forget/cancel operation, not a successful close or durable server revoke. A clean user-requested shutdown should attempt `revoke` before forgetting. Dropping or crashing a client cannot guarantee server cleanup. Accepted-unused expiry is server ownership, never client persistence or synthetic terminal facts.

### Audio and ordering

Input is nonempty, even-length binary PCM16LE mono 16kHz, at most 64KiB per frame. Output is binary PCM16LE mono 24kHz. This code does not generate, capture, play, resample, or reinterpret audio. A sink must honor cancellation, and `flush` must invalidate its older queued audio before returning. One ordered receive stream awaits an interruption flush before admitting later PCM; it does not invent `generationComplete` on interruption. Public transcription markers may be decoded ephemerally; nothing is stored locally.

Accepted marker frames use `type` equal to `ready`, `interrupted`, `generationComplete`, `turnComplete`, `waitingForInput`, `inputTranscription`, or `outputTranscription`, with positive integer `sequence` and `journalSequence`. Transcription frames carry `text`/`finished`; waitingForInput carries `value`. Terminal frames carry `type`, `state`, `code`, `complete`; the client exposes only the closed state enum and completeness, discarding the provider code. Outbound controls are exactly `{"type":"endAudioStream"}` and `{"type":"close"}`. Unknown, malformed, or oversized messages fail safely.

Application input admission is bounded to four pending frames and 128KiB; the Foundation socket additionally admits at most one send and one receive at a time. Overflow fails visibly and closes the owned transport, never silently discards successful audio. The client has no output queue: one bounded frame is delivered inline to the sink. Foundation/OS transport buffering is not claimed to be an application-controlled queue or an audible-delivery receipt. Input-stream end disables further input PCM for that session.

### Recovery and limitations

Explicit `readSnapshot`/`readJournal` recover only a known in-memory session, without attachment. The server journal is authoritative. A page's terminal row fact is separate from its fragments and is never fabricated as a transcript/marker. A fresh coordinator has no session identity and performs zero automatic requests. No local receipt/database is used. Host restart authority rebinding remains the future binder's responsibility.

The original source base is `f2acf9d17651f2770c068984137f44f2604e55db`; wire grammar comes from `server/http/live-upgrade.ts`, ownership from `server/live`, and profile composition from `server/host/live.ts`. Accepted upstream `ab4a8c1de94b0cea8e906e6d862fad9f0c296417` was merged normally to repair abandoned accepted-session expiry and project the four configured handshake/idle/session/close timers to the adapter. Both external regressions remain intact in the producer; historical failures are retained. The gateway's `wsBufferedBytes` and the provider adapter's `maxBufferedBytes` have different owners and are intentionally not mapped. Socket detach ends the consumer; configured idle cleanup and hard-deadline cleanup are separate proofs, not an immediate-close guarantee. The hard-deadline fixture explicitly sets idle longer than session duration and rejects an idle-timeout result. Acceptance requires the complete exact-commit producer and independent review; no device or product-binding acceptance is implied.

### Verification

Producer command: `bash scripts/check-native-live.sh`. Managed lanes invoke it only through their declared foreground controller check. It builds the committed server/web locks offline, uses the real canonical `web/dist` separately from fixture state, compiles only the two selected production Swift files and isolated test helpers with Swift 6 strict concurrency/warnings-as-errors, then runs affected accepted Live owner/gateway tests, real host/native child kill and EOF tests, actual Foundation header/redirect tests, client behavioral tests, and an isolated compiled Cookie-guard mutation sensitivity. All credentials and PCM are synthetic; all sockets are controlled loopback; the trusted `liveTesting` seam never opens an external provider. A second local trap proves zero redirect credential leakage. Failed artifacts are retained and reported, not mislabeled as passing or discarded.

No actual device, UI consent, real account/provider, installation, deployment, or product-binding claim is made.

### Full-duplex composition (R1)

`NativeLiveOperatorHTTP` combines operator and Live status, freezes the authority epoch, sends only `inputClass` and the coordinator's idempotency key when creating, and decodes canonical envelopes. Its dedicated ephemeral session refuses redirects and disables cookies, cache and shared credentials. The CompanionClient builder validates each destination and current readiness/expected epoch using the existing credential closure. Audio upgrades contain exactly Bearer Authorization, x-didi-authority-epoch and x-didi-live-profile. No cookie, Origin or provider key is sent.

Start Live voice is the explicit consent action: microphone audio leaves the device for the configured Live provider. Start requests audio permission, creates one AVAudioEngine, enables voice processing on both stopped IO nodes and checks both enabled flags. Refusal, denied permission or an unusable device fails Start visibly. The same engine captures and plays 24 kHz model PCM concurrently. Capture never waits for or pauses during playback; Gemini automatic VAD owns turn boundaries. There is no per-turn Stop or endAudioStream. Barge-in flush fences playback by turn: a chunk whose turn was flushed while it was in flight is dropped, never scheduled. The first ~80 ms of a turn (1920 frames at 24 kHz) is prebuffered before playback starts, so a bursty provider never begins on an empty queue; queue drains, positive speech gaps and late-after-flush chunks are counted separately in the call-end summary. There is no production player output tap: playback exposes a single speaking callback (`onOutput`), which the orb level feed owns.

One streaming AVAudioConverter converts the hardware format to 16 kHz mono Int16 little-endian and lives for the whole capture; a route or hardware-format change rebuilds it fresh for the new input format, never reusing a stale channel map. A carry buffer emits only complete 640-byte (20 ms) frames. The ring holds 25 frames (500 ms) so a sender stall up to half a second drains without a drop; it drops oldest only past that and counts every drop. Exactly one drain task pops all whole frames per wake and calls sendPCM sequentially. While connecting, frames are not sent until the coordinator reports active. Mute keeps the session and engine, clears unsent frames and partial carry, suppresses further frames and zeros the input indicator. Unmute resumes the same converter/session. A frame already committed to transport when Mute is pressed cannot be recalled. Stop drops unsent and final partial frames, never pads them, closes the Live session and releases the tap, engine, player and socket. The call-end summary carries a byte ledger, `converted = sent + dropped + residual` (residual is the final incomplete frame), so capture loss is always visible and never silent.

The player retains queued PCM up to a 120-second source-audio memory guard; exceeding that guard flushes the old queue and schedules the new frame. Hot mute fences arriving playback as well as capture, clears the queued tail and invalidates old completions. Unmute never replays PCM discarded by that fence. A mute keeps the provider session open for the host's 180 s cost cap, so a tap inside that window listens again on the same session and generation with no reconnect; past it, or after the session ends while muted, the next tap connects as before. Interrupted, terminal, receive error, close and revoke flush the sink; flush is player.stop(), not a wait for scheduled buffers. An output-route change releases old capture and queued output, follows the system defaults and rebuilds the converter, tap and player with voice processing on both IO nodes. It preserves mute and the same authorized Live session; it does not reconnect the Live socket or replay audio. Repeated notifications are coalesced and old drain/tap callbacks are fenced. An input identity change releases capture and shows “Microphone changed to <device name>. Resume?”; only explicit Resume authorizes the new input. Resume rechecks the default-device identity. No valid default input or a failed rebuild releases capture and presents Restart instead. The panel shows the current microphone and output route. There is no automatic Live reconnect. Dictation and Live enforce a one-microphone guard in both directions. Hide, sleep, logout, service loss and quit use the same teardown path.

Lifecycle labels are idle, connecting, listening, speaking, muted, ended, failed, outcomeUnknown and pausedForInput. Listening comes from coordinator active events; speaking follows the audible PCM at the current playback queue head, not a claim that the model heard the user. Silent fill remains scheduled in order and does not claim speaking; a later speech buffer becomes speaking only when earlier buffers have played. Silent synthetic tests cover real converter continuity for irregular 44.1 kHz stereo chunks, frame assembly, drop-oldest overflow, mute/unmute at the capture buffer, interleaved input while playback is suspended, and flush ordering. Both-node voice-processing effectiveness, permissions UI, physical device loss and provider barge-in require Rob's human device trial. Do not run an automated audible test.

### Where the logs are

Choose **Reveal logs** in the Didi menu bar menu to open the active service's
`<dataDir>/logs` directory in Finder. The normal installed app uses
`~/Library/Application Support/ai.peat.lux-didi/logs` (the active supervisor's state directory
is authoritative if a proof run uses an isolated directory).

The Node host writes `host.log`, containing timestamped JSON diagnostic events
and bounded `host_error` records with class and code. It rotates at 5 MiB,
keeping `.1` and `.2`, with file permissions `0600`. Supervisor diagnostics
are not included in this change.
Console output is unchanged. Ready frames, credentials, exception messages/stacks,
conversation bodies and memory text are not persisted. Unknown console errors are
recorded as a class token, not copied verbatim.

Native Live failures show the service's HTTP status and typed code or the socket
close code and bounded `attach_rejected:<code>` reason when available. Unknown
failures retain the generic guidance; no automatic reconnect is introduced.

Each host start creates `host.log` with a bounded `host_started` event containing the installed release commit (or `unknown` for source starts), configuration kind (`effective` or `seeded`) and endpoint count, never configuration paths or secrets.

#### Native Live operator feedback

Before Start, the native panel displays the configured session and idle limits
from the optional `limits` field on `/api/v1/live/status`. Older services without
that field remain decodable; the panel reports that limits are unavailable,
never substitutes defaults. A session or idle timeout explains the limit and
asks for an explicit new Start. Live never restarts automatically.

Start errors distinguish unreachable service, unconfigured Live, HTTP rejection,
unexpected response and local audio or permission failures. A lost CREATE reply
remains an unknown outcome, not a safe retry. The native app records closed
failure codes in `logs/native-live.log` (0600), without error bodies or credentials.

Show conversation focuses the existing authenticated embedded view. Connections
is read-only and uses the page cookie, never the Live bearer credential. It
refreshes every ten seconds only while its window is visible and not minimized.
The native client POSTs its typed pre-CREATE failure to `/api/v1/diagnostics/client`; Swift wiring lands with W-NAT2's follow-up.

### Local service recovery

An owned local child exit invalidates the old connection and stops Live. The supervisor shows a persistent “Local service restarting” status while attempting at most three replacements, after 1, 2 and 4 seconds. Successful recovery does not reset this budget; only an explicit new activation does. Quit or disconnect cancels pending work and fences old callbacks. Wake reconciles the owned child's liveness and reconnects the client to probe health. A network/health failure alone is not evidence of child death and does not trigger replacement.

A replacement child receives fresh connection authority. Child loss or authority replacement discards the old Live conversation, including its frozen HTTP origin and coordinator, while releasing capture synchronously. Recovery rebinds the service client, never the microphone or a Live session. Only a new owner Start creates the replacement conversation from the current client authority. A same-authority wake health reconciliation preserves the current conversation. Native audio tests use real AVAudioConverter, capture buffers and the device drain with an injected input format, so they exercise mute preservation and stale-frame discard without opening hardware. Mac lifecycle seams inject scheduling, launch results and wake events; no test waits out the real backoff or rearms a microphone.

The native menu provides explicit Start Live, Mute/Unmute and Stop. Global
Control-Option-Shift-L starts/shows Live, Control-Option-Shift-M toggles mute;
Control-Option-Space remains Show/hide only. Registration conflicts are visible
in the menu. No shortcut, login launch, call badge or Show action implicitly
restarts a stopped microphone. Login availability is opt-in; closing or hiding
still stops capture. Status text and its accessibility label expose the actual
Live state independently of pending calls.

#### Native silent callbacks

With the app running, pending callbacks are polled even when its window is closed.
Use **Enable callback notifications** to explicitly request macOS alert/badge
permission. Denied or unavailable notifications fall back to the independent menu
bar badge and **Pick up Naya’s call** entry. Notifications are silent and generic:
no result text, microphone activation, or override of Focus settings.

A successful notification submission is remembered for this app launch. Transient
submission failures retry on subsequent polls, at most three attempts per job per
launch. Denial does not consume attempts. Pickup suppresses that job for the rest
of the launch; the service owns durable acknowledgement. Relaunch discovers any
still-pending job again. Poll errors clear stale offers and show **Callbacks
offline** in the app and status menu. A stale notification click revalidates at
the service before stopping an active conversation, and reports a missing job or
an offline service without starting capture. Only explicit pickup starts voice.

### Provider continuity in the Mac client

Provider replacement keeps the same Live session. The socket sends JSON control
frames with `type: "continuity"`, `sequence: null`, `journalSequence: n` and
`event: "rebuilding"` or `event: "resumed"`; a rebuilding frame can include a
`reason`. Unknown continuity events are ignored. `/api/v1/live/current` projects
`state: "rebuilding"`; `/api/v1/live/status` remains configuration preflight and
continues to report `status: "configured"`.

During rebuilding the bar and status item show **Reconnecting**, without error
styling. The duplex audio device stays open, captured input is dropped and queued
model output is flushed. Resumption returns to listening, or muted if the owner
was muted, without creating another session. When the resumed setup itself fails,
the server opens one fresh seeded session that carries the conversation so far and
continues, so the client stays in rebuilding and returns to listening as usual; no
client action is needed. Only after the bounded recovery attempts always fail does
the server settle `resume_failed`, which stops the device and displays **Naya's
connection could not be resumed. Start Live again.** Only an explicit Start can open
another session.
#### Best-effort pre-CREATE diagnostic

A typed pre-CREATE failure still presents the same sentence and appends the same
`logs/native-live.log` line. Independently, the app asynchronously attempts one
`POST /api/v1/diagnostics/client` through its existing operator bearer client,
without cookies. The JSON contains only `event: "live_precreate_failed"`, the
`audio` or `service` failure class and the closed failure code. Only `http` and
`socketClosed` include an integer `detail` (status or close code). No text, paths,
error descriptions or response bodies are sent. A 429 or transport failure is
not recorded remotely; it never replaces the native failure and is not retried.

The pre-CREATE boundary is explicit: the start catch is pre-CREATE, and a
coordinator failure is pre-CREATE only while no created session ID exists.
After CREATE completes, failures emit neither this native log line nor this
POST; the service journal and terminal outcome already record them.

### Provider continuity wire contract

A provider replacement does not create a new Live session or change the accepted
prompt, memory or tools. The current projection (`GET /api/v1/live/current`) has
non-terminal `state: "rebuilding"` throughout replacement setup, then returns to
its normal listening/thinking/speaking state. `GET /api/v1/live/status` is the
configuration preflight, not the conversation-state projection: it still returns
`service: "live", status: "configured"` while rebuilding. Clients must not infer
conversation continuity from that configuration status.

Socket JSON control frames use `type: "continuity"`, `event: "rebuilding"` or
`event: "resumed"`, `sequence: null`, an increasing `journalSequence`, and omit absent
`text`, `finished`, and `value`. The rebuilding marker additionally has a typed
`reason` such as `go_away` or `remote_closed`. Journal fragment projections expose
the same `kind`, `event` and optional `reason` with `text: null`; page entries use
`seq` for the journal sequence. No marker, fragment or page entry includes a
provider handle. Continuity entries are status facts, never transcript turns.

For example, the exact socket JSON fields are:

```json
{"type":"continuity","sequence":null,"journalSequence":12,"event":"rebuilding","reason":"go_away"}
{"type":"continuity","sequence":null,"journalSequence":13,"event":"resumed"}
```

The resumed frame omits `reason`; nullable marker payload fields are omitted
rather than serialized as null. The journal sequences above are illustrative.

On `rebuilding`, keep the audio device open, drop captured input rather than
buffering/replaying it, stop old queued playback and show **Reconnecting**.
On `resumed`, permit new input and return to normal live presentation. Do not
restart, re-create or recap the conversation. Terminal snapshots use
`terminal: {state: "failed", code: "resume_failed"}` when recovery cannot complete;
the socket terminal frame is `{type: "terminal", state: "failed", code: "resume_failed", complete: false}`. The native terminal presentation is: **Live voice lost the connection and could
not resume. Start again.** A terminal snapshot ends the device as usual. The
night-master native lane owns coordinator, wire decoding, capture control and
presentation changes together; this server wagon does not edit Swift.

#### Native support exports and capture mute

Copy diagnostics exports only input/output route classifications: built-in, external wired, Bluetooth, USB or unknown. Device names remain local to the Live view and never enter the support snapshot.

The Live bar and status item use the same exhaustive state sentence/icon mapping. Notification permission labels are human descriptions, and local dictation controls say Dictate and Stop dictating.

The binding mute invariant is: (a) no audio frame captured after the owner's mute request is ever sent, and (b) the UI shows muted only after every submission admitted before the request has completed or been cancelled. A frame captured before the mute press and already handed to the transport may still complete: it is audio the owner had consented to send, and bytes handed to the socket cannot be recalled.

Captured frames carry the capture epoch assigned at dequeue. Mute fences capture immediately and advances the coordinator epoch before its acknowledgement. The coordinator checks that epoch again at its final transport submission boundary; older frames not yet handed to the transport are dropped, including after unmute. The muted lifecycle presentation awaits the completion or cancellation of admitted submissions, including a send suspended inside the transport.

#### Engine setup failures

The native player remains 24 kHz mono; its mixer explicitly connects to the voice-processing output node using that node's input-bus format before prepare/start. A built-in-device probe reproduced engine start OSStatus -10875 (`kAudioUnitErr_FailedInitialization`) on the implicit graph and succeeded with the explicit connection. Voice processing remains enabled.

Pre-CREATE audio failures distinguish `device_missing`, `format_unavailable`, `capture_not_configured`, `voice_processing_failed`, `engine_format_mismatch`, and `engine_failed`. Engine and voice-processing errors retain only the numeric OSStatus/NSError code as `detail` in the native journal, never an error description or device label. The owner's sentence names the precise failing step. For compatibility with the existing bounded service route, HTTP audio diagnostics omit `detail` and use its legacy codes: `unsupportedFormat` for unavailable/mismatched format, `voiceProcessingUnavailable` for voice-processing failure, and `deviceUnavailable` for missing device, unconfigured capture or other engine failure. The remaining audio cases retain their existing HTTP codes. Local journal codes stay precise. Input selection, route recovery and mute fencing are unchanged.

#### Playback queue measurements

The native capture summary reports `playbackQueueDrains` and `playbackSpeechGaps` separately. A queue drain is a playback completion that empties the queue, including digital silence and exact buffer boundaries. It is not an audible glitch. The counters reset at each session start; duration spans the whole capture lifetime, including route rebuilds.

A `playback_speech_gap` record carries `gapMs`, `burstMs`, `queuedMs` and `sinceLastChunkMs`. It requires a positive queue-empty interval shorter than 500 ms, with audible PCM on both sides. PCM is audible at an RMS level of at least -50 dBFS. A zero-time boundary, silence on either side, a flush, or a longer pause does not count. These measurements describe the native queue's callback/arrival clock, not a hardware recording or proof that the owner heard a glitch. Every silent PCM sample remains scheduled in order.


## Native conversation: page selection and durable run discovery


Service/web protocol for the native conversation decision (root decision Lux88944). This document is
the repo-side protocol note for the increment implemented on accepted CONNECTED base
`fdb0ea20041cc29b733a095080395d473a0984a5`. The exact wire is in the task's `API.md`; this note records
the contract and its deliberate non-goals.

### Product rules

- The web page remains the only conversation selector. There is no native transcript list, dropdown,
  injected JavaScript or authority bridge.
- Selection is a temporary routing hint keyed by the paired browser principal. It is service memory, not
  a database row or token: it is bound by live authenticated principals, cleared on logout and lost on
  service restart. Choosing a destination grants no processing permission.
- Native reads the selection through the same page principal (cookie) it already uses; it never falls
  back to bearer. Selection writes require the browser cookie, exact Origin/CSRF and the current
  authority epoch; cookie and `Authorization` never combine.
- An externally accepted run becomes visible in the existing web transcript without a page refresh and
  without a second UI. The transcript, orb and layout stay shared and frozen.

### Durable discovery

A run notification stream (`POST /api/v1/conversations/:sessionId/events`) emits only durable run
identifiers. Events carry no transcript, model parts, prompts or credentials. A client:

1. registers the conversation subscription,
2. then reads the conversation's durable `latestRunId`,
3. then attaches the existing per-run stream, deduped by run id.

Reconnect repeats the durable read, so a frame missed while disconnected is found. The server keeps no
replay buffer; backpressure is bounded per subscriber and closes the subscription with
`resync_required`. Terminal states (`accepted`/`dispatch_intent`/`terminal` and the owning outcome, for
example `outcome_unknown` or `cancelled`) stay owned by durable CHAT; an external notification or a
local HTTP 200 is never a model-complete answer.

### Non-goals in this increment

No Swift change, installer, manifest/lock, SQLite schema/migration, model/MCP/provider, planning or CI
change. No change to the CHAT POST body, idempotency fingerprint, consent semantics, route identity or
persistent authority epoch. No new selection database or token, bearer fallback, native transcript
renderer, JavaScript authority bridge or generic polling loop. Draft persistence and the Send API are
unchanged: in-flight drafts are never retargeted, and reselecting a conversation recovers its saved run.

### Native connected-send composition

The native **Send to Naya** action reads status and `/conversation-selection`
through CompanionClient's paired page cookie, then reads the named conversation
for server-resolved consent. An active conversation (including valid standing
consent resolved by the service) is required. No native consent mutation exists.
It prepares the existing PendingRequestStore envelope and marks dispatch unknown
before POST `/chat`, reusing the frozen destination, text and idempotency key on
retry. A successful named run acknowledgement clears the outbox. Authority or
selection changes cannot retarget an uncertain request. The page's existing
conversation event subscription renders the answer. **Save note** is unchanged.


## Native pending request recovery


`PendingRequestStore` preserves **one frozen connected request identity** across native
process termination. It does not send, retry, resolve, or render a conversation. The
store is used by the native Send path (`NativeConnectedSend.swift`). It makes no installed Send/restart parity claim beyond that.
The committed service transcript and CHAT acceptance remain the only conversation authority.

### Four different things

- A **pending request** is the immutable assistant ID, authority epoch, pinned session ID
  and display title, frozen text, idempotency key, optional explicit retry-of run ID,
  and local dispatch phase. It is private app-local JSON, not a transcript copy.
- A **committed server transcript** is service-owned conversation history. The pending
  file is neither proof that CHAT accepted a request nor proof a model completed it.
- A **pre-Send unsaved draft** is not stored here. The caller freezes a request only
  at the Send boundary. This component does not preserve or retarget draft selection.
- **Raw audio** is never stored here. Neither are profile/persona copies, cookies,
  credentials, CSRF tokens, model keys, or caller-defined extension fields.
  Frozen user text is private content; the DTO does not attempt to censor its prose.

### API and caller ordering

The provisional API was published before implementation at the architecture report's
`pending-request/API.md`. Public Swift types live in `Sources/LuxDidi/PendingRequestStore.swift`.

1. The app supplies an explicit dedicated **absolute private directory** to
   `PendingRequestStore(directory:)`. No HOME change, hardcoded user/checkout path,
   keychain/security prompt, network, or accessibility permission is involved.
2. Construct `PendingRequestIdentity(assistantId:authorityEpoch:sessionId:idempotencyKey:)`
   and `PendingRequestEnvelope(identity:displayTitle:frozenText:retryOf:phase:)` using
   the already chosen service identity, frozen destination/text, and caller-chosen stable key.
   The component never fabricates missing UUIDs, rotates an epoch, generates a key,
   truncates text, or changes a destination. Only `.prepared` can create a new record.
3. Await `prepare` **before** any attempted dispatch. It either installs the envelope,
   returns an exact existing envelope, or rejects a conflict. String comparison uses
   UTF-8 bytes: canonically equivalent Unicode text is not the same frozen request.
4. Await `markDispatchUnknown(identity)` **before** an attempted transport call.
   It is a forward/idempotent transition that leaves all frozen fields unchanged.
   `dispatch-unknown` is only evidence that dispatch might have been attempted, not
   evidence that acceptance, sending, or completion occurred. A crash after transition
   but before transport is intentionally indistinguishable from a lost response.
5. After restart, await `load(assistantId:authorityEpoch:)`: `.empty`, `.current(envelope)`,
   or `.orphaned(envelope)`. A different assistant or epoch is an orphan, not authorization
   to rewrite/reseed/retarget it. Corrupt or unsafe files raise a sanitized typed error
   and remain in place for explicit recovery. No automatic discard or new-key retry.
6. A later connected caller must use unchanged CHAT owner/key replay with the frozen
   session/text/retryOf, and obtain **valid durable CHAT acceptance** before invoking
   `acknowledgeAccepted(identity)`. This API cannot establish acceptance or validate a
   `RunSnapshot`. Owner+key lookup, fingerprint checking, and acceptance are service concerns.
   `discardByUser(identity)` is a separate explicitly user-authorized action, never an
   automatic error path. Both methods only remove local state and require all four
   identity fields; empty-state cleanup is idempotent, another request is rejected.

The store is a Swift actor. Calls from the existing `@MainActor` app are awaited;
filesystem operations execute on the store's actor, not the UI actor. There is no
network operation or network wait inside the component. Cooperative competing
processes receive `.busy`, rather than blocking for a filesystem lock.

### Exact version-1 DTO and bounds

Flat keys: `version`, `assistantId`, `authorityEpoch`, `sessionId`, `displayTitle`,
`frozenText`, `idempotencyKey`, `phase`, optional `retryOf`. `retryOf` is **omitted**
when absent, never null. Unknown/duplicate/missing keys, nested extensions, nulls,
wrong scalar types, unknown phases/versions, invalid JSON/UTF-8, and invalid UUIDs
are denied; version is the integer JSON token `1` (not a string, bool, or `1.0`).

UUID strings use HTTP's explicit case-insensitive versions 1 to 8 / RFC-variant syntax.
They are preserved, not normalized. Assistant and epoch are persisted runtime UUIDs.
Required strings must not be whitespace-only. Bounds are UTF-16 units to match
JavaScript string lengths: frozen text **16,000** (`server/http/routes.ts` default),
title **1,000** (session creation route), key **128** (`server/chat/index.ts`). The
local file bound **128 KiB** is newly proposed storage policy, sufficient for worst-case
JSON escaping of accepted text plus bounded metadata; it is not a server payload
limit. Every violation fails visibly; nothing is silently truncated.

### Filesystem and mutation guarantees

The final configured directory is current-user owned and exactly `0700`. Only that
last component may be created; the app must supply an existing parent. Absolute
path components cannot be empty, `.` or `..`, and no component may be a symlink.
Ancestors are descriptor-walked with `openat`/`O_NOFOLLOW` and must be root/current
user owned and not group/world writable, except root-owned sticky system temp
ancestors. The final directory never uses that exception.

`pending-request.json`, `.pending-request.lock`, and `.pending-request.next` must be
regular current-user-owned `0600` files with exactly one hard link. Reads are bounded.
Unsafe directory/file modes, symlinks, FIFOs, foreign owner metadata, hard links,
and path escape fail with fixed `PendingRequestError` codes; diagnostics do not
include the path, frozen text, or underlying exception. There is no permissive fallback.

Each operation opens the same retained private lock file and obtains nonblocking
exclusive `flock` before inspecting/mutating the record. Other cooperative processes
reject with `.busy`; after a winner commits, a competing differing prepare rejects
with `.conflict`. The lock file is never unlinked by cleanup. One active app is
expected; hostile same-UID unlink/rename of the directory or lock is outside this
cooperative writer guarantee. Directory descriptors avoid symlink-following races;
this is not a sandbox against arbitrary same-user code.

Replacement creates the reserved temporary file exclusively, writes all bytes,
`fsync`s and closes it, then atomically renames it over the old record. Rename is
the commit point; no fallible production success-path step follows it. Pre-commit
failures do not report success or replace the old record. Normal failures remove
only the store's own temporary file. Process death can leave the reserved safe temp;
the next locked operation removes it, without promoting it into a pending request.
Unsafe temp remnants are preserved and denied. The valid old/new record is never
reset as an error recovery shortcut.

**Guarantee: process-kill/reopen consistency, not power-loss durability.** No directory
fsync or full hardware flush guarantee is claimed. Explicit clear is an atomic local
unlink, not proof about service state. Malformed files require separate explicit
recovery by the app/user; this store does not provide a corrupt-file purge API.

### Focused verification

`bash scripts/check-pending-request.sh` compiles the actual component under Swift 6
strict concurrency with Foundation/POSIX and no package/dependency changes. It runs
only `Tests/DidiPendingRequestTests/Runner.swift`, using synthetic real private temporary
files and child processes. No browser, app, audio, model, server, or real app state.
`--durations=10` is the runner's supported timing flag, used by the producer.

Coverage includes exact reopen, byte-exact conflicts, transitions, omission and strict
DTO/bounds, orphan classification, symlink/path/mode/hard-link/FIFO denial, preservation,
wrong/matching clear, injected pre-commit failures and actual rename failure, and six
real child-kill checkpoints around initial prepare/transition replacement. Checkpoint
pipes (not sleeps) synchronize competing writers and SIGKILL of only those child PIDs.
Test-only checkpoints compile under `PENDING_REQUEST_TESTING`; the production API has
no fixture/fault extension parameter.

Foreign-file UID rejection uses the production metadata validator with `fstat` of a
real private fixture and a changed UID, since unprivileged macOS cannot create files
owned by another UID. Real foreign-owned system temp directory denial is also checked
read-only, before any lock creation. This does **not** claim a real foreign-owned
private-file fixture was created. No system file is linked, copied, or modified.


## Native companion protocol and trust boundary


The canonical business UI is the exact service-hosted page at `/`. Swift owns only
window/hotkey lifecycle, native draft/record controls, unavailable/retry state,
secure credential lookup and outbound REST. There is no Swift business database,
independent Conversation/Today/Memory screen, inbound JavaScript authority bridge,
script injection, custom command scheme, Node integration, or private WebKit KVC.

### Explicit local instance

Set `LUX_DIDI_DESCRIPTOR` to an operator-provided JSON file containing `origin`,
`credentialService`, and `credentialAccount`. `origin` must be precisely
`http://127.0.0.1:<explicit port>`, without credentials, path, query, or fragment.
The other fields reference an existing Keychain generic-password item. The file
contains no bearer. No default port is trusted. Keychain lookup disables user
interaction; missing access is an unavailable state rather than a prompt.

This first local slice refuses every remote origin. Future HTTPS support requires
explicit per-device pairing and credential scoping; merely changing the URL must
never forward a local bearer to a remote service. Bearer credentials are native
only; neither URL nor argv, logging, WebKit request, nor page script carries them.

### Network and page session

Native REST uses an ephemeral URLSession with no cookie/cache persistence and a
redirect-refusing task delegate. It reads authenticated status for the current
`authorityEpoch`; bootstrap requests a one-time pairing code with the bearer,
then exchanges that code with the exact configured `Origin`, without bearer.
The service's own HttpOnly, SameSite=Strict root cookie is validated and installed
in `WKHTTPCookieStore` before the first document load. Native logout reads CSRF
through the ordinary cookie-authenticated page API; the shared page independently
reads its own CSRF through that API. Nothing is injected into page JavaScript.
Native auth routes are `/api/v1/auth/pairing`, `/api/v1/auth/pair`,
`/api/v1/auth/session` and `/api/v1/auth/logout`; cookie-authenticated mutations
use `X-Didi-CSRF`. These match the published API and read-only accepted service
source at `821630133207ac021d022d51041f40eea8b32205`. Native parses actual
Set-Cookie rather than constructing its own independently named cookie. Fixtures
alone are not accepted production integration.

### Documented WebKit policies

`WKNavigationDelegate.decidePolicyFor navigationAction` accepts only main-frame
GET navigation from a main frame to the configured scheme+host+port and canonical
root path. Targetless popups, subframes, non-GET navigation, download actions,
other paths/origins/ports, credentials, queries and fragments are refused.
`decidePolicyFor navigationResponse` independently validates main-frame, exact
URL, HTTP 200, displayable `text/html`, and no Content-Disposition. Redirect
callbacks stop provisional loads rather than accepting an unexpected hop.
`WKUIDelegate.createWebViewWith` never creates a popup; media capture permission
is always denied via the documented delegate. Media requires user action.
The content controller has zero handlers and zero injected scripts; website data
is nonpersistent. These policies do not claim to make WebKit an OS sandbox or
prevent every same-origin page subresource; service CSP/Permissions-Policy and
trusted shared web code remain their owners' responsibilities.

A local page attempt has a five-second deadline covering cookie preparation and
document load. Ready requires an approved HTTP response AND canonical URL; a
WebKit internal error document completing without a response is unavailable, not
ready and not left loading. Withheld responses hit the finite deadline. Explicit
reconnect starts a fresh attempt; stale navigation callbacks cannot finish it.
Load failure, this bounded deadline, rejected response, and simulated
WebContent termination yield a native unavailable/reconnect view. Reconnect is
explicit, never an automatic authentication or mutation loop. Hide/show retains
the same WKWebView, DOM and cookie store. Reconnect reboots a page session; it does
not silently replace unresolved native capture requests. Clean logout/quit makes
a best-effort revocation of the old scoped page session. Crash revocation is not
guaranteed. Native capture session and unsaved draft are process-memory only.

### Text capture

Explicit native Save posts `/api/v1/sessions` `{title,timeZone}`, then
`/api/v1/sessions/:id/entries` `{text,role:"user",timeZone}`. Each mutation has
its own UUID `Idempotency-Key` and the pinned current `X-Didi-Authority-Epoch`.
The service validates Session's positive revision; entry appends do not carry an
`expectedRevision` field in this API. Existing commitment updates do, but they
are not duplicated in native controls.

An uncertain result retains the immutable text, timezone, epoch, keys and
created session ID. Retry uses that same request, never a new key or edited draft.
A new capture is blocked until the uncertain one resolves. Saved clears the
matching draft only; edits made while an old request runs remain. Cancellation
before dispatch is distinguished from transport loss/cancellation after dispatch,
which is conservatively unknown. No automatic retry runs on expiry, reconnect,
hide/show, or WebContent recovery.

Recording is an explicit native user action with the preserved on-device speech
gate. Automated proof uses only synthetic text and never starts microphone,
playback, permission requests, notifications or broad process kills. This slice
adds no private audio/raw transcript egress or remote microphone authority.

### Evidence limits

`bash Tests/DidiCompanionTests/check-companion.sh` compiles/signs disposable proof
bundles, takes the shared installed `lux-browser-slot` lease, runs actual WebKit
against a bounded disposable HTTP fixture, and preserves the Mac seam/runtime
checks. The installed helper is development tooling, not a public app runtime
dependency. Snapshot proves actual native rendering, not GPU acceleration.
Canvas2D/DOM Naya rendering is owned by the shared web author; no WebGL2 or GPU
claim follows from the WKWebView class or a successful screenshot. Accepted
service+web integration and measurable hardware rendering are separate root gates.

### App-owned installed service (native extension; combined proof still required)

A build-generated `Contents/Resources/didi-runtime.json` selects installed mode.
The native schema uses `schemaVersion: 1`, installId UUID, releaseCommit40hex,
bundle-relative nodePath (`Contents/MacOS/node` inside the app bundle, never an
absolute path), nodeMajor26 and resource-relative serverEntry/webRoot. The
installer owns the actual machine path and release identity; no machine paths or
runtime credentials are committed. A present invalid manifest never falls back
to explicit attach mode. Relative paths cannot traverse or escape resources by
symlink. State derives from macOS Application Support/ai.peat.lux-didi with
current-owner0700 directory; proof executables alone have explicit test overrides.

Native launches verified Node directly with a scrubbed environment (no shell,
PATH fallback, NODE_OPTIONS/NODE_PATH/DYLD injection). A bounded probe checks the
actual major and built-in SQLite. The service argv is exactly serverEntry,
`--supervised --data-dir <state> --web-root <webRoot> --port 0`. Only one owned
child is started. Private stdin carries one HOST-R3 `{type:"start",schemaVersion:1,
nonce}` line and remains open for liveness. One stdout ready line, at most1024
bytes, must match schema/type/fresh nonce/live owned PID, exact127.0.0.1 origin,
UUID authorityEpoch and assistantId. Stale disk descriptors never select a port.
The ready frame does not include a release commit; native does not invent one or
claim signed/notarized provenance from it. Installer validation supplies the
manifest/resource release boundary; same-UID malicious code is not a sandbox claim.

Only after readiness, native opens canonical admin-credential relative to a
validated private directory FD using O_NOFOLLOW, checking regular/current-owner
0600 and bounded/header-safe bytes. Store's single terminal LF is file framing:
native removes that LF before validation and bearer
use; only the canonical 43-character base64url token is accepted. Interior or
repeated LF, CR, whitespace and malformed tokens remain rejected. An unframed
canonical token remains compatible. At earliest executable entry, before AppKit,
WebKit or credential work, native establishes its own-process lifetime legacy
Keychain policy with Set(false) and checked Get(false), never restoring/re-enabling
it. Failed establishment/readback refuses credential work/bootstrap. Each native
Keychain boundary checks established policy and current false readback, retaining
LAContext and per-call authentication-UI fail. The deprecated public lifetime
policy covers legacy login-keychain creation UI that per-call flags do not.
Framework-internal flag changes/compatibility and an existing locked login keychain
remain untested residuals, not a blanket no-UI guarantee for external Keychain mode.
Owned installed mode selects the canonical file directly after verified owned
readiness, without querying, importing or synchronizing a Keychain mirror.
Each native request guard and credential resolution first checks the live owned
connection, strictly rereads the file and compares it to that connection's initial
validated bytes. An unsafe file or changed token retires the connection, stops its
owned host and disables automatic recovery. The visible error requires explicit
Reconnect; restoring the file cannot revive the old provider. A fresh owned start
accepts its current strict file as authority. This deliberately removes the extra
native code-specific Keychain denial/lock gate and historical mirrored-byte pin;
the host already authenticates with this same owner-readable plaintext file.
External descriptor-only mode keeps its existing Keychain source and policy.
An invalid installed resource never downgrades into external mode or an error-driven
source fallback. Existing owner Keychain items remain untouched. Synthetic unique
Keychain services exist only in external-source proof controls and are removed by
their test owner.

Every installed native REST request checks current owned-child identity before
strict credential validation/dispatch, including native page-cookie requests.
Browser requests directly using their existing cookie remain a separate authority;
there is no new browser request interceptor. Explicit restart rebinds only after fresh readiness,
retaining unresolved text/UUID/epoch rather than silently saving a new request.
Bootstrap checks the readiness epoch against authenticated status. Unexpected
child exit clears the page and retains the existing bounded automatic child recovery.
Canonical credential invalidity cancels that recovery and requires explicit Reconnect.
Hide/close retains the child. Quit first awaits bounded scoped
logout, then closes stdin, then applies bounded TERM/owned-PID KILL only if needed.
The actual HOST's supervised EOF contract owns crash cleanup; protocol fixtures
are not combined HOST/web installation proof. No launchd or installation effect
is added by these native sources.

### Isolated installed executable proof

The ordinary installed executable accepts exactly:

```sh
Contents/MacOS/LuxDidi --installed-proof --proof-state /owned-private/state --proof-report /owned-private/result.json
```

This is an explicit synthetic-only mode, not an attach shortcut. Missing,
duplicate, relative or mixed flags fail before normal startup. State must be
outside normal appdata (including its ancestors/descendants), with an owned0700
parent/directory. New state must be empty; existing state must carry the exact
owned0600 `didi-installed-proof.json` lifecycle marker with type
`didi-installed-proof-state`, schemaVersion1, installId and stable proofId.
No business records are stored in the marker, and reopening never deletes or
reseeds service data. The real installed manifest, verified owned HOST process,
canonical private credential file and normal bootstrap/client/UI paths are used;
there is no installed Keychain account or fixture HOST
fallback. Normal install credentials are not read or changed.

Version2 JSON reports use type `LuxDidiInstalledProof`, schemaVersion2,
phase (`running`, `complete`, `failed`), success, runId, installId, proofId,
reopened, source, native, service, priorRecords, newRecord, observations, visual,
serviceStop and error. Observations contain credentialSource `canonical-file`,
credentialValidated, bootstrap, canonicalUIReady, priorRecallComplete and newSaved.
There is no import or Keychain-cleanup success claim. Record fields are exact sessionId,
entryId, full synthetic text and visibleInCanonicalUI. Previous records come
from authoritative untruncated recall/session APIs and are verified in the
canonical UI before one new native synthetic save. Source identity records the
manifest releaseCommit and actual executable/manifest/server-entry SHA256s;
the external build driver must pin them to accepted source. Readiness reports
live owned PID/nonce/origin/epoch/assistantId without secrets. serviceStop
records observed owned exit/status/reason after private stdin/bounded stop.
Native pid/cleanQuitRequested are reported, **not native exit**: the external
driver must observe native exit0 and reject stale/running reports. Early
argument/ownership/config rejection can exit without a new report; never read
a previous successful report after a nonzero invocation.

CGPreflightScreenCaptureAccess is probed, never requested. SDK14.4 explicitly permits `SCShareableContent.currentProcess` content capture
without TCC consent: only that API and the exact live own window are used,
under a four-second one-shot deadline, even when the preflight is false.
Failure/unavailability yields actual WK page snapshot and actual own
accessibility names/enabled/visible states with an explicit native-chrome
visual limitation; late results cannot create claimed artifacts. Missing capture
permission does not block functional proof. Native chrome remains a separate
visual review; an NSView cache image is not faithful evidence. The external
producer owns the shared rendererlease; the public app does not depend on
private harness tooling. No microphone, playback, notifications, model calls
or OS grant prompts are introduced by proof mode.


#### Private installed-proof diagnostics
The consumer-facing `LuxDidiInstalledProof` schema 2 has exact report and visual keys. Schema 1 reports are not accepted by its current verifier. AX consumer/direct-tree diagnostics, WebKit diagnostics, and a capture-error diagnostic are serialized only in a private sibling `<report>.diagnostics.json` (mode 0600). The sidecar remains schema1 and binds `nativePid`, `windowId`, `sourceSHA`, `proofId`, `installId`, and `runId` to that same invocation. It never substitutes for truthful canonical `accessibility`, `nativeChrome`, `error`, or externally observed native exit. Connected same-process WebKit accessibility traversal runs on AppKit's thread; a single bounded own-window observation supplies both the report and the controls gate. Only the application's own PID/windows are inspected, with no permission requests.

