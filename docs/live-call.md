# The live call

Reader: anyone who changes a live call: the session core, the gateway, or the voice transport.

A live call is one provider session driven by the host and rendered by one client. This page covers the session core and its turn and stop rules, the gateway that carries it over the local WebSocket, and the voice transports it can use. The provider profiles that select a transport are in [provider-configuration.md](provider-configuration.md).

## Live session core


An independently testable local **Live session owner** on the same canonical SQLite Store as
the rest of the service. It drives the accepted `GeminiLiveVoiceAdapter` (`LiveVoicePort`) and
keeps a durable typed journal of provider-arrival transcription fragments and boundary facts.

It is a service core, not a microphone, not a native gateway, not an installed voice feature
and not canonical dialogue memory. It never calls Google during tests, never plays audio and
never records PCM.

### What it is

- `server/live/index.ts`: `LiveSessionOwner` and `createLiveSessionOwner(config)`.
- `server/live/types.ts`: the published types and `LiveError`/`LiveConfigError`.
- `server/live/config.ts`: trusted typed profile validation; no file loader, no environment convention.
- `server/live/schema.ts`: additive `live_sessions` / `live_grants` / `live_journal` migrations (owner `live`, version 1).
- `server/live/journal.ts`: journal byte accounting and bounded cursor reads.

The full published contract is in the task report directory (`live-session-core/API.md`).

### Root decision

The owner implements decision Lux88951: a **separate** `liveSessionId` with zero Domain entries
and no Domain session creation. Late, partial and interrupted transcription fragments are
provider-arrival facts: never paired turns, never a completed user utterance and never a claim
about what anybody heard. There is no automatic memory ingestion and no fictional alternating
history.

| Text chat | Live session |
| --- | --- |
| `chat_runs` / `chat_consents` / `chat_run_policy` | `live_sessions` / `live_grants` / `live_journal` |
| text consent and a `ProviderProfile` route | an explicit audio grant and a validated `LiveProfile` |
| Domain sessions and entries | no Domain write at all in this slice |
| completed user/assistant turns | provider-arrival fragments with truthful gaps |

The adapter's bounded pending queue (default 128 events / 1 MiB) is a live **transport** queue.
It is not the lifetime journal cap: `journalMaxEvents` / `journalMaxBytes` are independent,
configurable and finite, and a many-turn session outlives 128 persisted events.

### Usage

```ts
import { createLiveSessionOwner, liveMigrations, validateLiveProfile } from 'live/index.js';

const store = new Store(dataDir, [...domain.migrations, ...chatMigrations, ...liveMigrations]);
const profile = validateLiveProfile(trustedProfileInput);          // provider, liveModelId, voice, keyReference, route, prompt, limits
const owner = createLiveSessionOwner({ store, voice: liveVoiceAdapter, profile, now: Date.now });

const session = owner.create({ idempotencyKey: actionId, inputClass: 'ordinary' }, context);
const attachment = owner.attach({ liveSessionId: session.liveSessionId }, context);
await attachment.ready;                                            // no output before ready
attachment.sendAudio({ pcm: pcm16LE16k });                         // caller-owned capture is out of scope here
for await (const chunk of attachment.output) {                     // ordered ephemeral PCM + committed markers
  // chunk.kind === 'audio' -> chunk.pcm (PCM16LE mono 24k); chunk.kind === 'marker' -> a committed public marker
}
attachment.close();
await attachment.done;
await owner.shutdown();
store.close();
```

### Guarantees

- `create` freezes profile identity, prompt identity and an explicit audio grant, is idempotent
  per `(assistantId, idempotencyKey)` and conflicts on a different request fingerprint.
- Lifecycle `accepted -> opening -> active -> terminal`; exactly one attach; `dispatch_intent`
  is durable before the adapter is opened.
- Accepted sessions with no dispatch intent expire when `now - createdAt > unusedMs` (not at
  equality). `get`, matching same-key replay, `listFragments` and `attach` share the same
  transactional predicate and canonical `expired` terminal fact; replay never dispatches.
  The snapshot's `terminal` is authoritative, not an invented fragment outcome field.
- One unref'd owner timer tracks the earliest accepted deadline, regardless of session count.
  It ignores opening/active sessions and remains responsible for accepted sessions after
  invalidation. `shutdown()` cancels it synchronously before awaiting active-handle cleanup;
  a queued callback checks the closed fence before touching Store.
- The trusted `now` seam returns safe integer Unix epoch milliseconds (as `Date.now` does).
  A trusted optional `schedule(callback, delayMs)` seam returns `unref()`/`cancel()` handles;
  deterministic tests share its clock with `now`. The first eligible millisecond is deadline
  plus one; delays stay positive and bounded to Node's maximum timeout, without weakening
  the strict comparison. No client clock or provider timer controls unused expiry.
- Expiry Store errors roll back and propagate: operations throw the original error; an
  autonomous timer error escapes through Node's existing uncaught fatal seam, with no fake
  expiration or retry loop. This is fail-loud process termination, not graceful fatal shutdown.
- Startup recovery sweeps incomplete sessions to `not_started` (no intent) or
  `outcome_unknown` (possible egress). No retry, reconnect, replay or resume.
- `invalidate(reason)` synchronously aborts the adapter even while silent, during model output
  or during deferred credentials. No PCM egress after invalidation.
- The journal retains only transcription fragments, `ready`, `interrupted`,
  `generationComplete`, `turnComplete`, `waitingForInput` and one sanitized terminal record.
  PCM, thoughts, `modelText`, resumption handles and raw errors never persist.
- Count and byte limits end the session with a durable `journal_limit` terminal record,
  preserving every committed fragment. The effective `live.json` profile may override
  `limits.sessionMs`, `limits.idleMs` and the total call ceiling `limits.callMaxMs`
  (default four hours); omitted limits use the core defaults. Installation supplies
  no timer profile.
- Audio goes to a single bounded consumer channel; an undrained consumer terminates visibly.
- Voice stop is deterministic host admission on every owner transcription fragment, before response handling: the last 10 normalized words must hold Naya (bounded recognizer aliases: Naja, Nayah, Naia, Nia, Nayla, Nayer) within 4 words before or 2 words after an end phrase. A name ending a fragment has a 3 second grace across quiet finals, reset by model output or 3 seconds of input silence. Existing English and German end phrases remain, plus "stop now", "stop, please" and "stop" directly next to the name. R3 also admits bare "stop listening", "shut down", "stop now" and the existing German forms at the fragment end, optionally followed only by fillers or "to me"; the standalone word "stop" still requires the adjacent name. Quotation, negation, questions, typed input, echoed assistant output and trailing objects such as "to podcasts" do not admit a stop. Quiet and fallback finals share admission; playback never delays the owner final. Admission fences input, cancels supported in-flight responses, discards queued speech and delivers the typed `closed`/`voice_stop` terminal even if cleanup or storage fails. GPT Live has no cancel/truncate command: its stop purges local playback and closes the provider without waiting for acknowledgement. Candidate diagnostics contain only an alias id, bounded word count and flags.
- The client's `close` control is the owner's Stop: the session settles at once as `closed`/`user_stop`, the
  journal is kept, and the host log carries one `session_end` receipt naming the reason. A consumer socket that
  closes with no stop control settles as `cancelled`/`consumer_closed` after one second, and the five second
  consumer-gone rule stays behind it as the last net.
- A failed store write aborts the adapter and never fabricates a durable outcome.

### Not claimed

Native capture and playback, bearer/cookie authority or an HTTP route, real Google Live, audible
output, user-heard transcript, Domain recall, tool calls and installed voice. The gateway/native
integration and the host composition are separate follow-up work.

### Producer

```sh
bash scripts/check-live-session.sh
```

Builds the canonical service, runs this owner suite together with the accepted Live adapter
regression suite, and verifies the packaged tarball publishes `dist/live`. The packaging gate
`bash scripts/check-package.sh` covers the ordinary service artifact.

### Release 4: frozen ordinary memory

CREATE resolves durable entries through the domain memory layer and uses both the entry and
parent-session routing labels. Only ordinary entries qualify, even when the configured route
permits private or sensitive data. Unknown labels do not qualify. There is no voice write-back:
transcriptions, interruption, completion and terminal events remain in `live_journal` only.

The effective instruction, including tool conduct, selected historical notes and any deferred
pickup instruction, is committed in `accepted_prompt_snapshot`. Its full text is hashed into
`prompt_identity`, which contributes to the session fingerprint. Same-key replay returns the
original snapshot without reading memory again. Attach sends the stored instruction unchanged.
A subsequent CREATE can see revised notes and gets a new identity when effective text changes.

Memory records are JSON-delimited, stable by entry id, and never clipped. The complete instruction
must fit the existing 20,000-character trusted budget. Memory records yield before any static
persona layer. An oversized static baseline raises `instruction_too_large`; memory resolution
failure raises `memory_unavailable`, before provider dispatch. Selected ids and budget omissions
are retained privately with the session. Safe session, profile and Live status projections expose
only memory status and selected/omitted counts, never ids or note text. Empty recall is `empty`.

A pickup session captures the deferred job id and its state/result identity at CREATE. An attach
with a changed or missing pickup job raises `pickup_changed` before dispatch. The sanitized
WebSocket rejection carries that reason; create a new session instead of retrying the stale one.
The additive Live v4 migration adds `memory_provenance`; install migrations remain one-time.

### Provider continuity inside one Live session

The live owner moves `active -> rebuilding -> active` on a provider goAway or a
recoverable transport loss. `rebuilding` is non-terminal: the consumer and
`live_session_id` remain the same. The owner durably saves the latest usable
resumption handle before using it, clears it when the provider revokes resumption,
and increments a connection generation before replacing the adapter. Old
connection callbacks cannot append journal rows, dispatch tools, update handles,
or settle the session. One continuity row records `rebuilding` and one records
`resumed` after setup completes.

The replacement uses the original accepted prompt, memory provenance and admitted
tool declarations without re-running selection or authority resolution. Pending
tool calls receive `tool_call_lost_on_resume` results; no old call response is sent
on the replacement connection. Queued PCM and speech captured during rebuilding
are dropped, not replayed. When a resume is impossible or fails (no usable handle,
a refused or thrown resumed setup, the tool-call reuse limit) the owner makes one
fresh seeded attempt (no handle) whose history is this session's journal
transcriptions (owner and model, in order, bounded to 8000 characters by dropping
the oldest turns whole) and whose opening input is the fixed pickup line instead of
the fresh-call greeting. The recovery bound is per episode (R1-R1): three
consecutive failed recoveries end the call, a recovered connection healthy for
60 s resets the count, and backoff between consecutive attempts is 0/2/5 s. Each
attempt opens a new socket, inside the goAway window or ten seconds, within the
remaining session and idle budget, and the current session deadline does not move.
Only after the bound, an exhausted budget or a missing setup does the session
settle `resume_failed`. A provider session that reaches its own `sessionMs`
deadline while the owner is still in the call continues through the same fresh
seeded path in a new window; the total call ceiling `callMaxMs` (default four
hours) and the idle timeout are the only timeouts that end a call.

A barge-in during a pending tool batch is signalled by `serverContent.interrupted`, never
by `toolCallCancellation` (wire-38, `wire-38-report.md`). The batch keeps running and its
result is still sent once when it completes, because the server accepts a late
toolResponse after an interruption silently. When an `interrupted` arrives after a batch
was dispatched, the owner records that batch's `toolResult` projection with disposition
`after_barge_in` so the UI can show the answer may not match the interrupted turn. The
explicit provider cancellation path is unchanged.

#### Live remember finalization

`remember_note` persists only the owner's verbatim transcription, never model output or a model paraphrase. An explicit provider input transcription `finished: true` finalizes the owner turn immediately. When that flag is absent, the provider's tool call or first model output establishes a model-turn boundary; the owner finalizes the latest input journal row only after 300 ms without a newer input transcription. A newer input frame invalidates that boundary and requires a new one. An admitted remember tool waits at most 1500 ms for finalization, journaling exactly one typed `remember_deferred` row with `waitedMs` for the wait. If no finalization occurs within that bound, the existing `owner_transcript_not_final` refusal remains. The 300 ms default is a quiet-window safeguard, not permission to derive text from model words.

### Transcript provenance

The canonical `live_journal` retains original provider text fragments without word edits or text-based deduplication. New rows record connection epoch, observed optional provider event id and approximate start/end milliseconds, host receipt wall time (`arrived_at`), host monotonic receipt time and process clock domain. Missing or invalid optional provider fields remain null. Historical rows are not backfilled. The persisted provider grant determines append versus word-joining semantics.

`finished` groups display text; `final_origin` distinguishes provider, app quiet, app model start, app response end, typed input and unknown provenance. Finalization has its own wall/monotonic observation when applied later. GPT Live does not provide an authoritative conversational transcript-done event or exact per-word timing. These columns establish provenance, not ASR accuracy or proof of playback.

Run `node server/test/journal-provenance.integration.mjs` after compiling server for the actual adapter/Store replay, including missing metadata, invalid intervals and legitimate repeated same-id fragments.


## Live gateway


One operator-bearer Live connection on the existing loopback HTTP listener. The service core is
`server/live`; the HTTP/WebSocket surface is `server/http/live-upgrade.ts` plus the bearer guard in
`server/http/auth.ts`; composition is `server/host/live.ts`. The accepted Live adapter is
`server/adapters/live-voice`.

This slice proves real loopback protocol behaviour. It does **not** claim native microphone/playback,
audio hardware, a heard transcript, or a real Google Live network call.

### Native client and probe sequence

The Swift coordinator first reads `GET /api/v1/live/status`, then posts
`POST /api/v1/live-sessions` with `Content-Type: application/json`, a fresh
`Idempotency-Key`, and `{"inputClass":"ordinary"}` (or another permitted input class).
Both requests use `Authorization: Bearer <operator credential>`, the listener's
`Host: 127.0.0.1:<port>`, and `x-didi-authority-epoch: <current epoch>`.
Create returns the accepted grant; there is **no separate HTTP acceptance request**.
Validate the returned session is `accepted`, `detached`, and has no dispatch intent,
and that its profile identity and grant classes/model/voice match the status and frozen intent.

Upgrade `ws://127.0.0.1:<port>/api/v1/live-sessions/<liveSessionId>/audio` with the
same Authorization, Host and authority epoch, plus
`x-didi-live-profile: <snapshot.profileIdentity>`. There is no query string or
WebSocket subprotocol. Wait for the text `ready` frame before sending raw PCM16
mono 16 kHz audio as **binary**, then controls such as
`{"type":"endAudioStream"}` as **text JSON**. `endAudioStream` does not close the
session; the socket stays attached until an explicit close or terminal outcome.
Do not reuse a revoked, expired, terminal or previously attached session for a new upgrade.

The real-server fixture test `Swift create, grant acceptance and pinned audio upgrade stay attached`
passes against the pre-fix owner/gateway. Thus the correct native sequence is not
intrinsically refused by that implementation. A historical rejected probe needs
its exact request/session state compared with this sequence; the old generic close
reason alone cannot establish which step or configuration differed.

After HTTP upgrade, attach failures close with code `1008` and reason
`attach_rejected:<typed code>` (at most 123 bytes); unknown exceptions use
`attach_rejected:internal`. One structured stderr event with `event`,
`liveSessionId`, and `code` is captured by the host process log. It contains no
exception message, audio, grant contents or credentials, and does not write a
Live transcript fragment. HTTP preflight success alone does not prove attachment.

### Configuration

Strict owner-only `live.json` in the existing `configDir` (the same directory as the model
`profile.json` and the provider's credential slot file). It is loaded once at host startup; edits
require an explicit restart. No dynamic watch and no automatic grant rebinding.

A `live.json` that names no provider is the owner default: `provider: "openai"`, `modelId: "gpt-live-1"`,
`voice: "marin"`. Naming `gemini` selects Gemini 3.8 Live with `models/...` ids and `gemini-primary`
(OV1-R2). The owner changes the choice from the settings page or `config/cli.js select`; both write the
same fields through `saveLiveSelection`, and the change applies when the service next starts.

`provider` names the voice provider and selects both the adapter and the credential slot:
`gemini` (Gemini 3.8 Live, `models/...` ids on `gemini-primary`) or `openai` (GPT-Live, `gpt-live-*`
ids on `openai-primary`). `modelId` is validated by the selected provider's own pattern and
`keyReference` must name that provider's slot, so a Gemini id can never be paired with an OpenAI key.
The settings page offers `marin` first and then the gpt-live-1 English voice table
(`marin, vesper, ripple, willow, gleam, meridian, stone, quartz, beacon, delta, cinder`); `cedar` is a
Realtime voice and is not offered (OV1-R6).

The adapter factory selects on `provider`; every provider in the union has its own adapter, and an
unknown name is refused by the union as `unsupported_provider` instead of borrowing another adapter. A missing key in the selected slot fails
closed with `file_missing` and never falls back across slots. The Live status payload reports the
provider the profile carries.

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "gemini",
  "modelId": "models/gemini-live",
  "voice": "Aoede",
  "keyReference": "gemini-primary",
  "dataClasses": ["ordinary"],
  "preferences": { "dataClass": "ordinary", "language": "en-US", "register": "plain", "humor": "dry", "verbosity": "balanced" },
  "limits": { "sessionMs": 3600000 }
}
```

`limits` is optional and uses the canonical owner bounds. The loader needs no text `profile.json` and
never borrows text consent or reads the secret key: only the adapter's lazy `credentialsFor` seam reads
`gemini-primary.json` when a session actually opens. Prompt text is produced by the canonical prompt
compiler with empty history, evidence and tool declarations and the public persona; it never appears in
status or error payloads. Status meaning is local validation, never remote reachability:
`unconfigured` → absent, `disabled` → valid but off, `error` → strict failure with a closed code,
`configured` → valid and on.

### Operator authority

Authorization is header-only `Authorization: Bearer <store.adminCredential>`. Any `Cookie`, any
`Origin`, duplicate protected headers, a wrong `Host`, or a stale `x-didi-authority-epoch` fails before
the owner or credentials are touched. A paired browser cookie/CSRF never authorizes Live control or audio, and a browser
`clientId` is never trusted.

### Routes

| method | path | notes |
| --- | --- | --- |
| GET | `/api/v1/live/status` | safe configured model/voice/classes/profile identity |
| GET | `/api/v1/live/summary` | cookie-safe closed whitelist: `modelId`, `voice`, `personaName`, `limits{sessionMs,idleMs}`, `profileEnabled` |
| POST | `/api/v1/live-sessions` | `{ inputClass }` + `Idempotency-Key`; returns a frozen snapshot |
| GET | `/api/v1/live-sessions/:id` | snapshot |
| GET | `/api/v1/live-sessions/:id/journal` | bounded `?cursor&limit` page |
| POST | `/api/v1/live-sessions/:id/revoke` | ends exactly that session/grant durably before the response |
| GET | `/api/v1/live-sessions/:id/audio` | WebSocket upgrade |

The server creates the WebSocket handshake with `WebSocketServer({ noServer: true })` on the existing
`node:http` `upgrade` event, with no extensions and no subprotocols. The request is authenticated and
prechecked synchronously, then `handleUpgrade`, then the owner attaches synchronously in the callback:
there is no `await` and no user callback gap, so a malformed handshake never consumes the grant or opens
a provider. An optional `x-didi-live-profile` header is a nonsecret staleness pin compared against the
stored grant and the current owner identity, never authority.

### Providers

The host speaks to one provider-neutral port (`server/adapters/live-voice/types.ts`); each provider is
one adapter, chosen by the route provider and never by a call-site literal. The provider, model and voice
are frozen per session, so a setting change applies at the next session start.

| provider | adapter | transport | input | output | resumption |
| --- | --- | --- | --- | --- | --- |
| `gemini` | `gemini.ts` | Gemini Live WebSocket | 16 kHz PCM16 | 24 kHz PCM16 | handle |
| `openai` | `openai.ts` | GPT-Live WebSocket | 16 kHz PCM16, upsampled to 24 kHz in the adapter | 24 kHz PCM16 | none |

#### GPT-Live (`gpt-live-1`)

- Endpoint `wss://api.openai.com/v1/live/sessions`, no query parameters, `Authorization: Bearer` from the
  resolved `openai-primary` credential. The key never appears in the URL, a log line or an event.
- Start barrier: socket open, one `session.start` (instructions, voice, `audio.format` at 24 kHz, the seeded
  `input`, and `delegation.responses`), then wait for `session.started`; audio is refused before that.
- Tools are the port's own JSON schemas, passed unchanged into `delegation.responses.tools` as function
  tools; a delegated call arrives as a nested `response.output_item.done` and is answered with
  `function_call_output` carrying its `call_id`, then `response.create`.
- The voice layer publishes no speech-start and no spoken-response-end event, so the adapter derives
  `interrupted` from the first input transcript delta of a user turn that overlaps assistant speech (its
  audio is then dropped by a generation counter) and `turnComplete` from the nested `response.done`.
- Voice default `marin`; the Hindi voice `nira` is refused. The wrapper around the unchanged shared persona
  adds exactly three sections: Language, Tools and Delivery.
- No resumption: a drop, or `session.closed` with reason `expired`, uses the host's fresh-seeded path.
- Protocol details were checked against developers.openai.com on 2026-10-17 (guides `live-conversations`,
  `live-delegation`, `live-migration`, `voice-websockets`, and the `gpt-live-1` model page).
- `scripts/probe-gpt-live.mjs` opens one real session, sends three seconds of synthetic speech and prints
  event names and timings only. It is not part of any check and is run once by the operator.

### Wire

Server → client, one ordered stream: binary PCM16LE mono 24k audio, interleaved with text JSON markers
for committed durable facts only (`ready`, `inputTranscription`, `outputTranscription`, `interrupted`,
`generationComplete`, `turnComplete`, `waitingForInput`) and a final committed `terminal` frame. A
marker is emitted only after its journal row is committed, so the client never sees an uncommitted
durable fact. Audio is ephemeral and never persisted.

Client → server: binary PCM16LE mono 16k input (non-empty, even length, bounded, refused before ready),
and strict tiny text controls `{"type":"endAudioStream"}`, `{"type":"close"}`, `{"type":"inputMuted"}` or `{"type":"inputLive"}`. Unknown keys/types,
malformed or oversize frames fail visibly with a sanitized finite close; there is no ignored command,
silent frame shedding, or tool call.

Output uses one bounded ordered queue plus a bounded `ws.bufferedAmount` high-water. On overflow the
session closes with a durable `consumer_backpressure` outcome, retaining every previously committed
marker, and no DB query runs per PCM frame. Terminal upstream outcome stops input, emits the final
committed terminal when transport allows, then closes the owned socket. Transport failure never invents
a delivered terminal or heard audio.


### Granted tools and page projection

Trusted composition may pass `LiveToolsComposition = {owner, connectionIds(), registerAuthoritySource?}` as the sixth argument to `composeLive`. The Live owner persists an accepted run at attach, snapshots the owner's configured connection selection, and declares only that frozen tool-definition snapshot. When provided, `registerAuthoritySource` is called with the Live owner's current-authority lookup; a trusted composer may also delegate through `LiveService.lookupAuthority(runId)`. It returns the accepted hash and authority only while the Live session is attached and current, and null after revocation, termination, shutdown or epoch invalidation. The shared tool helper preserves the text loop's original validation, grant, authority, intent, execute ordering. Only resultGate-accepted responses become completed tool-result projections. The tool grant evaluator is unchanged.

The existing WS JSON marker channel now includes `toolCall` and `toolResult`. Both expose only the tool name and status; results additionally contain accepted Markdown and sources. A source URL exists only for a real HTTPS Markdown link; insight references without a URL remain title-only. PCM stays in binary frames. Arguments, credentials, provider errors and raw MCP envelopes are not markers or Live journal payloads.

`GET /api/v1/live/current?cursor=0` is a read-only same-origin page route requiring the existing page cookie. Bearer credentials are refused. It emits no CORS headers and uses `Cache-Control: no-store`. Its explicit projection is `{state, since, entries, cursor}`; entries contain `seq`, an allowlisted kind, optional transcription text or `{tool: {name, status, markdown?, sources?}}`. It exposes no Live session identifiers, grants, arguments, keys, PCM or thoughts. Cursors advance over committed journal sequence numbers and limit each page to 100 rows.

Server states are `idle`, `listening`, `thinking`, `speaking`, `ended` and `error`. Input is continuous and provider automatic VAD owns turn boundaries. `thinking` means a tool batch is unanswered; `speaking` means model audio is arriving until a completion or interruption boundary. The host also carries the owner's mute: the `inputMuted` and `inputLive` control frames set it, the uplink forwards no PCM while it is set, and a muted session stays open for at most 180 s before it settles as a benign `muted_expired` close. `endAudioStream` remains optional, never mandatory per turn.


### Deferred work and quiet callbacks

`live.json` accepts `limits.toolDeferralMs`: integer milliseconds from 1000 through
30000, default 4000. This budget applies to the tool batch, not the Live session
lifetime. A batch that exceeds it receives truthful function responses containing
its job ID and `status: "in progress"`. Naya can acknowledge the work without
waiting for the tools. Execution uses the acceptance captured at dispatch and the
existing tool intent journal and result gate.

Execution receipts and gated results live in the existing `runtime_outbox`, not
another database or queue. A service restart makes an interrupted dispatched job
`unknown`; it is never automatically replayed. Completed results, actual failures
and unknown outcomes remain available for callback. Completion does not send an
unsolicited result or audio to the old Live transport.

The authenticated, authority-bound `GET /api/v1/live/jobs/pending` returns only
operator-facing job identity, state and gate-approved Markdown, not raw host
acceptances or result references. The page's current projection also retains
these job outcomes in the transcript. A native poll creates a menu-bar badge and
a quiet notification through `NativeNotifications`; notification content has no
sound and does not include result text. Notification arrival never opens an
audio engine or starts microphone capture.

Click the menu's **Pick up Naya’s call**, the window's pickup button, or the
notification to explicitly start a fresh Live session. **Start Live voice** later
also offers the oldest pending outcome first. A specific notification carries
`pickupJobId` in the create request. The new session's existing adapter history
is primed with the gate-approved result before its first model turn. Results
retain their classification and must fit the newly selected Live route/input
classes. Failed or unknown work primes a truthful failure, not a fabricated
answer. Pending work is consumed only after that new session becomes ready;
ignoring a call leaves its outcome in the page and outbox.

Callback sessions use `opening: 'model_first'`: after setup, the adapter sends
the actual primed history as `clientContent` with `turnComplete: true`, opening
Gemini's first spoken turn without microphone input or a separate nudge message.
The callback's system instruction states that the user has just picked up and
asks for the pending outcome first, briefly. Normal starts use `user_first`
(the adapter default), preserving `turnComplete: false` history and waiting for
the user. No completion or notification switches an existing session to
model-first; only the user's explicit pickup or callback opens this new session.

#### Explicit voice remembering

Live sessions declare the gateway-owned `remember_note` tool with `text` (1 to 500 characters) and `kind` (`fact`, `preference`, or `task`), and no other arguments. It executes locally, not over MCP. The **owner-trusted explicit voice memory rule** permits only this built-in write identity in `owner-trusted-reads`; explicit grant mode leaves it unapproved, and a remote MCP tool with the same name receives none of its permission. Other writes remain unapproved. Original argument validation, owner authority checks, intent journaling, result authorization and result journaling still apply.

The gateway saves the owner's finalized input transcription, not the model's proposed note. The latest finalized explicit remember command in a bounded 64-fragment journal window supplies the payload. The model text must match that payload after case, whitespace and terminal-punctuation normalization, or be a normalized substring of it. When it is neither, the note is supported by the share of its content words that the owner's own turns carry: at least 60 percent, counted over the narrowest span of at most three **adjacent** turns, latest first, so one ask may run across a turn and its clarification while a note stitched from two turns apart is refused. Third-person framing (the owner's name or "the owner" plus a preference verb, and the framing words themselves) is dropped before that share is taken, because the note paraphrases the owner rather than quoting them. Polarity is compared on the clause that carries the note's words: a note that negates what the ask affirms is refused even when every content word was spoken. A missing finalized command refuses with `owner_transcript_not_final`; a mismatch or a polarity flip refuses with `owner_text_mismatch`. One finalized utterance can produce only one entry; a repeat refuses with `already_remembered` and identifies the existing entry. Provenance identifies `live-voice`, the Live session id and the finalized utterance journal sequence. The entry's existing source-reference note retains `kind:<kind>` without changing its owner-authored content. Every attempt writes one `memory_note` host-log line of counts only: whether it was saved, the refusal code, the note's content word count, how many of those words the supporting ask carried, that share, and how many turns the window held. The note text never reaches the log.

Voice remembering writes **ordinary memory only**. An explicit request to classify the note as private or sensitive refuses with `private_memory_unsupported`; it is never silently downgraded. Private notes must use an owner-controlled workflow, not this voice tool. Live-voice entries have **no deletion control yet**. Durable memory deletion is deferred to a separate wagon, not available through the Live projection or the selected-memory picker.

A successful result is only `{remembered: true, entryId}`; refusals return `{remembered: false, code}` (duplicate refusals additionally identify the existing entry). Note text is never echoed in the tool result. Naya confirms aloud only after success and otherwise reports the refusal. Saving does not modify the running session's `accepted_prompt_snapshot` or `prompt_identity`: recall occurs at the next session CREATE.

An upstream 1007 close before ready journals `provider_setup_rejected` without provider reason text and closes the client with `1008 attach_rejected:provider_setup_rejected`; post-ready terminal closes remain `1000 terminal`.


## The live voice transports

Two providers are wired: OpenAI GPT Live (`openai`, the default when `live.json` names none) and Gemini Live (`gemini`, the alternative the owner picks in Settings). Both implement the same `LiveVoicePort`, and the checked union is `liveVoiceProviders` in `server/adapters/live-voice/types.ts`. A new provider joins that array with its adapter and a factory case, never as a bare literal at a call site. The section below describes the Gemini adapter, which is the one with the longest transport history; the OpenAI adapter follows the same port.


The provider sends binary WebSocket frames carrying UTF-8 JSON; the adapter accepts both binary and text JSON frames.

This standalone adapter does not change the text ModelPort or install voice into the app. It provides transport evidence, not proof of playback, consent, durable transcript ownership or voice parity. Future service composition owns consent and aborts the session on invalidation. Native composition owns capture, playback and device permissions.

### Composition

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

### Events and truthful boundaries

One session spans multiple turns. Events have a monotonically increasing adapter-owned sequence, not provider IDs or durable turn IDs. Supported events: `ready`, `audio`, `inputTranscription`, `outputTranscription`, `modelText`, `generationComplete`, `turnComplete`, `interrupted`, `waitingForInput`, `interactionStatus`, `goAway`, `contextUsage`, `upstreamQueue`, `resumptionHandle`, and one terminal `outcome`. `contextUsage` is provider-neutral token use decoded from the provider's usage metadata (no behaviour reads it yet); `upstreamQueue` is the elevated send-queue depth. Audio events expose an owned Uint8Array and the validated output MIME type. Text transcription events preserve optional provider `finished`; this is not a heard, committed or recallable flag. `modelText.thought` preserves thought versus other model text; neither is labeled a spoken answer.

Combined serverContent fields are not discarded. Deterministic projection within one envelope is model parts, input transcription, output transcription, interruption, generation boundary, turn boundary, then activity facts. Ordering across envelopes follows actual ws delivery. Input transcription can arrive after output completion and remains independent evidence; durable association belongs to later orchestration. Interrupted output is followed by turnComplete without generationComplete. Generated audio does not prove playback.

Unknown harmless protocol additions are ignored. Empty envelopes, malformed recognized fields, invalid PCM/rates and premature or repeated setup completion fail closed. Tool batches are surfaced as events; the host executes already-granted tools and answers each batch in one response frame. `goAway` projects the documented duration then closes honestly. Resumption updates expose only availability; raw handles are never emitted or persisted and no resumption is attempted. Sliding-window context compression and documented history/VAD controls are included; no resumption or reconnect is attempted.

When a provider frame is rejected, the adapter emits one bounded stderr diagnostic event `live_frame_rejected` carrying the error code, the frame kind (the recognized top-level key, or `unknown`, `non_object` or `invalid_json`), the wire byte length and a bounded list of top-level and nested key-name paths. It never carries a value, text, audio or id. The host persists it to `host.log` through the closed `safeEvent` whitelist.

### Failure and resource bounds

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
| idleMs | 5 minutes | No accepted inbound/outbound activity after readiness |
| sessionMs | 1 hour | Whole session, including deferred credentials |
| closeMs | 1 second | Graceful close cleanup before forced termination |

Timers must also fit Node's 32-bit timer range. Absolute deadline is validated and checked before/after deferred credential resolution, before socket construction and at writes/event work boundaries. Handshake, idle, session, deadline and close timers are owned and cleaned on terminal paths. Defaults are configurable operational bounds, not claims that every transient network delay is fatal. Short test timers are synthetic test bounds, not product latency guarantees.

### Build and offline verification

Run `bash scripts/check-live-voice.sh` for the canonical server compiler, focused real-loopback ws tests and offline production tarball import. Run `bash scripts/check-package.sh` for existing package/artifact assertions. Canonical package files include the adapter and bundle locked ws 8.22.0 (MIT). Development type dependency is @types/ws 8.18.2 (MIT), not a runtime dependency. No unrelated dependency upgrade or private compiler path is needed.

No live account, provider call, microphone, speaker, browser, permission prompt or cloud credential is needed. Fixtures use fake credentials and synthetic silent PCM. Canary secret-bearing errors, close reasons and resumption handles must not appear in public serialization or captured logs.

### Primary technical references

- Google Live protocol, fixed endpoint and message schemas: <https://ai.google.dev/api/live>
- ws API, maxPayload, bufferedAmount, handshakeTimeout and termination: <https://github.com/websockets/ws/blob/master/doc/ws.md>
- Locked production release metadata: <https://registry.npmjs.org/ws/8.22.0>
- Type release metadata: <https://registry.npmjs.org/@types%2Fws/8.18.2>

These references document transport behavior. Local offline tests do not establish provider availability, model fluency, playback or an installed voice experience.


### Tool batches and setup parity

`LiveVoiceRequest.tools` accepts the frozen host-generated function declarations. Setup sends one `tools: [{functionDeclarations}]` array when nonempty. The shared declarations helper derives provider-compatible schemas while retaining the original tool-definition schemas; provider schemas never become grant identities or validation authority.

Optional `languageCode` is a BCP-47 language with an optional two-letter region, case-normalised to lower language and upper region (`en`, `en-IN`, `de-DE`); bare `ar` becomes `ar-XA`. Setup includes `historyConfig.initialHistoryInClientContent`, sliding-window compression with `targetTokens: 32000` and no trigger threshold, and LOW start-of-speech sensitivity. The adapter derives its declared `LiveVoiceCapabilities` once from the model id: a provider-default thinking level (no `thinkingConfig`) for 3.8 Live, and `thinkingConfig: {thinkingLevel: 'minimal'}` when `capabilities.thinking` is `minimal`.

A `toolCall` event carries the entire provider batch, and `toolCallCancellation` carries cancelled ids. The host answers all outstanding ids in exactly one `sendToolResponse({responses})` call, producing one `toolResponse.functionResponses` frame. The wire-38 experiment (10 real Gemini 3.8 Live sessions, `wire-38-report.md`) confirmed that realtimeInput sent while a BLOCKING call is pending is accepted, transcribed and answered, that barge-in is signalled by `serverContent.interrupted` and never by `toolCallCancellation`, and that a late toolResponse after that interruption is accepted silently. Microphone frames are therefore forwarded live in order while a batch is unanswered, never dropped or buffered; a batch always answers once when it completes. Drain-time drops are counted by `drainingDropCalls` and `drainingDropBytes`. Tool authorization and execution remain outside the adapter; the fixed endpoint, transport headers, limits, credential scrubbing and no-reconnect behavior are unchanged.

An upstream 1007 close before setup readiness is classified as `provider_setup_rejected`; provider close reason text is never included in the outcome.

Provider frames are validated independently for every known key: setupComplete, serverContent, toolCall, toolCallCancellation, goAway, sessionResumptionUpdate and voiceActivity. Voice activity ACTIVITY_START and ACTIVITY_END project through waitingForInput markers to listening and thinking; empty serverContent objects and empty modelTurn parts are valid informational content when accompanied by voiceActivity. Unknown informational siblings (including usageMetadata) are ignored, counted up to 65,535 per session, and logged as structured stderr key names only, once per retained name (at most 32 identifier-shaped names of 64 characters). Values are never logged. Empty top-level frames, malformed known content or tool calls, setupComplete after ready, provider errors, and serverContent before ready remain fail-closed.

After setup readiness, empty `serverContent` frames are informational, with or without siblings: they are counted on the session and their key name is logged once through the bounded `live_provider_informational_key` event. Gemini voice activity uses `voiceActivity: {type: 'ACTIVITY_START' | 'ACTIVITY_END'}` to emit the existing waiting-for-input activity events; the legacy `voiceActivityType` field remains accepted. Content before readiness, malformed model-turn parts and malformed tool calls still fail closed.

### Capabilities and accent placement

The adapter declares `LiveVoiceCapabilities` on the port (`capabilities` in `server/adapters/live-voice/types.ts`): `provider`, `supportsResumption`, `supportsGoAway`, `supportsInterruption`, `supportsServerVadConfig`, `inputRates`, `outputRates`, `outputModalities`, `thinking`, `supportsToolScheduling` and `toleratesEmptyReadyLifecycle`. The host and shared session code read these flags; a model id is read only inside the Gemini adapter, once, to derive the flags. There is no accent capability (the accent is a prompt input every provider receives) and no tool-execution capability: the host is the sole executor of tools.

The accent lives in exactly two places: the system instruction (the head block and the terminal voice anchor composed by the prompt layer) and the setup parameters (`voiceConfig.prebuiltVoiceConfig.voiceName` and `speechConfig.languageCode`). A function response carries the tool data only: there is no per-tool `_voice_anchor`, and the model-first opening trigger carries no accent text.

### Connection resumption contract

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

### GPT-Live turn taking

`gpt-live-1` publishes no turn detection, speech start or spoken-response end, and the
protocol has no input buffer commit, clear or output-audio-done frame: the server owns turn
taking (`server/adapters/live-voice/openai.ts`). The adapter therefore derives both
boundaries itself, and never drops an output frame doing it.

- No frame dropping at all. Every valid `session.output_audio.delta` of an open session is
  forwarded at 24 kHz, and an input transcript event can never silence future output audio. There
  is no drop window, because nothing local ever cuts her: see "No local interference" below.
- Think time. `gpt-live-1` sends no generation-start event on a plain turn, so when an input
  episode ends with no assistant audio playing or held the adapter synthesizes the pair the host
  needs: the owner's input transcript finished and a `modelTurnStarted`. The host maps that to
  THINKING unless she is already speaking, and it resets the turn's completion flag, which is
  what arms the response watchdog, so every owner turn is watched rather than only the first.
- Audible silence. When output deltas have been quiet for 500 ms (`OUTPUT_SILENCE_MS`) and the
  modelled playback has drained, the adapter emits `waitingForInput` true: the host leaves
  SPEAKING for LISTENING there instead of waiting out the 2000 ms synthesized `turnComplete`,
  which stays the semantic end of the turn. New audio before that completion re-enters SPEAKING.
- No local interference. The adapter never emits `interrupted` because of an input transcript
  delta or a gap in the provider's output stream, and never flushes her playback for one, so what
  the server already sent plays out in order and no syllable of it is dropped (ruling W1-R1,
  2026-10-20). The provider stops generating on real speech by itself, and the host flushes its
  native playback queue only on an `interrupted` the adapter emits for a provider error. An owner
  word is journaled as an input transcript and nothing more; an input episode ends after 700 ms
  with no input-transcript delta (`INPUT_EPISODE_QUIET_MS`), which is what closes the plain-turn
  journal pair of "Think time" above. Field sessions 82ab994a and the 2026-10-20 06:26:04 call
  are why: a 350 ms output-quiet check fired on one transcribed word or on an ordinary 517 to
  1512 ms gap in her own audio and cut her mid-reply, including cutting her 830 ms into a reply
  her own earlier words had started.
- Head start. gpt-live-1 sends output audio at about 1x real time and the native jitter buffer is 80 ms, so the
  first audio of each speaking stretch is held and forwarded as one event once it holds 300 ms of audio
  (`HEAD_START_MS`) or 300 ms of clock time have passed, whichever comes first; after that every delta passes
  through. A provider error or a close discards the hold, and held audio counts as playback to be cut.
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
  is still queued and reset by a provider error.
- Receipts, metadata only and never transcript text: `gptlive_unknown_frame` {type, count} once
  per session for each provider frame name the adapter has no rule for, which is how a cancel
  signal the server may already send would show up; `gptlive_turn_complete` {idleMs, drained};
  and `openai_instructions_size` {chars, bytes} at session start, which proves in a log that the
  instructions were not cut. Empty and whitespace-only input transcript deltas carry no word and
  start no episode.
- The wrapper instructions additionally carry OpenAI's live prompting lines "Do not treat a
  cough, music, or nearby conversation as a new request." and "Keep listening while the owner
  pauses to think."

#### No interruption check

There is no local interruption check: the adapter holds no output-quiet timer for owner speech, so no
scheduled check can finish after an input episode closes (ruling W1-R1). Input episodes close after 700 ms
without nonempty transcription, and a new input, a new backend response or session termination retires the
episode token. Every callback still checks its episode, socket and generation. Local windows use monotonic
time.

These event semantics do not establish acoustic owner identification or honk rejection. No energy or word-count rule identifies the speaker, and the adapter has no word-count rule to run.

