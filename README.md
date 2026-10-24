# Lux Didi

Lux Didi is a local voice companion for the Mac. Her name is Naya. She lives as a small floating orb in the top right corner of the screen. Tap a key, say what you need, and she answers by voice. She can look things up in your notes, mail, calendar and team chat, remember what you tell her, and open the item you asked for. She reads your accounts and opens what you ask for. She never sends, edits or deletes mail, events or chat messages; the only thing she writes outside her own notes is a vault note you dictate.

The app runs on your Mac. The voice itself comes from a cloud voice provider (OpenAI GPT-Live or Gemini Live, chosen in Settings) once you start a call. Nothing is sent before you start one.

This is a personal prerelease: a locally built, self-signed Mac app. It is not notarized, not a public release and not tested on a clean machine.

## What Naya does

- **Talks.** One tap on the orb or the Right Command key starts a call. She opens with one short line drawn from the last session, and an open loop she has not seen confirmed in the last day comes to you as a question, never as a fact she states. She keeps the call light: answers are short and she speaks while she looks things up. If speech from a video makes her go quiet, she rebuilds the call silently: no chime and no "I am back".
- **Looks things up** (read only), when you connect the matching source:
  - Lux Knowledge: your notes and past decisions.
  - Gmail and Google Calendar: "anything important in mail?", "what is on tomorrow?". Mail triage sets bulk mail aside and reads human threads first; a mail search uses at most three words from your ask and tries a wider search once when nothing matches.
  - Mattermost, through the `mattermost-mcp` server: "anything urgent on Mattermost?". Triage of what came in works again, and several chat searches in one ask run side by side.
  - Mongoose: company knowledge, data and crm, each its own sign-in; admin is never connected.
  - The web, for weather and news. A web result is never lost when the answer is trimmed to fit.
- **Stops when told.** She reads the last ten words of every spoken fragment, so an end phrase works inside any sentence: her name may sit up to four words before or two words after it, and a name at the end of a fragment stays good for three seconds. "Stop listening", "shut down" and "stop now", and the German forms, end the call with no name; a bare "stop" still needs her name next to it.
- **Remembers.** "Naya, remember that ..." saves a local note. Two different notes said in the same stretch of talk are both kept; the same note said twice is still refused. "Save to my vault: ..." saves a note to Lux Knowledge. Notes can be listed and deleted in the app.
- **Opens things** only when you ask: a mail, a calendar event, a chat thread, a file or an app.
- **Is honest about gaps.** A weak knowledge match is reported as "nothing matched". An empty mail or chat window says so and never says "nothing urgent".

## Using her

1. **Start.** Open Naya. She appears as the orb in the top right. Opening the app by hand starts a call by itself, once. A login start, an install relaunch and every check start only show the orb.
2. **Talk, mute, resume.** Tap the orb or tap the **Right Command** key (bare tap only; a held key or a chord does nothing). First tap starts her, the next tap mutes her (the orb turns purple), the next tap lets her listen again. Muting closes the microphone at once.
3. **End the call.** Say "Naya, stop listening" or "Naya, shut down" (also "end the call", "hang up", "goodbye", "good night", "turn off"; German: "Naya aus", "Naya, hör auf zuzuhören"). Her name is required at the start or the end, the sentence is at most 8 words, and a question about the phrase never ends the call. The microphone stops at once and a short goodbye sound plays. The menu bar **Stop** does the same. An unattended call also ends after 5 minutes of conversational silence; noise alone does not keep it alive. By default one provider session lasts at most an hour and a whole call at most four hours.
4. **Menu bar.** Start Live, Mute, Stop, Open Naya app, Settings, Getting started, Open at login, Right Command tap, Always show Naya, Show mini orb, Reveal logs, Copy diagnostics, Quit. The full window only opens from here (or the shortcut below); it is created the first time you ask for it.
5. **Shortcuts.** Control Option Space and Control Option Shift Space both show or hide the full window. Control Option Shift L starts Live. Control Option Shift M mutes. The orb itself is shown from the menu (**Show mini orb**) or by **Always show Naya**. If a shortcut is taken by another app, the menu says so.
6. **Settings** (in the full window): Live voice provider, voice and accent, speaking pace (1.0 to 1.2), light or dark theme, and the status of every connector with the next step to fix it.

More detail: [docs/user-guide.md](docs/user-guide.md).

## Install

You need an Apple silicon Mac on macOS 26 or newer, the Xcode Command Line Tools, Node 26 or newer and npm (Node is only needed to build; the app carries its own).

```sh
npm --prefix server ci && npm --prefix web ci
bash scripts/build-asset-bundle.sh /tmp/didi-assets      # needs a clean, committed tree
bash scripts/build-macos-app.sh "/tmp/build/Lux Didi.app" --assets /tmp/didi-assets
bash scripts/install-macos-app.sh "/tmp/build/Lux Didi.app" --to "$HOME/Applications"
```

The installer replaces only the app. It keeps your settings and data, and keeps the previous app next to it until the new one validates. Connectors and the voice provider are configured separately: see [docs/macos-install.md](docs/macos-install.md) and the connector section of [docs/user-guide.md](docs/user-guide.md). A local signing identity (`scripts/create-signing-identity.sh`) keeps macOS permission grants across rebuilds.

## How she is built

Three layers, one writer:

```text
Mac app (Swift, Sources/LuxDidi)
  menu bar, orb panel, window, microphone and speaker, hotkeys, presence machine
  starts and watches the host; shows the web UI inside a web view
        |  local HTTP and one local WebSocket, loopback only, private credential
Host (Node, server/)
  the only writer of the local database; chat, memory, the live call,
  the research layer and the connectors; talks to the voice provider
        |  serves
Web UI (TypeScript, web/)
  orb, conversation, memory, settings; the same UI in the window and in the orb
```

Everything speaks over loopback. The host is the single source of truth; the app and the web UI hold no private records of their own. [docs/architecture.md](docs/architecture.md) explains each layer, the call lifecycle, the presence states, the research layer and the connectors.

## Where things live

| Path | What |
| --- | --- |
| `Sources/LuxDidi/` | The Mac app: launch kinds, presence machine, orb panel, audio owner, host supervisor |
| `server/` | The host: `host/` entry and wiring, `live/` call core, `adapters/live-voice/` providers, `tools/` research and tools, `connectors/`, `prompt/`, `domain/` and `runtime/` store |
| `web/` | The web UI: `src/orb*.ts` orb, `src/live-view.ts`, `src/settings-view.ts`, `src/main.ts` |
| `Tests/` | Swift test sources and the Mac check scripts |
| `scripts/` | Build, install, every `check-*.sh`, and the log readers `naya-logs.mjs` and `didi-timeline` |
| `docs/` | The documentation, indexed below |
| `planning/` | The original planning backlog and its validator output (historical) |

## Checks

There is no hosted CI. Every check is a script you run locally, one at a time: see [docs/checks.md](docs/checks.md) for each script and what it covers. The release gate for a change is the set of checks that touch it; unit tests are not run by hand.

## Documentation map

Start here:

- [docs/user-guide.md](docs/user-guide.md): using Naya, the single key, permissions, signing, connector setup.
- [docs/architecture.md](docs/architecture.md): how it works today.
- [docs/checks.md](docs/checks.md): every check script.
- [docs/macos-install.md](docs/macos-install.md): build, install, protected configuration.
- [docs/local-development.md](docs/local-development.md): run the host and web UI from source.
- [docs/debugging.md](docs/debugging.md): read her logs and the trace store; [docs/diagnostic-store.md](docs/diagnostic-store.md) for the database.
- [docs/implementation-status.md](docs/implementation-status.md): what each release added.
- [CLAUDE.md](CLAUDE.md): rules for coding agents working in this repo.

Component reference (how one part is specified; read when you touch it): [mac-experience](docs/mac-experience.md), [companion-protocol](docs/companion-protocol.md), [native-live-client](docs/native-live-client.md), [native-conversation-protocol](docs/native-conversation-protocol.md), [native-request-recovery](docs/native-request-recovery.md), [live-gateway](docs/live-gateway.md), [live-session-core](docs/live-session-core.md), [live-voice-adapter](docs/live-voice-adapter.md), [tool-owner](docs/tool-owner.md), [chat-steps](docs/chat-steps.md), [conversation-runtime](docs/conversation-runtime.md), [prompt-composition](docs/prompt-composition.md), [provider-configuration](docs/provider-configuration.md), [mcp-configuration](docs/mcp-configuration.md), [mcp-adapter](docs/mcp-adapter.md), [lux-knowledge-connector](docs/lux-knowledge-connector.md), [model-adapter](docs/model-adapter.md), [domain-contract](docs/domain-contract.md), [client-service-contract](docs/client-service-contract.md), [service-runtime](docs/service-runtime.md), [local-runtime](docs/local-runtime.md), [service-packaging](docs/service-packaging.md), [web-client](docs/web-client.md), [selected-memory-context](docs/selected-memory-context.md), [selected-memory-interface](docs/selected-memory-interface.md), [memory-import](docs/memory-import.md), [owner-profile](docs/owner-profile.md), [privacy-and-authority](docs/privacy-and-authority.md).

Historical planning record (October 2026, written before the product existed; not a description of current behaviour): [roadmap](docs/roadmap.md), [decisions](docs/decisions.md), [risks](docs/risks.md), [research](docs/research.md), [acceptance](docs/acceptance.md), [parallel-masters](docs/parallel-masters.md), [overnight-execution](docs/overnight-execution.md), [cloud-deployment](docs/cloud-deployment.md) (a design, nothing is deployed), and `planning/`.

## Provenance and privacy

- `web/src/orb-classic.ts` keeps a bounded set of drawing helpers adapted from the public PEAT-AI/Vicuna repository; the exact ranges and exclusions are in `web/src/orb-provenance.md`. Third-party notices: `web/public/third-party-notices.txt` and `server/adapters/mcp/SDK-LICENSE.txt`.
- The public persona content in `server/prompt/` is generic and new. The repository contains no credentials, personal data, private endpoints or recorded conversations; tests use fakes and synthetic fixtures only.
