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

An open action uses a handle derived from accepted source evidence, not a URL invented from conversation text. `mintOpenLine`, `withOpenHandles` and `bodySourceLinks` in `server/tools/open-handles.ts` own handle construction and supported provenance; `server/tools/open.ts` owns the native-action surface.

One clear result can be opened. Ambiguous Drive matches require clarification and a fresh file read before opening the chosen result. Download/export URLs are not a substitute for an accepted viewer link. Gmail links use the connector's account evidence rather than assuming every mailbox is account zero.

`Sources/LuxDidi/NativeActions.swift` enforces native destinations and uses `chromeBundleIdentifier` to prefer Chrome, with the default browser as fallback when Chrome is unavailable. An open receipt, not the model's sentence, determines whether the action succeeded. The receipt carries the closed code the call ended on: a native ack (`opened`, `failed`), the allowlist's `not_allowed`, an unresolved handle's `not_found`, or the intent guard's `no_open_intent` / `kind_mismatch`. The guard reads every finalized owner turn since the model last spoke, so a provider that finalizes one utterance as two turns still carries the whole ask. No AppleScript or keystroke automation is implied by this capability.

## Local memory and Lux notes

Local `remember_note` capture creates a Didi memory, not a remote source edit. Recall selects authorized stored records rather than every transcript ever seen; [selected-memory.md](selected-memory.md) owns that selection.

`VAULT_WRITE_IDENTITY` in `server/tools/vault-write.ts` identifies `save_to_vault`, the owner-requested dictated-note flow. It is not permission to rewrite, delete or update arbitrary knowledge records.

`STAGE_NOTE_IDENTITY` in `server/tools/lux-note.ts` identifies `stage_lux_note`, the composed-note flow. It is advertised only when `liveFeatures` enables `composedNotes`, which defaults off. The host stages the note, reads it back and waits for fresh owner confirmation; staging itself is not saving. Interruption, expiry and unknown outcomes must remain visible. [Privacy and authority](privacy-and-authority.md) owns these gates.

## The Trello board (W7)

Trello is a separate host gateway, not a read-only registry connector. `server/host/trello.ts` owns sign-in and the privately selected board; `server/tools/trello.ts` owns the closed tool surface:

- `TRELLO_READ_VIEWS` includes board/list/card, due and search views.
- `TRELLO_WRITE_ACTIONS` includes card creation, update, notes, checklist, due, move/done, labels and archive.
- `TRELLO_READ_IDENTITY` and `TRELLO_WRITE_IDENTITY` are the advertised gateway tools.

Only the configured board is in scope. A list or card reference does not authorize a different board. Ambiguous names require clarification, not a guessed target. Card writes already granted for this surface do not require the composed-note readback flow. Board/list administration, member changes and permanent deletion are not implied.

A due date can support the owner's Trello notification workflow; it is not a promise that Naya can call back. Setup and browser consent belong in [mcp-configuration.md](mcp-configuration.md).

## Text and Live share the owner

Text consumes the host's tools through `ChatToolsComposition`; Live consumes its accepted definitions through the Live composition boundary. Do not create a second connection registry or approve tools in a renderer to work around a missing host grant. [Text chat](text-chat.md) and [live-call.md](live-call.md) own their lifecycle differences.

## Verification

Use [checks.md](checks.md) for tool, connector, prompt and native check routing. Test remote effects with fakes and receipt assertions, never real accounts. [Diagnostic store](diagnostic-store.md) explains canonical tool and source records without mistaking a bounded model projection for complete source content.
## Awake-Mac alarm tools

`set_alarm`, `list_alarms`, `cancel_alarm` and `snooze_alarm` are host-owned Live builtins under `gateway:live-voice` / `owner-alarms`. They participate in the exact stored-intent checks, rather than bypassing the registry. Mutation authority is separately derived from fresh finalized microphone transcription, never model arguments, typed text, host notes or alarm prompts. Split asks may span two finalized owner turns; the latest must still continue the alarm request.

The host parses time in its system IANA zone and commits a fixed UTC instant. Set and snooze return confirmation only with the durable tool receipt; snooze and old-occurrence completion share that transaction. Model timestamps are consistency checks, not write authority. Local scheduling and ringing do not depend on provider availability.

Per W11-R5, a new alarm session carries only alarm instructions, owner display name and scheduled time in non-user setup instructions. An already-live session receives no injected text or rebuild: local chime and menu state continue, with `live_session_no_channel` degradation until owner speech acknowledges it. The generic host-note prefix is not a non-user provider channel and is not used for alarm speech.

These are awake-Mac alarms: closed lids, manual sleep, shutdown and unavailable local services may prevent ringing. A denied notification, failed idle-sleep assertion or unreachable shell is disclosed in the committed receipt. See [voice alarms](alarm.md) for storage, recovery, diagnostics and synthetic verification.
