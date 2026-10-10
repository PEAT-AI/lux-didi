# Live gateway

One operator-bearer Live connection on the existing loopback HTTP listener. The service core is
`server/live`; the HTTP/WebSocket surface is `server/http/live-upgrade.ts` plus the bearer guard in
`server/http/auth.ts`; composition is `server/host/live.ts`. The accepted Live adapter is
`server/adapters/live-voice`.

This slice proves real loopback protocol behaviour. It does **not** claim native microphone/playback,
audio hardware, a heard transcript, or a real Google Live network call.

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
the owner or credentials are touched. A paired browser cookie/CSRF never authorizes Live, and a browser
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
