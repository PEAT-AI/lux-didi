# Connected sources and connector development

A connected source is an account or service Naya can consult through a host-approved tool. MCP, the Model Context Protocol, supplies the transport and remote tool descriptions; it does not grant authority by itself. Start with [mcp-configuration.md](mcp-configuration.md) to configure an existing source, or [user-guide.md](user-guide.md) to sign in.

## Available sources

| Source | Local implementation | Purpose |
| --- | --- | --- |
| Lux Knowledge | `server/connectors/lux-knowledge.ts` | Search and retrieve knowledge evidence |
| Gmail, Calendar and Drive | `server/connectors/google.ts` | Google account reads; each family has its own endpoint |
| Mattermost | `server/connectors/mattermost.ts` | Read people, channels, threads and attention evidence |
| Mongoose | `server/connectors/mongoose.ts` | Read the separately approved knowledge, data and CRM endpoints |

`CONNECTOR_DESCRIPTORS` in `server/connectors/index.ts` is the registry. These descriptors are read-only: `ConnectorToolDeclaration.effect` is `'read'`. Do not infer that all host tools are read-only. Trello is a separate host gateway in `server/host/trello.ts`, with a privately configured board (`TRELLO_BOARD_FILE`), rather than another descriptor in this registry. Its write authority and the note-writing flows belong in [tool-owner.md](tool-owner.md).

## Add or change a descriptor

1. Implement the contract named `ConnectorDescriptor` in `server/connectors/index.ts`, then register it in `CONNECTOR_DESCRIPTORS`. Read the interface rather than copying an older schema from documentation.
2. Define the remote tool names, schemas and argument validation in `server/connectors/<source>.ts`. The declared tool names must fit the connector's read envelope.
3. Project accepted evidence in `server/tools/<source>.ts`. Existing boundaries are `projectLuxResult`, `projectGoogleResult`, `projectMongooseResult` and `projectMattermostResult`; a remote response is not automatically model-visible evidence.
4. Configure the connection through `server/config/mcp.ts` and the route classes through `server/config/route-classes.ts`. Load and approval are owned by `server/host/mcp.ts`. Follow [mcp-configuration.md](mcp-configuration.md) rather than adding a token to a profile or repository file.
5. Add synthetic fixtures under `server/test/fixtures/` and tests under `server/test/`. No real account or credential belongs in a connector check. Use [checks.md](checks.md) for the repository's check routing.

For Google, endpoint identity is also routing identity: `ENDPOINT_SOURCES` in `server/tools/research.ts` maps `gmail`, `calendar` and `drive` to the corresponding research source. A new endpoint name is not interchangeable with one of those names.

## Capability differences are visible

A connected Mattermost archive may not expose every newer person or conversation read. The implementation must report that limitation instead of inventing a match. `server/connectors/mattermost.ts` owns capability handling, and `server/tools/mattermost.ts` owns the resulting projection. Do not use a draft PR number as a runtime capability test.

Mongoose knowledge, data and CRM are separate OAuth resources with separate sign-ins. The admin endpoint is not a supported source. A successful sign-in to one resource is not proof that another is ready.

Drive setup is optional and requires its own consent. When it is unavailable, a lookup must report that limitation, not turn it into a successful empty search. [mcp-configuration.md](mcp-configuration.md) owns setup details; [debugging.md](debugging.md) owns failure diagnosis.

## Keep one owner per contract

- Protocol and accepted-result mechanics: [mcp-adapter.md](mcp-adapter.md).
- Lux Knowledge operations and evidence: [lux-knowledge-connector.md](lux-knowledge-connector.md).
- Which tool may read, open or write: [tool-owner.md](tool-owner.md).
- Data-class and owner-approval rules: [privacy-and-authority.md](privacy-and-authority.md).

Changing a helper's build does not authorize expanding its stored tool grant. Review the new declarations and connection approval through the host, even when the remote service has the same name.
