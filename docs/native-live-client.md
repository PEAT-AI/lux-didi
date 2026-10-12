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

Start Live voice is the explicit consent action: microphone audio leaves the device for the configured Live provider. Start requests audio permission, creates one AVAudioEngine, enables voice processing on both stopped IO nodes and checks both enabled flags. Refusal, denied permission or an unusable device fails Start visibly. The same engine captures and plays 24 kHz model PCM concurrently. Capture never waits for or pauses during playback; Gemini automatic VAD owns turn boundaries. There is no per-turn Stop or endAudioStream.

One streaming AVAudioConverter converts the hardware format to 16 kHz mono Int16 little-endian. A carry buffer emits only complete 640-byte (20 ms) frames. The eight-frame ring drops oldest on overflow and counts drops; exactly one drain task calls sendPCM sequentially. While connecting, frames are not sent until the coordinator reports active. Mute keeps the session and engine, clears unsent frames and partial carry, suppresses further frames and zeros the input indicator. Unmute resumes the same converter/session. A frame already committed to transport when Mute is pressed cannot be recalled. Stop drops unsent and final partial frames, never pads them, closes the Live session and releases the tap, engine, player and socket.

The player queues at most 24 buffers; exceeding that bound discards old queued playback. Interrupted, terminal, receive error, close and revoke flush the sink; flush is player.stop(), not a wait for scheduled buffers. Configuration change/device loss stops capture and output and signals a visible interruption upward. There is no automatic reconnect. Dictation and Live enforce a one-microphone guard in both directions. Hide, sleep, logout, service loss and quit use the same teardown path.

Lifecycle labels are idle, connecting, listening, speaking, muted, ended, failed and outcomeUnknown. Listening comes from coordinator active events; speaking comes from scheduled model audio, not a claim that the model heard the user. Silent synthetic tests cover real converter continuity for irregular 44.1 kHz stereo chunks, frame assembly, drop-oldest overflow, mute/unmute at the capture buffer, interleaved input while playback is suspended, and flush ordering. Both-node voice-processing effectiveness, permissions UI, physical device loss and provider barge-in require Rob's human device trial. Do not run an automated audible test.

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
