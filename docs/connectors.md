# Connected sources and connector development

A connected source is an account or service Naya can consult through a host-approved tool. MCP, the Model Context Protocol, supplies the transport and remote tool descriptions; it does not grant authority by itself. Start with [mcp-configuration.md](mcp-configuration.md) to configure an existing source, or [user-guide.md](user-guide.md) to sign in.

## Available sources

| Source | Local implementation | Purpose |
| --- | --- | --- |
| Lux Knowledge | `server/connectors/lux-knowledge.ts` | Search and retrieve knowledge evidence |
| Gmail, Calendar and Drive | `server/connectors/google.ts` | Google account reads; each family has its own endpoint |
| Mattermost | `server/connectors/mattermost.ts` | Read people, channels, threads and attention evidence |
| Mongoose | `server/connectors/mongoose.ts` | Read the separately approved knowledge, data and CRM endpoints |

Each Mongoose endpoint is its own connection, so one unsigned endpoint never hides another: `mongoose-knowledge`
serves the research `company` source, `mongoose-data` serves the research `data` source (company numbers), and an
unsigned `mongoose-crm` disables only the CRM reads.

A forwarded Mongoose tool reaches the planner with the input schema and description the endpoint published in its
own MCP tool list, sanitized for the provider (integer bounds only, no keyword the provider rejects). The catalogue
is taken at connect time; a schema that cannot be sanitized fails that connect with the closed code
`schema_unsanitizable`, never as an empty schema. A count read (`run_metric_query`) without a date dimension and a
date filter is refused by the host with `count_needs_date_window`, because the undated query returns an all-time sum
rather than a user count.

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

## One owner account, proven before every use

Every identity-bearing connector acts as the one owner email in `ownerIdentity` of `provider-38/mcp.json` (`rob@plantix.net` today) and never as another account. The comparison is exact and case-insensitive on the EMAIL: a connector that reports an email must match it, so a matching username never carries a different mailbox (`server/connectors/identity.ts`).

- Gmail proves itself with the profile's `emailAddress`, Calendar with the primary calendar id, and Mattermost with the session email (its username only when the session reports no email at all).
- Drive proves itself from the helper's own account pin, `helper_pin`: the lux-cli helper compares every refreshed `id_token`'s verified address with `LUX_GOOGLE_MCP_ACCOUNT` and refuses every read otherwise (`tools/google-mcp/google_mcp/creds.py`, `assert_identity`, raising `AccountMismatch`/`IdentityUnverified`). Didi therefore requires each Google child's `LUX_GOOGLE_MCP_ACCOUNT` to equal `ownerIdentity` exactly (case-insensitive) when the catalog loads, and refuses a child pinned to any other account with `identity_mismatch` before it spawns. Drive stays strict, and the helper's `account_mismatch` or `identity_unverified` is its runtime refusal.
- Mongoose proves itself from the access token it was minted (`email` plus that endpoint's exact `aud`) after the PKCE code exchange and after every refresh, with no `get_started` probe. The claim names and audience strings live in `server/test/fixtures/mongoose-token-claims.json` with the commit they were read from (Mongoose `backend/src/mongoose/auth/tokens.py`, `issue_mongoose_access_token`). The sign-in also sends `expected_email` and `login_hint`; Mongoose refuses a different Google account before it mints a code and returns `error=access_denied&mongoose_error=account_mismatch`, which Didi reports as its own outcome.
- An identity failure is terminal for that endpoint: the endpoint latches until an explicit sign-in or a host restart, writes one `connector_latched` line with a closed code, and is never re-probed by the recovery round or by an owner turn. A tool call routed to a latched endpoint fails with that code, and the other endpoints keep working.
- A sign-in always ends in the log: `signin_finished` with `signed_in` or a closed failure, and a sign-in that never receives its callback ends in `signin_callback outcome=timeout`.
- A sign-in to one Mongoose endpoint connects that endpoint in place, with no relaunch: the host reconnects the endpoint and writes `connector_connected` or a `connector_failure` with its closed code. When the reconnect leaves it unconnected, the host also writes `signin_needs_restart` with the row's own reason, and the Settings row says so.
- Each Mongoose endpoint writes one `connector_identity` line (connector, endpoint, `proven`, `match`) at its first connect and after every token refresh, from the check of its own minted JWT. The proven owner email is kept in the endpoint's private record, so the Settings row says who it is signed in as; the log never carries the address.
- On the call after a Mongoose endpoint comes up, Naya has one sentence naming what became connected and who it connected as, and says it once.

## Keep one owner per contract

- Protocol and accepted-result mechanics: [mcp-adapter.md](mcp-adapter.md).
- Lux Knowledge operations and evidence: [lux-knowledge-connector.md](lux-knowledge-connector.md).
- Which tool may read, open or write: [tool-owner.md](tool-owner.md).
- Data-class and owner-approval rules: [privacy-and-authority.md](privacy-and-authority.md).

Changing a helper's build does not authorize expanding its stored tool grant. Review the new declarations and connection approval through the host, even when the remote service has the same name.
