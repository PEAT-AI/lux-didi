# Checks

There is no hosted CI workflow. Every check is a script in this repository that you run locally, one at a time (they share one machine and several take the single browser slot). Each script exits non-zero on failure and prints what it ran. Read the header comments of a script for its exact boundary.

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

Before a release, run these twelve at the release head, one at a time, with no rerun on a flake: `check-live-voice`, `check-live-session`, `check-prompt`, `check-live-gateway`, `check-tool-owner`, `check-google-connector`, `check-company-connectors`, `check-native-live`, `check-web-unit`, `Tests/DidiMacTests/check-mac.sh`, `check-host`, `check-install-smoke`. After installing the app, run `scripts/smoke.sh` once (it makes at most two real model turns, so never in a loop).

## Server and host

| Script | Covers |
| --- | --- |
| `check-service.sh` | Type-check and build; runtime store and HTTP tests (`runtime.test`, `http.test`). |
| `check-host.sh` | Build, then host, HTTP, stdout-protocol, connector publication, connector recovery and host-log tests, then the shipped UI against a real host in the browser. Fails on any `console.log` in server source. |
| `check-host-entry.sh` | Host entry migration and reopen ring (`host-entry.test.mjs`). |
| `check-domain.sh` | Domain and provenance tests against a temporary SQLite database. |
| `check-chat.sh` | Text chat, chat tools, prompt, model, runtime, domain and HTTP regressions. |
| `check-memory-context.sh` | Explicit selected local memory: memory-context tests plus chat, connected-authorization, domain and provenance regressions. |
| `check-model.sh` | The portable model adapter (`model.test`). |
| `check-provider-config.sh` | Provider profile validation (`provider-config.test`). |
| `check-credential-binding.sh` | Credential binding across provider config, model, live voice, prompt, remember, declarations and Mongoose auth. |
| `check-package.sh` | Builds the service package from a clean `git archive` and runs `package.test`. Needs committed `server/` source. |
| `check-api-response.sh` | The request boundary in a real browser against a real service (`api-response-browser.mjs`). |
| `check-archive-scale.sh` | Synthetic owner-cost assessment of a large archive. Not a performance gate. |

## Live voice and the research layer

| Script | Covers |
| --- | --- |
| `check-live-voice.sh` | Provider adapters: `live-voice`, `openai-live-voice`, `resample` tests. |
| `check-live-session.sh` | The call core: session, mute, continuity, resumption, recovery, watchdog, summary, selection, memory note, warm context, vault write, stop-phrase gate, trace store, voice fault replay, `naya-logs`, and the research suites for continuation, knowledge, steps and web. |
| `check-live-gateway.sh` | The loopback Live gateway with chat, host, HTTP, open-actions and prompt regressions. |
| `check-prompt.sh` | Prompt composition, the Live persona, runtime context and the research suites (`research`, calendar, mail query, routed, shape, web). It also runs `server/test/prompt-content.integration.mjs`, which compares the shipped instruction byte for byte against `server/test/fixtures/prompt-final.json` and pins the accepted character hash. This is where triage, topic, routing and the 2,500 character reply cap are pinned. |
| `check-tool-owner.sh` | The tool owner, Live tool shape and redaction (`tool-owner`, `live-shape`, `redact` tests). |

## Connectors and MCP

| Script | Covers |
| --- | --- |
| `check-knowledge-connector.sh` | Lux Knowledge reader (`knowledge-connector.test`). |
| `check-google-connector.sh` | Gmail and Calendar reader against a stdio MCP fixture. |
| `check-company-connectors.sh` | Mongoose and Mattermost readers, Mongoose auth and the Mattermost attention scan, against fixtures. |
| `check-mcp.sh` | The HTTP MCP adapter (`mcp.test`). |
| `check-mcp-stdio.sh` | The stdio MCP transport against a child fixture. |
| `check-mcp-config.sh` | Protected MCP configuration and consent (`mcp-config.test`). |
| `check-connected.sh` | Connector identity and status, and the connected conversation in a real browser. |

## Web

| Script | Covers |
| --- | --- |
| `check-web-unit.sh` | Builds the web bundle, then the headless suites: autoscroll, chat turn, connected, connector status, layout, live view, markdown, mini page, next steps, orb motion, orb parity, orb states, settings, tool phrases, UI hierarchy, vault card. |
| `check-native-conversation.sh` | Mini orb route unit test, then page selection and run discovery in a real browser. |
| `check-selected-memory-ui.sh` | Selecting stored notes for the next message, in a real browser. |

## Native (Swift)

| Script | Covers |
| --- | --- |
| `check-native-live.sh` | Strict Swift 6 compile and the Live tests: audio owner, callback bridge, playback scheduling, mute race, mic mode, presence, orb envelope, connecting ring, launch visibility, wait cue, native actions, bridge, journal, voice processing. |
| `check-pending-request.sh` | The pending request store that survives a native restart. |
| `Tests/DidiMacTests/check-mac.sh` | Compiles the app shell into a disposable bundle, signs it ad hoc, verifies it, then runs the native proofs in `main.swift` (surfaces, presentation coordinator, launch kinds, shortcuts, Getting started) and a real-host proof. Takes the browser slot for its launch phase. |
| `Tests/DidiCompanionTests/check-companion.sh` | Companion and real-host proofs, including keychain, lifecycle and credential proofs. Takes the slot. |
| `Tests/DidiCompanionTests/check-launch-services-probe.sh` | Launch through LaunchServices with bundled Node and no external descriptor. |

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
