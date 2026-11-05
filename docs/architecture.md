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

- `LiveSessionOwner` in `server/live/index.ts` owns a live call, including provider-drop recovery. Its public `recover()` method is the startup sweep for interrupted durable sessions, not the provider reconnect operation. Lifecycle, mute, stop and dead-air handling belong in [live-call.md](live-call.md).
- `LiveVoicePort` in `server/adapters/live-voice/types.ts` is the voice-provider boundary. `liveVoiceProviders` lists the supported adapters. Provider selection and credentials belong in [provider-configuration.md](provider-configuration.md).
- `ChatService` in `server/chat/index.ts` owns text conversation. See [text-chat.md](text-chat.md) for streaming and consent.
- `composeLiveInstruction` in `server/prompt/live-persona.ts` assembles the voice instructions. See [prompt-composition.md](prompt-composition.md) for their inputs and authority.

Keep lifecycle policy in the owning layer. A web rendering workaround cannot fix a host reconnect failure, and a host retry cannot repair a native capture failure.

## Tools and connected sources

`CONNECTOR_DESCRIPTORS` in `server/connectors/index.ts` defines the published connector surface. Connection configuration and approvals are distinct from whether a service happens to be reachable. Read [connectors.md](connectors.md) for the available sources and [mcp-configuration.md](mcp-configuration.md) for their setup.

The helper in `server/tasks/` receives finalized owner input and uses the typed registry in `server/tasks/tools.ts`. The voice model talks and delivers the helper's result; it does not choose or run source tools. The host executes those tools, retains task revisions and operation receipts, and rejects stale delivery. A correction revises the work rather than starting a competing answer.

Permission belongs in `server/tasks/authority.ts`. Direct asks run without another permission question. After outside text, an isolated check sees only owner words and the effect kind. Calendar deletion alone needs a later confirmation. No tool sends a message or invites anyone. See [tool-owner.md](tool-owner.md) and [privacy-and-authority.md](privacy-and-authority.md).

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

## Host-owned task core (10.11)

`server/tasks/` owns typed tool results, the configurable text worker loop and revision lifecycle.
`runtime.ts` composes `Store`, the pure controller and the delivery interface; `call.ts` binds it to the live host.
The model port supports OpenAI Responses and Gemini generateContent over host-resolved credential references.
Each role has one provider, model id and effort configuration; the measured default is one named constant in
`tasks/model.ts`. Provider continuation retains reasoning and thought signatures. No provider call runs in the task suites.

Finalized owner words start or revise work without a language classifier. Revision cancellation stops new admissions
and aborts inference. Read results are canonically deduplicated within a revision and retained across its corrections;
effect receipts are not a read cache. A stale revision cannot deliver; a current task survives provider generation changes.
Connector, inference and revision deadlines are 12, 12 and 36 seconds. There is no call or hop cap.
The model decides queries. Mail and chat windows are query operators; calendar has typed start and end.

`results.ts` separates empty, no_match, partial and failed from successful results. Ranked knowledge and company
candidates are labelled exact or neighbour by normalized full-title equality with the query. No-match opens nothing.
Opened documents carry up to 24,000 characters per result and an explicit character cursor; search items stay concise.
`clean.ts` contains shared structural mail cleaning. `tools/live-shape.ts` retains its legacy voice limits,
calendar and attendee formatting, search projections, omission annotations and source compatibility exports until C-VOICE.

Task migrations belong to `runtime/task-schema.ts` and are applied by `Store` only. Owner words, arguments,
results and final answers use the host content-capture gate; metadata and delivery attempts remain recorded.
Content is pruned at 30 days, metadata at 90, matching trace retention. Pending operations become unknown at restart.
Closed-field `task_lifecycle` events never include queries or bodies. Delivery completion means provider timeline acknowledgement, not proof of spoken audio. The live-call integration owns actual transport acknowledgement.

### Open-line task delivery (10.11)

Finalized owner speech starts or revises the helper after 600 ms without new owner transcript.
New words restart this host-owned quiet; adapter finalization consumes the same interval, not an extra delay.
There is no lexical hesitation classifier. Stop commands,
mic pacing and barge-in retain their existing paths. Longer gaps can revise running work.

OpenAI results use commentary on the current provider generation with its latest delegation id,
or null when there is none. The host waits for owner speech and output quiet, then appends ordered
chunks of at most 450 characters. Provider timeline acknowledgement settles each chunk, not exact
transcription or proven playback. An explicit rejection retries once on the same line and then logs
failure. Delivery never reconnects, never automatically resends an acknowledged chunk and has no
heard deadline. Store records pending sends and only records delivered after provider acknowledgement.

A real socket rebuild retains the bounded transcript through rebuildSeed. Unacknowledged remainder
is appended as commentary after ready, with a null id until this generation has a delegation.
Accepted chunks are not replayed; no say-first instructions replace conversation history.
Recovery timing is unchanged. Verified helper status names whether a rebuild happened and its closed
cause; live_rebuild metadata names running_task, finished_answer_pending or nothing_owed.

A no_action result releases an open delegation with situation-only commentary: no lookup is needed,
and the voice should answer from its own mind and the conversation. Without an open delegation it
sends nothing. A no-tool complete or incomplete result is suppressed if the voice already spoke and
no delegation is open. Tool evidence is always delivered; failure and incomplete text is not rewritten.
Stale revisions never deliver. Gemini retains its tool-response route apart from the shared input quiet.

Synthetic providers prove routing, ordering, acknowledgement state, holds and bounded rejection handling.
They cannot prove audibility, exact wording, model weaving, or remembered meaning. Real-wire trials
established null-id commentary and retained history; transcript matches are not delivery receipts.
