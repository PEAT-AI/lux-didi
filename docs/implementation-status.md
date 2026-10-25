# Implementation status

This page describes the first stable release merged by [PR #683](https://github.com/PEAT-AI/lux-didi/pull/683), commit `a256f5d64d4dba0af9855f0ef512f2a1e88e37f9`. It describes source capabilities, not proof that a particular installed application or account works. Use [releases.md](releases.md) to identify and verify an installed bundle.

## Available now

| Capability | Implementation owner | Start here |
| --- | --- | --- |
| Voice calls with OpenAI or Gemini | `LiveSessionOwner` in `server/live/index.ts`; `liveVoiceProviders` in `server/adapters/live-voice/types.ts` | [live-call.md](live-call.md) |
| Text conversation | `ChatService` in `server/chat/index.ts` | [text-chat.md](text-chat.md) |
| Native microphone, playback and controls | `AudioOwner` in `Sources/LuxDidi/AudioOwner.swift` | [mac-experience.md](mac-experience.md) |
| Knowledge, Google, Mattermost and Mongoose reads | `CONNECTOR_DESCRIPTORS` in `server/connectors/index.ts` | [connectors.md](connectors.md) |
| Opening results through native actions | `OPEN_ACTIONS` in `server/tools/open.ts` | [tool-owner.md](tool-owner.md) |
| Trello board gateway | `server/host/trello.ts` | [mcp-configuration.md](mcp-configuration.md) |
| Composed Lux notes | `STAGE_NOTE_IDENTITY` in `server/tools/lux-note.ts`; `liveDefinitions` in `server/tools/index.ts` | [privacy-and-authority.md](privacy-and-authority.md) |

## What the stable-release train changed

- Mongoose sign-in and renewal are handled per endpoint, rather than treating one token as authority for every resource (`server/host/mongoose-login.ts`, `server/host/mongoose-auth.ts`).
- Open-in-Chrome and Drive lookup paths provide a way to act on a found result. Drive remains a separately configured and consented Google family, not an implied part of Gmail access.
- Mattermost person and conversation capabilities are used when the child advertises and the connection grants them. Missing capabilities remain visible limitations.
- Voice recovery includes provider-drop handling in `LiveSessionOwner` (`server/live/index.ts`). Its public `recover()` method instead sweeps interrupted durable sessions at host startup. A release containing recovery code is not a guarantee that a network or provider cannot fail.
- Trello is a host-owned board gateway, not an unrestricted write connector.
- Composed Lux notes are optional and require a staged readback and owner confirmation. The staging tool is gated by `composedNotes`; do not describe it as an automatic memory export.

## Verification and limits

[checks.md](checks.md) names the repository checks; [debugging.md](debugging.md) explains how to inspect a real failure without publishing private content. Synthetic checks do not prove microphone permission, a valid provider key, browser sign-in or a working installed bundle. Follow [user-guide.md](user-guide.md) for the owner steps.

The research-depth wagon was not part of PR #683. Do not infer its behavior from a contract or an unmerged branch. Future work belongs in [roadmap.md](roadmap.md). Historical release-by-release notes are not a second capability contract for the current source.
