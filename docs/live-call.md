# Live voice calls

A Live call is a host-owned conversation with native microphone capture and playback. The provider receives audio and accepted instructions; the Mac app receives the host's state, audio and transcript events. Text chat is a separate owner, described in [text-chat.md](text-chat.md).

## User controls

Tap the orb or bare Right Command to start, mute and resume. Use Stop or say "Naya, stop listening" to end the call. Muting keeps the call open but closes capture; stopping ends the call. The native presence machine, not a web component's local guess, determines which state the controls show. [User guide](user-guide.md) and [Mac experience](mac-experience.md) own the interaction details.

An interactive launch can start one call automatically; login and installer relaunches do not. Microphone permission and a usable voice configuration are independent prerequisites. A provider error is not permission to switch the system's audio device or silently disable voice processing.

## Implementation map

| Contract | Owner |
| --- | --- |
| Call lifecycle and provider recovery | `LiveSessionOwner` in `server/live/index.ts` |
| Public host composition | `createLiveSessionOwner` in `server/live/index.ts`; `server/host/live.ts` |
| Accepted profile, limits and feature switches | `validateLiveProfile`, `defaultLiveLimits`, `liveFeatures` in `server/live/config.ts` |
| Durable call records | `server/live/schema.ts`, `server/live/journal.ts` |
| Provider transport | `LiveVoicePort` and `liveVoiceProviders` in `server/adapters/live-voice/types.ts` |
| Microphone and speaker | `AudioOwner` in `Sources/LuxDidi/AudioOwner.swift` |
| Native connection and presence | `Sources/LuxDidi/LiveSessionCoordinator.swift`, `Sources/LuxDidi/NativePresence.swift` |
| Stop-speech normalization | `normalizeStopSpeech` in `server/live/stop-phrase.ts` |

Read the owning types for frame schemas, lifecycle unions and timer bounds. Keep those contracts in source rather than copying a second protocol specification here.

## Acceptance and authority

A call accepts provider, route, permitted classes, prompt and usable tool context before dispatch. The provider selection is explicit; there is no permission to borrow another provider's key. The instruction can include selected local memory and an explicitly activated owner profile. [Provider configuration](provider-configuration.md), [prompt composition](prompt-composition.md) and [selected memory](selected-memory.md) own those inputs.

A reconnect must not expand the accepted tool grant. Current revocation and source/class gates still apply to results. A stale provider generation cannot speak into a newer active call merely because it eventually returned a response.

## Research and dead air

The merged release bounds research by owner-turn admission. `owner_turn_required` in `server/tools/research.ts` refuses a model-driven continuation without a new finalized owner turn. A partial result should be answered honestly from available evidence, not turned into an automatic cascade of more tool calls while the owner hears nothing.

Admitted paging is host-owned and bounded. Partial coverage remains partial; records examined, matches and represented results are different quantities. The model must not call a partial scan complete or treat an unknown total as zero. [Tool owner](tool-owner.md) owns research and coverage details.

`LiveSessionOwner` distinguishes pending tool work from an answer the provider owes after a result. Dead-air recovery must not rebuild over an admitted operation within its deadline, and a stuck operation must not suppress recovery forever. `live_dead_air` receipts describe observed timing; they are not proof that audio was audible on the Mac. Use the trace playback evidence described in [diagnostic-store.md](diagnostic-store.md).

## Recovery is not replay

Provider-drop handling is implemented by `#recoverFromDrop` and `#openRecovery` inside `LiveSessionOwner`. Failed resumption can fall back to a fresh open; exhausted recovery settles with `provider_recovery_exhausted`. Neither path grants another research operation or permission to replay an uncertain remote write.

The public `LiveSessionOwner.recover()` method has a different purpose: it sweeps interrupted durable sessions at host startup. Do not confuse that startup bookkeeping with opening a replacement provider connection.

Native capture recovery is another boundary again. Diagnose native audio, transport, provider and host-lifecycle failures separately rather than attaching one "reconnect" explanation to all of them. A terminal connection-lost state requires an explicit owner reconnect; it is not a successful answer.

## Notes and deletion

Voice can save local memories and owner-requested Lux notes. Composed Lux notes are gated off by default and require staged readback and confirmation; a tool call alone is not a save. Trello card writes have their own board-scoped authority. [Privacy and authority](privacy-and-authority.md) owns these distinctions.

Deleting a local memory can scrub later accepted/rebuilt context, but cannot remove bytes already held by an open provider connection. Stop and restart the call when discarding that current context matters.

## Verification

[Checks](checks.md) names the focused Live, gateway, transport and native proofs. Offline fixtures do not prove real provider availability, microphone permission or audible hardware playback. Do not launch an installed owner app or make a real call without authorization. [Debugging](debugging.md) gives the evidence-first path for a real failure.
