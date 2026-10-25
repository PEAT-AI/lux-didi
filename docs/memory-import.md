# Memory import and standing memory

Memory import is an explicit local owner operation for reviewed, distilled notes. It is not automatic transcript ingestion or permission to expose every imported record in every prompt. Imported records remain durable; prompt selection is separately bounded.

## Before running it

Use the correct host's private `state.sqlite`, reviewed JSONL input and a stopped host. Even a dry run acquires the writer lock. Do not stop the owner's application without approval, bypass its writer lock or point the importer at a database found by a filesystem search.

The implementation is `server/memory/cli.ts`, compiled to `server/dist/memory/cli.js`. Its grammar is:

```sh
node server/dist/memory/cli.js import --db /absolute/state.sqlite --input /absolute/reviewed.jsonl
node server/dist/memory/cli.js import --db /absolute/state.sqlite --input /absolute/reviewed.jsonl --apply
node server/dist/memory/cli.js import --db /absolute/state.sqlite --rollback IMPORT_RUN_ID
```

Without `--apply`, the input is reviewed without applying imported notes. The CLI also supports `--max-items`. Read its help before an authorized import; the source owns exact argument combinations and failure behavior. It backs up and integrity-checks the database before writes. Keep that backup private.

## Input and identity

`ImportItem` and `ImportProvenance` in `server/memory/import.ts` own the closed JSONL schema. `MemoryKind`, `MemoryStatus` and `MemoryConfidence` define the admitted values. Use `server/test/fixtures/memory-import-sample.jsonl` only as a synthetic format example, never as real owner history.

A valid JSON line is not evidence that its claim is true or that its source is available. Review the notes and provenance before applying them. Do not include credentials, raw account dumps or private content in a public fixture.

`IMPORT_PROVIDER` and `IMPORT_PROVENANCE_PROVIDER` distinguish imported records and source coordinates. Stable identity supports repeat-import handling; it does not authorize merging unrelated facts. Review supersession and duplicate outcomes instead of assuming that a second run replaced everything from the first.

## Rollback and prompt selection

Rollback targets one import run through the owner deletion/redaction path. It is not a whole-database reset, forensic erasure or deletion of a remote source. Already disclosed provider context and conversation quotations have separate limits, described in [privacy-and-authority.md](privacy-and-authority.md).

Standing memory is selected from eligible imported notes under the implementation's classification and budget rules. A successful import is not proof that every note was included in a particular Live or text acceptance. [Selected memory](selected-memory.md) owns the context boundary; [prompt composition](prompt-composition.md) owns rendering.

Use [checks.md](checks.md) for the focused memory checks. Import tests use temporary synthetic stores; they do not authorize running this command against the installed owner's records.
