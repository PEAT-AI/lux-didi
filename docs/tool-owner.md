# Canonical tools owner

Host tools connect a model's request to validated local or remote work. They do not turn model prose into authority. `createToolsOwner` in `server/tools/index.ts` composes the canonical owner with the existing Store and MCP boundary; `toolsMigrations` in `server/tools/schema.ts` owns its durable records.

## Accepted authority and results

`validatePolicy` validates a connection policy. `snapshotRun` freezes the accepted run's connection and route context; discovery after acceptance cannot silently add authority. `liveDefinitions` advertises only the tools the accepted context can use, including separately gated host capabilities.

The owner supplies the model loop's journal and result gate. Intent precedes dispatch; accepted results have canonical references rather than arbitrary handler objects. Revocation and class/route policy are rechecked before results are released. Unknown effects must remain unknown, not be automatically retried or reported as saved because a model said so. See [model-adapter.md](model-adapter.md).

## Helper work and source evidence

The voice has no source tools. The host-owned text helper uses the typed task
registry to read sources and perform authorized actions. The host runs tools
and keeps the record; it does not infer intent from model prose. The helper
reports only evidence actually returned and keeps missing results distinct
from incomplete reads. The voice speaks the result without exposing helper
or delegation machinery to the owner.

## Opening things

The helper uses the canonical `open` schema (`kind` and `target`) and `find_file` from the shared task registry. Task Authority admits an opening effect before the accepted native opener resolves and dispatches its exact destination. Finalized owner words belong to the task revision; partial speech holds delivery rather than minting an independent phrase-based permission grant. These tools only open destinations; they do not type, click, send or edit.

A direct ask executes now, without confirmation.

### Task effect authority (10.10)

Task effects are declared in `server/tasks/tools.ts` and admitted by `server/tasks/authority.ts`, not a free/guarded keyword tier. A write after outside text goes through the isolated effect check with the latest finalized owner words and the immediately preceding task owner words as earlier context when present. Ordinary effect-check failure follows the accepted fail-open tradeoff. `delete_event` is different: it stages one exact event id per call and requires a later finalized owner turn and a successful closed confirmation check. A failed check never deletes, a replacement stage cannot inherit confirmation, and a successful confirmation consumes its stage once.

Task Authority tracks outside-text exposure per task revision, not a session-wide owner/exposure-position fence. A clean owner ask can execute its declared local effects without phrase matching. After outside content reaches the helper, ordinary writes are evaluated by the isolated effect check described above; another finalized owner turn is not a mechanical fence reset. Calendar deletion retains its stricter staged confirmation path.

Open destinations are validated by scheme, network and provenance policy. After outside reads, the destination must be an unchanged eligible link from the disclosed results and still pass the ordinary effect check. A clean owner ask does not need prior result-link provenance. There are no one-use phrase grants by destination kind or retired research-run source handles. Operation identity and durable receipts govern retries; repeating a model sentence does not establish that an effect committed.

Alarm parsing and recurrence checks remain mechanical tool concerns after authority admission. A pending occurrence can be updated in place; moving an occurrence that has rung creates a fresh occurrence atomically with its receipt, preserving series linkage. The returned occurrence ID is used for later operations.

`Sources/LuxDidi/NativeActions.swift` owns mechanical native opening and system default-browser behavior, not destination policy. A native receipt, not the model's sentence, determines success. `opened`, `failed`, `not_allowlisted`, `no_native_client`, `ack_timeout` and `native_outcome_unknown` remain distinct outcomes. Open audits contain closed codes, counts and request state only, never target strings, titles, URLs or owner words.

## Local memory and Lux notes

`save_to_vault` sends the exact Task Authority-approved payload through `VaultWriter.saveTask` and the configured Lux write transport. It returns the real connector receipt; an unknown acknowledgement is not committed as success. The misleading local `stage_lux_note` tool is removed. `remember_note` remains a private local Domain memory note and must never be described as a remote Lux save.

Authorization and local state are committed before the remote writer runs outside the database transaction. A successful receipt contains the saved title/id; failure or an unknown write outcome never claims a saved note. Same-candidate retries reuse the receipt and cannot write twice. A quoted note, a source instruction or a vague comment cannot create a grant. A genuinely missing field returns a named clarification; it does not ask for a second complete confirmation. Historical nonterminal confirmation rows are cancelled by migration rather than resumed as executable requests. Existing local-memory formats remain separate from Lux knowledge writes.

## The Trello board (W7)

Trello is a separate host gateway, not a read-only registry connector. `server/host/trello.ts` owns sign-in and the privately selected board; `server/tools/trello.ts` owns the closed tool surface:

- `TRELLO_READ_VIEWS` includes board/list/card, due and search views.
- `TRELLO_WRITE_ACTIONS` includes card creation, update, notes, checklist, due, move/done, labels and archive.
- `TRELLO_READ_IDENTITY` and `TRELLO_WRITE_IDENTITY` are the advertised gateway tools.

Only the configured board is in scope. A list or card reference does not authorize a different board. Ambiguous names require clarification, not a guessed target. Card writes already granted for this surface keep their existing board policy. Board/list administration, member changes and permanent deletion are not implied.

A due date can support the owner's Trello notification workflow; it is not a promise that Naya can call back. Setup and browser consent belong in [mcp-configuration.md](mcp-configuration.md).

## Calendar reads and who is in the meeting (C-DEPTH11)

The Google calendar read is one merged window over the calendars the accepted grant covers (`createGoogleReader` in `server/connectors/google.ts`).

- The default read selects the owner's own calendars: the primary one and the ones whose `accessRole` is `owner`. A calendar entry with no `accessRole` at all is still selected, so a helper that omits the field never hides the owner's own calendar.
- A subscribed group calendar (holidays, week numbers, contacts' birthdays, ids ending in `@group.v.calendar.google.com`) is read only when the ask names it in `calendarIds` or `calendarId`. Reading every subscription spent the 40 s read window and answered a schedule question with public holidays.
- The attendee projection requests `include: ['attendees', 'organizer']` only when the accepted helper advertises that property; an older helper is never sent an argument it does not declare.
- Each attendee reaches the model as its display name, else the local part of its address, with its `responseStatus` (`accepted`, `declined`, `tentative`, `not answered`) and an `organizer` mark. One event line names at most eight people and counts the rest.
- An event with no attendee list says `attendees: none listed for this event`. An event whose helper could not be asked for attendees says `attendees: not available from this source`. Neither ever reads as an invite that hides its guests, and the prompt says who is in the meeting comes only from that line.
- A completed helper result with no JSON envelope at all is the adapter's closed failure code `invalid_result`, spoken as the helper returning no result, kept apart from a search that matched nothing. An honest empty names the query it ran.

Field provenance: `calendarList.accessRole` and `primary` in the Calendar API v3 calendarList resource, and `attendees[].responseStatus` plus `organizer` in the events resource.

## Text and Live share the owner

Text consumes the host's tools through `ChatToolsComposition`; Live consumes its accepted definitions through the Live composition boundary. Do not create a second connection registry or approve tools in a renderer to work around a missing host grant. [Text chat](text-chat.md) and [live-call.md](live-call.md) own their lifecycle differences.

## Verification

Use [checks.md](checks.md) for tool, connector, prompt and native check routing. Test remote effects with fakes and receipt assertions, never real accounts. [Diagnostic store](diagnostic-store.md) explains canonical tool and source records without mistaking a bounded model projection for complete source content.
## Open destinations

Finalized spoken and typed owner turns authorize actions. An action cue anywhere in owner input grants that kind; fillers, quotations, reported speech and conditionals are not vetoes. An explicit negation governing a cue voids that kind only. Tool results, mail, web, notes and model output never grant authority.

The current ask joins owner turns until her completed answer, with a 120-second lifetime. Pending clarification can take short time, day, zone and name follow-ups. Each kind is single-use per ask; same-target retries return the existing receipt. Interrupting the model does not erase the owner's request.

An authorized `open_web` may use a model-resolved HTTP(S) URL, including a path or query, or a site name. Other URL schemes are refused. `open_source` still requires a host-shown handle; an any/some deck request selects the top matching host-shown result. Local file and browser destination-kind checks remain. Refusal guidance is one plain sentence, never an internal code.

## Awake-Mac alarm tools

`set_alarm`, `list_alarms`, `cancel_alarm` and `snooze_alarm` use the same request state as opens and notes. Each named alarm kind receives its own grant; model speech cannot create or spend it. Spoken and digit hours/minutes, dotted and undotted meridiems, half/quarter past or to, noon/midnight, tomorrow/morning/evening, relative intervals and validated named zones are parsed from owner words. An unqualified hour chooses its next future occurrence. SGT and Singapore time resolve to Asia/Singapore. A successful set receipt includes a calendar date, clock time and zone; unconsumed wording or unknown zones produce a structured clarification rather than a different silent time.

Alarms ring only on an awake Mac and cannot wake a sleeping or closed-lid machine. That limit belongs in guidance, not in a repeat/confirmation requirement. Alarm audits use closed request/parse/result codes and counts, never spoken time text or note bodies.

### Live catalog coverage

The host declares `set_alarm`, `list_alarms`, `cancel_alarm` and `snooze_alarm` through the same live registry composition as its other owner-facing tools. Both Gemini setup and OpenAI responses delegation receive these declarations. Alarms ring only on an awake Mac; finalized owner speech authorizes mutations and the host parses the time.

The shared task registry is the model-facing read/write catalog. Chat derives its declarations through `declarationsFor`; the worker uses the same definitions, Authority, provenance and receipts. The live voice surface exposes client delegation or the single Gemini `delegate(request)` function, not internal reads or writes. The retired live exception list and research catalog no longer choose which tools a voice model may call.

## Registered calendar schema and safe rejection evidence

The helper's `calendar_events` tool takes typed `start` and `end` bounds. The connector maps those bounds to Google's `timeMin` and `timeMax`; it does not construct a second query vocabulary from an orchestration engine's schema guesses. Tool arguments must satisfy the registered task-tool schema before execution. Diagnostic logging is a redacted projection, not input validation or proof of a live provider's rejection cause.

Alarm time parsing uses the complete owner ask, not model-selected timing. Wake requests without a period choose the next morning occurrence. Today and tonight do not block the next occurrence. Reminder text and trailing requested work are extracted from owner words and stored in the existing alarm `label` column. Conflicting time expressions clarify.

## Task worker boundary (10.10)

The host-owned helper uses the typed `server/tasks/` registry. Structural argument validation
uses the repository MCP SDK schema validator; nullable optional fields are removed before connector execution.
Configured company resources compile into `query_company(resource, filters)` from `CONNECTOR_DESCRIPTORS`.
Read results declare whether they count as outside text. The host tracks that fact between inference turns;
model output never changes authority. Every effect passes exactly one injected `Authority.authorize` port.
C-AUTH supplies production admission and commit journaling. `FakeAuthority` is for synthetic tests only.

`open(kind, target)` shares one simple schema. Alarm create, list, cancel and update remain distinct:
their required fields differ and a combined action schema would add unused optional fields. Trello reuses
its existing read and write parameters and validators. Local executors, memory, people and web tools are
injected as bound existing executors by the eventual host composition, never discovered from model text.
No automatic retry of an unacknowledged write is safe. Such an outcome remains unknown until reconciled.

Follow-ups outside this registry: calendar event updates, invitation responses, sending email or chat,
Drive writes, connector configuration and connector administrative capabilities. They are not silently
translated into another action. Unconfigured tools return actionable repair text, not an opaque batch error.

The offline task check is `bash scripts/check-tasks.sh`. It includes contract, lifecycle and synthetic Store
integration suites, the retained live-shape regression suite and the check-map selftest. Synthetic replay
fixtures in `scripts/eval-worker-replay.mjs` reuse the probe's Gmail data and search semantics; they do not
prove that a real model chooses the right calls or behaves correctly. Real model replay and installation
remain separate acceptance work, never an implicit effect of this check.

Gmail search accepts a required nullable `cursor`: use null for the first page, then pass the returned
`next_cursor` with the same query. The host prunes null and maps a real cursor to Google `pageToken`;
page tokens participate in read-cache identity. Other source search and merged multi-calendar results
that cannot consume an upstream cursor stay partial, expose no `next_cursor`, and explicitly state
that paging is not exposed rather than instructing an impossible continuation.
## Task permission integration (10.10)

The new authority module returns `allow`, or a closed refusal code with repair text.
The controller owns argument validation, exposure declarations on every read tool,
finalized owner turns, effect classification and stable journal action identity.
`configuredEffectCheck` adapts the configured model client to the isolated boolean
check. It must receive the same configured model port used by the task core, with
its fastest current model selected for this role. No model identifier belongs in
a tool or an authority test.

The web search port accepts host-owned exposure state. Clean tasks are untouched.
After exposure, split on whitespace and remove each whole token containing a
scheme separator (`://`), `www.` or `site:`, in any case or punctuation. There is
no owner-word comparison or exemption. Ordinary exposed questions still pass;
private pasted-passage protections remain.

Calendar creation constructs a closed dispatch object with no attendees and no
update fields, even if surplus input has such fields. Trello write shapes do not
offer member assignment, and normalization drops supplied member fields and strips
mentions from text. Atlassian documents that mentions notify users in
[commenting on cards](https://support.atlassian.com/trello/docs/commenting-on-cards/).
Trello watchers can also receive service-generated activity notifications; stripping
mentions is not a promise that shared-board activity is silent.

`assertRegistryExposure(registry)` validates declared exposure for every read entry
(`effect: null`). C-VOICE calls it on the actual registry once that registry exists.
`Authority.authorize` accepts host-owned `webTarget`, `toolResultURLs` and
`canonicalURLs` for web opens. Clean spoken tasks may open any public HTTPS URL
without credentials or private addresses. After exposure, both the owner effect
check and byte-exact result/canonical provenance apply. Worker arguments must never
be used as provenance. The legacy open implementation and fixtures stay at base
behavior. C-VOICE owns removal of the vault speech grammar with its caller bridge.
## 10.10 task worker opening

The worker surface is `open(kind, target)`, with `web`, `app`, `file` and `source` kinds. Its schema and executor are `OPEN_SCHEMA` and `executeOpen` in `server/tools/open.ts`. C-CORE registers those instead of the legacy live open family. Web targets accept HTTP(S) URLs or named sites; installed app names and readable paths are not allowlisted. URL credentials are refused; missing native targets are `not_found`. Only a native `opened` receipt means opened. No typing, clicking, sending or editing is added. The host task authority layer owns outside-text policy.

C-CORE also registers `FIND_FILE_SCHEMA` and `findFile` from `server/tools/find-file.ts`. Spotlight receives literal argv predicates, never shell interpolation. Results contain paths, names, modified dates and `outsideText` provenance, capped at 20 and sorted newest first. Content-only matches are outside text; name matches are not. `empty` and `unavailable` are separate outcomes. There is no `find_app`: installed applications resolve by name in the native opener.

### Call-scoped deletion confirmation (VOICE-R3)

`Authority` owns one exact staged event id per call. A later delete attempt for that
id in a later finalized owner turn runs the isolated `confirm_delete_event` check
using only that turn's owner words. Failure is closed and retryable; unrelated speech
never confirms. A different id stages afresh, even if a different task is active.
The runtime includes the stage in verified worker status and clears it at call end.
Ordinary effect checks always receive available immediately preceding owner task
words as earlier context; no host short-follow-up classification is used.

### Voice and helper instruction ownership (10.10)

The voice model has no source tools. A host-owned text helper reads sources and
performs authorized actions with typed tools; the voice receives its results.
The shipped public helper policy lives in `server/tasks/instructions.ts` and is
limited to 3,000 characters. The composed owner presentation style follows it
at runtime when present. Owner lore is not added by the instruction builder.
The offline synthetic replay reads this shipped policy, not a separate copy.

## Helper read recovery and deadlines (10.11)

Readers take source identifiers, not interchangeable record numbers. `read_memory.ref` is the entry id from `search_memory`; `read_knowledge.id` is the insight id from `search_knowledge`; `read_company.ref` is the company search ref, passed verbatim even when the result also has a numeric id. Memory owns retained local entries, knowledge owns retained insights, and company connectors own current connected records. Company reads forward `depth` (`summary`, `full`, or `all`, default `all`) and the native continuation cursor. An incomplete page is not evidence that the remaining source is empty.

Read failures carry a closed category and source-specific repair instructions. Raw exception text is not helper evidence. A speech revision stops the old inference and write admissions, but an already-running read survives and an identical read joins its promise. Task cancellation still aborts reads. Completed read results remain in the existing per-task read cache; writes never enter it.

The tool phase retains its 36-second revision ceiling and individual connector limits. After a deadline, or an inference failure with findings available, one final inference receives completed evidence and unfinished-tool coverage with no tools. It has a separate budget of up to 24 seconds. Its answer remains `incomplete`, never `complete` or `no_action`; if composition fails, the fallback includes the completed findings and does not claim completeness.
