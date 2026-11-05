# Inspect a conversation locally

The host's `state.sqlite` connects conversation, tool and trace records by explicit identifiers. It also contains private content. A read-only database connection prevents mutation; it does not make the data safe to publish.

Use the data directory of the host actually being investigated. A source-run host and the installed app can use different directories. Verify launch identity first; never search another person's files or assume that the newest database belongs to the failing call. [Local runtime](local-runtime.md) owns path selection.

## Start with the timeline CLI

```sh
node scripts/didi-timeline --help
node scripts/didi-timeline latest --data-dir /absolute/host/data --json
node scripts/didi-timeline "LIVE_SESSION_OR_CHAT_RUN_ID" --data-dir /absolute/host/data --json
```

`latest` selects the latest **Live session**, not the latest text conversation. A text conversation has a session ID and separate run IDs; use the run ID for one tool-bearing turn. Default output is metadata, not transcript or result bodies.

For explicit local owner inspection only, add `--content`. Content reads are gated by current source/class/revision and diagnostic-context authority. Unavailable content must stay unavailable rather than falling back to an older preview. The gate is implemented by `diagnosticContentAccess` in `server/trace/content.ts`; `DiagnosticContext` in `server/trace/diagnostic-context.ts` records the accepted disclosure context. An unfinished or unsealed run is not permission to guess its provenance.

`didi-timeline call <session|latest> --audit` answers "what happened in that call" in one command: session coverage and clock health, one row per tool call with its `callKey`, `executionMs`, `totalMs`, outcome and refusal code, one row per owner turn with its first-sound waits (owner final to the provider's first audio, and to the app's first audibility receipt), the completed-answer wait measured at the last drain of the turn's own playback segments, and missing unless every one of them drained and every response that made audio owns one, the playback segments the store joined to the turn, and any inverted pair as a flag rather than a zero, then the aggregates (slowest calls, refusals by code, tool failures by tool and code, turns over four seconds from final to first sound, announced claims with no call, dead air, the owner finals with no provider audio split into `fragment` and `unanswered` over a stated follow bound, the first-sound coverage counts behind every percentile, and the playback segments attributed and unattributed). A measure without a receipt prints `missing`, never a zero, and `#1011` gives the review its denominators: `first sound coverage owner-turns=N provider=a/N native=b/N answer-complete=c/N`. A call with no turn row is still a table row with `turn -`. `didi-timeline sessions --since <date> --audit-summary` prints the same aggregates across every session with a turn or a call since the date. Both read metadata only; `--json` carries a schema `version` (4 from #1011, which renamed `finalToProvider` and `finalToAudible`, split first sound from the completed answer and added the coverage and flag fields). The CLI reads a built `server/dist` and never builds one: a missing, stale or older dist is reported with `npm --prefix server run build` and the read stops.

The join is the envelope, not a timestamp guess: `trace_call.call_key` is the same key the call's admit, dispatch and outcome lines carry, and every host log line inside a turn carries that turn's `turnId`. A measurement the store or the log does not have prints as `missing` with a closed reason; it is never printed as zero, and it is never inferred from a neighbouring line.

`--turn N` filters traced Live turns. It does not invent an association between an unrelated source execution and that turn. For a metadata-only export, use `--export-metadata` and optionally `--session`; inspect the output before sharing it.

## Follow identifiers, not prose guesses

| Record family | What it explains | Schema owner |
| --- | --- | --- |
| `live_sessions`, `live_journal` | Call lifecycle and received transcript fragments | `server/live/schema.ts` |
| `chat_runs` | A text run's acceptance and completion | `server/chat/schema.ts` |
| `tool_runs`, `tool_calls` | Accepted tool context and canonical execution/result identity | `server/tools/schema.ts` |
| `tool_dispatches` | Observed source attempts and captured supported results | `server/tools/schema.ts` |
| `trace_turn`, `trace_response`, `trace_call`, `trace_event`, `trace_playback` | Correlation, receipt stages and native playback evidence | `server/trace/schema.ts` |
| `history_sessions`, `history_dependencies`, `history_exclusions` | Current history eligibility and derived dependencies | `server/domain/schema.ts` |

Use the owning migrations for exact columns. A canonical model-facing result is not necessarily the full source response; a stored response is not proof that the remote corpus was complete. Reuse edges are not new wire calls, and an absent playback receipt is not proof that a speaker was audible.

## Direct SQL is privileged forensics

[diagnostic-queries.sql](diagnostic-queries.sql) contains named queries for local inspection. Open only the verified database read-only, set the requested identifiers and select the query you need. Do not expose these raw queries as model tools: direct owner SQL bypasses model-retrieval gates and can reveal excluded text, arguments and results.

A database dump, a content-mode timeline, or raw SQL output is not a safe support attachment. Conversation transcripts, result bodies and document titles remain private even when credentials were excluded from their transport envelope.

## Coverage and retention limits

Host receipt time is not provider event time, transcript fragments are not a perfect audio recording, and a successful capture is not a guarantee of source completeness. Keep coverage and unavailable reasons when analyzing a failure instead of replacing them with a confident narrative.

Two clocks govern the store, and the schema enforces them. At **30 days** owner content is nulled **in place**: transcripts, call results, legacy lookup questions, connector result bodies (`tool_dispatches.source_json`), connector argument values (`tool_dispatches.arguments_json`), chat tool results (`tool_calls.result_json`), chat tool inputs (`tool_calls.input_json`), live journal text and the accepted prompt snapshot. The trace and tools tables also stamp the row with `content_pruned_at`, so a reader can tell a pruned body from a body that never existed; the live journal and session rows are owned by another migration owner and carry no such stamp, so for them an empty body and a pruned body look the same. At **90 days** the trace metadata rows are deleted. A dispatch row is an audit record and is never deleted, and a chat call row is deleted at 90 days only once it owns no dispatch row; what it keeps is metadata: ids, `source_sha256`, `source_bytes`, `entity_sha256`, `entity_bytes`, `arguments_sha256`, `arguments_key_count`, `arguments_keys` (sorted key names), `started_at`, `ms`, `state`, `source_outcome` and `reason` (the connector's own code). `tool_calls.created_at` is what ages a chat call; rows migrated from schema v3 carry the migration time because the older table had no timestamp.

A trigger, not a caller's discipline, holds that line: `tool_calls_content_guard` and `tool_dispatches_content_guard` fire on any update touching a content column, allow only the write that assigns NULL (or the one seal write), and abort if any other column changes. A body whose hash no longer matches is not the same thing as a body that was pruned: a pruned result reads `pruned`, never `unavailable_or_hash_mismatch`.

`server/trace/record.ts` owns trace writes; `server/trace/schema.ts` owns their storage contract. The pruner runs at host start, never during a live call, in bounded batches, and checkpoints the WAL afterwards. Content pruning is not forensic erasure of SQLite WAL/free pages, backups or snapshots. [Privacy and authority](privacy-and-authority.md) explains memory deletion separately from conversation retention.

For the operational sequence and content-free logs, use [debugging.md](debugging.md). For the existing verification producers, use [checks.md](checks.md); this page is not another list of direct integration-test commands.

## Helper task records

Release 10.10 retains task revisions, reads, operation receipts and delivery state through `server/tasks/runtime.ts` and `Store`. A completed task is not proof that the voice spoke it. A stale revision may retain useful reads and committed writes without being eligible for delivery. Inspect metadata first; retained task arguments are private content, not a safe support attachment. In 10.11, task result bodies are not retained, only their closed category and byte size.

## Helper task diagnostics (10.11)

`task_tool` logs contain only task/revision/operation identifiers, tool name, duration, terminal category, the closed `reason_code` of a failure (`null` when nothing failed), the ranked-search word `candidates` (`returned`, `none`, or `null` when the tool is not a ranked search) and cache disposition. A `reason_code` is one of the closed council reasons in `server/tasks/results.ts`: no_access, sign_in_needed, not_found, wrong_id, bad_argument, timeout, rate_limited, source_down, empty_content, not_configured, cancelled, invalid_result, unknown. Failure repairs are helper-facing content, not log messages. No task arguments, results, final answers, connector text or owner speech are added to these events.

Task operation rows and revision evidence are metadata, not evidence copies. A failed operation row keeps a size, its closed category, its `reason_code` and the host-authored repair text, cut to 200 characters; a resolved one keeps a size and its status word. Revision evidence is the aggregate it is, so it keeps a size and an item count instead of borrowing `upstream_error`, which it never measured.

Task owner words, tool arguments and the helper's own final answer text are captured unconditionally in the same owner-only local database as transcripts. There is no task capture flag. Existing task pruning nulls this content in place after 30 days and records `content_pruned_at`; metadata retention remains 90 days. Revision evidence, tool results and effect-journal responses retain only byte size and a closed terminal category, never source bodies or result references. A final answer stores only its spoken text, not the helper's findings or receipts. Pruning is also applied at host startup alongside transcript retention.

The final answer record holds the helper's own text. A `no_action` has no helper text; the no-lookup commentary is host text, not a helper answer.
