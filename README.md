# Lux Didi

Lux Didi is a voice companion that lives on your Mac. Her name is Naya. She is a small floating orb in the top right corner of the screen: tap a key, say what you need, and she answers by voice. She reads your notes, mail, calendar, team chat and company knowledge, remembers what you tell her, and opens the item you asked for. She never sends, edits or deletes anything in those accounts; the only thing she writes outside her own notes is a vault note you dictate.

The app runs locally. The voice itself comes from a cloud voice provider (OpenAI GPT Live by default, Gemini Live as the alternative, chosen in Settings) once you start a call. Nothing leaves the Mac before you start one.

This is a personal prerelease: a locally built, self-signed Mac app. It is not notarized, not a public release and not tested on a clean machine.

## What she can reach

Every source is read only and each one is connected separately (Settings shows the status and the next step):

- Lux Knowledge: your notes and past decisions.
- Gmail and Google Calendar (through the lux-google-mcp helper, pinned to one account): "anything important in mail?", "what is on tomorrow?".
- Mattermost (through the mattermost-mcp server): "anything urgent on Mattermost?", "find that channel".
- Mongoose: company knowledge, business data and CRM, each endpoint with its own sign in button in Settings; the admin endpoint is never connected.
- The web, for public facts, weather and news.

What she says about a lookup is honest: an empty window says so, a source she could not search says why, and a weak match is reported as nothing matched.

## Using her

1. **Start.** Open Naya. She appears as the orb. A launch by hand, including a cold click on the Dock icon, is an interactive launch: the orb appears and one call starts by itself, after a bounded wait for the calendar connector (four seconds at most). A login start shows the orb and makes no call, an install relaunch shows the orb only, and a click on the Dock icon while the app is already running shows the orb without a call. The full window opens from the menu bar (Open Naya app) or the shortcut below.
2. **Talk, mute, resume.** Tap the orb or tap the **Right Command** key (a bare tap; a held key or a chord does nothing). The first tap starts her, the next tap mutes her (the orb turns purple), the next lets her listen again. Muting closes the microphone at once.
3. **End the call.** Say "stop listening", "shut down" or "stop now" anywhere in a sentence, with or without her name; a bare "stop" needs her name ("Naya, stop"). The German forms work both ways ("Naya aus", "hör auf zuzuhören", and bare "aus"). A question about the phrase never ends the call. The microphone stops at once, a short goodbye sound plays and the connection to the voice provider closes; the orb stays. The menu bar **Stop** does the same. An unattended call ends after 5 minutes of conversational silence.
4. **Menu bar.** Start Live, Mute, Stop, Open Naya app, Settings, Getting started, Open at login, Right Command tap, Always show Naya, Show mini orb, Reveal logs, Copy diagnostics, Quit.
5. **Shortcuts.** Control Option Space shows or hides the orb, Control Option Shift Space shows or hides the full window, Control Option Shift L starts Live, Control Option Shift M mutes. If a shortcut is taken by another app, the menu says so.
6. **Remember and save.** "Naya, remember that ..." keeps a local note. "Save to my vault: ..." writes a note to Lux Knowledge. Notes are listed and deleted in the app.

More: [docs/user-guide.md](docs/user-guide.md).

## Run it

You need an Apple silicon Mac on macOS 26 or newer, the Xcode Command Line Tools, Node 26 or newer and npm (Node builds the app; the installed app carries its own runtime).

```sh
npm --prefix server ci && npm --prefix web ci
bash scripts/build-asset-bundle.sh /tmp/didi-assets      # needs a clean, committed tree
bash scripts/build-macos-app.sh "/tmp/build/Lux Didi.app" --assets /tmp/didi-assets
bash scripts/install-macos-app.sh "/tmp/build/Lux Didi.app" --to "$HOME/Applications"
```

The installer replaces only the app. It keeps your settings and data and keeps the previous app next to the new one until it validates. A dirty tree builds an app whose `didi-runtime.json` names a commit that is not what you built; commit first. Connectors and the voice provider are configured afterwards: [docs/macos-install.md](docs/macos-install.md) and the connector section of the user guide. A local signing identity (`scripts/create-signing-identity.sh`) keeps macOS permission grants across rebuilds.

## Run it from source

```sh
npm --prefix server ci && npm --prefix web ci
bash scripts/run-local.sh --build-only
node server/dist/host/index.js          # the host, port 8765
```

Two data directories exist and they are the most asked question: a source run writes to `~/Library/Application Support/Lux Didi`, the installed app to `~/Library/Application Support/ai.peat.lux-didi`. Each holds `state.sqlite` and `logs/` (`host.log`, `native-live.log`, `audio.log`, all content free). [docs/local-development.md](docs/local-development.md) has the flags, ports and proofs.

## How she is built

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

Three ownership rules explain most of the code: the host is the single writer of every record; the app owns the microphone and the speaker and nothing else touches audio; the web UI holds no records. A call is one provider session driven by the host, rendered by the app, with every step journalled. [docs/architecture.md](docs/architecture.md) is the full picture.

## Where to go next

| You want to | Read |
| --- | --- |
| use her and connect your accounts | [docs/user-guide.md](docs/user-guide.md), [docs/mcp-configuration.md](docs/mcp-configuration.md) |
| change her | [CLAUDE.md](CLAUDE.md), then [docs/architecture.md](docs/architecture.md) and the component doc the architecture page names for your layer |
| add a connector | [docs/connectors.md](docs/connectors.md) |
| debug a call | [docs/debugging.md](docs/debugging.md), [docs/diagnostic-store.md](docs/diagnostic-store.md) |
| ship a release | [docs/releases.md](docs/releases.md), [docs/checks.md](docs/checks.md) |
| know what each release added | [docs/implementation-status.md](docs/implementation-status.md) |

## Working in this repository

Coding agents and people follow [CLAUDE.md](CLAUDE.md): the orb look is frozen, audio belongs to one owner, connectors stay read only, tests use fakes, the repository is public and holds no private data, and a change updates the doc that describes it in the same pull request. There is no hosted CI: every check is a script under `scripts/` you run locally, and a release passes the twelve-check gate listed in [docs/checks.md](docs/checks.md).

## Provenance and privacy

- `web/src/orb-classic.ts` keeps a bounded set of drawing helpers adapted from the public PEAT-AI/Vicuna repository; the exact ranges and exclusions are in `web/src/orb-provenance.md`. Third-party notices: `web/public/third-party-notices.txt` and `server/adapters/mcp/SDK-LICENSE.txt`.
- The persona content in `server/prompt/` is generic and new. The repository contains no credentials, personal data, private endpoints or recorded conversations; tests use fakes and synthetic fixtures only.
- The planning documents from before the product existed live under [docs/history/](docs/history/README.md). [docs/privacy-and-authority.md](docs/privacy-and-authority.md) is also historical: it states the authority model as designed, and the live constraints now sit in [CLAUDE.md](CLAUDE.md) and [docs/architecture.md](docs/architecture.md).
