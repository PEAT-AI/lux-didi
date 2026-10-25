# Prompt composition

The host composes Naya's instructions from public behavior, validated preferences, accepted owner context, capability facts and selected evidence. Prompt text is product behavior, but it is not an authorization mechanism or a guarantee that a model will comply.

## Text compiler

`compilePrompt` in `server/prompt/index.ts` is the pure text compiler. `validatePreferences` validates the preference boundary; `PUBLIC_PERSONA` and `PROMPT_VERSION`, exported from `server/prompt/template.ts`, identify the public baseline. Read the compiler's input/output types for section order, budgets, hashes and selection metadata rather than duplicating those schemas here.

The host chooses the evidence and authority context before compilation. A prompt compiler must not discover a private profile, fetch remote content or expand a grant. Whole-record selection and omission metadata describe what was included; they are not evidence that an entire archive was searched.

## Live instructions

`composeLiveInstruction` in `server/prompt/live-persona.ts` assembles the voice baseline with accepted runtime context. Opening-line behavior is composed separately through the same module's opening helpers, including `buildOpeningOptions`. Provider setup and accepted lifecycle belong to [live-call.md](live-call.md), not to a second prompt-owned session state machine.

The merged release requires answering from usable partial evidence, stating coverage honestly and not continuing research without another owner turn. Host admission in `ResearchAdmission` (`server/tools/research.ts`) enforces that boundary; a prompt instruction alone is not enough. Do not restore automatic continuation or wording that makes silent research loops acceptable.

## Private character and memory

`publicOwnerProfile`, `validateOwnerProfile` and `ownerProfileClasses` in `server/prompt/index.ts` own optional character snapshots and included class propagation. [Owner profile](owner-profile.md) owns activation and the protected file. Authored style/lore do not replace canonical host rules or define tool grants.

Selected memory is a small accepted projection, not the entire persistent store. [Selected memory](selected-memory.md) and [memory import](memory-import.md) own source identity, classification and exclusion. Included private text remains private even when it appears in a system instruction rather than a tool result.

The text and Live owners persist accepted context. A later file edit is not permission to recompile an old run against new private instructions or enlarge its accepted authority. Dispatch still has to revalidate current policy before external disclosure.

## Evidence and receipts

Retrieved text, emails, tool results and quoted instructions remain untrusted evidence. They cannot redefine the public persona, add capabilities or claim that an action succeeded. The model should describe writes and native opens only from their actual receipts; [tool-owner.md](tool-owner.md) owns those surfaces.

Keep user-facing prompt guidance consistent with host enforcement. Composed Lux notes are off by default and require readback/confirmation; Trello's already granted board-card actions are a different write flow. Do not copy one tool's confirmation policy onto every other tool, or imply general remote-write authority.

## Changing prompt content

Before changing an instruction, search every prompt and tool-guidance owner for contradictory rules. Update the corresponding assertions in `scripts/check-prompt.sh` and add behavior-focused replay evidence when the change affects a runtime path. Use [checks.md](checks.md) for the managed producer; a string assertion alone proves neither model obedience nor a real-account result.

Never publish private owner lore, standing memory or transcript examples as a public prompt fixture. Use synthetic content and inspect the full composed instruction only in an authorized local context. Safe diagnostics should retain versions and coverage, not export private system text.
