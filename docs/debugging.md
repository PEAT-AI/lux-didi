# Debugging Naya from her own logs

Two local files describe every session. They sit in the host data directory, which is `--data-dir`,
else `DIDI_STATE_DIR`, else the platform default the host itself uses: `~/Library/Application
Support/Lux Didi` on macOS, `%LOCALAPPDATA%\Lux Didi` on Windows, and `$XDG_DATA_HOME/lux-didi`
(or `~/.local/share/lux-didi`) elsewhere. The reader resolves it the same way.

| path | holds | privacy |
| --- | --- | --- |
| `<dataDir>/logs/host.log` | content-free metadata: enums, counts and timings only | safe to quote in a bug report |
| `<dataDir>/debug/<YYYY-MM-DD>/live-<sessionId>.jsonl` | the full local record of a voice session | owner content, never publish |
| `<dataDir>/debug/<YYYY-MM-DD>/chat-<sessionId>.jsonl` | the full local record of a chat run | owner content, never publish |

The journal root is the parent of the host's config directory, which is `<dataDir>/debug` for the
default layout (the host reads `live.json` from `<dataDir>/provider-config`). A host started with a
different config directory writes its journal beside that directory instead, so `--data-dir` is the
switch that moves both.

The debug journal is the content twin of `host.log`, not a replacement: `host.log` keeps its
content-free contract, and every debug journal line is one JSON object per line so it can be
grepped and read by a program.

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

1. `sessions --since 24h` and find the session by start time, duration and terminal code.
2. `errors --since 24h` and see whether that session is already named there.
3. `timeline <id>` and read the shape of the session: turn boundaries, tool calls, provider close.
4. `slow --over 5000` for the timings, then `tools <id>` for the arguments of the slow call.
5. Rerun `timeline <id> --content` for the words, and `native <id>` when the question is about what
   the app did.

Read content only as far as the question needs it: the point of the ordering is to find the one
line that matters before reading a transcript.

## Privacy rule

The debug journal holds owner content: transcripts, the composed instructions, tool arguments and
tool results. Only the owner and owner-authorized Claude sessions read it. Never paste a debug
journal line, a transcript or a tool result into a public issue, a pull request, a commit, a test
fixture or a message, and never read the owner's real data directory from a test or a check.
