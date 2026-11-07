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

Legacy local memories remain readable for recall. Closing a call never exports them automatically. An asked helper vault save uses `vault_save` or `vault_update` with the requested owner turn and discovered payload schema; the host verifies that turn and claims the existing write ledger before using the shared Lux client. The separate dictated-note feature remains available. Only an acknowledged receipt proves a remote write; pending or uncertain work is not a save. See [tool-owner.md](tool-owner.md).
## Verification

Use the selected-memory and memory-context producers named in [checks.md](checks.md). Tests should prove selection, omission, classification, stale/deleted records and observable UI state with synthetic records. A successful context compile proves neither real-account permission nor model recall quality. For a specific accepted run, inspect authorized metadata through [diagnostic-store.md](diagnostic-store.md).

## Verbatim conversation recall

Finished Live speech is retained as automatic transcription in `history_turns`, independently of summaries and without a time limit. Explicit forget deletes those turns and their full-text index entries. The helper uses its advertised memory read tools for past-call evidence; only text returned by those reads may be quoted as past speech. Current-call speech and tool results are not past-conversation evidence. Legacy calls are backfilled as sensitive and remain subject to the selected route's class gate. Debug-journal pruning is unchanged; text already pruned before this feature cannot be recovered.
