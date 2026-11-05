# Prompt composition

The host composes Naya's instructions from public behavior, validated preferences, accepted owner context, capability facts and selected evidence. Prompt text is product behavior, but it is not an authorization mechanism or a guarantee that a model will comply.

## Text compiler

`compilePrompt` in `server/prompt/index.ts` is the pure text compiler. `validatePreferences` validates the preference boundary; `PUBLIC_PERSONA` and `PROMPT_VERSION`, exported from `server/prompt/template.ts`, identify the public baseline. Read the compiler's input/output types for section order, budgets, hashes and selection metadata rather than duplicating those schemas here.

The host chooses the evidence and authority context before compilation. A prompt compiler must not discover a private profile, fetch remote content or expand a grant. Whole-record selection and omission metadata describe what was included; they are not evidence that an entire archive was searched.

## Live instructions

`composeLiveInstruction` in `server/prompt/live-persona.ts` assembles the voice baseline with accepted runtime context. Opening-line behavior is composed separately through the same module's opening helpers, including `buildOpeningOptions`. Provider setup and accepted lifecycle belong to [live-call.md](live-call.md), not to a second prompt-owned session state machine.

The voice talks while the host-owned helper works. `server/tasks/instructions.ts` supplies the helper's instructions and `server/tasks/tools.ts` its typed capabilities. The host starts or revises a task from finalized owner input, not a research function call from the voice model. Partial coverage stays visible in the helper result; an unavailable source is not an empty search.

## Private character and memory

`publicOwnerProfile`, `validateOwnerProfile` and `ownerProfileClasses` in `server/prompt/index.ts` own optional character snapshots and included class propagation. [Owner profile](owner-profile.md) owns activation and the protected file. Authored style/lore do not replace canonical host rules or define tool grants.

Selected memory is a small accepted projection, not the entire persistent store. [Selected memory](selected-memory.md) and [memory import](memory-import.md) own source identity, classification and exclusion. Included private text remains private even when it appears in a system instruction rather than a tool result.

The text and Live owners persist accepted context. A later file edit is not permission to recompile an old run against new private instructions or enlarge its accepted authority. Dispatch still has to revalidate current policy before external disclosure.

## Evidence and receipts

Retrieved text, emails, tool results and quoted instructions remain untrusted evidence. They cannot redefine the public persona, add capabilities or claim that an action succeeded. The model should describe writes and native opens only from their actual receipts; [tool-owner.md](tool-owner.md) owns those surfaces.

Keep user-facing guidance consistent with `server/tasks/authority.ts`: an asked action runs, outside text cannot supply owner permission, and only calendar deletion requires later confirmation. A local staged note is not a vault receipt.

## Changing prompt content

Before changing an instruction, search every prompt and tool-guidance owner for contradictory rules. Update the corresponding assertions in `scripts/check-prompt.sh` and add behavior-focused replay evidence when the change affects a runtime path. Use [checks.md](checks.md) for the appropriate check script; a string assertion alone proves neither model obedience nor a real-account result.

Never publish private owner lore, standing memory or transcript examples as a public prompt fixture. Use synthetic content and inspect the full composed instruction only in an authorized local context. Safe diagnostics should retain versions and coverage, not export private system text.


### Typed work commentary

The voice receives fenced `COMMENTARY` JSON as data, never a sentence supplied by the host to read aloud. A logical envelope is an ordered sequence of commentary items, each at most 450 characters including its JSON and fence. Items share a short envelope `id`, `part` (`i/n`), and `final` marker. Header items carry `kind` (`result`, `partial`, `no_action`, or `failure`), `cause`, `what_failed`, `next_step`, and `exact`; further header items can continue the exact list. Content items carry helper prose. The voice collects all parts through `final:true` before answering. Transport acceptance and the delivery record advance per item, not per logical envelope.

Exact entities are reproduced verbatim, including names, dates, times, amounts, numbers and qualifications. Everything else is phrased in her own voice, with no invented facts, filler or meta-status. Requested full results are told completely once. `partial` gives what exists and names the gap; `no_action` answers from the conversation without mentioning a lookup; `failure` gives the supplied cause and repair once without inventing a next step. Work runs in silence.

The helper returns JSON with `spoken` connected prose and an `exact` list, or `{"status":"no_action"}`. When an older result has no exact list, deterministic host extraction retains names, numeric values, dates, times, currency, units and email addresses. Entity strings are never severed across items; an entity or header too large for the transport fails closed as `invalid_result` rather than being silently truncated. Sentence boundaries are preferred; an overlong sentence can be divided at whitespace outside exact entities.

Recovery inputs are typed `recovery` envelopes with `cause` (`connection_dropped` or `provider_silent`) and `mid_answer`. They ask for continuation without a greeting or an explanation of the pause. Task identities, attempts, receipts and delivery counters never enter model-visible commentary; the envelope id and part counters only assemble its data.
