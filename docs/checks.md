# Checks

Every check is a script in this repository, and you run the ones that cover your change locally, one at a time (they share one machine and several take the single browser slot). Each script exits non-zero on failure and prints what it ran. Read the header comments of a script for its exact boundary.

CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) runs the Linux part of the release gate on every pull request into main, through `scripts/ci-gauntlet.sh --ci`. [What CI runs and what stays local](#what-ci-runs-and-what-stays-local) says which check is which, and why.

Rules that apply to all of them:

- Fakes and synthetic fixtures only. No real account, credential, provider call, voice hardware or owner data.
- A check that cannot run says so (a `CHECK BLOCKED` line and a non-zero exit) and is never read as a pass.
- Run the checks that cover what you changed, not all of them. Do not run unit tests by hand for their own sake.
- Browser-backed checks run under `lux-browser-slot run` (a lease on the shared GPU renderer; it is not an npm dependency and exists only on a managed host). Without it those checks are blocked, not skipped.
- Most server checks copy the exact sources they cover into a temporary directory and compile there, so a stale `dist` can never make them pass.

## Memory discipline

Every Swift compile in this repository is serialized. Each `swiftc` invocation passes one
compiler job (`-j 1 -num-threads 1`, declared once per script in a `swift_serial` flag set) and
runs as `scripts/with-compile-lock.sh -- swiftc ...`. The wrapper takes one exclusive lock on the
per-user path `${LUX_COMPILE_LOCK:-$HOME/.lux/state/compile.lock}`, starts the compiler only once
it holds that lock, and the lock lives exactly as long as the compiler process. One compiler at a
time per user on the machine is what stops three parallel lanes from each fanning a frontend out
per core and eating the Mac's memory. Set `LUX_COMPILE_LOCK` to move the lock path, and a script
that invents its own `HOME` pins `LUX_COMPILE_LOCK` to the real user path before it does. Test
binaries run outside the lock: only the compiler is inside it.

## The release gate

Before a release, run these twelve at the release head, one at a time, with no rerun on a flake: `check-live-voice`, `check-live-session`, `check-prompt`, `check-live-gateway`, `check-tool-owner`, `check-google-connector`, `check-company-connectors`, `check-native-live`, `check-web-unit`, `Tests/DidiMacTests/check-mac.sh`, `check-host`, `check-install-smoke`. `bash scripts/ci-gauntlet.sh` runs exactly that list, in that order, one at a time, then `check-package`; CI runs the same script with `--ci`.

## What CI runs and what stays local

Nine of the twelve need nothing macOS: they install from the npm cache, compile TypeScript, and run node test files. Those nine are the gate CI reproduces, in this order:

`check-live-voice`, `check-live-session`, `check-prompt`, `check-live-gateway`, `check-tool-owner`, `check-google-connector`, `check-company-connectors`, `check-web-unit`, `check-install-smoke`.

`check-package` is the tenth check CI runs. It packs the service from a clean `git archive`, installs the tarball offline into an empty cache and runs the package tests, so it needs `git`, `npm`, `tar` and `node` and no macOS tool. It is not one of the twelve above, and the gauntlet runs it last because it builds and reinstalls the whole service.

The three that stay local, and the reason from the script itself:

| Check | Why it cannot run on an ubuntu runner |
| --- | --- |
| `check-native-live` | compiles Swift with `xcrun swiftc` under `scripts/with-compile-lock.sh` and builds the app bundle with `scripts/build-macos-app.sh` |
| `Tests/DidiMacTests/check-mac.sh` | compiles `Sources/LuxDidi/*.swift` and `Tests/DidiMacTests/main.swift` with `xcrun swiftc`, then runs the binary |
| `check-host` | takes the `lux-browser-slot` lease on the shared GPU renderer and drives `server/test/host-browser.mjs`; without that lease the check is blocked, not skipped |

A gate check that runs past twenty minutes is a defect; the CI job is under fifteen in practice and fails on the job timeout at twenty.

`check-mcp` needs no macOS tool either, so it could run on ubuntu, but it is not a gate check and CI does not run it: it covers the MCP connector surface and belongs to a change that touches that connector.

After installing the app, run `scripts/smoke.sh` once (it makes at most two real model turns, so never in a loop).

## Rules that stop green-but-broken

Release 8 shipped four live failures with every test green: an untested tool entry, a Trello call to a route the vendor does not publish, a connector refused after install, and host notes the model read as the owner's words. Each rule below names its trigger and the action it costs.

- A tool is new or changed: it joins the registry-wide intent test (`server/test/intent-tools.test.ts`) and the real-host integration matrix under its own name, never through a sibling tool.
- A transport calls an external API: it validates every outbound method and path against a pinned vendor-published spec, checked in under `server/test/fixtures/specs/` with its retrieval URL and date, and an agent-written extract is never a source.
- A guard judges the owner's words: test it with the ask split across two finalized owner turns.
- A refusal or a gate gets a test: pair it with a test that the valid case passes.
- Host-originated text moves toward the model: it carries the host-note mark (`[host note, not the owner]`) at the wire frame, never an unmarked user turn, and `server/test/wire-envelope.test.ts` lists every emitter so a new one cannot reach the model unregistered.
- Per-turn state is added (admission, budgets, ledgers): add a two-turn reset test.
- An install is declared done: `scripts/run-installed-checks.sh` passes on the installed bundle, and that script fails when zero checks ran (the script arrives with the release 9 install gate).
- A test looks wrong against new code: never edit the test to match the code, and an accepted assertion changes only under a ruling that names it.

## Server and host

| Script | Covers |
| --- | --- |
| `check-service.sh` | Type-check and build; runtime store and HTTP tests (`runtime.test`, `http.test`). |
| `check-host.sh` | Build, then host, HTTP, stdout-protocol, connector publication, connector recovery, host-log and Trello guidance tests, the `host-compose-wire` suite that proves the write path through the real host composition (the shipped `draft_email`, `draft_chat`, `create_event` and `delete_event` tools, their closed wire arguments, the `google_identity` consent probe and the `connector_not_authorized` answer), the `--mongoose-login` CLI sign-in (`mongoose-login.integration.mjs`), then the shipped UI against a real host in the browser. Fails on any `console.log` in server source. |
| `check-host-entry.sh` | Host entry migration and reopen ring (`host-entry.test.mjs`). |
| `check-domain.sh` | Domain and provenance tests against a temporary SQLite database. |
| `check-chat.sh` | Text chat, chat tools, prompt, model, runtime, domain and HTTP regressions. |
| `check-memory-context.sh` | Explicit selected local memory: memory-context tests plus chat, connected-authorization, domain and provenance regressions. |
| `check-model.sh` | The portable model adapter (`model.test`). |
| `check-provider-config.sh` | Provider profile validation (`provider-config.test`). |
| `check-credential-binding.sh` | Credential binding across provider config, model, live voice, prompt, remember, declarations and Mongoose auth. |
| `check-package.sh` | Builds the service package from a clean `git archive` and runs `package.test`, including the assertion that every module the host imports is in the tarball. Needs committed `server/` source. In the [release gate](#the-release-gate) and in CI. |
| `check-api-response.sh` | The request boundary in a real browser against a real service (`api-response-browser.mjs`). |
| `check-archive-scale.sh` | Synthetic owner-cost assessment of a large archive. Not a performance gate. |

## Live voice and the research layer

`history_exclusions` and session kinds (F2): a live session's kind is the prefix of the idempotency key it was
created under, and `liveSessionKindOf` reads it back from the store. An unmarked key is the owner's own call; a
`canary:` key names the installed canary, and `eval:` or `test:` name a typed eval or test harness. A marked
session is never owner memory: it schedules no summarizer run, its `conversation_summaries` row is never an
injection candidate for `buildOpeningOptions` or the earlier-conversations section, and `history-reader` skips
both its summaries and its turns in `history_turns`. Rows already in an owner store stay untouched: they are
filtered on read, so removing them is an owner decision and never a check or a migration.

| Script | Covers |
| --- | --- |
| `check-live-voice.sh` | Provider adapters: `live-voice`, `openai-live-voice`, `resample` tests. |
| `check-live-session.sh` | The call core: session, mute, continuity, resumption, recovery, watchdog, summary, selection, memory note, warm context, vault write, stop-phrase gate, trace store, voice fault replay, `naya-logs`, the research suites for continuation, knowledge, steps and web, and the C-LIVE replay eval `partial-research-turn-contract-replay` (one research operation per owner turn, the bounded operation, coverage rows). |
| `check-live-gateway.sh` | The loopback Live gateway with chat, host, HTTP, open-actions and prompt regressions. |
| `check-prompt.sh` | Prompt composition, the Live persona, runtime context and the research suites (`research`, calendar, mail query, routed, shape, web). It also runs `server/test/prompt-content.integration.mjs`, which compares the shipped instruction byte for byte against `server/test/fixtures/prompt-final.json` and pins the accepted character hash. This is where triage, topic, routing and the 2,500 character reply cap are pinned, and the Trello tool descriptions (`server/test/trello-guidance.test.ts`). |
| `check-tool-owner.sh` | The tool owner, Live tool shape and redaction (`tool-owner`, `live-shape`, `redact` tests), and the open destinations: the shared table both allowlists answer, their host parity, Gmail, Calendar and Drive handles, and the open evals E1 to E9 replayed host side (`open-destinations` test). It also covers the owner-only write asks: the `create_event` length declaration beside its validator, a calendar ask answered after the model's own question (granted once, only inside the 120 s window), an explicit retry claim only held against a refused write, and a refused call's own rule names in the `tool_arguments_rejected` line, never its text. The argument normalizer's cases in the `tools-builtin-intent` suite prove the twelve-key person read dispatches, that a wrong value of a key the intent reads still refuses with every violation at once, and that `tool_arguments_rejected` carries a `path:keyword` per violation and no value, with dropped keys on their own `tool_arguments_normalized` event. |

## Connectors and MCP

| Script | Covers |
| --- | --- |
| `check-knowledge-connector.sh` | Lux Knowledge reader (`knowledge-connector.test`). |
| `check-google-connector.sh` | Gmail, Calendar and Drive readers against a stdio MCP fixture, and the Google helper wiring guard. |
| `check-company-connectors.sh` | Mongoose and Mattermost readers, Mongoose auth and the Mattermost attention scan, against fixtures, and the Mongoose sign-in contract: the real host login against a synthetic Mongoose (`server/test/mongoose-contract-fake.ts`) that enforces the server's own OAuth rules, with the discovery shape captured from the live server (`server/test/fixtures/mongoose-discovery.json`). It also runs the Trello board (`server/test/trello-board.test.ts`) against a synthetic Trello MCP server and authorization server on two loopback origins (`server/test/trello-fake.ts`). |
| `check-mcp.sh` | The HTTP MCP adapter (`mcp.test`). |
| `check-mcp-stdio.sh` | The stdio MCP transport against a child fixture. |
| `check-mcp-config.sh` | Protected MCP configuration and consent (`mcp-config.test`). |
| `check-connected.sh` | Connector identity and status, and the connected conversation in a real browser. |

## Evals

| Script | Covers |
| --- | --- |
| `check-evals.sh` | The eval harness self-test in scripted mode only (`docs/evals.md`): the tool catalogue, the fake world, the real alarm scheduler on a virtual clock, the recording sink, the guards, and the deterministic scorer. All 118 public cases either `PASS` or report `EXPECTED_RED` with their reason, and a deliberately broken answer fails. No model call, no network, no audio. Release pull requests only. |
| `eval-release.sh` | Tier 2 (`docs/evals.md`): the real realtime adapter in text mode over a loopback fake provider. `--dry-run` prints the plan and the price, `--fake-model` replays recorded synthetic turns, `--real` refuses without a matching `--confirm-price`. |
| `eval-audio-probe.sh` | Tier 2b: a synthetic utterance through the adapter's upload path, provider audio counted and dropped, no audio device. |
| `eval-mutation-probe.sh` | Honesty probe (a): each known mutation of the guarded eval code makes the self-test fail. |
| `check-test-sensitivity.sh` | Honesty probe (b): each sidecar in `server/test/sensitivity/` mutates one production file in a copy of the tree and proves the named test fails under it. Skipped sidecars whose test is absent from this tree are reported, never counted as passes (`--require-all` refuses). `--selftest` covers the runner with a test that cannot fail and one that can. See `docs/evals.md`. |
| `check-combined-tree.sh` | The combined-tree gate for a release branch: `<base> <head>` maps every changed file through `config/check-map.json` to its check scripts and runs the union one at a time, and two static passes fail when a check's staging list or a Swift compile unit misses a changed file its target imports. Renders the LaunchAgent plist from the app's writer and lints it with a key whitelist when `Sources/` changes. `--static` runs the two static passes alone; `--selftest` proves the map, both static passes and the plist validator. The extractors read literal text: a `cp <src> "$out/source/..."` staging line and a `swiftc ... <files>.swift` compile unit. A check that stages through a variable or a helper, or builds with `swift build`, is named in a `STATIC WARN` line and is not extracted; that warning never fails the gate by itself. |
| `red-at-base.sh` | Honesty probe (b): a named test must fail at a base commit. |

| `check-live-boundary.sh` | The live-boundary evals (`docs/evals.md`): the scenario files and the phrasing corpus driven through the production live session and its dispatch path, with only the provider transport and the connector I/O replaced. Prints `PASS` / `EXPECTED_RED` / `FAIL` per scenario, then the per-kind false-refusal usability gate and the injection and noncommand safety gate. `EXPECTED_RED` names the base defect it waits on and never counts as a pass; the release train runs it with `--release-gate`. No model call, no network, no audio, about fifteen seconds. |

`scripts/run-local-evals.sh` is the owner's own run and is not a check: scripted by default, `--live` only
with `--yes`, and the full private suite never leaves the owner's machine.

The eval harness is a developer tool, never a production unit. `server/eval/` has its own TypeScript
project (`server/tsconfig.eval.json`, extending `server/tsconfig.json`) and is not in the production
`include`, so the service build never carries it: `server/test/host.test.ts` still sees exactly the
production roots, and `check-host.sh` excludes exactly `server/eval/` from its `console.log` scan because
none of that code can reach the supervised stdout. That exclusion holds only while nothing production-side
imports it, so `check-host.sh` also fails if any non-`test/`, non-`eval/` source imports from `server/eval/`.

## Web

| Script | Covers |
| --- | --- |
| `check-web-unit.sh` | Builds the web bundle, then the headless suites: autoscroll, chat turn, connected, connector status, layout, live view, markdown, mini page, next steps, orb motion, orb parity, orb states, settings, tool phrases, UI hierarchy, vault card, memory list. |
| `check-native-conversation.sh` | Mini orb route unit test, then page selection and run discovery in a real browser. |
| `check-selected-memory-ui.sh` | Selecting stored notes for the next message, in a real browser. |

## Native (Swift)

| Script | Covers |
| --- | --- |
| `check-native-live.sh` | Strict Swift 6 compile and the Live tests: audio owner, callback bridge, playback scheduling, mute race, mic mode, presence, orb envelope, connecting ring, launch visibility, wait cue, native actions (the shared destination table and the Chrome or default browser choice), bridge, journal, voice processing, and the first-buffer watchdog (`MicWatchdogTests.swift`: a started engine with no tap buffer in 1 s logs `audio_input_stalled`, restarts once without voice processing, then fails as `engine_failed`) with its host guard (`live-recovery.test.ts`, run by `check-live-session.sh`: a provider session that expires with zero owner audio ends `audio_input_dead` instead of rebuilding). |
| `check-pending-request.sh` | The pending request store that survives a native restart. |
| `Tests/DidiMacTests/check-mac.sh` | Compiles the app shell into a disposable bundle, signs it ad hoc, verifies it, then runs the native proofs in `main.swift` (surfaces, presentation coordinator, launch kinds, shortcuts, Getting started, the confirm panel) and a real-host proof. Takes the browser slot for its launch phase. |
| `Tests/DidiCompanionTests/check-companion.sh` | Companion and real-host proofs, including keychain, lifecycle and credential proofs, and `window.confirm` reaching the native panel through WebKit. Takes the slot. |
| `Tests/DidiCompanionTests/check-launch-services-probe.sh` | Launch through LaunchServices with bundled Node and no external descriptor. |
| `Tests/DidiCompanionTests/check-real-host.sh` | The built app against a real host: takes the app bundle, a proof directory and a node path as three required arguments. Takes the slot. |

## Build, install and bundle

| Script | Covers |
| --- | --- |
| `check-asset-bundle.sh` | The asset-only bundle: a planted bad bundle must be refused first (so green is never vacuous), then the real bundle is built and verified. |
| `check-install-smoke.sh` | The install research smoke (`server/test/smoke/install-research-smoke.mjs`) against the repo build: a synthetic mail endpoint with every fetch intercepted, both research paths (the scheduler and a live tool call) started from arguments derived from the tool's declared input schema. The installer runs the same file against a bundle, so a newly required input field fails here instead of at install. |
| `check-macos-install.sh` | Composes the real app, drives it through LaunchServices, and checks signatures, artifact hygiene, the configure matrix and install with rollback. Takes the slot. |
| `test-npm-offline.sh` | The offline npm install helper fails loud on an empty cache and is a pure swap on a warm one. |

## Not checks, but useful

- `scripts/smoke.sh`: real-path smoke run, described in [local-development.md](local-development.md).
- `scripts/naya-logs.mjs` and `scripts/didi-timeline`: read the logs and trace store ([debugging.md](debugging.md)).
- `scripts/probe-gpt-live.mjs`: manual probe of the OpenAI Live socket with a private config path. Uses a real provider; do not run it in a check.
- `scripts/backlog_validate.py`: validates the historical planning backlog in `planning/`. It does not test the product.
- `scripts/warm-npm-cache.sh`, `scripts/npm-ci-offline.sh`: fill and use the offline npm cache that several checks need.
- `scripts/ci-gauntlet.sh [--ci]`: the release gate in one command, in the order listed above, stopping at the first failure. `--ci` is the nine that need no macOS, which is what CI runs.

## Installed alarm smoke

| Check | Evidence |
| --- | --- |
| `scripts/check-installed-alarm.sh [app target]` | Runs the four alarm tools, stub-clock delivery, fake-shell frames and alarm setup against packaged host modules, with synthetic state and no audio or app launch. With no target it stages an offline package; an explicit target never falls back to the checkout. The installed-check discovery runner finds this script automatically. |

## Installed real-provider canary (opt-in, paid)

`scripts/run-installed-canary.sh <installed-target>` runs separately AFTER relaunch,
against the running installed app. It is not part of `scripts/run-installed-checks.sh`,
which the install helper runs while the app is down. This is an explicit exception to the fake-only local/CI
rule above: **only the installer/operator runs the paid path after installation**. Author
and reviewer checks use recorded fake sessions. Do not launch or relaunch the app for this
check. The already-running shell must be the exact bundle named by `<installed-target>`.

The opt-in file is **outside this public repository** at `~/.lux/didi-canary/asks.json`.
Never commit it, its real names, or its results. Start from the synthetic
[`scripts/fixtures/canary-asks.example.json`](../scripts/fixtures/canary-asks.example.json),
replace the placeholders locally, and choose the actual canonical tool names exposed by
your configured connectors. The example is not a real account corpus. The format is:

```json
[
  {
    "id": "alarm-split",
    "finals": ["Set an alarm", "in two minutes"],
    "expect": {"tool": "set_alarm", "codeClass": "success", "nonEmpty": false, "sideEffect": "alarm"}
  }
]
```

- Use 1 to 15 unique, safe `id` values. `finals` holds 1 to 8 owner finals per ask,
  including speech-recognition splits. Finals are injected unchanged through the existing
  typed-owner-text path, with `finalOrigin === 'typed'`; they are not a prompt quoting an ask.
- `expect.tool` names the actual tool, including a source tool called inside research,
  not just the model's prose or a guessed connector name. `codeClass` is `success`.
  `nonEmpty` requires data in the tool's own reply. Successful typed read-data envelopes
  report `code=data`; explicit error/refusal fields always fail. A stored `completed`
  outcome never converts a refusal into a pass.
- Optional `sideEffect` is `alarm`, `open`, or `note`. Alarms must exist as a pending row
  belonging to a tool call in this canary session, then be cancelled. Opens must receive a
  matching acknowledgement from the production native transport. The shell's host-only
  `canary_ack` action returns before all URL, workspace, window and focus operations.
- The active save tool is `stage_lux_note`, not the retired `remember_note`. Use a clearly
  synthetic note. Its remote insight ID must match a confirmed `vault_writes` row for this
  session. Cleanup reads that exact insight, archives it through the configured local
  lux-knowledge endpoint, and verifies it in the archived list. Missing or failed cleanup
  fails the ask. No arbitrary model-provided insight ID can authorize deletion.

Before any paid work, the script reads `logs/host.log` under `LUX_DIDI_DATA_DIR` (default:
`~/Library/Application Support/ai.peat.lux-didi`), using the host's structured
start/terminal receipts. A live call is refused **even if the asks file is absent**. The
host also checks its authoritative active-session rows, closing the preflight race.
Only an absent asks file prints `CANARY SKIP reason=private_ask_file_absent` and exits 0.
Invalid JSON, unreadable files, a busy call, an unavailable shell/provider, a timeout,
missing data, a refusal or failed cleanup are failures, never skips.

The script writes one private request containing only a nonce, bundle target and deadline.
The already-running shell claims it and uses its existing bearer authority to open one
host session, then attaches its real `LiveSocketTransport`. No credentials or asks are
copied into the request. The host-side session registry alone selects canary native mode;
model arguments and tool result properties cannot enable it. The normal configured voice
provider is used, not a fake provider or a fake native client. There is no capture device
or microphone input. Providers that produce audio on text turns keep that normal output
path; the native transport decodes and discards that audio rather than playing it.

The host runs at most 15 asks in one session, waits for each provider response and tool
work to settle, and taps raw own tool replies at the canary-only provider-session boundary rather than
stored outcome labels. Normal sessions keep their exact original object and event iterator. Each
ask has a 25-second turn bound. A request-wide 350-second deadline revokes the session;
cleanup has an 8-second bound, and the script has a hard six-minute outer deadline.
It prints only `CANARY PASS|FAIL id=<id> tool=<tool> code=<code> ms=<ms>` plus a summary
with `providerTurns=<count>` measured from standardized `modelTurnStarted` events,
including the opener and recovery generations. This works for both Gemini and OpenAI;
it does not assume that Gemini emits OpenAI trace-response receipts. A native/transport
failure before the host can return its count explicitly reports `providerTurns=unknown`
and fails; it is not reported as zero paid usage or a pass. Any failed ask exits 1.

`scripts/check-host.sh` exercises the actual CLI's absent-file and busy-call paths in
private temporary homes, the recorded-session runner and failure classes with fakes,
and, on macOS, a lock-compiled native proof that acknowledgement never invokes the
workspace opener and text-only attachment rejects an ordinary session. Linux CI runs
the same fake assertion/CLI tests without Swift or real services. The broader native
regression gate remains `scripts/check-native-live.sh`; documentation uses
`scripts/check-docs.sh`.

### Stop alarms without a call

The owner-local native bearer endpoint `POST /api/v1/alarms/stop` accepts an
empty JSON object. It cancels all pending and ringing alarms through the host
scheduler, including when no live call exists. Browser clients are refused.
Use the host's existing native bearer authorization with this endpoint; never
put the bearer in a committed script, issue, or diagnostic report. A successful
reply includes the number of cancelled alarms. It does not quit the app.

### Recurring reminders

A reminder can repeat daily, on weekdays or on a weekly weekday set ("every
Saturday at ten remind me to do one hour of cardio"); `set_alarm` reads the rule
from the owner's own words, `list_alarms` shows the rule and its next occurrence,
and `cancel_alarm` cancels one occurrence ("skip this Saturday") or the whole
series ("stop the Saturday cardio reminders"). The series keeps the timezone it
was said in, so travel or a host timezone change never moves it. The stop
endpoint above also cancels every active series: it cancels the series row
(never a silent row delete) together with the ringing and pending occurrences,
so a stopped series is gone from `list_alarms` until the owner asks again.

### Latency budget

`scripts/check-latency-budget.sh` replays a plain turn, a one-tool turn, a two-tool batch and a silent
continuation through the real host path, with a fake realtime transport and a fake connector carrying
recorded synthetic timings, and judges every host-side segment against `config/latency-budgets.json`.
Each budget is the recon's measured p50 for that segment plus a margin and says so in its `basis`. The
eval prints each segment with its budget and fails only on a breach, a missing segment or a missing
receipt. Its last step slows every fake by eight and requires a breach, so a gate that cannot fail is
itself a failure. No network, no model, well under two minutes.
