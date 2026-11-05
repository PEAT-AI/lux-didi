# Checks

Every check is a script in this repository, and you run the ones that cover your change locally, one at a time (they share one machine and several take the single browser slot). Each script exits non-zero on failure and prints what it ran. Read the header comments of a script for its exact boundary.

CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) runs the Linux part of the release gate on every pull request into main, through `scripts/ci-gauntlet.sh --ci --group <name>` in three parallel jobs. [What CI runs and what stays local](#what-ci-runs-and-what-stays-local) says which check is which, and why, and [Check inventory](#check-inventory) says which group each one runs in.

Rules that apply to all of them:

- Fakes and synthetic fixtures only. No real account, credential, provider call, voice hardware or owner data.
- A check that cannot run says so (a `CHECK BLOCKED` line and a non-zero exit) and is never read as a pass.
- Run the checks that cover what you changed, not all of them. Do not run unit tests by hand for their own sake.
- Browser-backed checks run under `lux-browser-slot run` (a separately installed browser concurrency prerequisite, not an npm dependency). Without it those checks are blocked, not skipped.
- Most server checks copy the exact sources they cover into a temporary directory and compile there, so a stale `dist` can never make them pass.

## Memory discipline

Every Swift compile in this repository is serialized. Each `swiftc` invocation passes one
compiler job (`-j 1 -num-threads 1`, declared once per script in a `swift_serial` flag set) and
runs as `scripts/with-compile-lock.sh -- swiftc ...`. The wrapper takes one exclusive lock on the
per-user path `${LUX_COMPILE_LOCK:-$HOME/.lux/state/compile.lock}`, starts the compiler only once
it holds that lock, and the lock lives exactly as long as the compiler process. One compiler at a
time per user on the machine is what stops several builds from each fanning a frontend out
per core and eating the Mac's memory. Set `LUX_COMPILE_LOCK` to move the lock path, and a script
that invents its own `HOME` pins `LUX_COMPILE_LOCK` to the real user path before it does. Test
binaries run outside the lock: only the compiler is inside it.

## The release gate

Before a release, run these thirteen at the release head, one at a time, with no rerun on a flake: `check-live-voice`, `check-live-session`, `check-prompt`, `check-live-gateway`, `check-tool-owner`, `check-google-connector`, `check-company-connectors`, `check-native-live`, `check-web-unit`, `Tests/DidiMacTests/check-mac.sh`, `check-host`, `check-install-smoke`, `check-helper-provider`. `bash scripts/ci-gauntlet.sh` runs exactly that list, in that order, one at a time, then `check-package`; CI runs the same script with `--ci` on every pull request into `main`, so this fixed list is the pull request gate. It sees only the checks it names; the combined-tree gate below sees every file the branch changed.

`bash scripts/check-combined-tree.sh <base> <head>` is the release gate: it maps every file the branch changed to its checks and runs that union at the head, so a release never ships a file no check covers.

## What CI runs and what stays local

Nine of the thirteen need nothing macOS: they install from the npm cache, compile TypeScript, and run node test files. Those nine are the gate CI reproduces, in this order:

`check-live-voice`, `check-live-session`, `check-prompt`, `check-live-gateway`, `check-tool-owner`, `check-google-connector`, `check-company-connectors`, `check-web-unit`, `check-install-smoke`.

`scripts/check-combined-tree.sh --selftest` proves the release gate's own bookkeeping on three
fixture checks: one passes, one fails, one prints `CHECK BLOCKED`, and the blocked one is counted
apart from the failed one while both still fail the gate.

`check-package` is the tenth check CI runs. It packs the service from a clean `git archive`, installs the tarball offline into an empty cache and runs the package tests, so it needs `git`, `npm`, `tar` and `node` and no macOS tool. It is not one of the thirteen above, and the gauntlet runs it last because it builds and reinstalls the whole service.

### Check inventory

Those ten run in three parallel jobs, one per group below. Each group is its own runner, so ports and artifact directories cannot collide, and the matrix runs with `fail-fast: false`, so one CI run reports a red in every group instead of only the first. A group runs every check it owns before it reports, so a second red in the same group is never hidden either. `--group <name>` is how the workflow asks for one group; running the script with no group still walks the whole gate in release order and stops at the first red. `server/test/ci-gate-groups.mjs` asserts that the ten checks are exactly the union of the three groups, so a check can neither drop out of CI nor be counted twice.

| Check | Group | What it proves |
| --- | --- | --- |
| `check-live-gateway` | gateway | the real Live socket admits one owner, forwards audio frames and survives a reconnect |
| `check-live-session` | session | a real Live session round trip: connect, greet, answer, close |
| `check-live-voice` | session | voice capture and playback against the synthetic device, with no real hardware |
| `check-prompt` | other | the prompt builder's context, budget and owner-data boundaries |
| `check-tool-owner` | other | the owner's own tools dispatch through the real registry |
| `check-google-connector` | other | the Google connector's synthetic fixture round trip |
| `check-company-connectors` | other | the company connectors' synthetic fixture round trip |
| `check-web-unit` | other | the web unit suite |
| `check-install-smoke` | other | the assembled install serves and answers after install |
| `check-package` | other | the packed service installs offline from a clean `git archive` and passes its tests |

`ci-success` is the one status a branch protection can require: it needs the gate job and passes only when its result is `success`, so a failed, cancelled or blocked leg fails `ci-success`.

The four that stay local, and the reason from the script itself:

| Check | Why it cannot run on an ubuntu runner |
| --- | --- |
| `check-native-live` | compiles Swift with `xcrun swiftc` under `scripts/with-compile-lock.sh` and builds the app bundle with `scripts/build-macos-app.sh` |
| `Tests/DidiMacTests/check-mac.sh` | compiles `Sources/LuxDidi/*.swift` and `Tests/DidiMacTests/main.swift` with `xcrun swiftc`, then runs the binary |
| `check-host` | takes the `lux-browser-slot` lease on the shared GPU renderer and drives `server/test/host-browser.mjs`; without that lease the check is blocked, not skipped |
| `check-helper-provider` | sends one real request to the owner's configured provider with the owner's own credential, which an ubuntu runner does not have; with no provider configuration it prints SKIP |

A gate check that runs past twenty minutes is a defect; the CI job is under fifteen in practice and fails on the job timeout at twenty.

### Every check in the map

`config/check-map.json` maps changed paths to check scripts. The table below records their prerequisites. These are code-derived requirements, not fresh performance measurements. Consult the script for its current suite list.

| Check | Group | Platform | Prerequisites |
| --- | --- | --- | --- |
| `check-evals` | - | Linux-portable | server `node_modules` installed in this worktree; refuses a symlinked one |
| `check-prompt` | other | Linux-portable | server TypeScript and `@types/node` installed |
| `check-live-voice` | session | Linux-portable | built server and the local provider fixtures |
| `check-live-session` | session | Linux-portable | built server and the live suites' local provider adapters |
| `check-model` | - | Linux-portable | server TypeScript and `@types/node` installed |
| `check-host` | - | Mac only | Swift toolchain, a built app bundle and the `lux-browser-slot` lease |
| `check-helper-provider` | - | Mac only | the owner's configured provider directory and its credential, plus a built server `dist` |
| `check-host-entry` | - | Linux-portable | a clean committed tree and a built `dist` |
| `check-service` | - | Linux-portable | `npm ci` in `server` |
| `check-connected` | - | Linux-portable | the renderer lease and a built server and web |
| `check-archive-scale` | - | Linux-portable | Node 26 or newer, `node_modules`, and an output path it writes |
| `check-api-response` | - | Linux-portable | the renderer lease, installed server and web dependencies, built `dist` |
| `check-live-gateway` | gateway | Linux-portable | built server and the local provider fixture |
| `check-domain` | - | Linux-portable | `npm ci` in `server` |
| `check-memory-context` | - | Linux-portable | server build and `git` |
| `check-knowledge-connector` | - | Linux-portable | built server |
| `check-chat` | - | Linux-portable | built server |
| `check-provider-config` | - | Linux-portable | built server |
| `check-credential-binding` | - | Linux-portable | built server and `git` |
| `check-tool-owner` | other | Linux-portable | installed TypeScript, Node types and the MCP SDK |
| `check-google-connector` | other | Linux-portable | a verified TypeScript, Node types and MCP SDK assembly |
| `check-company-connectors` | other | Linux-portable | a verified TypeScript, Node types and MCP SDK assembly |
| `check-mcp` | - | Linux-portable | npm dependencies for the MCP surface |
| `check-mcp-stdio` | - | Linux-portable | a verified TypeScript, Node types and MCP SDK assembly |
| `check-mcp-config` | - | Linux-portable | a verified TypeScript, Node types and MCP SDK assembly |
| `check-dispatch-gate` | - | Linux-portable | installed TypeScript, Node types and the MCP SDK |
| `check-test-sensitivity` | - | Linux-portable | `python3`, `tsc` and `git`; writes mutated copies and runs them |
| `check-latency-budget` | - | Linux-portable | npm dependencies and its budget test |
| `check-live-boundary` | - | Linux-portable | server TypeScript and `@types/node` installed |
| `check-native-live` | - | Mac only | `xcrun swiftc` under the compile lock and a built app bundle |
| `check-native-conversation` | - | Mac only | a built macOS app, the renderer lease and `git` |
| `check-macos-install` | - | Mac only | Swift toolchain, `codesign`, the installed-app paths and the renderer lease |
| `check-install-smoke` | other | Linux-portable | `npm` and `node` only |
| `check-installed-alarm` | - | Mac only | the Swift toolchain and the installed app's shipped runtime |
| `check-installed-connectors` | - | Mac only | the installed app and its shipped runtime |
| `check-installed-open-web` | - | Mac only | the built app and the Swift toolchain |
| `check-pending-request` | - | Mac only | the Swift toolchain only |
| `check-package` | other | Linux-portable | `git`, `npm`, `tar`, `node` and an empty npm cache for the offline install |
| `check-selected-memory-ui` | - | Linux-portable | the renderer lease and a built server and web |
| `check-asset-bundle` | - | Linux-portable | `git`, `node` and the asset-bundle build scripts |
| `check-web-unit` | other | Linux-portable | web dependencies installed |
| `check-docs` | - | Linux-portable | `node` only; also runs the gate inventory test |
| `check-combined-tree` | - | Mac only for the full union, `--static` is portable | `git`, `python3` and `swift` for the static Swift pass; runs the mapped union |

## Timing

Release time is measured, not estimated, so the next release can say which step moved.

- The gate prints `== pass: <check> (<n>s)` per check and one total, and writes one TSV row per
  check plus a total to `$DIDI_TIMING_FILE` (CI points it at the runner's temp directory and prints
  it in the log step; a local run gets a fresh file in `$TMPDIR` and the script prints its path).
  Columns: `kind`, `name`, `verdict`, `seconds`, where kind is `GATE_CHECK` or `GATE_TOTAL` and
  verdict is `pass`, `failed` or `blocked`. The ten checks this records include `check-install-smoke`,
  so install and startup cost is in the same record as the rest.
- `scripts/check-combined-tree.sh` writes the same shape to `$DIDI_TIMING_FILE` (`COMBINED_CHECK`,
  `COMBINED_TOTAL`) and prints a per-check duration column, a counts row and a total row in its
  Markdown summary. Its record also names what the run was: `COMBINED_HEAD`, `COMBINED_BASE`,
  `COMBINED_SELECTED` (`count` and `names`), one `COMBINED_COUNTS` row each for `pass`, `fail` and
  `blocked`, and `COMBINED_LOAD` `start` and `end`, the machine's one, five and fifteen minute load
  averages. The same facts sit in an HTML comment at the top of the summary. Without the load
  averages a slow check on the shared Mac cannot be told from a busy host.
- The release producers print one `TIME <step> <n>s` line per step and a `TIME total <n>s` line,
  through `scripts/lib/timing.sh`, and append the same steps to `$DIDI_TIMING_FILE` when it is set:
  `scripts/build-asset-bundle.sh` (node runtime, service package, web shell, asset-only),
  `scripts/build-macos-app.sh` (bundle skeleton, native compile, accepted assets, signing),
  `scripts/install-macos-app.sh` (stage copy, swap, installed checks) and `scripts/smoke.sh`
  (dist check, plan, probes). Elapsed seconds come from the shell's `SECONDS`, which is monotonic and
  unaffected by a clock or timezone change.

`check-mcp` needs no macOS tool either, so it could run on ubuntu, but it is not a gate check and CI does not run it: it covers the MCP connector surface and belongs to a change that touches that connector.

After installing the app, run `scripts/smoke.sh` once (it makes at most two real model turns, so never in a loop).

## Rules that stop green-but-broken

Release 8 shipped four live failures with every test green: an untested tool entry, a Trello call to a route the vendor does not publish, a connector refused after install, and host notes the model read as the owner's words. Each rule below names its trigger and the action it costs.

- A tool is new or changed: it joins the typed registry tests and the real-host integration matrix under its own name, never through a sibling tool.
- A transport calls an external API: it validates every outbound method and path against a pinned vendor-published spec, checked in under `server/test/fixtures/specs/` with its retrieval URL and date, and an agent-written extract is never a source.
- An isolated permission check judges the owner's words: test it with the ask split across two finalized owner turns.
- A refusal or a gate gets a test: pair it with a test that the valid case passes.
- Host-originated text moves toward the model: it carries the host-note mark (`[host note, not the owner]`) at the wire frame, never an unmarked user turn, and `server/test/wire-envelope.test.ts` lists every emitter so a new one cannot reach the model unregistered.
- Per-turn state is added (admission, budgets, ledgers): add a two-turn reset test.
- An install is declared done: `scripts/run-installed-checks.sh` passes on the installed bundle, and that script fails when zero checks ran (synthetic state must stay separate from owner state).
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

## Live voice and the helper

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
| `check-live-session.sh` | Call lifecycle, mute, continuity, recovery, summaries, trace storage and helper integration. Consult the script for the exact selected files; older suite names are not a current tool contract. |
| `check-live-gateway.sh` | The loopback Live gateway with chat, host, HTTP, open-actions and prompt regressions. |
| `check-prompt.sh` | Prompt composition, runtime context, persona, tool guidance and the shipped prompt fixture. Assertions must describe the helper rather than the retired voice-directed lookup flow. |
| `check-tool-owner.sh` | Tool schemas, dispatch, result projection and native opening. Task authority is owned by `server/tasks/authority.ts`; legacy assertions alone do not prove its integration. |

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
| `check-evals.sh` | The eval harness self-test in scripted mode only (`docs/evals.md`): the tool catalogue, the fake world, the real alarm scheduler on a virtual clock, the recording sink, the guards, and the deterministic scorer. All 118 public cases either `PASS` or report `EXPECTED_RED` with their reason, and a deliberately broken answer fails. No model call, no network, no audio. Every step is walled with `timeout`, so a step that hangs names itself and fails the check instead of stalling a release (issue #884). Release pull requests only. |
| `eval-release.sh` | Tier 2 (`docs/evals.md`): the real realtime adapter over a loopback fake provider. `--dry-run` prints the plan and the price, `--fake-model` replays recorded synthetic steps (an owner uplink, a delegation, the fixture helper's answer, the spoken transcript), `--real` refuses without a matching `--confirm-price`. |
| `eval-audio-probe.sh` | Tier 2b: a synthetic utterance through the adapter's upload path, provider audio counted and dropped, no audio device. |
| `eval-mutation-probe.sh` | Honesty probe (a): each known mutation of the guarded eval code makes the self-test fail. |
| `check-test-sensitivity.sh` | Honesty probe (b): each sidecar in `server/test/sensitivity/` mutates one production file in a copy of the tree and proves the named test fails under it. Skipped sidecars whose test is absent from this tree are reported, never counted as passes (`--require-all` refuses). `--selftest` covers the runner with a test that cannot fail and one that can. See `docs/evals.md`. |
| `check-combined-tree.sh` | The combined-tree gate for a release branch: `<base> <head>` maps every changed file through `config/check-map.json` to its check scripts and runs the union one at a time, and two static passes fail when a check's staging list or a Swift compile unit misses a changed file its target imports. Renders the LaunchAgent plist from the app's writer and lints it with a key whitelist when `Sources/` changes. `--static` runs the two static passes alone; `--selftest` proves the map, both static passes and the plist validator. The extractors read literal text: a `cp <src> "$out/source/..."` staging line and a `swiftc ... <files>.swift` compile unit. A check that stages through a variable or a helper, or builds with `swift build`, is named in a `STATIC WARN` line and is not extracted; that warning never fails the gate by itself. |
| `red-at-base.sh` | Honesty probe (b): a named test must fail at a base commit. |

| `check-live-boundary.sh` | The live-boundary evals (`docs/evals.md`): the scenario files and the phrasing corpus driven through the production live session and its dispatch path, with only the provider transport and the connector I/O replaced. Prints `PASS` / `EXPECTED_RED` / `FAIL` per scenario, then the per-kind false-refusal usability gate and the injection and noncommand safety gate. `EXPECTED_RED` names the base defect it waits on and never counts as a pass; the release runs it with `--release-gate`. No model call, no network, no audio, about fifteen seconds. |

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
| `check-install-smoke.sh` | Packaged source-read smoke using synthetic mail and intercepted transport. The implementation file `server/test/smoke/install-research-smoke.mjs` retains a legacy filename; it is not a voice tool name. |
| `check-macos-install.sh` | Composes the real app, drives it through LaunchServices, and checks signatures, artifact hygiene, the configure matrix and install with rollback. Takes the slot. When the accepted bundle carries no installed runtime (no bundled Node, or no packed host runtime), it prints `MACOS-INSTALL CHECK BLOCKED` and exits non-zero instead of passing, because an install was never proven. |
| `test-npm-offline.sh` | The offline npm install helper fails loud on an empty cache and is a pure swap on a warm one. |

## Not checks, but useful

- `scripts/smoke.sh`: real-path smoke run, described in [local-development.md](local-development.md).
- `scripts/naya-logs.mjs` and `scripts/didi-timeline`: read the logs and trace store ([debugging.md](debugging.md)).
- `scripts/probe-gpt-live.mjs`: manual probe of the OpenAI Live socket with a private config path. Uses a real provider; do not run it in a check.
- `scripts/backlog_validate.py`: validates the historical planning backlog in `planning/`. It does not test the product.
- `scripts/warm-npm-cache.sh`, `scripts/npm-ci-offline.sh`: fill and use the offline npm cache that several checks need.
- `scripts/ci-gauntlet.sh [--ci] [--group <name>]`: the release gate in one command, in the order listed above, stopping at the first failure. `--ci` is the nine that need no macOS, which is what CI runs. `--group <name>` runs only that group's checks and keeps going after a red, exiting non-zero at the end if any check failed or was blocked; the three groups partition the ten CI checks (see [Check inventory](#check-inventory)).

## Installed alarm smoke

| Check | Evidence |
| --- | --- |
| `scripts/check-installed-alarm.sh [app target]` | Runs the four alarm tools, stub-clock delivery, fake-shell frames and alarm setup against packaged host modules, with synthetic state and no audio or app launch. With no target it stages an offline package; an explicit target never falls back to the checkout. The installed-check discovery runner finds this script automatically. |

## The helper's provider contract (one paid request)

`scripts/check-helper-provider.sh` sends exactly one real request to the owner's configured provider and
proves the whole declared tool set of this build is one the provider accepts. It exists because release
10.12 shipped `read_knowledge.ids` with `uniqueItems` under `strict: true`, and OpenAI answered HTTP 400
for every helper request until 10.13.

The declared set is the static declarations plus the company tools of every configured endpoint, built
from the app's cached discovery (`server/test/fixtures/mongoose-tools-list-literal.json`, the committed
capture of the published tool lists) read-only. The request goes through the packaged model port
(`server/dist`, rebuilt when a source file is newer), the installed role from `loadTaskModels(configDir)`
and the real credential resolver for the provider key. The check never connects a connector, never
resolves a sign-in material, never refreshes an OAuth grant and never copies or writes the owner's
configuration: connector liveness and sign-in state are `check-installed-connectors.sh`'s job, so this
check proves the schemas whatever the token state. It prints closed states, counts and timings only:
never the key, never owner content.

- `HELPER-PROVIDER PASS` requires the observed registry to equal the expected one: every run prints
  `expected=<static>+<company> observed=<n>`, and PASS also needs a `completed` response that names a
  registered tool.
- A configured endpoint with no cached discovery is exit 2 `reason=discovery_missing`, naming the
  endpoint: it is never skipped and never passes, because its declarations would ship unproved.
- A registry smaller than the configuration requires is exit 2 `reason=company_bindings_unavailable`.
- exit 2 also prints the redacted provider error body (bounded to 2 KB) when the provider rejected the
  schema.
- exit 3 prints SKIP when the machine has no provider configuration, or configures a provider that
  does not take the OpenAI strict shape. A machine with nothing configured has nothing to prove.
- A run costs well under USD 0.01. Do not loop it.

The cached capture is a dated artifact: a company tool the live endpoint publishes but the capture does
not carry is not sent, so the capture has to be refreshed when the endpoints gain tools.

It runs in `scripts/run-installed-checks.sh`, so `scripts/install-macos-app.sh` restores the prior app
when it fails, and it is a local check of `scripts/ci-gauntlet.sh` (`check-helper-provider:local`). It is
never part of a GitHub CI run, which has no provider key.

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
your configured connectors. That file is a shape, not a list of current names: where it
still shows an older voice-tool name, use the name from the helper registry in
[tool-owner.md](tool-owner.md) instead, for example `alarm_create` for an alarm ask.
The example is not a real account corpus. The format is:

```json
[
  {
    "id": "alarm-split",
    "finals": ["Set an alarm", "in two minutes"],
    "expect": {"tool": "alarm_create", "codeClass": "success", "nonEmpty": false, "sideEffect": "alarm"}
  }
]
```

- Use 1 to 15 unique, safe `id` values. `finals` holds 1 to 8 owner finals per ask,
  including speech-recognition splits. Finals are injected unchanged through the existing
  typed-owner-text path, with `finalOrigin === 'typed'`; they are not a prompt quoting an ask.
- `expect.tool` names the actual tool, including a source tool called by the helper,
  not just the model's prose or a guessed connector name. A canary ask whose
  `expect.tool` names a tool this release no longer calls fails with `wrong_tool`, so
  every name comes from the current helper registry. `codeClass` is `success`.
  `nonEmpty` requires data in the tool's own reply. Successful typed read-data envelopes
  report `code=data`; explicit error/refusal fields always fail. A stored `completed`
  outcome never converts a refusal into a pass.
- Optional `sideEffect` is `alarm`, `open`, or `note`. Alarms must exist as a pending row
  belonging to a tool call in this canary session, then be cancelled. Opens must receive a
  matching acknowledgement from the production native transport. The shell's host-only
  `canary_ack` action returns before all URL, workspace, window and focus operations.
- A local staged note is not a remote save. Release 10.10 uses `save_to_vault` for an asked Lux vault save; the misleading local `stage_lux_note` tool has been removed. Any paid canary must match the current helper's actual operation and receipt, not assume an older voice-tool name proves a remote write. A real-account cleanup requires explicit authorization and exact receipt identity.

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

### Reminder coverage

Alarm scheduler recurrence and task-tool exposure are separate contracts. The current helper schemas in `server/tasks/tools.ts` declare create, list, cancel and update; do not infer a recurring-rule parameter from an older scheduler test. See [alarm.md](alarm.md) for delivery and wake behavior.

### Latency budget

`scripts/check-latency-budget.sh` replays a plain turn, a one-tool turn, a two-tool batch and a silent
continuation through the real host path, with a fake realtime transport and a fake connector carrying
recorded synthetic timings, and judges every host-side segment against `config/latency-budgets.json`.
Each budget is the recon's measured p50 for that segment plus a margin and says so in its `basis`. The
eval prints each segment with its budget and fails only on a breach, a missing segment or a missing
receipt. Its last step slows every fake by eight and requires a breach, so a gate that cannot fail is
itself a failure. No real account or provider. Run it with
`bash scripts/check-latency-budget.sh`; it takes no flags and builds the server host itself before the replay.

## Private source evaluation (manual only)

`scripts/eval-sources.mjs` is a private, priced, manual tool, **never in CI**.
Only the owner/master writes the private question file and runs real connectors.
Do not put questions, expected facts, identifiers, responses or traces in this
public repository, CI logs, issues or build artifacts. Synthetic tests are not
an owner evaluation.

Prerequisites: Node 26, `npm ci --prefix server`, then
`npm run build --prefix server`. Configure the helper credentials and read
connector grants through the normal app setup before evaluating. The runner
uses `loadTaskModels`, `credentialsFor`, `composeMcpRuntime`, the production
registry and `connectorExecutor`, and a fresh `runWorker` per question. There
is no voice model. Native open, local effects and external writes are excluded;
the authority port also refuses effects. This measures connector read authority,
not the conversation's voice routing or write approval workflow.

The data directory is `--data-dir`, or the app's standard
`${XDG_DATA_HOME:-$HOME/.local/share}/lux-didi`; provider configuration is its
`provider-config` subdirectory. The app store has an exclusive lock. When the
app is running, use a consistent offline snapshot/SQLite backup of the store
and its required configuration in a private evaluation directory. Do not copy a
live database without its WAL consistency. Preserve owner identity and connector
grants. Keep the source snapshot read-only, and give the runner a separate
writable working copy, since production store migrations, connector receipts
and credential refresh need local writes. Resolve credential references through
the existing credential provider; never paste keys into question files. Do not
point this working copy at the installed app's data. The runner does not launch,
quit, control the app or modify Settings. It closes its own connector runtime.
A locked store or missing credentials is a failed run, not a successful score.

Run privately, with fresh output paths outside **every** git checkout:

```sh
node scripts/eval-sources.mjs --questions /private/path/questions.json --out /private/path/before.json --data-dir /private/path/eval-copy --runs 1 --max-tokens 800000
node scripts/eval-sources.mjs --questions /private/path/questions.json --out /private/path/after.json --data-dir /private/path/eval-copy --only case1,case2
```

EVAL-R1: the ceiling is **tokens, not dollars**. `--max-tokens` defaults to
800000 combined input/output tokens. Usage comes from provider responses,
including reasoning output when reported. It stops before the next helper turn
or question after the ceiling is observed. An in-flight response may exceed
the ceiling; this is not a provider-side hard billing cap. Without a private price table, or for a model absent from it, only tokens are
reported. Optional `--prices /private/path/prices.json` enables estimates from
owner-supplied rates, never invented prices. The private JSON schema is
`{"effective_date":"2026-11-05","models":{"model-id":{"input_per_million":2,"output_per_million":8}}}`.
Rates are nonnegative USD per million tokens; the date is required. The table
and effective date stay in the private report. Console prints estimates, not
the table. A missing, malformed or nonnumeric provider usage record stops the
run with an explicit usage error, even if the worker catches inference errors. The first question prints measured
tokens so the owner can decide whether to continue at a different ceiling.
Use the same questions, models, grants, runs and ceiling for before/after runs.
The private output stores complete questions, scoring, tool arguments/results,
helper turns and usage, is created exclusively at mode 0600, and refuses existing
files and paths in checkouts (including symlinked parents). Console output is
limited to case ids, scores and aggregate numeric measures.

The question JSON is a nonempty array. Each object has `id` (unique printable
ASCII letters/digits/underscore/dot/hyphen), `question` (nonempty natural speech),
`expected_sources` (source names such as `vault`, `company`), `expected_refs`
(any-of exact refs that must be opened), `required_facts` (each a nonempty list
of accepted text alternatives), `forbidden_facts` (text alternatives that must
never occur), and `kind` (`fact`, `abstain`, `restricted`, `capability`). Empty
expectation lists are allowed. Fact checks are case-insensitive substring
checks, not a semantic judge. Review private traces for paraphrases. A retrieved
search hit alone does not count as opened. Empty/no-match or restricted connector
outcomes can justify abstention only when the answer itself is an explicit,
no-match/restricted response, not an unsupported factual answer. Every sentence
must be an abstention, so appending fabricated facts cannot pass. Ordinary
paraphrases are supported; for other legitimate wording, private
`required_facts` alternatives may specify an accepted full abstention response
(or each accepted sentence). These are exact case-insensitive full-answer or
full-sentence matches, not substring permission for additional assertions; unavailable capability is reported separately
from a miss. Structured job status determines incomplete coverage wherever supplied,
including a running/failed job inside a successful tool response; source prose
is not parsed for job state. Incomplete coverage plus an exhaustive claim, forbidden facts and
writes are hard failures. Three separate rates report source, opened hit and
facts, with median/p90 latency, turns, per-tool counts and token usage.

For synthetic development only add `--fake`. This uses the real worker and
production read registry with deterministic synthetic inference and executor
responses. It proves plumbing, trace privacy, scoring and budget handling; it
**does not prove** provider behavior, credential validity, real connector
permissions, source freshness, retrieval quality or owner-answer correctness.
Never use its score as a real before/after evaluation.
