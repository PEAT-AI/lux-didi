# Selected memory

Durable memory and prompt context are different things. Saving a note does not put every saved note into every provider request. A conversation uses an accepted, bounded selection with source identity and classification; later dispatch must still respect deletion, exclusion and current authority.

## Explicit text selection

`server/chat/memorySelection.ts` owns explicit selected-memory normalization and snapshots. `normalizeSelectedMemory`, `memorySelectionSnapshot` and `selectedEvidenceId` bind the selected records to accepted evidence. `MemorySelectionSnapshot` in `server/chat/types.ts` is the public typed projection.

The owner can select local notes for a connected conversation. `ChatService` accepts that selection with the run rather than trusting a renderer to supply arbitrary prompt text. Selected IDs are not permission to read a different record, ignore its class or resurrect an excluded source. `server/chat/context.ts` owns assembly and dispatch classification.

## Live startup and recall

`server/live/warm-context.ts` owns the Live warm-context path. Standing imported notes are selected by `server/memory/import.ts`; [memory-import.md](memory-import.md) owns the reviewed offline import. These mechanisms are bounded context construction, not proof that all history was read or that a provider remembers every earlier call.

On-demand recall uses the domain and host tool boundaries. Distinguish original transcript evidence, a remembered note and a derived summary. A summary is a separate record, not an exact quotation of everything said. [Domain contract](domain-contract.md) owns records; [prompt composition](prompt-composition.md) owns rendering.

## Deletion and retained context

The owner-delete transaction composes domain removal with retained chat/Live and cached-response redaction. `redactDeletedMemoryContext` in `server/chat/index.ts`, `redactDeletedMemorySnapshots` in `server/live/index.ts` and `scrubDeletedMemoryResponses` in `server/runtime/store.ts` are the owning seams.

New reads and later connection setup must not include the deleted memory. An already open provider connection can still hold it until reconnect or end. The HTTP result's `liveSessionRetainsUntilRebuild` flag exposes that limitation. Deletion does not remove an external original, quoted conversation history, provider-held bytes, backups or SQLite free pages. See [privacy-and-authority.md](privacy-and-authority.md).

## Export is a separate write

Legacy local memories of every kind remain readable for recall. They are never automatically exported when a live session closes. Vault writes use only `stage_lux_note`: a fresh owner request, frozen candidate, verified readback and confirmation are required. `composedNotes` defaults on and an explicit false disables saving; the legacy `notesExport` setting grants no write authority. The historical export ledger migration is retained unchanged in `server/live/schema.ts` solely for database compatibility. See [tool-owner.md](tool-owner.md).
## Verification

Use the selected-memory and memory-context producers named in [checks.md](checks.md). Tests should prove selection, omission, classification, stale/deleted records and observable UI state with synthetic records. A successful context compile proves neither real-account permission nor model recall quality. For a specific accepted run, inspect authorized metadata through [diagnostic-store.md](diagnostic-store.md).
