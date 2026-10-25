# Privacy and authority

Lux Didi keeps its durable state on the Mac, but configured voice and text providers receive the context needed for their requests. "Local application" does not mean "offline inference". Connector reads and optional writes also contact their configured services. This page describes implemented boundaries, not the broader historical product-policy proposal.

## Configuration is not consent

The installer preserves configuration; it does not create provider keys, sign in to connected accounts or approve new data routes. The owner selects protected configuration explicitly. See [provider-configuration.md](provider-configuration.md), [mcp-configuration.md](mcp-configuration.md) and [macos-install.md](macos-install.md).

Three decisions remain separate:

1. A credential identifies the configured provider or source account.
2. A connection policy permits particular source tools and data classes.
3. A model route and its consent permit particular classes to leave for inference.

A reachable endpoint or valid token does not substitute for all three. `server/host/mcp.ts` owns MCP connection approval; `server/tools/index.ts` owns accepted tool context and result release. `ToolResultGate` in `server/adapters/model/types.ts` is the text-loop disclosure boundary. Unknown classification must not be relabeled ordinary to make a request work.

## Models and remote text do not grant authority

Tool arguments and results are untrusted. A document, email or model answer cannot add a tool, change its account or approve a write. Host validators and current grants govern dispatch. A prose claim that something was saved or opened is not a receipt.

`ConnectorToolDeclaration.effect` in `server/connectors/index.ts` restricts registry connectors to reads. Other host-owned tools have narrower write authority, described below; there is no general permission to send mail, run shell commands or modify an arbitrary connected account.

## The supported write boundaries

| Action | Authority and limit |
| --- | --- |
| Local memory | A local record, not a write to its original external source; inspect it in Memory |
| Dictated Lux note | The owner asks to save the dictated text; `server/tools/vault-write.ts` owns this flow |
| Composed Lux note | Explicitly enabled, staged, read back and confirmed before creation; `server/tools/lux-note.ts` owns the state machine |
| Trello card change | An owner-requested action on the privately pinned board; `server/tools/trello.ts` owns the exposed actions |
| Native open | An allowed native action, not arbitrary application automation; `server/tools/open.ts` and `Sources/LuxDidi/NativeActions.swift` own it |

Composed notes default **off**: `liveFeatures` in `server/live/config.ts` returns `composedNotes: false` unless enabled. `STAGE_NOTE_IDENTITY` identifies `stage_lux_note`; staging alone does not save. `noteOwnerUtterance` and `noteOwnerFragment` handle confirmation and interruption, rather than treating any earlier "yes" in a conversation as authorization.

Trello's `TRELLO_WRITE_ACTIONS` is a closed surface. The board pin is configured privately through `TRELLO_BOARD_FILE` in `server/host/trello.ts`. Do not publish its real name or infer board administration, member changes or permanent deletion from the fact that card writes are available. Already granted card actions do not use the composed-note confirmation flow. Unknown write outcomes must remain unknown, not be retried as if nothing happened.

## Conversation consent and audio

Text conversation consent is enforced by `ChatService` in `server/chat/index.ts`. A remembered disclosure is a server-side scoped grant, not a browser preference. It does not enroll Live voice, grant microphone access or broaden a connector approval.

The Mac's microphone permission and native audio owner are separate again. `AudioOwner` in `Sources/LuxDidi/AudioOwner.swift` owns capture and playback. Muting Naya does not authorize changing system audio settings or another application's devices. See [mac-experience.md](mac-experience.md).

## Local records and deletion

Deleting a memory removes that local memory from future reads. It does not delete the remote source, an old conversation that quoted it, a provider's already received request, a filesystem snapshot or a backup.

The authenticated entry-delete path in `server/http/server.ts` composes domain deletion with retained-context and cached-response redaction. `scrubDeletedMemoryResponses` in `server/runtime/store.ts` removes stale cached response content without re-executing the original mutation. Errors roll back the transaction rather than claiming a partial deletion as complete.

An already open provider connection can still hold the deleted note. The response field `liveSessionRetainsUntilRebuild` makes that limit explicit. Stop and restart Live to discard the current provider context; local redaction cannot un-send data already disclosed. See [selected-memory.md](selected-memory.md) for the memory-selection boundary.

## Diagnostics and publication

Operational logs and metadata exports are designed to use safe codes, counts, IDs and timings. The database also contains private conversation and result content: it is not a safe support attachment merely because some tables are content-free. Follow [debugging.md](debugging.md) and [diagnostic-store.md](diagnostic-store.md); prefer the app's Copy diagnostics flow to copying arbitrary logs or database rows.

Never publish real credentials, private profiles, board names, account content, transcript text or private machine paths in this public repository. `scripts/check-docs.sh` catches dash and home-path patterns in current documentation; it is not a semantic privacy audit. Human review still has to catch private names and content.

## Honest limits

Same-user process separation is not an operating-system sandbox. Data-class enforcement is routing policy, not perfect sensitivity detection. Prompt-injection immunity, forensic erasure, guaranteed notification delivery and universal provider availability are not claimed. Future policy belongs in [roadmap.md](roadmap.md), not in descriptions of the installed release.
