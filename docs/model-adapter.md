# Text model adapter

The text model adapter is the host's asynchronous model boundary. It is separate from the live voice adapters in `server/adapters/live-voice/`; a voice-provider choice does not imply that text chat uses the same provider.

## Components

`server/adapters/model/index.ts` exports the public surface:

| Symbol | Role |
| --- | --- |
| `ModelPort` | Generate from a host-authored request and explicit control |
| `GeminiAdapter` | Translate that request to Gemini's streaming HTTP API |
| `runTools` | Validate and orchestrate model-requested tools |

Exact request, result, event and tool contracts live in `server/adapters/model/types.ts`. Transport implementation belongs in `gemini.ts`; tool-loop policy belongs in `loop.ts`. Do not copy their schemas into another layer.

## Configuration and disclosure

The host supplies the model, credential reference, route, data classes, selected context and cancellation/deadline control. The adapter is not an account sign-in mechanism or an automatic model-discovery service. [provider-configuration.md](provider-configuration.md) owns operator setup; [prompt-composition.md](prompt-composition.md) owns the prompt inputs.

`GeminiAdapter` sends the credential using `x-goog-api-key`, not a query parameter, and disables redirects. The injected transport is a trusted in-process seam because it can see that credential. Never expose it as an arbitrary operator-configured URL or log the serialized request.

Streamed text is provisional. The adapter distinguishes a validated `STOP` from truncated output, cancellation, deadline and provider failures. Opaque provider continuation parts must remain host-side; they are not UI text or diagnostic material.

## A tool request is not authority

The loop uses an explicit tool registry, argument validators, host-bound identity and current authority. A function call from a model cannot add a tool or expand a grant.

`ToolCallJournal` records intent before dispatch. `ToolResultRef` identifies accepted journaled results rather than carrying arbitrary handler output directly into a later provider request. An existing intent is not permission to repeat an uncertain effect.

`ToolResultGate` is mandatory: the host must reauthorize references, route and classes before disclosure. Handler success alone does not prove that a result is authorized for the next model request. Tool output remains untrusted evidence, never a system instruction.

For an explicit continuation, the host carries selected provider contents together with their matching `carriedResults` bindings. `LoopResult.continuation` and `LoopResult.resultBindings` remain host-only. Do not blindly replay an interrupted batch with pending calls, or infer a successful write from a final prose answer.

## Integration and verification

`ChatService` in `server/chat/index.ts` is the text-conversation integration owner. Durable records, consent and production effects belong to the host, not this adapter; see [text-chat.md](text-chat.md) and [tool-owner.md](tool-owner.md).

`bash scripts/check-model.sh` is the focused offline adapter check. Consult [checks.md](checks.md) for routing before running it. Synthetic HTTP and stream fixtures prove contract handling, not model availability to a real key. This documentation change does not claim a live provider request or a fresh model-check run.
