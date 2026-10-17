# Memory import and standing memory

`import-memory` loads a reviewed JSONL file of distilled owner notes into a
stopped host's domain store, and `--rollback` removes one run again. The idea is
the owner's history as standing context: what she learned in months of
conversations, available in every Live call and every text chat.

Nothing here writes to a running host. The command refuses while the host holds
the writer, backs the database up first, and never prints note text.

## The command

The compiled entry point is `server/dist/memory/cli.js`. Both paths are
explicit and absolute, the same discipline as `config/cli.ts`.

```
node <compiled-root>/memory/cli.js import --db <absolute path to state.sqlite> --input <absolute path to jsonl> [--apply] [--max-items N]
node <compiled-root>/memory/cli.js import --db <absolute path to state.sqlite> --rollback <run id>
```

- `--db` must name the private `state.sqlite` of one state directory. The
  directory beside it is the state directory.
- A dry run is the default. It prints counts only and writes nothing.
- `--apply` writes. It prints the backup path and a `runId`; keep the `runId`,
  it is what `--rollback` takes.
- `--max-items N` caps how many items one apply writes. The rest are reported
  as `limited`, never silently dropped.
- `--rollback <run id>` deletes every entry that run created, through the same
  owner-delete path the HTTP route uses: the entry tombstone, the chat context
  redaction, the Live prompt-snapshot scrub and the cached-response scrub.

Every line the command prints is JSON with a `event` field. Rejections are
`{"event":"memory_import_rejected","line":7,"code":"invalid_field"}`: a line
number and a code, never the note.

Exit status is `0` on success and `1` on refusal or failure, with a
`{"event":"memory_import_failed","code":"..."}` line on stderr. Codes:
`invalid_arguments`, `writer_locked`, `invalid_input`, `backup_failed`,
`run_not_found`, `import_failed`.

## What `--apply` does, in order

1. Probes the host writer lock (`writer.sqlite`, the same exclusive lock the
   host holds for its whole life) and refuses with `writer_locked`.
2. Runs `PRAGMA integrity_check` on the target and refuses if it is not `ok`.
3. Takes an online backup with `VACUUM INTO` to
   `state.sqlite.bak-<timestamp>` beside the database, and integrity-checks the
   backup. A failed backup refuses the apply before anything is written.
4. Writes, in one transaction per statement batch: one session titled
   `Imported history` labelled `ordinary`, and one entry per item labelled
   `ordinary`, each carrying a source reference with provider `import-history`,
   `externalId` equal to the item `id`, and the note
   `kind:<kind> topic:<topic> status:<status> importance:<n>`. The item's own
   `sources` become separate source references with provider
   `import-history-provenance`; they are never sent to a model.
5. Runs `PRAGMA integrity_check` again.

Every write goes through the domain module (`domain/memory.ts`,
`domain/labels.ts`), never raw SQL, so a routing-label row, a session row and an
entry row are created exactly as an ordinary owner write would create them.

## The input format

One JSON object per line. Unknown keys are rejected, every field is validated,
and a rejected line never blocks the rest of the file.

| field | type | rule |
| --- | --- | --- |
| `id` | string | 16 lowercase hex characters; the idempotency key |
| `kind` | string | `fact`, `preference` or `task` |
| `label` | string | free tag, 1 to 64 characters, no control characters |
| `topic` | string | one token, `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; part of the supersession key |
| `status` | string | `current`, `dated` or `open` |
| `importance` | number | integer 1 to 3 |
| `confidence` | string | `high`, `medium` or `low` |
| `capturedAt` | string | `YYYY-MM-DD`, a real calendar date |
| `text` | string | 1 to 500 characters, one line, no control characters |
| `sources` | array | up to 8 of `{sessionId, date, key}`; session and key 1 to 128 characters, date `YYYY-MM-DD` |

A `text` that begins with the private or sensitive marker (`privately ...`,
`this is private ...`, `as sensitive ...`) is refused with
`private_memory_unsupported`. That is the same detector `rememberOwnerNote`
applies, so an import cannot label something ordinary that Live would have
refused to remember.

A minimal, synthetic line:

```json
{"id":"1000000000000000","kind":"fact","label":"synthetic","topic":"mint-release","status":"current","importance":1,"confidence":"high","capturedAt":"2026-03-01","text":"Prefers the short status note first.","sources":[]}
```

## Idempotency, supersession and deletion

- An item whose `(provider='import-history', externalId)` already exists is
  skipped and reported as `existing`. Re-running the same file writes nothing.
- If the file holds the same `topic` and `label` twice, only the newest
  `capturedAt` is written; the older one is reported as `superseded`.
- The entry id is derived from the item `id` (`sha256`, formatted as a UUID),
  never random. When the owner deletes an imported note the source reference is
  deleted with it, so the derived id is what ties a later re-import to the
  tombstone: a deleted item stays deleted and is reported as `tombstoned`.

## Standing memory in the prompts

Imported notes are ordinary entries, so they reach text chat through recall and
evidence. They also get their own prompt section, `standing-memory`, placed
after the owner lore and before `# Memory`:

- budget: `STANDING_MEMORY_CHAR_LIMIT` = 3,000 characters, separate from
  `MEMORY_SECTION_CHAR_LIMIT` (1,500) which stays for ad hoc voice notes;
- rank: `importance` descending, then status (`open`, `current`, `dated`), then
  `capturedAt` descending, then entry id. Never uuid order;
- whole notes only: a note that does not fit is omitted with reason `budget`,
  it is never truncated;
- yielding: `earlier-conversations` yields first, then `# Memory` keeps its own
  budget, then `standing-memory`, then style and lore, which never yield.

`LIVE_INSTRUCTION_TARGET_CHARS` and the hard limit are unchanged: the section
lives inside today's budget.

## Safety notes

- The input file is sensitive. Keep it outside any git tree and delete it after
  the reviewed apply. `.jsonl` files are not tracked here.
- Never run the command against the installed data directory while the host is
  running; it refuses, and that refusal is the intended behaviour.
- The backup `state.sqlite.bak-<timestamp>` beside the database is a full copy
  of the owner's memory. Treat it like the database itself and delete it once
  the import is verified.
- A dry run opens the store and therefore takes the host's writer lock while it
  runs, so stop the host first either way.
