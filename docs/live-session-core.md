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

## Release 4: frozen ordinary memory

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

## Provider continuity inside one Live session

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

### Live remember finalization

`remember_note` persists only the owner's verbatim transcription, never model output or a model paraphrase. An explicit provider input transcription `finished: true` finalizes the owner turn immediately. When that flag is absent, the provider's tool call or first model output establishes a model-turn boundary; the owner finalizes the latest input journal row only after 300 ms without a newer input transcription. A newer input frame invalidates that boundary and requires a new one. An admitted remember tool waits at most 1500 ms for finalization, journaling exactly one typed `remember_deferred` row with `waitedMs` for the wait. If no finalization occurs within that bound, the existing `owner_transcript_not_final` refusal remains. The 300 ms default is a quiet-window safeguard, not permission to derive text from model words.

## Transcript provenance

The canonical `live_journal` retains original provider text fragments without word edits or text-based deduplication. New rows record connection epoch, observed optional provider event id and approximate start/end milliseconds, host receipt wall time (`arrived_at`), host monotonic receipt time and process clock domain. Missing or invalid optional provider fields remain null. Historical rows are not backfilled. The persisted provider grant determines append versus word-joining semantics.

`finished` groups display text; `final_origin` distinguishes provider, app quiet, app model start, app response end, typed input and unknown provenance. Finalization has its own wall/monotonic observation when applied later. GPT Live does not provide an authoritative conversational transcript-done event or exact per-word timing. These columns establish provenance, not ASR accuracy or proof of playback.

Run `node server/test/journal-provenance.integration.mjs` after compiling server for the actual adapter/Store replay, including missing metadata, invalid intervals and legitimate repeated same-id fragments.
