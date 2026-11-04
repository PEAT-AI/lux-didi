# Privacy and authority

Lux Didi keeps its durable state on the Mac, but configured voice and text providers receive the context needed for their requests. "Local application" does not mean "offline inference". Connector reads and optional writes also contact their configured services. This page describes implemented boundaries, not the broader historical product-policy proposal.

## Configuration is not consent

The installer preserves configuration; it does not create provider keys, sign in to connected accounts or approve new data routes. The owner selects protected configuration explicitly. See [provider-configuration.md](provider-configuration.md), [mcp-configuration.md](mcp-configuration.md) and [macos-install.md](macos-install.md).

Three decisions remain separate:

1. A credential identifies the configured provider or source account. Every identity-bearing connector proves the one owner email (`ownerIdentity`) before use and after every token refresh: Gmail, Calendar, Mattermost and Drive from the account the helper answers for, Mongoose from the `email` and `aud` claims of its own minted access token. A connector that cannot prove it is refused, and an endpoint that proves another account stays refused until an explicit sign-in.
2. A connection policy permits particular source tools and data classes.
3. A model route and its consent permit particular classes to leave for inference.

A reachable endpoint or valid token does not substitute for all three. `server/host/mcp.ts` owns MCP connection approval; `server/tools/index.ts` owns accepted tool context and result release. `ToolResultGate` in `server/adapters/model/types.ts` is the text-loop disclosure boundary. Unknown classification must not be relabeled ordinary to make a request work.

## Models and remote text do not grant authority

Tool arguments and results are untrusted. A document, email or model answer cannot add a tool, change its account or approve a write. Host validators and current grants govern dispatch. A prose claim that something was saved or opened is not a receipt.

`ConnectorToolDeclaration.effect` in `server/connectors/index.ts` restricts registry connectors to reads. Other host-owned tools have narrower write authority, described below; there is no general permission to send mail, run shell commands or modify an arbitrary connected account.

## The supported write boundaries

`server/tasks/tools.ts` declares reads and effects. Local memories and chat drafts stay on the Mac. An email draft is created through the configured Google source, never sent. Calendar creation supplies no attendees. Trello changes use only the pinned board's declared actions. A vault save uses the configured vault writer; a local staged note is not a remote save. No action sends, posts, invites, accepts an invitation or pays.

The helper may perform an asked action immediately. `server/tasks/authority.ts` owns permission and the operation journal. A stable operation identity prevents an uncertain or pending outcome from becoming permission to execute twice. The model's prose is never proof of success.

After outside mail, chat, web, Drive or company text, including retained outside evidence, an isolated check compares the owner's finalized words with the effect kind. It sees no targets, payloads or outside text. The answer is cached for that task revision and kind. A failed effect check logs failure and permits the effect, an explicit availability tradeoff, not an injection-immunity guarantee.

Deleting a calendar event stages its exact id and requires a later owner turn. The isolated confirmation check sees the latest owner words and the confirmation kind. A failed confirmation check refuses deletion. Ending the call clears the pending confirmation.

After outside text, a web open must also match a URL exactly from a tool result or canonical connector link. The host does not repair a synthesized URL. Web search removes address-bearing query tokens after outside exposure. These restrictions do not make outside text trustworthy.

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

Legacy local memories remain available for recall. Closing a call never automatically exports them. An asked vault save runs through the task permission and receipt boundary, not a phrase test or a spoken readback ceremony.

## Opening things on the Mac

`open(kind, target)` opens a web address or named site, an installed application, a readable local path or a shown source handle. There is no destination allowlist or home-folder restriction. URLs carrying credentials are refused. A missing file or application returns `not_found`; native failures never imply success. Opening never types, clicks, sends or edits. Host task authority still applies.

`find_file(query)` uses Spotlight without a shell. It returns paths, names and modification dates, not file bodies. Content-only matches are outside text; name matches are not. Empty results and unavailable Spotlight are distinct outcomes.
