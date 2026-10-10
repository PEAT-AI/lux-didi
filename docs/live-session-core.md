# Live session core

An independently testable local **Live session owner** on the same canonical SQLite Store as
the rest of the service. It drives the accepted `GeminiLiveVoiceAdapter` (`LiveVoicePort`) and
keeps a durable typed journal of provider-arrival transcription fragments and boundary facts.

It is a service core, not a microphone, not a native gateway, not an installed voice feature
and not canonical dialogue memory. It never calls Google during tests, never plays audio and
never records PCM.

## What it is

- `server/live/index.ts` — `LiveSessionOwner` and `createLiveSessionOwner(config)`.
- `server/live/types.ts` — the published types and `LiveError`/`LiveConfigError`.
- `server/live/config.ts` — trusted typed profile validation; no file loader, no environment convention.
- `server/live/schema.ts` — additive `live_sessions` / `live_grants` / `live_journal` migrations (owner `live`, version 1).
- `server/live/journal.ts` — journal byte accounting and bounded cursor reads.

The full published contract is in the task report directory (`live-session-core/API.md`).

## Root decision

The owner implements decision Lux88951: a **separate** `liveSessionId` with zero Domain entries
and no Domain session creation. Late, partial and interrupted transcription fragments are
provider-arrival facts — never paired turns, never a completed user utterance and never a claim
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

## Usage

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

## Guarantees

- `create` freezes profile identity, prompt identity and an explicit audio grant, is idempotent
  per `(assistantId, idempotencyKey)` and conflicts on a different request fingerprint.
- Lifecycle `accepted -> opening -> active -> terminal`; exactly one attach; `dispatch_intent`
  is durable before the adapter is opened.
- Startup recovery sweeps incomplete sessions to `not_started` (no intent) or
  `outcome_unknown` (possible egress). No retry, reconnect, replay or resume.
- `invalidate(reason)` synchronously aborts the adapter even while silent, during model output
  or during deferred credentials. No PCM egress after invalidation.
- The journal retains only transcription fragments, `ready`, `interrupted`,
  `generationComplete`, `turnComplete`, `waitingForInput` and one sanitized terminal record.
  PCM, thoughts, `modelText`, resumption handles and raw errors never persist.
- Count and byte limits end the session with a durable `journal_limit` terminal record,
  preserving every committed fragment.
- Audio goes to a single bounded consumer channel; an undrained consumer terminates visibly.
- A failed store write aborts the adapter and never fabricates a durable outcome.

## Not claimed

Native capture and playback, bearer/cookie authority or an HTTP route, real Google Live, audible
output, user-heard transcript, Domain recall, tool calls and installed voice. The gateway/native
integration and the host composition are separate follow-up work.

## Producer

```sh
bash scripts/check-live-session.sh
```

Builds the canonical service, runs this owner suite together with the accepted Live adapter
regression suite, and verifies the packaged tarball publishes `dist/live`. The packaging gate
`bash scripts/check-package.sh` covers the ordinary service artifact.
