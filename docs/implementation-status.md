# Implementation status

Release 10.11: Naya answers on the open line, knows when nothing is coming, and has tools that explain failures. This describes source capabilities, not proof that an installed app or connected account works. See [releases.md](releases.md) for release and installation checks.

## Release history

| Release | Date (UTC) | What changed |
| --- | --- | --- |
| 10.11 | 2026-11-04 | Answers stay on the open line, idle listening is clear, saved memories stay selected, and tool failures explain what went wrong. |

## What changed for you

- Ask naturally. There is no phrase to learn and no second permission question for the action you just asked for.
- The helper reads connected sources, follows their results and performs typed actions while the conversation continues.
- Corrections revise the work. Old answers are not delivered as current ones. Work can finish across a voice connection drop and wait for delivery.
- Prepare email and chat drafts, create owner-only calendar entries, save notes, change board cards, set alarms and open web addresses, apps or files. Nothing sends or invites anyone.
- Calendar deletion needs a later confirmation. After outside text, permission is checked against your words rather than instructions found in that text.
- The helper model is configurable, with an OpenAI low-effort default and a Gemini option. It is separate from the voice model.

## Available now

| Capability | Implementation owner | Start here |
| --- | --- | --- |
| Voice calls | `server/live/index.ts`, `server/tasks/call.ts` | [live-call.md](live-call.md) |
| Helper, tools and receipts | `server/tasks/` | [tool-owner.md](tool-owner.md) |
| Text conversation | `server/chat/index.ts` | [text-chat.md](text-chat.md) |
| Microphone, playback and controls | `Sources/LuxDidi/AudioOwner.swift` | [mac-experience.md](mac-experience.md) |
| Connected source reads | `server/connectors/index.ts`, `server/tasks/connectors.ts` | [connectors.md](connectors.md) |
| Opening and finding files | `server/tools/open.ts`, `server/tools/find-file.ts` | [privacy-and-authority.md](privacy-and-authority.md) |
| Board changes | `server/host/trello.ts` | [mcp-configuration.md](mcp-configuration.md) |
| Permission | `server/tasks/authority.ts` | [privacy-and-authority.md](privacy-and-authority.md) |

## Verification and limits

[Checks](checks.md) names the repository scripts. Synthetic checks do not prove microphone permission, a valid provider key, a working account or an installed bundle. Follow the [user guide](user-guide.md) for those steps. No microphone, account, provider or installed-app verification is claimed by this documentation change.

Future work belongs in [roadmap.md](roadmap.md); older plans remain in [history/](history/README.md).
