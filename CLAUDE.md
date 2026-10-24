# Lux Didi: instructions for coding agents

Lux Didi is a local Mac voice companion called Naya: a Swift app (`Sources/LuxDidi`), a Node host (`server/`) and a web UI (`web/`). The repository is public. Read [README.md](README.md) for what she is and [docs/architecture.md](docs/architecture.md) for how she works before changing anything.

## Hard rules

1. The orb's visual design is frozen: the old floating orb, only less text, smooth transitions, smaller, more transparent. Behaviour and wiring may change; the look needs an explicit ask.
2. Never touch audio devices outside the app's single audio owner (`AudioOwner.swift`). Never change system input or output devices, volume or routing, and never break Mac audio. The host never touches audio at all.
3. Tests use fakes and synthetic fixtures only. No real account, provider call, microphone, credential or owner data in any test or check.
4. No real credentials, tokens, keys, personal data, private names, mail subjects or transcript text anywhere in the repository, including docs, fixtures, comments, logs and PR text. The repository is public.
5. Fail loudly. Never weaken, skip or silence a failing check to get green, and never add a fallback that hides a failure (a missing dependency or an empty upstream result is an error, not stub data).
6. The host writes nothing to stdout except the supervision protocol (`writeProtocolFrame` in `server/host/index.ts`); never `console.log` in server source.
7. Connectors are read-only. The only write outside Naya's own notes is the dictated vault note. Open tools only open; they never type, click or send.
8. No backward compatibility shims, rollback paths or `v2` names. Replace cleanly under the canonical name.
9. Voice content (`server/prompt/`, tool guidance strings) is product: change it with content assertions in `check-prompt.sh` and look for contradictions with the rules already there.
10. A launch may connect a call by itself only for the interactive kind (`LaunchKind.autoConnects`). A login start, `--install-relaunch` and every proof launch must never connect.

## Layout

- `Sources/LuxDidi/`: Mac app. Entry `LuxDidiApp.swift`; launch kinds `SingleInstanceGuard.swift`; presence machine `NativePresence.swift`; surfaces `PresentationCoordinator.swift` and `NativeMiniOrb.swift`; keys `SingleKeyTrigger.swift`, `NativeShortcuts.swift`; audio `AudioOwner.swift`; host supervision `NativeServiceSupervisor.swift`.
- `server/`: host. `host/` wiring and logs, `live/` call core and stop phrase, `adapters/live-voice/` providers, `tools/` research and tools, `connectors/`, `prompt/`, `chat/`, `domain/`, `runtime/`, `trace/`, `config/`, `http/`, `test/`.
- `web/`: UI. `src/orb*.ts`, `live-view.ts`, `settings-view.ts`, `main.ts`; tests in `web/test/`.
- `Tests/`: Swift test sources and `check-mac.sh`, `check-companion.sh`.
- `scripts/`: build, install, checks, log readers. `docs/`: documentation. `planning/` and the planning docs listed in the README are history.

## Commands

```sh
npm --prefix server ci && npm --prefix web ci          # locked installs
bash scripts/run-local.sh --build-only                 # build web and server
node server/dist/host/index.js --help                  # host flags
bash scripts/build-asset-bundle.sh OUTDIR              # needs a clean committed tree
bash scripts/build-macos-app.sh "OUT/Lux Didi.app" --assets OUTDIR
bash scripts/install-macos-app.sh "OUT/Lux Didi.app" --to "$HOME/Applications"
node scripts/naya-logs.mjs --help                      # read content-free logs
bash scripts/check-install-smoke.sh                    # install research smoke against the repo build
```

Do not launch the installed app from an agent session and do not start a call. Runtime proof of the app goes through the check scripts.

## Checks

There is no hosted CI. Run the `scripts/check-*.sh` that cover your change, one at a time, and paste the output into the PR; [docs/checks.md](docs/checks.md) maps each script to what it covers. The release gate is twelve checks at the release head (listed there), `check-install-smoke.sh` among them. Browser-backed and native-launch checks need `lux-browser-slot`; without it they are blocked, not passed. Do not run the unit suites by hand for their own sake.

## Working rules

- Work in a git worktree, never in the main checkout. One change, one branch, one pull request into `main`; the PR body is a few lines and ends with `## Closes` naming each issue it closes.
- Touch only what the task names. A bug fix does not rename, reformat or clean up neighbours.
- A change to behaviour updates the doc that describes it in the same PR; deleting or renaming a public file, flag or route means grepping the docs and fixing every reference.
- Comments: one line for a live constraint, nothing narrative.
- Write plain words. No em-dashes or en-dashes in docs, comments, commits or PR text.
- Logs and the trace store hold metadata, not owner speech: keep `host.log` content-free (see [docs/debugging.md](docs/debugging.md)).
