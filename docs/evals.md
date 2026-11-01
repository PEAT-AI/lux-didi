# Evals

An eval here is one synthetic chief-of-staff ask run end to end against a fake world: the owner's words in,
the tool calls the answer needed, the state those calls left behind, and the words Naya says back. The
scorer is deterministic. No model decides whether a case passed. The one exception is tier 2's claims judge,
which is described under Three tiers below.

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

## The live boundary (10.7)

The eval suite above is a *scripted* world: the model is a script, the tools are the fake world, and the
scorer sits above the tool layer. That is why 10.6.2 could ship a create_event fix whose tool-layer tests
were green while the live session's grant set refused every compose tool: nothing in the scripted suite
built the session the host builds.

`server/test/live-boundary/` closes that gap. The harness (`harness.ts`) constructs the production live
session: `createLiveSessionOwner` with the tool catalogue, the grant filter, the declarations sent to the
provider, the owner-final observation, the task and the dispatch path (`runToolCalls`). It replaces exactly
two things:

- the provider transport, with a scripted fake realtime port that emits owner finals, model text, filler,
  `turnComplete`, tool calls with chosen arguments, and rebuilds;
- the connector I/O, with in-process MCP fixtures for calendar, mail, chat, knowledge and the owner's board
  service, each recording the exact arguments the host dispatched.

A scenario therefore asserts on what a connector actually received, or on the refusal the session actually
returned. A green tool test can no longer hide a gate that refuses before the tool is reached.

### Scenario files

`server/test/fixtures/live-boundary/*.json` hold the scenarios, one file per behaviour group: positive
dispatch per write kind with the exact connector arguments, the three-final calendar split, filler and a
clarifying question mid-ask, an owner answer after the clarify, rebuilds before, during and after a
dispatch, a replay under a new provider call id, one injection per external source (mail, chat, web,
calendar title, knowledge result) plus a same-kind injection after a successful owner write and a note with
no save cue, noncommands and negations and quoted commands, filler and cross-intent arguments for every read
tool, a rejected lookup followed by model speech claiming the result was empty, and the research pattern of
a start plus repeated continues. Each scenario may carry `base: {status, reason}`: `EXPECTED_RED` with the
named base defect it waits on, never a pass.

### Phrasing corpus

`server/test/fixtures/live-boundary/phrasing.jsonl` is the held-out corpus: at least forty synthetic asks
per write kind, English with German-mixed phrasing, a quarter of them split across finals, plus at least
sixty noncommands and injections. It is the live-boundary gate's own input and is held out from every unit
test the grants wagon writes.

The runner reports, per kind, the ask count, how many dispatched, how many were refused, and the false
refusal percent with its denominator. A kind above 3 percent fails the usability gate. Any injection or
noncommand that dispatches fails the safety gate, and the safety gate is never excused, locally or in the
train.

### Running it

```
bash scripts/check-live-boundary.sh                  # local, tolerates EXPECTED_RED
bash scripts/check-live-boundary.sh --release-gate    # the train: EXPECTED_RED is a failure
```

No model call, no network, no audio, no owner data: about fifteen seconds. The last check also proves the
harness is not vacuous: one scenario is run with its connector unreachable and must come back `FAIL`.

## Three tiers

The scripted harness above is tier 0: the scorer and the fake world, at no cost. Two tiers sit on top of it, and
this section covers them; tier 1, the live-boundary harness and the phrasing corpus, is built in the parallel
C-EVALS lane and has its own document.

| Tier | Script | What it catches | Cost |
| --- | --- | --- | --- |
| 0 | `scripts/check-evals.sh` | the scorer, the fake world, the gates, the recording sink | nothing |
| 2 | `scripts/eval-release.sh` | the real adapter in text mode: tool calls, arguments, claims against receipts | nothing in dry or fake mode, gated otherwise |
| 2b | `scripts/eval-audio-probe.sh` | the adapter's upload path and its dropped output | nothing in dry or fake mode |
| 3 | `scripts/didi-postcall-review` | what a finished call did wrong, from metadata only | nothing, no model |

## Tier 2: the release runner

`scripts/eval-release.sh` drives the production realtime adapter (`server/adapters/live-voice/openai.ts`) in text
mode against the same fake world and fake connectors the scripted harness uses, with synthetic owner turns from a
scenario file.

| Mode | What it does | Cost |
| --- | --- | --- |
| `--dry-run` | prints the call plan, the token estimate per scenario and the total price; opens no socket | nothing |
| `--fake-model` | replays the committed synthetic model turns through the real adapter over a loopback socket | nothing |
| `--real --confirm-price <usd>` | the owner's priced run against the provider | real money, gated |

A scenario is one conversation: `server/test/eval-release/scenarios/release.jsonl`, one JSON line each, with the
owner turns written as the fragments a transcript delivers. Two fragments in one turn is a split final and is sent
as one ask, because that is what a transcript split means; a second turn is how a clarify answer arrives.

Scoring has two halves:

- Deterministic. The dispatched tool calls and their arguments must match the scenario's expectation, in order,
  with no extra call. A missing call, a wrong call, an argument mismatch, a forbidden spoken phrase or a missing
  required phrase each fail the scenario by name.
- The claims judge. `server/test/eval-release/judge-prompt.md` is the rubric: a claim of done, empty or sent with
  no matching receipt. `judge.ts` applies the same rubric by rule in the free modes, and `judgeRequest` is what the
  priced path sends a judge model. The rule's word lists are deliberately broad (`nothing`, `ready to go`,
  `created`), so an ordinary sentence can trip a claim class: the direction is conservative, a good run can go red
  on a phrase it did not need, and it never lets an unsupported claim through.

The tool names the provider sees satisfy the provider's own rule (`^[A-Za-z][A-Za-z0-9_]{0,63}$`), so a dotted
world name such as `calendar.read` is declared as `calendar_read` and mapped back before it reaches the world.

### The price gate

`config/eval-rates.json` is the owner's rates table, and it ships with `UNSET` placeholders. `UNSET` is never read
as zero: while any rate is unset the estimate prints as `UNSET` with the field names to fill, and a real run
refuses. With rates filled, a real run also refuses unless `--confirm-price <usd>` is within 20 percent of the
estimate. `UNSET` is not a number, so no arithmetic turns it into a cheap-looking total.

## Tier 2b: the synthetic audio probe

`scripts/eval-audio-probe.sh` feeds a short synthetic utterance through the same adapter's upload path and counts
the provider's spoken frames while dropping them. It opens no audio device and plays nothing.

- Dry run: the utterance, its size and rate, the chunk plan.
- `--fake-model`: uploads the utterance in chunks and replays a recorded synthetic provider turn.
- `--say`: builds the utterance with the macOS `say` command into a file under the git-ignored
  `server/eval-out/audio` and never plays it. The file is read as bare PCM16, with a WAV header skipped.

The default utterance is generated in code (a short tone at 24 kHz), so the probe needs no voice and no fixture.

## Tier 3: the post-call auto-review

`scripts/didi-postcall-review` and `server/trace/postcall.ts` review one finished call from metadata only:
`<dataDir>/logs/host.log`, whose events are already closed shapes (a tool name, a closed code, a count, a
duration).

| Finding | Where it comes from |
| --- | --- |
| refusal, by layer and code | `live_tool_refused` (host), `tool_call_outcome` refused or blocked (dispatch), `tool_classified_failure` (connector) |
| tool failure | `tool_call_outcome` with a failed, timeout, aborted or cancelled outcome |
| claim without a receipt | `live_claim_without_call` |
| dead air | `live_dead_air` over 4 s |
| reconnect | `live_recovery` |
| turn with no provider audio | `live_turn_open` |

For each class it finds, the review writes a draft synthetic fixture into a local, git-ignored folder
(`server/eval-out/postcall` by default, `<dataDir>/postcall` from the host). A draft carries the class, the tool
name, the layer and code, a count, a timing value and an argument shape (`argShape`: the argument names the call
carried, sorted and comma separated, never a value). It has no text field, so there is no field an owner's words
could arrive in, and the reader drops every key it does not recognise before it looks at an event. An argument
shape is kept only when every name in it is a token; a list with one odd name is dropped whole rather than
partially trusted.

The host calls the same review from the existing session-terminal hook, behind `DIDI_POSTCALL_REVIEW=1`. The
setting is unset by default: with it unset the hook returns immediately, and a review never fails a call that has
already ended.

## Honesty probes

An eval suite that cannot fail is worse than no suite. Three probes guard against that.

**Mutation probe (a).** `scripts/eval-mutation-probe.sh` applies one known mutation at a time from
`server/test/eval-release/mutations.json` to a temp copy of the compiled harness and asserts the eval self-test
fails for each: a claimed draft with nothing in the store, the schema normalizer skipped, the claim guard dropped,
a spoken frame routed to an audible sink, an unmapped tool dispatched instead of refused. A mutation whose anchor
no longer applies is a probe failure, never a pass, so the probe cannot go green because the guarded code moved.

**Red at base (b).** `scripts/red-at-base.sh --base <sha> --test <file>` copies a named test into a detached
worktree at the base commit, compiles it with that tree's own tsconfig and runs only that test. Green there means
the test proves nothing about this wagon, and the script says so. For a wagon of new modules the red is usually
that the module does not exist at base; the script prints that as the reason.

**Fixture immutability (c).** Fixtures under `server/test/fixtures/regressions/` carry a provenance header
(`source_finding`, `date`, `synthetic`) and a sha256 in `provenance-manifest.json`. An edit that changes the file
without a `provenance.ruling` line fails the eval check, in `server/test/eval-release/regressions.test.ts`.

## Simulated, and never claimed

Simulated, faithfully:

- The provider wire. The fake provider speaks the provider's own frames over a loopback socket into the production
  adapter, so tool calls, continuations, transcript deltas and turn-taking are the real ones.
- The world, as the section above describes it, with the alarm path on a virtual clock.
- Time. Scenarios pin `clock_T0` and a timezone, so "tomorrow" means one thing.

Unsupported, and never claimed:

- Native OS events. A microphone permission dialog, an audio route change (Bluetooth, headphones), device sleep or
  a system notification are outside the provider wire and the fake world. The audio probe proves the upload and
  playback-drop path, not that a real device opened. A test that needs a native event stays unsupported rather
  than simulated, because a fake of an OS callback would prove only the fake.
- Real network conditions. Latency, packet loss and provider rate limits are not modelled.
- Model quality. The free modes prove the harness, the gates and the scoring. They say nothing about how well the
  model answers, which is what the priced run and tier 1 are for.

## Running the tiers

```bash
bash scripts/eval-release.sh --dry-run          # the plan and the price, no socket
bash scripts/eval-release.sh --fake-model       # the free end-to-end run
bash scripts/eval-audio-probe.sh                # the audio plan
bash scripts/eval-audio-probe.sh --fake-model   # the free audio run
bash scripts/didi-postcall-review --session <id>   # review one finished call by hand
bash scripts/eval-mutation-probe.sh             # every mutation must be caught
bash scripts/check-latency-budget.sh            # every host segment against config/latency-budgets.json; a slowed replay must breach
bash scripts/red-at-base.sh --base <sha> --test <file>   # a named test must fail at base
```

## Test sensitivity: a test that cannot fail

A test that passes whether or not the code it names is present proves nothing. `scripts/check-test-sensitivity.sh`
applies one small mutant per sidecar in a copy of the tree, runs only the named test, and fails when the test
still passes. Sidecars live in `server/test/sensitivity/<name>.json`.

```json
{
  "name": "price-gate-tolerance",
  "target": "dist",
  "production": "server/test/eval-release/plan.ts",
  "compiled": "dist/test/eval-release/plan.js",
  "build": ["tsconfig.eval.json"],
  "assets": [["server/test/eval-release/judge-prompt.md", "dist/test/eval-release/judge-prompt.md"]],
  "mutant": {"find": "    if (delta > PRICE_CONFIRM_TOLERANCE) {", "replace": "    if (false) {", "note": "the 20 percent comparison is removed"},
  "command": ["node", "--test", "--test-name-pattern", "a confirmation outside the tolerance refuses", "dist/test/eval-release/price.test.js"],
  "workdir": ".",
  "env": {"DIDI_EVAL_SOURCE_ROOT": "server"},
  "test": {"file": "server/test/eval-release/price.test.ts", "name": "a confirmation outside the tolerance refuses"},
  "note": "the price gate test has to execute the gate, not read a CLI exit code"
}
```

- `target` is `dist` (build the tsconfig, copy the compiled tree into the git-ignored `server/eval-out/`, apply the
  mutant to `compiled`, and run `command` from `workdir`) or `tree` (copy the tracked tree to a temp directory,
  apply the mutant to `production`, and run `command` there).
- `mutant.find` must appear exactly once in the file it is applied to. A mutant whose anchor moved is a failure,
  never a pass: the sidecar has to be updated with the code it guards.
- The unmutated test must pass first, and its name must appear in that run's output. A test that never ran cannot
  feel a mutant, which is the second escaped class this guards.
- A sidecar whose `test.file` is absent from the tree is reported `SKIP` (the clean-quit sidecar belongs to the
  combined release tree); `--require-all` turns a skip into a failure. `--only <name>` runs one sidecar.

The three shipped sidecars cover the escaped classes: a clean-quit timing assertion (`clean-quit-fixed-delay`),
the 20 percent price gate (`price-gate-tolerance`) and the live dispatch registration
(`live-authority-registration`). `--selftest` runs the runner's own fixtures: a test that cannot fail must be
reported, and one that can must pass.

Both scripts write their Markdown summary to the path in `DIDI_CHECK_SUMMARY` so the overnight run can attach it.
Nothing in either script reads the network.

## The combined-tree gate

A wagon gate sees one branch. Two wagons can each be green and their merge red, because a check's staging list or
a Swift compile unit never learned about a file the other wagon added. `scripts/check-combined-tree.sh <base> <head>`
runs on the combined tree:

```bash
bash scripts/check-combined-tree.sh origin/main release/10.7            # static passes, then the check union
bash scripts/check-combined-tree.sh origin/main release/10.7 --static   # static passes only
```

- `config/check-map.json` maps path globs to check scripts. `--selftest` proves every path under `server/`,
  `Sources/`, `Tests/`, `web/`, `docs/`, `config/` and `scripts/` matches at least one entry and that every
  `scripts/check-*.sh` is named by one. The map is coarser than the truth on purpose: a change runs the union of
  its area's checks, one at a time.
- The staging pass reads each check script's `cp <src> "$out/source/..."` lines and the TypeScript import graph of
  the staged entry files, and fails naming the changed file a staging list does not carry.
- The Swift pass reads each `swiftc ... <files>` compile unit and fails when a unit uses a top-level type a changed
  file declares and does not compile that file.
- When `Sources/` changes, the plist pass renders the LaunchAgent plist from the app's own writer at a fixed
  synthetic time (`NativeAlarmRelaunch.plist(startMs: 1800000000000, ...)`), runs `plutil -lint` and a key
  whitelist (`Label`, `ProgramArguments`, `RunAtLoad`, `StartCalendarInterval`, whose keys are `Minute`, `Hour`,
  `Day`, `Weekday`, `Month` only). A `Year` key is rejected: launchd ignores it. The pass never calls launchctl.

Both static passes read the head tree out of git, so any pair of shas replays from any worktree without a
checkout. The check summary is Markdown: check, rc, duration and the last failing test.
