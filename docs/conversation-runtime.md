# Durable local conversation runtime

`server/chat/index.ts` exports `ChatService`, `ChatPort`, `ChatError`, config/
input/event/snapshot types and `chatMigrations`. This is an in-process engine,
not an HTTP handler, transport, generic job platform or tool executor. It does
not discover credentials, read environment settings, open a database, or call
MCP/notification/commitment effects. A completed answer is an assistant entry;
it is not proof that any requested action happened. Existing manual commitment
controls remain host-owned. No UI, voice or actual provider success is claimed.

## Host composition and authority

Use the existing Store once, with all owner migrations:

```ts
import { Store } from '../server/runtime/store.js';
import { Outbox } from '../server/runtime/outbox.js';
import { createDomainPort } from '../server/domain/facade.js';
import { ChatService, chatMigrations } from '../server/chat/index.js';
import { validatePreferences } from '../server/prompt/index.js';

const domain = createDomainPort({ outbox: Outbox });
const store = new Store(dataDirectory, [...domain.migrations, ...chatMigrations]);
const chat = new ChatService({
  store, domain, model: configuredModelPort,
  route: { provider: configuredProvider, model: configuredModelId,
    available: routeIsAvailable, allows: classes => routeAllows(classes) },
  preferences: validatePreferences(explicitPreferences, store.assistantId),
  classify: trustedClassificationLookup,
  context: { budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 },
    sources: [] },
});
chat.recover(trustedStartupContext); // before accepting work/listening
```

The placeholders are host-owned values, not globals supplied by this module.
The host binds the injected ModelPort to the explicit provider/model tuple,
validates any provider/key configuration before marking the route available,
and provides declared language/register/humor/verbosity (no inferred language).
Every call receives a **trusted** DomainContext, not user JSON. CHAT checks
assistantId against the Store, current authorityEpoch and a nonempty clientId;
run lookup/cancel/subscribe additionally require the accepting actor. The host
still owns authenticated actor derivation and HTTP Host/Origin/auth/CSRF rules.
The engine's startup recovery must run exclusively before listeners/work; it
is not a browser or model operation and may sweep multiple actors' orphans.

`appendEntry` remains public-user-only. The separate trusted in-process domain
operation `appendAssistantEntry({sessionId,text,timeZone})` always forces role
`assistant`. It shares the caller's Store transaction. There is **no** HTTP
assistant-append route; the existing append-entry route rejects forged roles.

## Acceptance, dispatch and durable outcomes

`accept({sessionId,text,idempotencyKey,retryOf?}, context)` synchronously commits
the domain user entry and chat run together. Its closed input includes no
provider/model/role override. Actor/key plus a SHA-256 canonical fingerprint
of `{sessionId,text,retryOf:null-or-id}` identify acceptance. Same key/body
returns the original run even after completion/recovery and never dispatches
again. Changed body conflicts. One active run per session is protected by both
transactional checks and a partial unique index. Unavailable/unconfigured route
and invalid session/ownership fail before capture. A ChatError from acceptance
has `localCapture=false`; database/domain errors may propagate but roll back
the entire acceptance transaction. Successful acceptance means the user entry
is durable, **not** that a provider sent or an answer was saved.

Compilation/domain reads happen after the acceptance transaction closes.
The engine commits `dispatch_intent` plus compiler trace/hash only if the run
is still accepted at its original current epoch. It yields to the event loop,
rechecks cancellation/state, then invokes the ModelPort outside every tx.
There is at most one attempted generation per accepted identity; there is no
exactly-once network-delivery claim. Intent itself never proves a send.

A complete, nonempty result commits the trusted domain assistant entry and
terminal `complete`/final-entry link in the same transaction. A final write
failure rolls back the answer and reports `persistence_failed` if that terminal
write is possible. If storage prevents every terminal write, lookup still
shows durable dispatch intent; subscribers receive `resync_required` with
`storage_unavailable`, never a false complete/saved event.

Other distinct terminal outcomes: `denied`, `blocked`, `error`, `empty`,
`truncated`, `cancelled`, `deadline`, `unavailable`, `input_too_large`,
`compile_failed`, `not_dispatched`, `outcome_unknown`, `persistence_failed`.
Noncomplete text is labelled provisional on the run, never an assistant entry
or ordinary completed history. Provider parts/signatures/continuation and
provider reason strings are neither exposed nor persisted.

`recover(context)` explicitly sweeps accepted orphans to `not_dispatched` and
intent orphans to `outcome_unknown`. It works under the current Store authority
for prior-epoch orphans, retains original run epoch, and records terminal epoch.
Existing terminal rows/user entries stay unchanged. It never retries/resubmits.
A crash after intent may have **zero** actual provider calls and still has
unknown outcome. A deliberate new acceptance may name a terminal same-actor,
same-session `retryOf` with a new key/run; it does not reuse previous effects.

`cancel(runId, context)` commits terminal cancellation conditionally before
aborting. Whichever terminal commit wins is observed: a late answer cannot
replace cancellation, and cancel after complete returns the complete answer.
A failed cancellation write does not pretend cancellation succeeded. A model
ignoring abort cannot keep a cancelled worker's local deadline timer alive.
Deadlines are enforced locally as well as passed to the model control.

## Context accounting and capabilities

The configured host assembler uses actual DomainPort `getSession`, optional
`recall({q,limit})` and optional `plan({date,timeZone})` in a synchronous read tx,
then closes it before calling **only** `compilePrompt`. All session/entry/recall/
commitment classifications must be explicitly supplied by a trusted classifier
as `{ownerId: store.assistantId,dataClass}`; null/unknown/foreign/throwing
classifiers fail unavailable. Source references and domain record IDs remain
in source evidence. Compiler evidence priority selection and its coverage notice
are retained; recall also carries the domain's total/truncated coverage. This
is read evidence, not a fabricated action receipt or psychological inference.

Source availability is computed from actually configured reads: session is
available; recall/Today are available only when configured, otherwise missing.
Optional explicit `context.sources` entries can constrain the known IDs
`session`, `recall`, `today`, but cannot advertise disabled/unknown sources as
available or silently enable a missing/error source. There are zero runnable
tools/declarations in this engine's capability snapshot. Read failures prevent
dispatch. Unexpected paginated reads are unavailable rather than guessed full.

History is a contiguous suffix of **whole turns**, beginning at a user entry
and always ending at the accepted current user. Actual compiler serialization,
including identity-minimized JSON, escaping, metadata, UTF-16 code units and
compiler item limits, determines fit; this is not a token estimate or arbitrary
archive cap. Attempts to prepend whole turns stop when the compiler budget/
limit is reached. Private trace records omitted history entry count, selected
history/source IDs, omission reason, exact compiled manifest and compile input.
If the current turn cannot fit, it remains captured but fails typed
`input_too_large` before dispatch. Full database history is untouched. System
entries cannot be reinterpreted as trusted/user history and fail unavailable.
No summaries, copied memory SQL, inferred classification or hidden replay buffer.

## Subscribers and reconnect

`get(runId, context)` returns the durable snapshot. Complete snapshots include
`finalText` read from the exact durable domain assistant entry (not a stream
buffer), including after restart/replay, and its `finalEntryId`.
`subscribe` returns an AsyncIterable with an immediate snapshot, then sequenced
provisional text and terminal durable snapshots. Text sequencing/retention is
persisted so reconnect/restart does not rely on process replay. `return()`/
disconnect only detaches; it never cancels accepted work.

Default queue bound is 16 events per subscriber; overflow drops the **queue**,
closes the subscriber and delivers explicit `resync_required/backpressure`.
No archival answer is silently truncated. Provisional run text has a separate
100000-code-unit default retention bound with `partialTruncated`; completion
clears provisional text and supplies the entire final domain entry. A slow
consumer must durably look up/resubscribe. Snapshots/events never include the
private compiler trace/manifest or raw provider parts.

## Focused verification

Acceptance command: `bash scripts/check-chat.sh` (managed workers run it only
through their declared controller check). It strict-compiles fresh scoped CHAT,
needed accepted domain/runtime/contracts/model/prompt and HTTP sources using
existing SERVICE TypeScript/@types/node into disposable output; no installs,
manifest edits, stale dist or live provider/credentials. It runs CHAT real
SQLite tests and affected domain/runtime/compiler/model mechanism checks, plus
only the real HTTP forged-assistant boundary regression. Existing package
installation/CLI tests are unrelated and explicitly not run here.

Crash tests fork owned child processes, observe acceptance, intent-before-send
or actual synthetic generation, then the parent SIGKILLs its own child. The
intent test uses a blocking child-only observer and event-loop yield to prove
zero observed calls are possible with unknown recovery. Temporary synthetic
Store authority is rotated before restart; prior terminal records are compared
byte-for-byte. No production data, external network or artificial host load.
Node TAP reports per-test durations; pytest-only `--durations=10` is inapplicable
to this Node test runner. Host HTTP/PWA/voice integration is a later component.
