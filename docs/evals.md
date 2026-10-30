# Evals

An eval here is one synthetic chief-of-staff ask run end to end against a fake world: the owner's words in,
the tool calls the answer needed, the state those calls left behind, and the words Naya says back. The
scorer is deterministic. No model decides whether a case passed.

The cases live in `server/eval/cases/*.jsonl` (one file per category). They are the `public_ok` subset of
the private catalogue: synthetic names, synthetic addresses on `example.invalid`, synthetic meetings and
mail. Cases that carry real owner content stay in the private folder outside this repository and are never
copied here. `server/eval/tool-map.json` names, for each abstract tool the cases use, the real or planned
Didi tool behind it.

## What each layer proves

| Layer | Real or fake | What a case proves |
| --- | --- | --- |
| Cases | fixtures, content unchanged | The ask shapes and the acceptance the product claims. |
| Tool catalogue | `server/eval/tool-map.json` plus the connector modules' own read lists | Every tool a case names resolves to a real Didi tool or is honestly marked planned. |
| Fake world (`server/eval/world.ts`) | fake, stateful, recording | Gmail, Calendar, Drive, Mattermost, lux knowledge and meeting stubs, Mongoose, Trello and web research answer from the case's `setup.seeded_state`, hold drafts, events, cards and memory, and record every call with its arguments and its virtual time. An unmapped or unfaked connector call fails the case loudly. |
| Alarm, wake and reminder cases (`server/eval/alarms.ts`) | real scheduler over a real store | `AlarmScheduler` from `server/host/alarm-scheduler.ts` runs unmodified against a real `Store` with its real migrations; only the `AlarmClock` is the virtual one from `server/eval/clock.ts`. So a wake case exercises the production alarm row, state machine and recheck, and the clock is the one thing that differs. |
| Recording sink (`server/eval/sink.ts`) | fake live voice port | The repo's `fakeLiveVoicePort` fixture records the spoken text. Every spoken frame carries `outputSink: recording-only`, a wake fires into a list of strings, never into a speaker, and the self-test asserts that every frame of a whole run is `recording-only`, with the module watch as the other half of that guard. |
| Guards (`installEvalGuards`) | fakes refused | The global `WebSocket` both realtime adapters open, `net.Socket.prototype.connect`, `net.createConnection`, DNS, `fetch` and every child process launch throw `eval_guard` inside a run. So an unfaked connector cannot reach the network, no realtime session can open, and no audio player can be spawned; the self-test probes the WebSocket refusal and asserts that no case opens one. The harness also counts real timers: zero are armed. A module watch (`server/eval/modules.ts`) records every module a run loads, and the self-test asserts that no run resolves `adapters/live-voice/gemini.js`, `openai.js` or `eval/live.ts`: the scripted path cannot reach a device even by accident. |
| Scripted provider (`server/eval/scripted.ts`) | fake, free | Replays the case's required calls and composes an answer out of the facts the fake world actually holds. It proves the harness, the gates and the scorer, and says nothing about model quality. |
| Live provider (`server/eval/live.ts`) | real realtime adapter | The owner's configured model answers the same asks as text turns, with tool calls executed against the same fake world. Expensive, so never automated. |
| Scorer (`server/eval/scorer.ts`) | deterministic | Required tools as a set, in the dependency order the case states, extra reads allowed, any write the case did not ask for a failure, `expected_state` checked against the fake store, and the spoken text checked against both. |

The scorer's rules, in the order it applies them:

1. **Capability.** The mapping table names, for every tool, the capability behind it (`capabilities` in
   `tool-map.json`), and a case is `EXPECTED_RED` only while one of the capabilities it needs is `planned`:
   the red label follows the capability, never the case's own `red_today` claim. A case whose capabilities
   all exist runs for real and has to pass, so the four cases that assert a clarifying or refusing answer
   over an empty store (`email-09`, `email-10`, `mattermost-07`, `mattermost-08`) are exercised today. Once a
   planned capability ships, its cases run for real too, and a case that still fails is a hard `FAIL`.
2. **Required set.** Every expected tool appears at least `count` times (default one). `count: 0` asserts the
   opposite: the tool is never called.
3. **Dependency order.** Required tools appear in the order the case lists them. Extra reads may interleave
   anywhere inside the declared source scope; a call to a tool the table does not name fails the case.
4. **Writes.** Any write the case did not ask for fails (`write_not_expected`). `unchanged: true` fails on any
   write at all.
5. **State.** `expected_state` is asserted against the fake store: drafts and chat drafts (with their target,
   language, body and unsent status), sent mail (always empty: there is no send tool), new calendar events,
   alarm rows and their state at fire time, memory notes, Trello cards.
6. **Speech.** `spoken_must` tokens in order (an entry may say where its token belongs, as in
   `reminder text 'go to bed' before any overview`; the quoted text is the token), `spoken_must_not` absent,
   and every claim checked against the store: a draft claim needs a stored draft, an invitation or a sent
   message is always a failure, a finished meeting may never be spoken as upcoming, and a meeting inside the
   asked window must be named.

## Running it

Scripted, free, and the same thing `check-evals.sh` runs:

```bash
bash scripts/check-evals.sh                    # harness self-test: scripted only
bash scripts/run-local-evals.sh                # every public case, scripted
bash scripts/run-local-evals.sh --category wake
bash scripts/run-local-evals.sh --id calendar-01
```

The summary is one line of totals plus one line per category with `PASS`, `FAIL` and `EXPECTED_RED` counts.
A failure names the case and every reason it failed for. The command exits non-zero when anything failed,
`4` when the filter matched no case at all (a typo is not a green suite), and `--live` without `--yes` exits
`2` before spending anything.

Live, real model, real money:

```bash
bash scripts/run-local-evals.sh --live --yes --category wake
```

`--live` first prints the number of model calls and an estimated cost from a per-call token estimate
(`server/eval/live.ts`: 6000 prompt and 900 response tokens per case at the configured price). Without
`--yes` it stops before the first session opens. It reads the provider, model and voice from the app's own
`live.json`, takes the key from `GEMINI_API_KEY` or `OPENAI_API_KEY` in the environment, and prints the
measured token usage and cost at the end. Tool calls the model makes execute against the fake world, so a
live run never touches the owner's Gmail, Calendar, Mattermost or disk.

## Cost discipline

- Never in CI with a model. `scripts/check-evals.sh` is the scripted harness self-test only, and it belongs
  to release pull requests.
- The full suite, scripted or live, runs locally and on demand: before a release install, and after a change
  to a capability a case covers.
- Every run states its model-call count and cost before it starts and its measured cost after.
- A live write smoke (a draft, an event, a chat draft against a real service) needs a disposable sandbox
  account the owner provisions. Until then it is owed, not run.

## Adding a case

1. Write the ask as the owner would say it, in `finals`.
2. Put only synthetic people, addresses, meetings, mail and files in `setup.seeded_state`, on
   `example.invalid`.
3. Name the tools the answer needs in `expected_tools`, in dependency order, with the arguments that matter.
   Use an abstract name from `tool-map.json`; add an entry there if the name is new, with `planned` for a
   capability that does not exist yet.
4. Say what the world must hold afterwards in `expected_state`, and what Naya must and must not say in
   `spoken_must` and `spoken_must_not`.
5. Add it to the category file and run `bash scripts/run-local-evals.sh --id <id>`. It must pass scripted
   before it means anything live.

Red cases are cases whose capability does not exist yet. They are honest only while `tool-map.json` still
marks that capability `planned`; flipping its status to `implemented` is what turns the case into a hard
requirement. A case that needs no absent capability is never red, whatever its own `red_today` field says.

## What is not covered yet

- The connector dispatch path itself (the strict source gate in `server/tools/dispatch.ts`, with connector
  envelopes, freshness receipts and digests) is not exercised: connector reads and writes go through the
  fake world at the point where the real MCP child would answer. A case therefore proves the tool layer above
  the connector boundary, not the connector's own wire contract. `check-google-connector.sh` and
  `check-company-connectors.sh` cover that boundary.
- `--live` has not been run in this wagon: it costs money, so the owner runs it. The scripted path is what the
  check proves.
