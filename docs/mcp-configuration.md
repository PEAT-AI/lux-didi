# MCP configuration and sign-in

MCP is the Model Context Protocol, used to call a connected service's tools. A configured endpoint, an authenticated account and an approved read policy are separate requirements. For a first run, use [user-guide.md](user-guide.md); this page owns the protected configuration and approval mechanics.

## Protected configuration

The owner supplies `mcp.json` in the selected configuration directory. Use directory mode `0700` and private file mode `0600`; never embed a token in the catalog or commit real account configuration. Installation does not create this catalog or install its helper executables.

`McpEndpointCatalog` and `McpEndpointEntry` in `server/config/mcp.ts` are the current schema. HTTP entries name the endpoint, account/resource identity, credential reference and explicit egress choice. Stdio entries bind an absolute command and explicit arguments/environment, not a command found by searching PATH. `validateApprovedStdioEnv` owns the required environment shape. `validateEndpointUrl` limits plain HTTP to literal loopback.

The host loads the catalog through `server/host/mcp.ts`. Restart deliberately after file changes; do not assume a mutable file changed the authority of an already accepted run.

## Mongoose: three resources, three sign-ins

`MONGOOSE_ENDPOINTS` and `MONGOOSE_ENDPOINT_PATHS` in `server/connectors/mongoose.ts` define knowledge, data and CRM. Configure all required endpoints with distinct IDs and credential references. The OAuth resource is the full endpoint URL, not the catalog's local resource label. The admin endpoint is not supported.

In Settings, choose the sign-in button on the row for the endpoint you need. Finish that browser flow; signing in to knowledge does not authorize data or CRM. The host reports progress and reconnects that endpoint after a successful save. `server/host/mongoose-login.ts` owns the login flow and `server/host/mongoose-auth.ts` owns resource-bound records and renewal.

The terminal equivalent uses the host entry:

```sh
node server/dist/host/index.js --mongoose-login knowledge --config-dir /absolute/private/config
```

Replace `knowledge` with `data` or `crm` for that resource. `--no-browser` lets the owner open the printed authorization URL manually. Do not paste a token into chat or a diagnostic report.

Data also needs the owner's Lightdash connection in Mongoose settings. A `data_not_connected` result is an account setup limitation, not an empty dataset. CRM access is restricted by Mongoose's own team admission; `endpoint_not_allowed` must not disable the other resources. Didi cannot grant membership or widen the service's permissions.

## Trello board sign-in

Trello uses the official remote MCP server through `server/host/trello.ts` and the shared `server/host/oauth-client.ts`. It is a separate gateway, not an `mcp.json` descriptor entry. Settings exposes **Sign in to Trello**. Choose the workspace that contains the intended board and approve the requested access in the browser.

The owner must also supply the board name privately in `trello-board.json`, beside the sign-in record:

```json
{"board":"Your board name"}
```

`TRELLO_BOARD_FILE` owns that filename. With no valid board selection, do not assume that sign-in authorizes an arbitrary board. `server/tools/trello.ts` scopes reads and card writes; [tool-owner.md](tool-owner.md) owns the action contract. Never put a real board name, ID or card body in this repository.

## Google and Mattermost helpers

Google families use separately configured stdio endpoints: `gmail`, `calendar` and optional `drive`. Each needs the helper's own account authorization and read scopes. Gmail or Calendar consent does not imply Drive consent. Use the exact command, account and token location selected for the installed helper, not a guessed universal Didi sign-in command.

Mattermost also uses the installed archive helper's account flow. A missing session is an authentication limitation, not a successful empty read. New person or conversation reads work only when the child publishes them and the connection grants them. [connectors.md](connectors.md) explains capability fallback.

## Approval modes and changes

The catalog's `grantMode` defaults to `explicit`. `owner-trusted-reads` is an explicit owner choice to approve the local connector's reviewed read envelope after discovery, not permission for all tools a server advertises. The local envelope and the remote read-only declaration constrain admission; writes and unknown effects must not become reads because of a familiar tool name.

A stored connection binds its endpoint, discovered schema and policy generation. New published reads can require renewed owner approval. Do not silently widen an existing grant when upgrading a child. Disabling or removing an enabled catalog entry retires its authority for new runs; restoring an entry is not permission to approve a different endpoint under its old identity.

For the protected single-connection CLI, the compiled entry is:

```sh
node server/dist/config/mcp-cli.js --help
```

Its commands are `init`, `catalog`, `approve` and `disable`. `catalog` needs explicit egress permission; `approve` and `disable` write a protected intent for the canonical host owner rather than opening a second database. Read the exact flags in the CLI before preparing private inputs. The implementation owners are `initMcpConfiguration`, `catalogMcpConfiguration`, `approveMcpConfiguration` and `disableMcpConfiguration` in `server/config/mcp.ts`.

## Diagnosis

Settings distinguishes configuration, connection and authentication failures. A connection contributes usable acceptance authority only after credential validation, discovery and host reconciliation; a visible status row is not proof of a usable grant. See [mcp-adapter.md](mcp-adapter.md) for protocol/evidence handling and [debugging.md](debugging.md) for safe diagnostics.
