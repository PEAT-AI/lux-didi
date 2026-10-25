# Text chat

Text conversation is a durable host-owned path, separate from a live voice call. `ChatService` in `server/chat/index.ts` owns acceptance, dispatch, completion, consent and subscriptions. The web interface presents its state; it must not invent a saved answer from provisional text.

## User flow

Open the full Naya window, configure a text provider and start a connected conversation. The disclosure identifies the provider and route before sending conversation content. Local notes and imported history are not silently enrolled as a new connected conversation.

A send accepts a user entry and run durably. Partial answer text and tool-step updates can appear while the run is active. A failed acceptance should preserve the draft; an uncertain dispatched run must not be automatically resent by a reload, focus event or reconnect. Check saved history before explicitly trying again.

A standing disclosure is optional server-side consent, scoped to the accepted provider/route/model/class policy. It is not localStorage authority and does not grant Live microphone or connector access. See [privacy-and-authority.md](privacy-and-authority.md).

## State and persistence

| Contract | Source |
| --- | --- |
| Service and consent resolution | `ChatService` in `server/chat/index.ts` |
| Runs and accepted inputs | `RunSnapshot`, `AcceptInput` in `server/chat/types.ts` |
| Stream/subscription events | `ChatEvent`, `ConversationEvent`, `ChatStepEvent` in `server/chat/types.ts` |
| Tables and migrations | `chatMigrations` in `server/chat/schema.ts` |
| Context selection and compilation inputs | `server/chat/context.ts` |
| HTTP and stream projection | `server/http/server.ts` |

Read these types rather than maintaining a second event union or SQL schema here. Run identity differs from conversation session identity. Durable final completion and a streamed partial answer are different observations.

## Context and source tools

Accepted context freezes selected memory, owner profile and authority inputs for that run. Dispatch must revalidate current authority before disclosure; a frozen acceptance is not permission to use a revoked source. [Selected memory](selected-memory.md) owns selection and deletion; [owner profile](owner-profile.md) owns authored-character snapshots.

Text can use approved read tools through the host's `ChatToolsComposition`. That type shares the host's tool-composition boundary rather than creating a second MCP client. The shipped train also handles composed reads at the tool door; old statements that this integration belongs only to a future owner are no longer a valid description of the merged source.

Tool results are evidence, not authority or proof of an effect. Text dispatch uses the model adapter's journal and result gate; [model-adapter.md](model-adapter.md) owns that contract and [tool-owner.md](tool-owner.md) owns the tool surface.

## Steps, partial answers and recovery

`ChatStepEvent` identifies progress for a tool step; it does not make a final answer durable. The UI should render actual step/outcome data and retain failures rather than treating the model's final prose as proof that every requested tool succeeded.

Restart recovery must report an interrupted dispatched turn honestly. Cancelling can stop further work, but cannot retract bytes already sent to a provider or prove that a dispatched effect never happened. Do not automatically replay a non-complete continuation with pending calls.

## Verification and diagnosis

Use [checks.md](checks.md) for focused chat/connected checks, [local-development.md](local-development.md) for an isolated host and browser prerequisites, and [diagnostic-store.md](diagnostic-store.md) for inspecting a specific chat run. Synthetic adapters and browser fixtures prove contract handling, not that an owner's real provider key is valid.
