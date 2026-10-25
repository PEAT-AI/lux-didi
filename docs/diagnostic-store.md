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

`server/trace/record.ts` owns trace writes; `server/trace/schema.ts` owns their storage contract. Content pruning is not forensic erasure of SQLite WAL/free pages, backups or snapshots. [Privacy and authority](privacy-and-authority.md) explains memory deletion separately from conversation retention.

For the operational sequence and content-free logs, use [debugging.md](debugging.md). For the existing verification producers, use [checks.md](checks.md); this page is not another list of direct integration-test commands.
