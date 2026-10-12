# Live gateway

One operator-bearer Live connection on the existing loopback HTTP listener. The service core is
`server/live`; the HTTP/WebSocket surface is `server/http/live-upgrade.ts` plus the bearer guard in
`server/http/auth.ts`; composition is `server/host/live.ts`. The accepted Live adapter is
`server/adapters/live-voice`.

This slice proves real loopback protocol behaviour. It does **not** claim native microphone/playback,
audio hardware, a heard transcript, or a real Google Live network call.

## Native client and probe sequence

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

## Configuration

Strict owner-only `live.json` in the existing `configDir` (the same directory as the model
`profile.json`/`gemini-primary.json`). It is loaded once at host startup; edits require an explicit
restart. No dynamic watch and no automatic grant rebinding.

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
  "limits": { "sessionMs": 900000 }
}
```

`limits` is optional and uses the canonical owner bounds. The loader needs no text `profile.json` and
never borrows text consent or reads the secret key: only the adapter's lazy `credentialsFor` seam reads
`gemini-primary.json` when a session actually opens. Prompt text is produced by the canonical prompt
compiler with empty history, evidence and tool declarations and the public persona; it never appears in
status or error payloads. Status meaning is local validation, never remote reachability:
`unconfigured` → absent, `disabled` → valid but off, `error` → strict failure with a closed code,
`configured` → valid and on.

## Operator authority

Authorization is header-only `Authorization: Bearer <store.adminCredential>`. Any `Cookie`, any
`Origin`, duplicate protected headers, a wrong `Host`, or a stale `x-didi-authority-epoch` fails before
the owner or credentials are touched. A paired browser cookie/CSRF never authorizes Live control or audio, and a browser
`clientId` is never trusted.

## Routes

| method | path | notes |
| --- | --- | --- |
| GET | `/api/v1/live/status` | safe configured model/voice/classes/profile identity |
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

## Wire

Server → client, one ordered stream: binary PCM16LE mono 24k audio, interleaved with text JSON markers
for committed durable facts only (`ready`, `inputTranscription`, `outputTranscription`, `interrupted`,
`generationComplete`, `turnComplete`, `waitingForInput`) and a final committed `terminal` frame. A
marker is emitted only after its journal row is committed, so the client never sees an uncommitted
durable fact. Audio is ephemeral and never persisted.

Client → server: binary PCM16LE mono 16k input (non-empty, even length, bounded, refused before ready),
and strict tiny text controls `{"type":"endAudioStream"}` or `{"type":"close"}`. Unknown keys/types,
malformed or oversize frames fail visibly with a sanitized finite close; there is no ignored command,
silent frame shedding, or tool call.

Output uses one bounded ordered queue plus a bounded `ws.bufferedAmount` high-water. On overflow the
session closes with a durable `consumer_backpressure` outcome, retaining every previously committed
marker, and no DB query runs per PCM frame. Terminal upstream outcome stops input, emits the final
committed terminal when transport allows, then closes the owned socket. Transport failure never invents
a delivered terminal or heard audio.


## Granted tools and page projection

Trusted composition may pass `LiveToolsComposition = {owner, connectionIds(), registerAuthoritySource?}` as the sixth argument to `composeLive`. The Live owner persists an accepted run at attach, snapshots the owner's configured connection selection, and declares only that frozen tool-definition snapshot. When provided, `registerAuthoritySource` is called with the Live owner's current-authority lookup; a trusted composer may also delegate through `LiveService.lookupAuthority(runId)`. It returns the accepted hash and authority only while the Live session is attached and current, and null after revocation, termination, shutdown or epoch invalidation. The shared tool helper preserves the text loop's original validation, grant, authority, intent, execute ordering. Only resultGate-accepted responses become completed tool-result projections. The tool grant evaluator is unchanged.

The existing WS JSON marker channel now includes `toolCall` and `toolResult`. Both expose only the tool name and status; results additionally contain accepted Markdown and sources. A source URL exists only for a real HTTPS Markdown link; insight references without a URL remain title-only. PCM stays in binary frames. Arguments, credentials, provider errors and raw MCP envelopes are not markers or Live journal payloads.

`GET /api/v1/live/current?cursor=0` is a read-only same-origin page route requiring the existing page cookie. Bearer credentials are refused. It emits no CORS headers and uses `Cache-Control: no-store`. Its explicit projection is `{state, since, entries, cursor}`; entries contain `seq`, an allowlisted kind, optional transcription text or `{tool: {name, status, markdown?, sources?}}`. It exposes no Live session identifiers, grants, arguments, keys, PCM or thoughts. Cursors advance over committed journal sequence numbers and limit each page to 100 rows.

Server states are `idle`, `listening`, `thinking`, `speaking`, `ended` and `error`. Input is continuous and provider automatic VAD owns turn boundaries. `thinking` means a tool batch is unanswered; `speaking` means model audio is arriving until a completion or interruption boundary. `muted` is exclusively client state. `endAudioStream` remains optional, never mandatory per turn.


## Deferred work and quiet callbacks

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
