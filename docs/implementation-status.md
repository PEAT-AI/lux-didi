# Implementation status

State of the source tree at release 10.7 (main `685d26c267ced64f91e39349c96bf19813facbe3`, 2026-11-01). It describes source capabilities, not proof that a particular installed application or account works. Use [releases.md](releases.md) to identify and verify an installed bundle.

## Releases

| Release | Date | What changed for the owner |
| --- | --- | --- |
| 10.7.1 | 2026-11-01 | Native action checks no longer depend on whether a browser is open; README and CLAUDE.md describe 10.7 |
| 10.7 | 2026-11-01 | Quit works from every window and always finishes cleanly; the orb no longer starts a call when clicked and its animation cannot freeze after login; a wake-up alarm wakes her and she speaks, even after quit; calendar entries and drafts asked for directly now happen in live calls, and questions, reports or "don't" never write (deleting an event and email drafts still refuse some valid phrasings, tracked for 10.8); Mongoose and knowledge reads follow each server's own paging and shapes; Mattermost chat reads keep the person and channel; one research job per question with honest partial answers; filler arguments repaired and refusals told truthfully; every segment of a turn timed in the host log with a latency budget eval; evals: live-boundary harness, priced release tier (dry run by default), post-call review, combined-tree gate, test-sensitivity mutants, plist check. |
| 10.6.2 | 2026-10-31 | Calendar events and drafts survive Naya's follow-up question; one-time alarms no longer pick up an invented repeat; she no longer claims a retry she never made; when the Mac's microphone path is stuck she retries without voice processing or tells you, instead of ringing in a loop. |
| 10.6.1 | 2026-10-31 | Email and chat drafts and owner-only calendar events can now really be asked for in a call, a spoken name or channel is matched before anything is written, a detail she cannot use is explained instead of asking you to authorize, and a wake-up ask spoken across two turns sets the alarm again. |
| 10.6 | 2026-10-30 | Nothing is read before you speak, a long lookup reaches you as research instead of a lost answer, drafts and owner-only events land without sending or inviting anyone, reminders can repeat, Mattermost topics and threads can be read, and the evals run locally. |

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
- Open-in-Chrome and Drive lookup paths provide a way to act on a found result. An open runs through the intent guard in `server/tools/open.ts` and the allowlist in `server/tools/open-handles.ts`. Drive remains a separately configured and consented Google family, not an implied part of Gmail access.
- Mattermost person and conversation capabilities are used when the child advertises and the connection grants them. Missing capabilities remain visible limitations.
- Voice recovery includes provider-drop handling in `LiveSessionOwner` (`server/live/index.ts`). Its public `recover()` method instead sweeps interrupted durable sessions at host startup. A release containing recovery code is not a guarantee that a network or provider cannot fail.
- Trello is a host-owned board gateway, not an unrestricted write connector.
- Composed Lux notes are optional and require a staged readback and owner confirmation. The staging tool is gated by `composedNotes`; do not describe it as an automatic memory export.

## Verification and limits

[checks.md](checks.md) names the repository checks; [debugging.md](debugging.md) explains how to inspect a real failure without publishing private content. Synthetic checks do not prove microphone permission, a valid provider key, browser sign-in or a working installed bundle. Follow [user-guide.md](user-guide.md) for the owner steps.

Deeper research answers ship in the release after PR #683: `server/tools/research.ts` sizes the reply by the tier the owner's question earns, reads knowledge in two stages and rebuilds an oversized call's research context from a host-built ledger. Its behavior is the merged source, not a contract or an unmerged branch. Future work belongs in [roadmap.md](roadmap.md). Historical release-by-release notes are not a second capability contract for the current source.
