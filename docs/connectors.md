# Adding a connector

Reader: whoever adds a new read-only source to Naya, or changes one that exists.

A connector is one more read-only source the model can search through MCP. It is not a plugin and it has no lifecycle of its own: it is a descriptor object, a tool table, a projection, a credential route class, one policy entry in the owner's MCP profile, a fake, and a check. Everything below names the file that has to change.

The one rule that shapes all of it: a connector reads. `ConnectorToolDeclaration.effect` is the literal `'read'`, the model sees only the local projection of an accepted result, and nothing in this path writes to the remote account.

## 1. Register the descriptor

`server/connectors/index.ts` holds `CONNECTOR_DESCRIPTORS`, the one map from a connector id to its `ConnectorDescriptor`:

```ts
export const CONNECTOR_DESCRIPTORS = {
  'lux-knowledge': luxKnowledgeDescriptor,
  'google': googleDescriptor,
  'mattermost': mattermostDescriptor,
  'mongoose': mongooseDescriptor,
};
```

A new connector adds a descriptor to that map and exports nothing else from it. The descriptor interface, a few lines above, is the contract:

- `id`: the connector id the profile, the log lines and the UI status all use.
- `envelope`: the read envelope, the tool names this connector may dispatch.
- `declarations(policy)`: the tool table for one approved connection policy.
- `createReader({ port, registry, endpoint, schemaDigest, generation })`: a reader bound to the approved endpoint, digest and generation, so a stale grant can never be used.
- `project(evidence, port, policy)`: the model-visible view of one accepted result.
- `status(evidence)` (optional): the connection state a non-completed result reports.
- `identity(policy)` (optional): the own-account probe, when the connector can prove which account it reads.

## 2. Write the tool map

Each connector has its own module next to the map: `server/connectors/google.ts`, `mattermost.ts`, `mongoose.ts`, `lux-knowledge.ts`. It exports the tool names as constants (for example `GOOGLE_TOOLS`) and the input shapes the reader understands.

`declarations(policy)` turns those into `ConnectorToolDeclaration` rows. Each row carries `name`, `description`, `parameters` (a JSON schema), `effect: 'read'`, an optional `guidance` line shown when the model sends an unusable argument shape, and a `validate` function. Bounds are part of the schema, so a maximum page size is refused at the tool boundary instead of after a remote call.

The envelope and the declarations must agree: a tool the model can name but the envelope does not carry is refused before dispatch.

## 3. Project the result

Projection lives in `server/tools/`, one file per connector: `projectLuxResult`, `projectGoogleResult`, `projectMongooseResult`, `projectMattermostResult`. The reader returns `ConnectorEvidence`; the projection turns it into a `ModelSnapshot` built only from locally accepted data. A projection that cannot classify the result throws (`result_projection_failed`, `unknown_source_denied`) instead of passing the remote text through.

A projection that produces a mail or calendar page also produces the scope the UI needs, so the card the owner sees is bounded markdown from the same boundary, never raw MCP content.

## 4. Declare the route class

Every connector has a data class: `ordinary` unless the owner has approved something else. The class comes from the connection profile's `sourcePolicy.unknownClass` (`server/config/mcp.ts`) and it is carried into the result snapshot as `dataClasses`. The credential binding in `server/config/route-classes.ts` names the classes a route may carry (`allowedClasses`), so a connector whose profile and route classes disagree is refused at load, not at the first call.

The data class is also what the privacy rules are written against: a private-class source is never read for a background prewarm, and the prompt composition marks the classes it is allowed to see.

## 5. Add the policy entry

A connector does nothing until the owner approves one connection for it. That entry lives in the protected MCP profile (`mcp.json`), read at startup by `server/host/mcp.ts` and validated by `server/config/mcp.ts`:

- `endpoint`: how to start or reach the server (stdio command or loopback HTTP), the account label and the resource.
- `policy`: the connection policy, including the tool names the profile approves and the `sourcePolicy` block above.
- `credentialRef` and `keyReference`: which private record holds the credential; the record itself never enters the profile.

Mongoose is three entries, not one: knowledge, data and CRM are separate OAuth resources with separate token records, and the admin endpoint is never approved. See [mcp-configuration.md](mcp-configuration.md) for the profile and its CLI.

Google is one entry per family, each its own stdio endpoint of the lux-cli Google helper (`--family gmail`, `calendar`, `drive`) with the endpoint id `gmail`, `calendar` or `drive`: the id is what maps an endpoint to its research source (`ENDPOINT_SOURCES` in `server/tools/research.ts`). The Drive family is read-only metadata (`drive_search_files`, `drive_get_file`, schemas in the lux-cli helper) and has no own-account probe, so its helper's pinned token is the account it reads. A profile without a `drive` entry is normal: a drive lookup then settles as `drive_not_available` ("Drive is not set up for me yet"), never as an empty listing. At host start a Google entry whose command, or the interpreter its first line names, sits under `~/.lux/reports` logs `google_mcp_path_unsafe` and its Settings row says how to fix it; the connector keeps running, and the install step is what repoints the command.

## 6. Fake the server

Connectors are tested against a fake, never a real account. The fake is a small stdio or loopback child under `server/test/fixtures/` (for example `google-mcp-child.mjs` and `stdio-mattermost-attention-child.mjs`) plus the contract JSON it publishes its failures from. The fixture carries the protocol evidence: the tools it advertises, the shapes it accepts, and the error codes it can return. No fixture holds a credential, owner text or a private endpoint, and the check stages its own copy of the profile so no probe writes beside the installed configuration.

## 7. Cover it with a check

A connector ships with a script under `scripts/` and a row in [checks.md](checks.md):

- `scripts/check-knowledge-connector.sh` for the local knowledge reader (`server/test/knowledge-connector.test.ts`).
- `scripts/check-google-connector.sh` for Gmail, Calendar and Drive against the stdio fixture, plus the Google helper wiring guard.
- `scripts/check-company-connectors.sh` for Mongoose and Mattermost, including Mongoose auth and the Mattermost attention scan.

The test file lives in `server/test/`, runs under the shared node test runner and uses the fake from step 6. A check joins the release gate in `checks.md` only by an owner decision; adding a connector to the gate is a release decision, not part of adding the connector.

## The Mattermost child build

The Mattermost connector reads the local archive child (`mattermost-mcp`). Every build serves the five base reads (`mattermost_whoami`, `mattermost_get_channel_history`, `mattermost_get_thread`, `mattermost_search`, `mattermost_list_channels`), and the chat read (`mattermost_chat`) works on those alone. A build with the person reads (mattermost-mcp draft PRs #67, #68 and #69, or their merge) adds what makes the person, group and channel reads exact:

| child capability | what Didi uses it for | without it |
| --- | --- | --- |
| `mattermost_resolve_person` | a spoken name to one account and its direct message channel; two people with one first name is a question back | the name must be the username, matched on the direct message channel; the reply says person lookups by name need the newer chat archive |
| `mattermost_list_channels` with `query`, `types`, `member`, `sort` | a channel by its spoken name, a group chat by its members, the conversations that moved for attention | channel names match through the one full channel list; group chats match on their member names and the reply says so; attention skips the direct and group leg and says so |
| `mattermost_conversation_overview` | everything the owner and one person exchanged: their direct messages, shared group chats and channels where both posted, with counts | both sides of the direct messages only, and the reply says an overview needs the newer chat archive |
| `attachmentText` on posts | webhook and bot posts whose words live in the attachment | those posts show their header with an empty body |

Each missing capability is named once in the reply, never replaced by a guess. Moving an installed connection to a newer build is a new connection id: delete the old `mcp.json` entry and add the new one, see [mcp-configuration.md](mcp-configuration.md).

## The clone list

| what | where |
| --- | --- |
| descriptor and map | `server/connectors/index.ts` |
| tool constants and input shapes | `server/connectors/<id>.ts` |
| projection | `server/tools/<id>.ts` |
| route classes | `server/config/route-classes.ts` |
| profile and validation | `mcp.json`, `server/config/mcp.ts`, `server/host/mcp.ts` |
| fake | `server/test/fixtures/` |
| test | `server/test/<id>-connector.test.ts` |
| check | `scripts/check-<id>-connector.sh` |
