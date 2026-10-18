# Debugging Naya from her own logs

Every store a debugger can read sits in the host data directory, which is `--data-dir`, else
`DIDI_STATE_DIR`, else the platform default the host itself uses: `~/Library/Application
Support/Lux Didi` on macOS, `%LOCALAPPDATA%\Lux Didi` on Windows, and `$XDG_DATA_HOME/lux-didi`
(or `~/.local/share/lux-didi`) elsewhere. Every reader resolves it the same way.

| path | holds | privacy |
| --- | --- | --- |
| `<dataDir>/state.sqlite`, `trace` tables | the joinable record: turns, responses, calls, playback, the event spine | metadata is content-free; two content tables are owner content |
| `<dataDir>/logs/host.log` | content-free metadata: enums, counts and timings only | safe to quote in a bug report |
| `<dataDir>/logs/native-live.log` | the app's own voice session journal: closed reason codes, counts and timings | content-free |
| `<dataDir>/logs/audio.log` | numbers only: captured and played byte counts per second | content-free |
| `<dataDir>/debug/<YYYY-MM-DD>/live-<sessionId>.jsonl` | the full local record of a voice session | owner content, never publish |
| `<dataDir>/debug/<YYYY-MM-DD>/chat-<sessionId>.jsonl` | the full local record of a chat run | owner content, never publish |
| the unified log | the app's own OS log, subsystem `ai.lux.didi` | treat as owner content |

The four files are four answers to different questions. `state.sqlite` is the only one whose
tables join on host-minted ids, so it is the one to read first; `host.log` and the debug journal
remain the detail and content twins of that record.

The journal root is the parent of the host's config directory, which is `<dataDir>/debug` for the
default layout (the host reads `live.json` from `<dataDir>/provider-config`). A host started with a
different config directory writes its journal beside that directory instead, so `--data-dir` is the
switch that moves both.

The debug journal is the content twin of `host.log`, not a replacement: `host.log` keeps its
content-free contract, and every debug journal line is one JSON object per line so it can be
grepped and read by a program.

## The trace store

The `trace` migration owner lives in `state.sqlite` beside every other table, on the same
connection. Five metadata tables and two content tables share host-minted keys, so a session is one
query rather than four files that cannot be joined.

| table | holds |
| --- | --- |
| `trace_turn` | one turn: turn id, index, origin (`owner`, `assistant`, `recovery`), open and close time, monotonic ms, close reason, derived summaries, attribution flag |
| `trace_response` | one response or delegation: provider and delegation ids (nullable until observed), connection epoch, turn, status, continuation of another response |
| `trace_call` | one tool call: name, argument and result character counts, intent/execute/output-prepared/output-written times, outcome, ms |
| `trace_playback` | one audio segment: source instance, segment sequence, response and turn (nullable, audio carries no provider id), received/audible/enqueued/started/drained/interrupted times |
| `trace_event` | the append-only causal spine: seq, kind, source (`host`, `native`, `provider`), source sequence, producer wall ms, producer monotonic ms, host ingest time, schema version, typed detail |
| `trace_utterance` | content: transcript lines, by turn and role, final flag |
| `trace_call_result` | content: tool result text, capped at 16 KB, with its truncation flag |

Only the last two tables hold owner text. Every metadata column is an id, a closed code, a count or
a duration: the writer refuses any field outside its allowlist, so a provider message, a tool
argument, a result preview, a transcript snippet, a path or a title has nowhere to land. A turn
opens at the earliest reliable owner-utterance boundary, never on raw mic frames. Under full duplex
turn N stays open while turn N+1 opens, and nothing is silently reparented.

Every event carries three times: the producer's wall ms, the producer's monotonic ms, and the host
ingestion time. Within one clock domain an interval is exact; an interval between the host clock and
a native instance clock is approximate and is labelled so. Host and native monotonic values are
never subtracted from each other. A native receipt carries `source_instance_id` and `source_seq`,
dedups on that pair, and the reader reports a missing sequence range rather than hiding it.

Retention covers the two content tables only: rows older than 30 days are pruned at host startup.
Metadata rows are untouched by that pass. Deletion is logical, so SQLite WAL frames and free pages
are not forensically erased; see `docs/privacy-and-authority.md`.

## The SQL timeline

`scripts/didi-timeline` reads `state.sqlite` only and prints one timeline. It never reads the
journal or `host.log`. Every command accepts `--data-dir <path>`.

```sh
scripts/didi-timeline latest                                  # the most recent traced session, content hidden
scripts/didi-timeline <sessionId> --turn 3                    # one turn, its responses, calls and playback
scripts/didi-timeline <sessionId> --content                   # add transcript lines and tool result text
scripts/didi-timeline <sessionId> --json                      # the report as JSON, no owner text unless --content
scripts/didi-timeline --export-metadata --session <sessionId> # named metadata columns only, never a dump
```

Tracks overlap as the session did: while turn N's answer plays, turn N+1 prints as its own open
turn, and the playback line stays under turn N. A `GAP` line is a typed obligation with the receipt
that would close it, not a long interval:

- `no_delegation`: a response was created and no provider response or delegation id arrived.
- `no_response`: a continuation was sent and no provider response came back.
- `no_continuation_decision`: a call batch settled and no continuation response or turn close followed.
- `no_audible_output`: an answer completed and no playback segment became audible.
- `no_playback_drain`: playback started and no drain, interruption or termination followed.

Interrupted, superseded or intentionally silent work owes nothing and is never labelled a stall.
Outstanding obligations are listed at capture time, so a timeline taken mid-turn states what was
still owed, not a verdict. `NATIVE-GAP` reports an interior hole in a native instance's own
sequence.

## The debug journal

One line is written per event:

```json
{"t":"2026-10-17T12:01:03.412Z","mono":1412,"kind":"live","sessionId":"...","generation":0,"event":"tool","tool":"calendar_window","args":{"kind":"today"},"ms":812,"outcome":"completed","resultChars":1204,"result":"..."}
```

`t` is the wall clock in ISO milliseconds, `mono` the milliseconds since that session started, so
two lines minutes apart are still one ordered timeline.

Events, with the fields each one carries:

- `session_start`: provider, model, voice, build sha, the instruction section sizes and the full
  composed instructions text, written once per session.
- `session_end`: the terminal code and who ended it (`ended`, `detached`, `host`, `owner`).
- `transcript`: `speaker` is `owner` or `model`, `text` is what was actually said, `final` marks a
  finished transcription. Chat writes the owner's message and the model's answer here.
- `turn_start`, `turn_end`, `interrupt`: the turn boundaries and each barge-in.
- `model_round`: a chat model round, with `requestMs` (time to the first token), `responseMs`, token
  usage when the provider reports it, and `stopReason`. Live has no such event: a live turn is one
  provider stream, so its timings are the `provider_setup` request and response ms, the turn
  boundaries, `context_usage` and the per-tool lines. That is a deliberate gap, not a missing log.
- `tool`: name, full arguments, `ms`, `outcome`, `resultChars` and the result text itself, already
  passed through the secret redactor and capped at 16 KB per call.
- `provider_setup`, `provider_close`, `provider_error`, `context_usage`: the provider handshake, the
  close status and code, the error text, and the provider's own usage counts.
- `audio` (numbers only): one line per second with the captured and played byte counts.
  `audio_marker` records a `drain` (playback a barge-in abandoned) or a `stall`.
- `deadline`: a configured deadline fired, with its name (`call_ceiling`, `provider_session`,
  `provider_go_away`) and the value it was configured with.
- `recovery`, `continuity`: a provider drop, a resume or a fresh seeded window.
- `native`: a native receipt the app already forwards to the host (an open action and its ack).
  Mute, presence and window events never leave the app; read those with `naya-logs native` (below).

Safety and housekeeping:

- Files are mode `0600` in mode `0700` day directories, checked the same way `host.log` checks its
  own file.
- Retention is 30 days and at most 2 GB; the oldest whole day is deleted first, at start and once
  per day.
- A journal write that fails never touches the session: it is counted in `host.log` as
  `debug_journal_error` with the failing stage only.
- The setting lives in `live.json` preferences: `"debugJournal": false` turns the journal off.
  It is on when absent. `host.log` is unchanged either way.

## The reader

`scripts/naya-logs.mjs` reads the journal and `host.log` and prints aligned plain text, capped at
200 lines per command. Every command accepts `--data-dir <path>`, `--json` and `--lines <n>`.

```sh
node scripts/naya-logs.mjs sessions                      # id, kind, start, duration, provider, turns, tools, terminal
node scripts/naya-logs.mjs sessions --since 24h --kind live
node scripts/naya-logs.mjs timeline latest                # merged millisecond timeline, content hidden
node scripts/naya-logs.mjs timeline <id> --content        # same, with transcripts, instructions and tool results
node scripts/naya-logs.mjs tools <id>                     # each tool call: args, ms, outcome, result size
node scripts/naya-logs.mjs errors --since 24h             # failures across sessions, plus host.log receipts
node scripts/naya-logs.mjs slow --since 24h --over 5000   # slowest model rounds and tools first
node scripts/naya-logs.mjs native <id>                    # the app's own OS log for the session window
```

`timeline` merges the journal with every `host.log` record that names the session, and with the
session-less records that fall inside its window.

`--json` prints the records as stored, owner content included, because it is for machine use; the
plain-text output is the one that hides content behind `--content`. `native` reads the app subsystem
(`ai.lux.didi`) from `/usr/bin/log show` for the session window; `NAYA_LOG_BIN` overrides the
binary, `NAYA_LOG_SUBSYSTEM` the subsystem.

## When the owner says "inspect the logs"

1. `didi-timeline latest` for the shape of the session and its typed `GAP` obligations.
2. `sessions --since 24h` and find the same session by start time, duration and terminal code.
3. `errors --since 24h` and see whether that session is already named there.
4. `timeline <id>` and read the journal detail: turn boundaries, tool calls, provider close.
5. `slow --over 5000` for the timings, then `tools <id>` for the arguments of the slow call.
6. Rerun `timeline <id> --content` for the words, and `native <id>` when the question is about what
   the app did.

Read content only as far as the question needs it: the point of the ordering is to find the one
line that matters before reading a transcript.

## Release gates

A gate is a script under `scripts/` that builds first, runs its own compiled suite and refuses to be green on a
zero test count. Run it before a voice release; it prints its verdict and its own refusals.

```sh
bash scripts/check-live-session.sh    # the host live session, its summaries, journals, adapters and the voice
                                      # fault-replay scenarios (release gate F1)
```

The fault-replay part of that gate drives the real OpenAI adapter and the real host live session together over a
virtual monotonic clock, against a scriptable fake provider socket, scriptable fake tools and the driver's own
playback receipts, so no test in it sleeps, opens a provider or reads the owner's data directory. Each scenario
asserts the six council invariants: one terminal disposition and one output submission per observed call, one
continuation per ready batch, no write for a settled generation, no repeated uncertain action, no obligation
dropped because audio went quiet, and an answer or a typed failure inside the scenario's virtual deadline.

A scenario the current code fails is marked `todo` with the assertion it falsifies quoted, and named here with the
wagon that owes the fix: wagon S4a owns the late-callback repeat, the partial-batch continuation, the duplicate
terminal event and the failed backend response. A trace is a list of `{at_ms, direction, event}` built by
`server/test/voice-replay/sanitize.ts` from a recorded provider log of test data only, with every free text field
replaced by a placeholder.

## Privacy rule

The debug journal holds owner content: transcripts, the composed instructions, tool arguments and
tool results. The trace content tables hold transcript lines and tool result text, and the unified
log may too. Only the owner and owner-authorized Claude sessions read them. Never paste a debug
journal line, a transcript or a tool result into a public issue, a pull request, a commit, a test
fixture or a message, and never read the owner's real data directory from a test or a check.
