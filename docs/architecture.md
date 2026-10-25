# Architecture

Lux Didi is a local Mac application with three cooperating parts: a Swift app, a Node host and a TypeScript web interface. Naya is the assistant presented by those parts, not a separate service.

## Ownership boundaries

| Part | Owns | Source entry point |
| --- | --- | --- |
| Mac app | Microphone, playback and native controls | `AudioOwner` in `Sources/LuxDidi/AudioOwner.swift` |
| Host supervisor | Starting and observing the app's host process | `NativeServiceSupervisor` in `Sources/LuxDidi/NativeServiceSupervisor.swift` |
| Host | Conversation, tools, connector access and persistent records | `server/host/index.ts` |
| Web interface | The conversation, settings and memory surfaces | `web/src/` |

The host, not a browser component, owns durable records. `createDomainPort` in `server/domain/facade.ts` exposes the domain boundary; storage and migration details belong in [domain-contract.md](domain-contract.md). The native app owns audio hardware; the host transports audio rather than opening a microphone.

## Starting the application

The launch kind determines whether opening the app also starts a call. `LaunchKind.autoConnects` in `Sources/LuxDidi/SingleInstanceGuard.swift` is true only for an interactive launch. Login and installer relaunches must not surprise the owner with a call.

The app supervises the host rather than relying on an independently installed daemon. For the startup handshake, authentication and foreground host command, see [service.md](service.md). For installed paths and packaging, see [macos-install.md](macos-install.md).

## Conversations

Voice and text have different owners but share host-side capabilities:

- `LiveSessionOwner` in `server/live/index.ts` owns a live call. Its `recover()` path can retry a failed initial connection as well as recover an existing call. Lifecycle, mute, stop and dead-air handling belong in [live-call.md](live-call.md).
- `LiveVoicePort` in `server/adapters/live-voice/types.ts` is the voice-provider boundary. `liveVoiceProviders` lists the supported adapters. Provider selection and credentials belong in [provider-configuration.md](provider-configuration.md).
- `ChatService` in `server/chat/index.ts` owns text conversation. See [text-chat.md](text-chat.md) for streaming and consent.
- `composeLiveInstruction` in `server/prompt/live-persona.ts` assembles the voice instructions. See [prompt-composition.md](prompt-composition.md) for their inputs and authority.

Keep lifecycle policy in the owning layer. A web rendering workaround cannot fix a host reconnect failure, and a host retry cannot repair a native capture failure.

## Tools and connected sources

`CONNECTOR_DESCRIPTORS` in `server/connectors/index.ts` defines the published connector surface. Connection configuration and approvals are distinct from whether a service happens to be reachable. Read [connectors.md](connectors.md) for the available sources and [mcp-configuration.md](mcp-configuration.md) for their setup.

The host's tool layer, `server/tools/`, validates requests and projects results before returning evidence to a model. Research, opening a result in Chrome, Trello reads and note creation are tool capabilities, not permission for arbitrary remote writes. See [tool-owner.md](tool-owner.md).

Composed Lux notes are an explicit gated write flow. `liveDefinitions` in `server/tools/index.ts` advertises the staging tool only when `composedNotes` is enabled; staging is not saving. The owner must confirm the host's readback. See [privacy-and-authority.md](privacy-and-authority.md) before changing any write path.

## Where to investigate

| Question | Read |
| --- | --- |
| Install, sign in and make a first call | [user-guide.md](user-guide.md) |
| Native presence, keys or windows | [native-app.md](native-app.md), [mac-experience.md](mac-experience.md) |
| Host identity or runtime directories | [local-runtime.md](local-runtime.md) |
| Explain a failed call without exposing content | [debugging.md](debugging.md), [diagnostic-store.md](diagnostic-store.md) |
| Develop or verify a change | [local-development.md](local-development.md), [checks.md](checks.md) |
| Package or release | [releases.md](releases.md) |

This page describes the merged release. Future work belongs in [roadmap.md](roadmap.md), not in the runtime contract. Historical designs remain under [history/](history/README.md).
