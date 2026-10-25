# Lux Didi

Lux Didi is a personal assistant application for your Mac. Her name is **Naya**. She lives in a small floating orb: tap it or the bare Right Command key, ask a question, and hear an answer. Open the full window when you want text conversation, memory or Settings.

Naya can consult your approved sources, explain what she found and open the result for you. She can remember a local note, work on a selected Trello board and save narrowly authorized notes to Lux Knowledge. She is not a general-purpose account administrator or unrestricted computer-control agent.

This is the first stable source release, merged in [PR #683](https://github.com/PEAT-AI/lux-didi/pull/683). The Mac app is built and signed locally; stable source does not mean notarized public distribution or proof that every installation/account has been verified.

## What Naya can do today

| Capability | What to expect |
| --- | --- |
| Voice and text | Live voice through OpenAI or Gemini; separately configured Gemini text conversation in the full window |
| Lux Knowledge | Search and read approved knowledge evidence |
| Gmail, Calendar and Drive | Read the configured account/family; Drive needs its own setup and consent |
| Mattermost | Read people, direct/group conversations, channels and threads when the installed archive exposes the required capabilities |
| Mongoose | Consult knowledge, data and CRM with separate endpoint sign-ins; no admin endpoint |
| Public web | Read public evidence through the host's research tools |
| Open a result | Open an accepted email, event or document destination, preferring Chrome with a default-browser fallback |
| Trello | Read and make granted card changes on the privately configured board, not administer arbitrary boards |
| Memory and Lux notes | Save local memories, explicitly dictated vault notes, and optionally composed notes after readback/confirmation |

An unavailable source is not an empty successful search, and partial coverage must not be described as complete. A model's statement that something was saved or opened is not enough; the host needs the actual receipt.

## Install and make a first call

You need an Apple silicon Mac running macOS 26 or newer, the Xcode Command Line Tools, Node 26 or newer and npm. From a clean, committed checkout:

```sh
npm --prefix server ci
npm --prefix web ci
bash scripts/build-asset-bundle.sh /tmp/didi-assets
bash scripts/build-macos-app.sh "/tmp/build/Lux Didi.app" --assets /tmp/didi-assets
bash scripts/install-macos-app.sh "/tmp/build/Lux Didi.app" --to "$HOME/Applications"
```

Use new output paths, not directories containing unrelated files. The installed app bundles Node; installation preserves owner data/configuration and keeps a rollback copy of the previous app. It does **not** create provider keys, install connector servers or sign in to accounts.

Next, follow [the user guide](docs/user-guide.md#2-configure-a-first-voice-provider) to create/select protected voice configuration and make a first non-sensitive call. That guide includes a minimal first-call configuration example and the connector sign-in steps. [Mac installation](docs/macos-install.md) covers local signing, packaging and rollback in more detail.

Opening the app interactively can attempt one call automatically. Login and installer relaunches do not. Tap the orb or Right Command to start/mute/resume; use Stop or say **"Naya, stop listening"** to finish. Right Command needs Input Monitoring; audio needs microphone permission. Closing the full window does not stop a call.

## Connect your accounts

Open Settings to see source status and next steps. Mongoose has one sign-in per knowledge/data/CRM endpoint. Trello has its own browser sign-in and private board selection. Google families and Mattermost use their installed helpers' account flows; Lux Knowledge needs its configured endpoint and approval.

Configuration, authentication, source approval and inference-route consent are separate. Do not assume that signing in to Gmail grants Drive, or that one Mongoose token authorizes another resource. The [connector walkthrough](docs/user-guide.md#4-add-connected-accounts) explains these boundaries and first reads.

## Privacy and write authority

The host keeps durable state on the Mac, but configured cloud providers receive accepted context/audio and connectors contact their services. **Local-first is not offline inference.** Real credentials, private profiles, board names, transcripts and account content do not belong in this public repository or a support attachment.

Registry connectors are read-only. Host-owned exceptions are narrow: local memory, owner-requested dictated Lux notes, separately gated composed Lux notes, and granted card operations on the selected Trello board. Composed notes default **off** and require staged readback plus fresh owner confirmation. Trello card actions use their own board-scoped authority, not that confirmation flow.

Deleting a local memory is not deletion of a remote original or provider-held bytes. An already open call can retain the note until reconnect/end. Read [privacy and authority](docs/privacy-and-authority.md) before broadening a route or enabling a write.

## How it is built

- **Swift app, `Sources/LuxDidi/`:** audio, native controls, presence, approved actions and host supervision.
- **Node host, `server/`:** the persistent writer, text/Live owners, prompt composition, tools and connectors.
- **TypeScript web interface, `web/`:** shared conversation, memory and Settings presentation.

The host owns records and authority; the native app owns audio; the renderer presents observed state. [Architecture](docs/architecture.md) explains the boundaries. For a source-run host and isolated browser pairing, start with [local development](docs/local-development.md), not the installed application's data directory.

## Documentation map

| You need | Read |
| --- | --- |
| Install, permissions, sign-in and first call | [User guide](docs/user-guide.md), [Mac installation](docs/macos-install.md) |
| Current scope and future work | [Implementation status](docs/implementation-status.md), [Roadmap](docs/roadmap.md) |
| Process and wire ownership | [Architecture](docs/architecture.md), [Service](docs/service.md), [Local runtime](docs/local-runtime.md) |
| Develop, check or release | [CLAUDE.md](CLAUDE.md), [Local development](docs/local-development.md), [Checks](docs/checks.md), [Releases](docs/releases.md) |
| Native and web behavior | [Mac experience](docs/mac-experience.md), [Native app](docs/native-app.md), [Web client](docs/web-client.md) |
| Conversations and models | [Live calls](docs/live-call.md), [Text chat](docs/text-chat.md), [Model adapter](docs/model-adapter.md), [Provider configuration](docs/provider-configuration.md) |
| Source/tool integration | [Connectors](docs/connectors.md), [MCP configuration](docs/mcp-configuration.md), [MCP adapter](docs/mcp-adapter.md), [Lux Knowledge](docs/lux-knowledge-connector.md), [Tool owner](docs/tool-owner.md) |
| Memory, character and disclosure | [Domain contract](docs/domain-contract.md), [Selected memory](docs/selected-memory.md), [Memory import](docs/memory-import.md), [Owner profile](docs/owner-profile.md), [Prompt composition](docs/prompt-composition.md), [Privacy](docs/privacy-and-authority.md) |
| Explain a failure safely | [Debugging](docs/debugging.md), [Diagnostic store](docs/diagnostic-store.md) |

Historical planning remains under [docs/history/](docs/history/README.md). It is not the current runtime contract. The research-depth wagon was not part of PR #683; do not infer it shipped from an unmerged plan.

## Contributing and provenance

Read [CLAUDE.md](CLAUDE.md) before changing the application. Keep the orb design unchanged unless explicitly requested, audio in its native owner, test data synthetic and private material outside public artifacts. Use the repository's existing check producers rather than inventing another build path.

The orb's public-source attribution is in [web/src/orb-provenance.md](web/src/orb-provenance.md). Third-party notices are in [web/public/third-party-notices.txt](web/public/third-party-notices.txt) and [server/adapters/mcp/SDK-LICENSE.txt](server/adapters/mcp/SDK-LICENSE.txt).
