# Isolated native Live protocol client

This is an unbound Swift 6 Foundation protocol client, not a device or UI feature. There is no microphone, playback, OS permission, Keychain access, personal preferences, transcript database, app entry point, installation, or CompanionClient integration. It cannot contact a provider directly. The accepted native credential owner must supply a future separately reviewed binder before product exposure.

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

The frozen source base is `f2acf9d17651f2770c068984137f44f2604e55db`; wire grammar comes from `server/http/live-upgrade.ts`, ownership from `server/live`, and profile composition from `server/host/live.ts`. At this base, accepted-unused expiry is checked only on attach, not independently settled, and host composition does not forward the profile's idle/handshake/session/close limits to the adapter. The check deliberately preserves separate real failing gates for unused settlement and configured idle propagation. Socket detach ends the consumer; eventual hard-deadline cleanup is a distinct proof, not an immediate-close or configured-idle guarantee. This client must not be presented as accepted end-to-end until the root-owned server repair and all exact-commit checks pass.

## Verification

Producer command: `bash scripts/check-native-live.sh`. Managed lanes invoke it only through their declared foreground controller check. It builds the committed server/web locks offline, uses the real canonical `web/dist` separately from fixture state, compiles only the two selected production Swift files and isolated test helpers with Swift 6 strict concurrency/warnings-as-errors, then runs affected accepted Live owner/gateway tests, real host/native child kill and EOF tests, actual Foundation header/redirect tests, client behavioral tests, and an isolated compiled Cookie-guard mutation sensitivity. All credentials and PCM are synthetic; all sockets are controlled loopback; the trusted `liveTesting` seam never opens an external provider. A second local trap proves zero redirect credential leakage. Failed artifacts are retained and reported, not mislabeled as passing or discarded.

No actual device, UI consent, real account/provider, installation, deployment, or product-binding claim is made.
