# Lux Didi

Lux Didi is a personal assistant that runs on your own Mac. Her name is **Naya**. You talk to her the way you would talk to someone who knows your work, and she finds things, remembers things and gets things done while the conversation carries on.

She lives in a small floating orb. Press the bare Right Command key, say what you need, and she answers out loud. Open the full window when you want to type, look through memory or change settings.

## What she does for you

Ask in your own words. There are no commands to learn and no phrases to remember.

| You want | She can |
| --- | --- |
| To find something | Search and read your mail, calendar, team chat, Drive, notes, knowledge vault, connected company records, past conversations and the web |
| To get something ready | Draft an email or a chat message, add a calendar entry, save a note, change a card on your board |
| To be reminded | Set a wake-up alarm that rings and speaks what you asked it to remember, even after you quit the app |
| To see something | Open any web address, app, document or file on your Mac |
| To remember | Keep local memories across conversations, so you can pick up where you left off |

Nothing she does reaches another person. A draft waits for your click and a calendar entry invites nobody. Sending is always yours.

If a source is unavailable or a search only covered part of what you asked, she says so. She reports something as done only when the system has a receipt for it.

## How a conversation works

Two things happen at once. A voice model talks with you, and a separate helper does the work. As soon as you finish a sentence the helper starts on it, reads what it needs, takes the actions you asked for and writes the answer. Naya then says it. If you correct yourself or change your mind while it is working, the work changes with you, and an answer that no longer fits is never spoken. Work you asked for finishes even if the connection drops, and she tells you when she is back.

The helper's model is one setting, so you can switch it. It defaults to a fast OpenAI model at low effort, and Gemini Flash works through the same setting.

## Running locally

The app, its database, your memories, your settings and every record of what she did live on your Mac, under your account. There is no Lux Didi server and no account with us.

Local does not mean offline. The voice and helper models run at the provider you configure, so that provider receives your audio and the context needed for the request, and each connected source talks to its own service. You choose the providers and sources, and you bring your own keys and sign-ins.

## What she may do on her own

The design gives her a lot of freedom and keeps the few rules that matter:

- When you ask for something, it runs at once. She does not ask permission for what you just asked for.
- After she has read outside text, such as mail, a web page or a chat message, a small isolated check compares your own words with the kind of action about to happen, so that text inside a message cannot give her orders. It sees nothing of the outside text.
- After reading outside text, she opens only a web address that came exactly from a trusted result.
- Deleting a calendar event is the one action that waits: she names it and you confirm in your next words.
- She cannot send a message, post, invite anyone, accept an invitation, or pay for anything.

Read [privacy and authority](docs/privacy-and-authority.md) and the [tool owner](docs/tool-owner.md) for the exact rules.

## Install and make a first call

You need an Apple silicon Mac running macOS 26 or newer, the Xcode Command Line Tools, Node 26 or newer and npm. From a clean, committed checkout:

```sh
npm --prefix server ci
npm --prefix web ci
bash scripts/build-asset-bundle.sh /tmp/didi-assets
bash scripts/build-macos-app.sh "/tmp/build/Lux Didi.app" --assets /tmp/didi-assets
bash scripts/install-macos-app.sh "/tmp/build/Lux Didi.app" --to "$HOME/Applications"
```

Use new output paths, not directories containing unrelated files. The Mac app is built and signed on your machine; it is not a notarized public download. The installed app bundles Node, keeps your data and settings, and keeps a copy of the previous app for rollback. It does **not** create provider keys, install connector servers or sign in to accounts.

Next, follow [the user guide](docs/user-guide.md#2-configure-a-first-voice-provider) to set up a voice provider and make a first call. [Mac installation](docs/macos-install.md) covers signing, packaging and rollback.

Opening the app yourself can start one call automatically; login and installer relaunches do not. Tap Right Command to start, mute or resume, or use the status menu, the Dock menu or the window pill. A click on the orb starts and stops nothing. Use Stop or say **"Naya, stop listening"** to finish. Right Command needs Input Monitoring and audio needs microphone permission. Closing the full window does not stop a call.

## Connect your sources

Open Settings to see each source's status and next step. Google accounts, team chat, your board, your knowledge vault and company records each have their own sign-in, and signing in to one never grants another. The [connector walkthrough](docs/user-guide.md#4-add-connected-accounts) explains each one.

Real credentials, private profiles, board names, transcripts and account content never belong in this public repository or in a support attachment.

## How it is built

- **Swift app, `Sources/LuxDidi/`:** audio, native controls, the orb and opening things on your Mac.
- **Node host, `server/`:** the only writer of stored data; the live voice session, the helper and its typed tools in `server/tasks/`, permission, prompts and connectors.
- **TypeScript web interface, `web/`:** conversation, memory and Settings.

The host owns records and authority, the native app owns audio, and the interface shows what the host reports. [Architecture](docs/architecture.md) explains the boundaries, and [local development](docs/local-development.md) is the place to start for running from source.

## Documentation

| You need | Read |
| --- | --- |
| Install, permissions, sign-in and first call | [User guide](docs/user-guide.md), [Mac installation](docs/macos-install.md) |
| What exists and what is next | [Implementation status](docs/implementation-status.md), [Roadmap](docs/roadmap.md) |
| How it fits together | [Architecture](docs/architecture.md), [Service](docs/service.md), [Local runtime](docs/local-runtime.md) |
| Develop, check or release | [CLAUDE.md](CLAUDE.md), [Local development](docs/local-development.md), [Checks](docs/checks.md), [Releases](docs/releases.md) |
| Native and web behaviour | [Mac experience](docs/mac-experience.md), [Native app](docs/native-app.md), [Web client](docs/web-client.md) |
| Conversations and models | [Live calls](docs/live-call.md), [Text chat](docs/text-chat.md), [Model adapter](docs/model-adapter.md), [Provider configuration](docs/provider-configuration.md) |
| Sources and tools | [Connectors](docs/connectors.md), [MCP configuration](docs/mcp-configuration.md), [MCP adapter](docs/mcp-adapter.md), [Lux Knowledge](docs/lux-knowledge-connector.md), [Tool owner](docs/tool-owner.md) |
| Memory, character and privacy | [Domain contract](docs/domain-contract.md), [Selected memory](docs/selected-memory.md), [Memory import](docs/memory-import.md), [Owner profile](docs/owner-profile.md), [Prompt composition](docs/prompt-composition.md), [Privacy](docs/privacy-and-authority.md) |
| Explain a failure safely | [Debugging](docs/debugging.md), [Diagnostic store](docs/diagnostic-store.md) |

Older planning is kept under [docs/history/](docs/history/README.md). It does not describe how she works today.

## Contributing and provenance

Read [CLAUDE.md](CLAUDE.md) before changing the application. The orb's public-source attribution is in [web/src/orb-provenance.md](web/src/orb-provenance.md). Third-party notices are in [web/public/third-party-notices.txt](web/public/third-party-notices.txt) and [server/adapters/mcp/SDK-LICENSE.txt](server/adapters/mcp/SDK-LICENSE.txt).
