# Native Live client

The Foundation protocol client is composed with native HTTP, audio and app controls. Native requests contact only the configured loopback service, never a provider directly. CompanionClient remains the sole descriptor, credential and readiness owner. Construction and app launch do not request microphone permission, create an audio engine, play audio or attach a Live socket. Hardware/provider acceptance is a separate human trial, not a claim established by silent synthetic tests.

## Injected boundaries

`LiveSessionCoordinator` accepts `LiveOperatorHTTP`, `LiveSocketConnecting`, and `LiveAudioSink`. HTTP status/create/snapshot/journal/revoke are typed injected operations: the coordinator neither serializes REST requests nor obtains credentials. The binder must combine the canonical operator status and Live profile status, enforce operator authority, send only `inputClass` in a create body and the supplied exact idempotency key in its header, bound response decoding, honor task cancellation, and return safe errors.

`LiveSocketTransport` accepts `LiveAuthenticatedRequestFactory`. It validates each factory result **before creating a task**: exact bound `ws://127.0.0.1:<port>` origin and that session's audio path, GET, no query/fragment/userinfo/body, exact Host, one non-folded Authorization header, epoch and profile pin, no Cookie/Origin/subprotocol/proxy authorization. Credentials are not rebuilt in the coordinator. Transport uses `URLSession.webSocketTask(with: URLRequest)` in a dedicated ephemeral session with cookies, cache, credential storage, and redirects disabled. No shared session, Network-framework fallback, generic proxy, or automatic reconnect is provided.

## Intent and finite states

An explicit `begin` freezes origin, assistant ID, authority epoch, provider, model, voice, profile identity, and input data class. Status must match before create; the returned snapshot and grant must match before attachment. A fresh key is generated only by a new explicit begin. A lost create response enters `createUnknown` while preserving its key/meaning; `retryCreate` replays only that exact key/meaning after fresh status validation. A terminal or already-consumed snapshot cannot attach. No restart replay, automatic create/rekey/attach, or list endpoint exists.

States are `idle`, `checking`, `creating`, `createUnknown`, `attaching`, `active`, `closing`, `terminal`, `outcomeUnknown`, and `failed`. Only server facts produce a known terminal outcome; a socket close or failed revoke does not imply successful close. A new explicit begin/stop fences old callbacks by generation; explicit recovery reads also fence operation order. All public errors are fixed enum values, not raw Foundation errors, headers, credentials, provider codes, or payloads.

`stop` is an explicit forget/cancel operation, not a successful close or durable server revoke. A clean user-requested shutdown should attempt `revoke` before forgetting. Dropping or crashing a client cannot guarantee server cleanup. Accepted-unused expiry is server ownership, never client persistence or synthetic terminal facts.

## Audio and ordering

Input is nonempty, even-length binary PCM16LE mono 16kHz, at most 64KiB per frame. Output is binary PCM16LE mono 24kHz. This code does not generate, capture, play, resample, or reinterpret audio. A sink must honor cancellation, and `flush` must invalidate its older queued audio before returning. One ordered receive stream awaits an interruption flush before admitting later PCM; it does not invent `generationComplete` on interruption. Public transcription markers may be decoded ephemerally; nothing is stored locally.

Accepted marker frames use `type` equal to `ready`, `interrupted`, `generationComplete`, `turnComplete`, `waitingForInput`, `inputTranscription`, or `outputTranscription`, with positive integer `sequence` and `journalSequence`. Transcription frames carry `text`/`finished`; waitingForInput carries `value`. Terminal frames carry `type`, `state`, `code`, `complete`; the client exposes only the closed state enum and completeness, discarding the provider code. Outbound controls are exactly `{"type":"endAudioStream"}` and `{"type":"close"}`. Unknown, malformed, or oversized messages fail safely.

Application input admission is bounded to four pending frames and 128KiB; the Foundation socket additionally admits at most one send and one receive at a time. Overflow fails visibly and closes the owned transport, never silently discards successful audio. The client has no output queue: one bounded frame is delivered inline to the sink. Foundation/OS transport buffering is not claimed to be an application-controlled queue or an audible-delivery receipt. Input-stream end disables further input PCM for that session.

## Recovery and limitations

Explicit `readSnapshot`/`readJournal` recover only a known in-memory session, without attachment. The server journal is authoritative. A page's terminal row fact is separate from its fragments and is never fabricated as a transcript/marker. A fresh coordinator has no session identity and performs zero automatic requests. No local receipt/database is used. Host restart authority rebinding remains the future binder's responsibility.

The original source base is `f2acf9d17651f2770c068984137f44f2604e55db`; wire grammar comes from `server/http/live-upgrade.ts`, ownership from `server/live`, and profile composition from `server/host/live.ts`. Accepted upstream `ab4a8c1de94b0cea8e906e6d862fad9f0c296417` was merged normally to repair abandoned accepted-session expiry and project the four configured handshake/idle/session/close timers to the adapter. Both external regressions remain intact in the producer; historical failures are retained. The gateway's `wsBufferedBytes` and the provider adapter's `maxBufferedBytes` have different owners and are intentionally not mapped. Socket detach ends the consumer; configured idle cleanup and hard-deadline cleanup are separate proofs, not an immediate-close guarantee. The hard-deadline fixture explicitly sets idle longer than session duration and rejects an idle-timeout result. Acceptance requires the complete exact-commit producer and independent review; no device or product-binding acceptance is implied.

## Verification

Producer command: `bash scripts/check-native-live.sh`. Managed lanes invoke it only through their declared foreground controller check. It builds the committed server/web locks offline, uses the real canonical `web/dist` separately from fixture state, compiles only the two selected production Swift files and isolated test helpers with Swift 6 strict concurrency/warnings-as-errors, then runs affected accepted Live owner/gateway tests, real host/native child kill and EOF tests, actual Foundation header/redirect tests, client behavioral tests, and an isolated compiled Cookie-guard mutation sensitivity. All credentials and PCM are synthetic; all sockets are controlled loopback; the trusted `liveTesting` seam never opens an external provider. A second local trap proves zero redirect credential leakage. Failed artifacts are retained and reported, not mislabeled as passing or discarded.

No actual device, UI consent, real account/provider, installation, deployment, or product-binding claim is made.

## Full-duplex composition (R1)

`NativeLiveOperatorHTTP` combines operator and Live status, freezes the authority epoch, sends only `inputClass` and the coordinator's idempotency key when creating, and decodes canonical envelopes. Its dedicated ephemeral session refuses redirects and disables cookies, cache and shared credentials. The CompanionClient builder validates each destination and current readiness/expected epoch using the existing credential closure. Audio upgrades contain exactly Bearer Authorization, x-didi-authority-epoch and x-didi-live-profile. No cookie, Origin or provider key is sent.

Start Live voice is the explicit consent action: microphone audio leaves the device for the configured Live provider. Start requests audio permission, creates one AVAudioEngine, enables voice processing on both stopped IO nodes and checks both enabled flags. Refusal, denied permission or an unusable device fails Start visibly. The same engine captures and plays 24 kHz model PCM concurrently. Capture never waits for or pauses during playback; Gemini automatic VAD owns turn boundaries. There is no per-turn Stop or endAudioStream. Barge-in flush fences playback by turn: a chunk whose turn was flushed while it was in flight is dropped, never scheduled. The first ~80 ms of a turn (1920 frames at 24 kHz) is prebuffered before playback starts, so a bursty provider never begins on an empty queue; underruns and late-after-flush chunks are counted in the call-end summary. There is no production player output tap: playback exposes a single speaking callback (`onOutput`), which the orb level feed owns.

One streaming AVAudioConverter converts the hardware format to 16 kHz mono Int16 little-endian and lives for the whole capture; a route or hardware-format change rebuilds it fresh for the new input format, never reusing a stale channel map. A carry buffer emits only complete 640-byte (20 ms) frames. The ring holds 25 frames (500 ms) so a sender stall up to half a second drains without a drop; it drops oldest only past that and counts every drop. Exactly one drain task pops all whole frames per wake and calls sendPCM sequentially. While connecting, frames are not sent until the coordinator reports active. Mute keeps the session and engine, clears unsent frames and partial carry, suppresses further frames and zeros the input indicator. Unmute resumes the same converter/session. A frame already committed to transport when Mute is pressed cannot be recalled. Stop drops unsent and final partial frames, never pads them, closes the Live session and releases the tap, engine, player and socket. The call-end summary carries a byte ledger, `converted = sent + dropped + residual` (residual is the final incomplete frame), so capture loss is always visible and never silent.

The player retains queued PCM up to a 120-second source-audio memory guard; exceeding that guard flushes the old queue and schedules the new frame. Hot mute fences arriving playback as well as capture, clears the queued tail and invalidates old completions. Unmute never replays PCM discarded by that fence. Interrupted, terminal, receive error, close and revoke flush the sink; flush is player.stop(), not a wait for scheduled buffers. An output-route change releases old capture and queued output, follows the system defaults and rebuilds the converter, tap and player with voice processing on both IO nodes. It preserves mute and the same authorized Live session; it does not reconnect the Live socket or replay audio. Repeated notifications are coalesced and old drain/tap callbacks are fenced. An input identity change releases capture and shows “Microphone changed to <device name>. Resume?”; only explicit Resume authorizes the new input. Resume rechecks the default-device identity. No valid default input or a failed rebuild releases capture and presents Restart instead. The panel shows the current microphone and output route. There is no automatic Live reconnect. Dictation and Live enforce a one-microphone guard in both directions. Hide, sleep, logout, service loss and quit use the same teardown path.

Lifecycle labels are idle, connecting, listening, speaking, muted, ended, failed, outcomeUnknown and pausedForInput. Listening comes from coordinator active events; speaking follows the audible PCM at the current playback queue head, not a claim that the model heard the user. Silent fill remains scheduled in order and does not claim speaking; a later speech buffer becomes speaking only when earlier buffers have played. Silent synthetic tests cover real converter continuity for irregular 44.1 kHz stereo chunks, frame assembly, drop-oldest overflow, mute/unmute at the capture buffer, interleaved input while playback is suspended, and flush ordering. Both-node voice-processing effectiveness, permissions UI, physical device loss and provider barge-in require Rob's human device trial. Do not run an automated audible test.

## Where the logs are

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

### Native Live operator feedback

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

## Local service recovery

An owned local child exit invalidates the old connection and stops Live. The supervisor shows a persistent “Local service restarting” status while attempting at most three replacements, after 1, 2 and 4 seconds. Successful recovery does not reset this budget; only an explicit new activation does. Quit or disconnect cancels pending work and fences old callbacks. Wake reconciles the owned child's liveness and reconnects the client to probe health. A network/health failure alone is not evidence of child death and does not trigger replacement.

A replacement child receives fresh connection authority. Child loss or authority replacement discards the old Live conversation, including its frozen HTTP origin and coordinator, while releasing capture synchronously. Recovery rebinds the service client, never the microphone or a Live session. Only a new owner Start creates the replacement conversation from the current client authority. A same-authority wake health reconciliation preserves the current conversation. Native audio tests use real AVAudioConverter, capture buffers and the device drain with an injected input format, so they exercise mute preservation and stale-frame discard without opening hardware. Mac lifecycle seams inject scheduling, launch results and wake events; no test waits out the real backoff or rearms a microphone.

The native menu provides explicit Start Live, Mute/Unmute and Stop. Global
Control-Option-Shift-L starts/shows Live, Control-Option-Shift-M toggles mute;
Control-Option-Space remains Show/hide only. Registration conflicts are visible
in the menu. No shortcut, login launch, call badge or Show action implicitly
restarts a stopped microphone. Login availability is opt-in; closing or hiding
still stops capture. Status text and its accessibility label expose the actual
Live state independently of pending calls.

### Native silent callbacks

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

## Provider continuity in the Mac client

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
### Best-effort pre-CREATE diagnostic

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

## Provider continuity wire contract

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

### Native support exports and capture mute

Copy diagnostics exports only input/output route classifications: built-in, external wired, Bluetooth, USB or unknown. Device names remain local to the Live view and never enter the support snapshot.

The Live bar and status item use the same exhaustive state sentence/icon mapping. Notification permission labels are human descriptions, and local dictation controls say Dictate and Stop dictating.

The binding mute invariant is: (a) no audio frame captured after the owner's mute request is ever sent, and (b) the UI shows muted only after every submission admitted before the request has completed or been cancelled. A frame captured before the mute press and already handed to the transport may still complete: it is audio the owner had consented to send, and bytes handed to the socket cannot be recalled.

Captured frames carry the capture epoch assigned at dequeue. Mute fences capture immediately and advances the coordinator epoch before its acknowledgement. The coordinator checks that epoch again at its final transport submission boundary; older frames not yet handed to the transport are dropped, including after unmute. The muted lifecycle presentation awaits the completion or cancellation of admitted submissions, including a send suspended inside the transport.

### Engine setup failures

The native player remains 24 kHz mono; its mixer explicitly connects to the voice-processing output node using that node's input-bus format before prepare/start. A built-in-device probe reproduced engine start OSStatus -10875 (`kAudioUnitErr_FailedInitialization`) on the implicit graph and succeeded with the explicit connection. Voice processing remains enabled.

Pre-CREATE audio failures distinguish `device_missing`, `format_unavailable`, `capture_not_configured`, `voice_processing_failed`, `engine_format_mismatch`, and `engine_failed`. Engine and voice-processing errors retain only the numeric OSStatus/NSError code as `detail` in the native journal, never an error description or device label. The owner's sentence names the precise failing step. For compatibility with the existing bounded service route, HTTP audio diagnostics omit `detail` and use its legacy codes: `unsupportedFormat` for unavailable/mismatched format, `voiceProcessingUnavailable` for voice-processing failure, and `deviceUnavailable` for missing device, unconfigured capture or other engine failure. The remaining audio cases retain their existing HTTP codes. Local journal codes stay precise. Input selection, route recovery and mute fencing are unchanged.
