# Protected local owner character

Lux Didi can optionally use one explicitly selected, protected local JSON file for authored presentation style and background lore. The product and stored assistant identity remain Lux Didi. A display label is presentation only, not a new assistant/account identity.

## Explicit activation

The service CLI accepts `--owner-profile PATH` alongside its existing options. The flag selects exactly that file; there is no directory discovery, marker, environment/global setting, browser override or hot reload. Omission intentionally uses the public/default character. The host reads and validates once, outside a Store transaction, and shares an immutable snapshot with text and Live. Deliberate restart reloads the file for new acceptances, not historical runs.

The file must be a single-link regular file owned by the service user, mode `0600`, in a directory owned by that user, mode `0700`. Neither may be a symlink. Ancestors are trusted under the existing protected-config boundary; same-user ancestor replacement is not an operating-system sandbox. A selected missing, unsafe, invalid or oversize file produces a safe activation error and prevents inference. It never silently selects defaults. Do not commit a real profile to source control.

## Closed JSON schema

This example is entirely synthetic:

```json
{
  "schemaVersion": 1,
  "kind": "profile",
  "profileVersion": "example-v1",
  "displayName": "Example Companion",
  "ownerId": "the-local-store-assistant-id",
  "style": { "text": "Speak warmly and clearly.", "dataClass": "private" },
  "lore": { "text": "A fictional companion from a quiet library.", "dataClass": "sensitive" }
}
```

All fields are required and additional fields are rejected, including in `style` and `lore`. The owner ID must exactly match the local Store; this does not change it. Schema version is integer `1` and the file discriminator is `profile`. Each classification must be exactly `ordinary`, `private` or `sensitive`; unknown labels are errors. Both style and lore contribute classes, even though they enter system text. Classifying private material as ordinary does not make it public: choose labels conservatively.

`profileVersion` is nonempty and at most 80 UTF-16 code units. `displayName` is nonempty, trimmed, control-character-free, at most 80 UTF-16 code units. Each authored text is at most 4,096 UTF-16 code units (empty strings allowed); the complete file is at most 65,536 bytes and must be valid UTF-8 JSON. These are upper bounds, not guaranteed capacity: the complete canonical prompt must also fit the existing text/voice budgets. In particular, Live's complete accepted instruction is limited to 4,096 code units. Oversize instructions fail; authored content is never truncated.

## Authority and provider gating

Authored style and delimited background are not a replacement system prompt or a tool/grant configuration. Didi continues to generate canonical runtime rules, actual capability/source availability, epistemic boundaries, memory coverage and valid receipt rules. The same compiler assembly supplies text and turn-less voice instructions. Outgoing class sets include every included style, lore, preference, evidence/history or audio input class. Existing route/consent/grant gates must permit the whole set before inference; no extra classification or unknown-to-ordinary conversion exists.

## Durable acceptance

Chat migration 4 binds a closed snapshot to each new run in the same transaction as the run/entry/policy/frozen memory. Replay retains that snapshot; an explicit retry is a new acceptance and may bind a newer profile. Dispatch reads the accepted row, not the file or mutable current config. Migration backfills genuinely pre-profile runs with an explicit public/default selection. Missing or corrupt new bindings fail closed. Existing interrupted-run recovery behavior is unchanged.

Live migration 2 stores a versioned exact accepted instruction, its owner snapshot, generic compiler version and full included class set before dispatch intent. Open uses the accepted instruction and classes, with current route/grant/epoch validation. Changed routes and terminal/recovered lifecycles still refuse honestly; there is no silent recompilation, retry or automatic resume. Nullable pre-migration instructions are documented legacy records and cannot be opened against a current private character: they refuse as invalidated rather than invent a missing instruction. Create a new session explicitly.

The typed public `ownerProfile` status projection supplies the current display label independently of provider/model configuration, including when providers are unconfigured. Public status exposes only safe current activation state and display label; no authored text, profile path, private version/hash or accepted record is exposed in status/ready/errors/receipts. Current UI headings use the display label, while stored historical records/titles/assistant IDs are unchanged. There is no claim of account setup, installation completion, listening, provider availability, model obedience, identical speech or automatic memory access. Structural tests establish assembly, persistence and pre-egress boundaries, not how a model will behave.
