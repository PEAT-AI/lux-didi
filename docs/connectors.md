# Adding a connector

Reader: whoever adds a new read-only source to Naya, or changes one that exists.

A connector is one more read-only source the model can search through MCP. It is not a plugin and it has no lifecycle of its own: it is a descriptor object, a tool table, a projection, a credential route class, one policy entry in the owner's MCP profile, a fake, and a check. Everything below names the file that has to change.

The one rule that shapes all of it: a connector reads. `ConnectorToolDeclaration.effect` is the literal `'read'`, the model sees only the local projection of an accepted result, and nothing in this path writes to the remote account.

Trello is deliberately not a connector in this sense. The official Trello MCP server dispatches by `action` with ARI ids, and the owner granted card writes on his one board, so it follows the gateway tool pattern of the vault note instead: a host-owned client, two gateway tools with closed schemas, and the board pin on Didi's side. The board name it pins is the owner's private `trello-board.json`, never a string in this repository (W7-R2). [tool-owner.md](tool-owner.md#the-trello-board-w7) owns it; its sign-in shares the OAuth client of the Mongoose endpoints ([mcp-configuration.md](mcp-configuration.md#the-trello-board-sign-in)).

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

## 6. Fake the server

Connectors are tested against a fake, never a real account. The fake is a small stdio or loopback child under `server/test/fixtures/` (for example `google-mcp-child.mjs` and `stdio-mattermost-attention-child.mjs`) plus the contract JSON it publishes its failures from. The fixture carries the protocol evidence: the tools it advertises, the shapes it accepts, and the error codes it can return. No fixture holds a credential, owner text or a private endpoint, and the check stages its own copy of the profile so no probe writes beside the installed configuration.

## 7. Cover it with a check

A connector ships with a script under `scripts/` and a row in [checks.md](checks.md):

- `scripts/check-knowledge-connector.sh` for the local knowledge reader (`server/test/knowledge-connector.test.ts`).
- `scripts/check-google-connector.sh` for Gmail and Calendar against the stdio fixture.
- `scripts/check-company-connectors.sh` for Mongoose and Mattermost, including Mongoose auth and the Mattermost attention scan.

The test file lives in `server/test/`, runs under the shared node test runner and uses the fake from step 6. A check joins the release gate in `checks.md` only by an owner decision; adding a connector to the gate is a release decision, not part of adding the connector.

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
