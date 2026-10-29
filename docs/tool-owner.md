# Canonical tools owner

Host tools connect a model's request to validated local or remote work. They do not turn model prose into authority. `createToolsOwner` in `server/tools/index.ts` composes the canonical owner with the existing Store and MCP boundary; `toolsMigrations` in `server/tools/schema.ts` owns its durable records.

## Accepted authority and results

`validatePolicy` validates a connection policy. `snapshotRun` freezes the accepted run's connection and route context; discovery after acceptance cannot silently add authority. `liveDefinitions` advertises only the tools the accepted context can use, including separately gated host capabilities.

The owner supplies the model loop's journal and result gate. Intent precedes dispatch; accepted results have canonical references rather than arbitrary handler objects. Revocation and class/route policy are rechecked before results are released. Unknown effects must remain unknown, not be automatically retried or reported as saved because a model said so. See [model-adapter.md](model-adapter.md).

## Research and coverage

`server/tools/research.ts` owns source routing, bounded reads, coverage and follow-up state. `ResearchLedger`, `ResearchScheduler` and `ResearchAdmission` separate retained results, scheduling and owner-turn permission. A finalized owner turn admits bounded research; a model's desire to continue does not grant another turn.

A coverage statement must distinguish unavailable sources from completed empty reads, and partial work from complete coverage. Found matches, examined records and represented findings are not interchangeable counts. A deadline cannot be disguised as "nothing matched". [Live call](live-call.md) owns dead-air behavior around those operations.

Registry connectors and their projections are described in [connectors.md](connectors.md). Keep exact schemas, source budgets and query operators in the implementation, not a second prose table here.

The reply budget is a tier, not one number: 12,000 chars for a plain ask, 16,000 for an analytical one (a named person or a document, a comparison, team implications, a synthesis across sources) and 20,000 when the owner asks to go deep. The tier is read off the owner's question before the run reads anything, a later question may raise it, and nothing lowers it. The allocator shares the budget as before, with two changes: a source is only trimmed while it still holds more than `sourceFloorChars` (about 1,000) of evidence, so one line never counts as shown, and memory the ask did not refer to gets no allocation at all when the ask names a person or a document, not merely the last word in a squeeze. A hit two reads both returned is shown once.

Beside the per source counts the header closes with `<label> full` or `<label> excerpt` for each source it read, so an excerpt is never called full, and `entities N of M covered` with `missing: <names>` for the people and documents the owner named, read off the question itself rather than a model call.

Knowledge reads in two stages. The search answers with summaries; when the ask names a person or a document, or asks for depth, the host then makes one batched `get_insight` read of at most three hits, the ones naming an asked entity first, inside the round already dispatched and under its own 1,500 ms bound. Each fetched body replaces the summary of the hit it came from, keyed by that hit's id, so the reply shows the entry and not its abstract. A plain search spends no second call.

## Opening things

`open_source`, `open_home`, `open_file`, `open_app` and `open_web` share the per-ToolsOwner `ownerRequests` state with the four alarm tools and `stage_lux_note`. Only finalized microphone words create a request. A request expires after 120 seconds on a monotonic clock. Partial input waits for its final event; a model preamble or provider delay is not a new permission window and does not revoke a valid ask. An independent owner ask supersedes the old request. A short fragment joins only a pending host clarification and never extends the original age.

A direct ask executes now, without confirmation. A compound ask grants each named kind once. Dispatch reserves an open grant before awaiting the native ack; a same-target retry returns the cached receipt, including an uncertain native outcome, without another effect. A different target after use returns `grant_spent`. `no_owner_request`, `request_expired`, `target_not_authorized` and `grant_spent` are structured host refusals, not instructions to use another device or repeat a complete ask.

A source handle must resolve in the existing host-shown registry, have the kind the owner requested, and satisfy scheme/browser/destination policy. `any`/`some` selects the top matching host-shown result from this request's lookup, not an arbitrary model handle. File paths and app names must bind to the owner's words. Source text, summaries, persona, model speech and injected Lux/mail instructions grant nothing. A named site keeps domain binding; among several candidates it opens the best ranked bound registrable domain and names the chosen site in the receipt. Unknown, unshown or disallowed targets remain refused.

`Sources/LuxDidi/NativeActions.swift` still owns native destination enforcement and browser fallback. A native receipt, not the model's sentence, determines success. `opened`, `failed`, `not_allowlisted`, `no_native_client`, `ack_timeout` and `native_outcome_unknown` remain distinct outcomes. Open audits contain closed codes, counts and request state only, never target strings, titles, URLs or owner words.

## Local memory and Lux notes

`stage_lux_note` saves a direct finalized owner write request immediately through the canonical host tool path and the already-authorized remote writer. There is no yes/readback/settle commit path. The host validates the bounded candidate body before adding a small provenance line with the host request id and successful-read source counts. An external-content marker conservatively covers reused source context from the same session. Counts are request-local, host-recorded after actual successful reads, and cannot create write permission.

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

Existing allowlists and destination-kind checks still run after request authorization. Native web opens stay in the requested browser path; Gmail, Calendar and Mattermost home targets remain fixed host destinations. A failed or uncertain ack is an honest non-success receipt, never a prompt to retry a native effect blindly. Trello remains unchanged: its model-supplied card target binding is an adjacent follow-up, not part of this open/alarm/note authority patch.

## Awake-Mac alarm tools

`set_alarm`, `list_alarms`, `cancel_alarm` and `snooze_alarm` use the same request state as opens and notes. Each named alarm kind receives its own grant; model speech cannot create or spend it. Spoken and digit hours/minutes, dotted and undotted meridiems, half/quarter past or to, noon/midnight, tomorrow/morning/evening, relative intervals and validated named zones are parsed from owner words. An unqualified hour chooses its next future occurrence. SGT and Singapore time resolve to Asia/Singapore. A successful set receipt includes a calendar date, clock time and zone; unconsumed wording or unknown zones produce a structured clarification rather than a different silent time.

Alarms ring only on an awake Mac and cannot wake a sleeping or closed-lid machine. That limit belongs in guidance, not in a repeat/confirmation requirement. Alarm audits use closed request/parse/result codes and counts, never spoken time text or note bodies.

### Live catalog coverage

The host declares `set_alarm`, `list_alarms`, `cancel_alarm` and `snooze_alarm` through the same live registry composition as its other owner-facing tools. Both Gemini setup and OpenAI responses delegation receive these declarations. Alarms ring only on an awake Mac; finalized owner speech authorizes mutations and the host parses the time.

`LIVE_NOT_MODEL_FACING` in `server/tools/declarations.ts` is the single explicit exception list for registered internal reads, with a reason per name. Research owns those reads. Release 10 removes `remember_note` and `save_to_vault` from the live registry; `stage_lux_note` is the live vault-write path. The catalog guard in `server/test/tools-builtin-intent.test.ts`, run by `scripts/check-tool-owner.sh`, compares real host registrations with both adapters' first fake-provider wire frames. New registered owner tools must reach that wire catalog or have an explicit exception.

## Registered calendar schema and safe rejection evidence

Research builds calendar arguments from the currently registered tool inputSchema properties, including pagination/deadline construction; it drops keys the registration does not advertise. Synthetic schemas verify different key sets rather than assuming a provider vocabulary. If registration has no usable schema, the read reports `calendar_schema_unavailable`. `diagnosticInputFields` is a safe logging projection, not an input validator. `tool_arguments_rejected` reports rejected key names and `arguments_not_object` or `schema_validation_failed`, never values. No live-provider cause is inferred from a masked field-only log. The next authorized live call is the follow-up that can identify the provider rejection.
