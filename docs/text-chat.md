# Text chat

Reader: anyone who changes the text conversation (the chat runtime, its steps, or its partial answers).

The text path is a durable local runtime: a run is recorded, each step is a durable record, and an answer may be delivered in pieces. The live call is a different path; see [live-call.md](live-call.md).

## Durable local conversation runtime


`server/chat/index.ts` exports `ChatService`, `ChatPort`, `ChatError`, config/
input/event/snapshot types and `chatMigrations`. This is an in-process engine,
not an HTTP handler, transport, generic job platform or tool executor. It does
not discover credentials, read environment settings, open a database, or call
MCP/notification/commitment effects. A completed answer is an assistant entry;
it is not proof that any requested action happened. Existing manual commitment
controls remain host-owned. No UI, voice or actual provider success is claimed.

### Host composition and authority

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
chat.recover({ assistantId: store.assistantId, authorityEpoch: store.authorityEpoch });
// Clientless host startup authority, before accepting work/listening.
```

The placeholders are host-owned values, not globals supplied by this module.
The host binds the injected ModelPort to the explicit provider/model tuple,
validates any provider/key configuration before marking the route available,
and provides declared language/register/humor/verbosity (no inferred language).
Every call receives a **trusted** DomainContext, not user JSON. CHAT checks
assistantId against the Store, current authorityEpoch and a nonempty clientId;
run lookup/cancel/subscribe additionally match the persisted stable owner.
`clientId` is an immutable accepting-client audit, not run ownership: accepted
HTTP uses local-admin for bearer and random browser client IDs on each pairing.
A new authenticated same-owner browser can read/subscribe/explicitly cancel a
native or previous-client run. Current request epoch is required; historical
accepting epoch does not deny access. Foreign rows return the same not_found as
absent IDs. The host still owns actual authentication/context derivation and
HTTP Host/Origin/auth/CSRF rules. Startup recovery uses CHAT-owned
`ChatRecoveryContext={assistantId,authorityEpoch}` with no fictitious client,
runs exclusively before listeners/work, and is never a browser/model operation.
It refuses foreign-owner active rows before any mutation, never adopting them.

`appendEntry` remains public-user-only. The separate trusted in-process domain
operation `appendAssistantEntry({sessionId,text,timeZone})` always forces role
`assistant`. It shares the caller's Store transaction. There is **no** HTTP
assistant-append route; the existing append-entry route rejects forged roles.

### Acceptance, dispatch and durable outcomes

`accept({sessionId,text,idempotencyKey,retryOf?}, context)` synchronously commits
the domain user entry and chat run together. Its closed input includes no
provider/model/role/owner/client override. Stable owner/key plus a SHA-256 canonical fingerprint
of `{sessionId,text,retryOf:null-or-id}` identify acceptance. Same key/body
returns the original run even across native/browser/rebootstrap, after
completion/recovery, and never dispatches again or changes accepting-client
audit. Changed body conflicts. This semantic fingerprint uses a server-defined
fixed field order, not raw JSON wire bytes; no canonicalization library is needed. One active run per session is protected by both
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
unknown outcome. A deliberate new acceptance may name a terminal same-owner,
same-session `retryOf` with a new key/run; it does not reuse previous effects.

`cancel(runId, context)` commits terminal cancellation conditionally before
aborting. Whichever terminal commit wins is observed: a late answer cannot
replace cancellation, and cancel after complete returns the complete answer.
A failed cancellation write does not pretend cancellation succeeded. A model
ignoring abort cannot keep a cancelled worker's local deadline timer alive.
Deadlines are enforced locally as well as passed to the model control.

### Context accounting and capabilities

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
available or silently enable a missing/error source. When the host supplies the
canonical tools composition, approved read declarations are derived with the
shared declaration helper and filtered by the conversation route classes. No
write tool or remember_note is admitted. Read failures prevent dispatch. Unexpected paginated reads are unavailable rather than guessed full.

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

### Subscribers and reconnect

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

### Focused verification

Acceptance command: `bash scripts/check-chat.sh` (managed workers run it only
through their declared controller check). It strict-compiles fresh scoped CHAT,
needed accepted domain/runtime/contracts/model/prompt and HTTP sources using
existing SERVICE TypeScript and the Node.js type declarations into disposable output; no installs,
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
to this Node test runner. Owner-scoped engine tests inject synthetic trusted
native/browser/rebootstrap contexts; they do not prove actual transport auth.
Before connected chat is accepted, the owning integration must authenticate
every route, reject body owner/client injection, enforce CSRF/Origin/epoch,
and maintain authenticated SSE-session liveness on every flush with explicit
expiry/revocation closure that never cancels durable background work. A new
valid client reconnects to the same run. HTTP/PWA/voice integration is later.

#### Standing connected-chat disclosure

The enrollment form can explicitly remember the provider disclosure for the current provider, route and model. The server stores this as a `standing` chat consent. Existing rows remain `conversation` scoped after the additive chat migration (version 5); they are never promoted automatically. A standing grant retains its originating conversation for provenance, but the consent resolver selects it by owner and the full route tuple, not by conversation id.

Enrollment and generation use the same server resolver: a valid conversation grant takes precedence, otherwise a valid standing grant may apply. Provider, model, route identity, permitted data classes, disclosure revision and revocation must all match. A private route cannot inherit an ordinary route's grant. A model or route change requires a new disclosure, not consent inheritance.

`GET /api/v1/chat/status` returns the server-resolved standing `consent` or null. The UI can skip the checkbox only when that payload contains a valid grant, and displays its scope and a revoke action. `POST /api/v1/conversations` accepts boolean `consent` and `remember` controls; absent consent does not create a grant unless the server resolves standing consent. Remembering requires an explicit checked disclosure. The existing conversation revoke endpoint also revokes a server-resolved standing grant. After revocation, new enrollment requires disclosure again; unrelated conversation-scoped grants remain valid.

This is separate from connector read grants, Live consent and microphone disclosure. The native WKWebView renders the same UI; no separate native consent state authorizes chat.

### Approved read tools in text chat

The host passes the same tools owner, registry and connection selection used by
Live into `composeChat`. The first tool-enabled dispatch stores a conversation
capability acceptance: provider, model, route identity, permitted classes, policy
identity, original declaration descriptors and connection IDs. This is a frozen
ceiling, not a grant: later approvals do not join that conversation. Create a new
conversation to admit newly approved reads. Revoked registry grants, changed
connection policy identity or stale authority still stop execution. Provider,
model, route and class changes cannot reuse the acceptance.

Dispatch uses the shared `runTools` loop. Original schemas validate arguments;
only `declarationsFor` derives provider schemas. The canonical evaluator, intent
journal, owner execution, result gate and result journal remain authoritative.
No chat evaluator, connector journal, schema derivation or permissive result gate
is introduced. Provider consent and route currency are checked before every
model request, including follow-ups carrying accepted evidence.

`maxSteps` is **4 model requests**: an initial request, up to two evidence
refinement rounds, and an answer opportunity. Repeated tool calls cannot keep a
turn alive indefinitely; exhausting this ceiling yields the existing truncated
outcome, not a saved complete answer. The owner gate is reused at the finite
boundary so a last accepted result can be projected without a follow-up request.
Denied/rejected evidence is not copied from the raw connector or journal.

`RunSnapshot.toolEvidence` extends the existing snapshot response, including
subscription snapshots and later retrieval. Only accepted gate projections are
persisted in the private compiler trace extension; raw connector results,
provider parts and signatures never become cards. Each card has a name, at most
4096 markdown characters and eight permitted sources; at most sixteen cards are
displayed. Source titles are limited to 256 characters and URLs to 2048. The web
uses the existing safe markdown renderer, escapes HTML, displays unsafe links as
text and links sources only over HTTP(S). Cards precede the latest saved answer.

The chat system TOOLS paragraph requires tools only when the question needs
external evidence, answers grounded in accepted evidence and explicit disclosure
when a tool refused. Writes, per-call approval dialogs, hot capability refresh
and connector-specific rich cards are not part of this composition.


## Chat steps and partial answers


Text chat runs in two phases under one run budget (90 s):

- **ACQUIRE** (ends at 70 s, or after 4 model-to-tool rounds): the model calls tools, each call
  bounded by its own 15 s timeout. A call that outlives it is aborted and returns
  `{ status: 'failed', code: 'timeout' }`; it never hangs the round.
- **ANSWER**: at the fence every in-flight call is aborted and the evidence gathered so far is
  frozen. One tool-free model call answers from that evidence and says plainly what was not
  reached. If that call fails, the server writes the answer itself from the same evidence.

Gathered evidence is never discarded: it is persisted in `chat_runs.trace.toolEvidence` before
every model request, and the answer phase reads only that frozen copy.

### Step events

Step events are published on the existing chat subscription, one pair per tool call. They carry a
label and counts only, never tool content, and never the model's text.

```
{ type: "chat_step", runId, stepId, tool, phase: "start" | "end", label, resultCount?, ok?, ms? }
```

| field | meaning |
| --- | --- |
| `stepId` | stable id for one call, `${runId}:${n}`; the `end` event repeats it |
| `tool` | the tool name as the model called it |
| `phase` | `start` when the call begins, `end` when it settles |
| `label` | short human phrase from the server map in `server/chat/tools.ts` (`listed mail`) |
| `resultCount` | number of results, when known; omitted rather than guessed |
| `ok` | on `end` only: whether the call completed |
| `ms` | on `end` only: wall time of the call |

The final snapshot event of a run that hit the fence carries `partial: true` and
`notReached: [label, ...]` naming the calls the fence cut, so a client can show the answer as
provisional and list what was not reached.

### Timing receipts

`host.log` records one `chat_timing` receipt per run that answered or was fenced, validated by
`server/host/log.ts`, milliseconds and counts only and never text:

```
{ event: "chat_timing", runId, outcome: "answered" | "fenced",
  rounds: [modelMs, ...], tools: [{ tool, ok, ms }, ...],
  fenceMs, acquireMs, answerMs }
```

`fenceMs` is the wall time from run start to the end of acquisition; `acquireMs` and `answerMs` are the
budgets the run was given, so a receipt shows whether the fence cut the run early or the budget did.

### resultCount

Every `end` event carries `resultCount`: the number of result cards the tool's response yields, the
same `sourceCards` projection the owner evidence uses. A call that failed, was cut by the fence, or
whose response was refused by the result gate carries `0`.

### Intent wiring is not in this wagon

Text chat declares exactly the raw connector tools it declared at `c70a41c`; there is no intent tool
and no host-side interception in the loop. K3-R7 keeps that work out of this wagon: a composed read
cannot be journaled under one connection scope (`server/tools/index.ts:147-148`,
`intent_scope_mismatch`) and `ToolsOwner.complete` needs a journaled intent
(`server/tools/index.ts:345-352`), so the routed-research seam is the better place for it. Follow-up:
issue #337.

